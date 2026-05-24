# CloudKit Sync

**Issue:** [#178](https://github.com/yicheng47/quill/issues/178)
**Spec:** [28 — CloudKit Sync](../features/28-cloudkit-sync.md)

## Context

Quill syncs via raw SQLite file in an iCloud ubiquity container. This breaks with concurrent access, creates conflict files (`quill (1).db`), and doesn't work cross-platform — iOS can't share ubiquity containers like macOS. Now that Quill ships on both macOS and iOS, we need record-level CloudKit sync.

**Approach:** Mirrored implementations — Tauri Swift plugin on macOS, native `CloudKitSyncService` on iOS. No shared Swift package. Same pattern as iCloud sync / OAuth / migrations today.

**Migration 008 divergence:** Desktop has `008_drop_book_settings.sql` (clears data), iOS has `008_dedup_indexes.sql` (adds unique indexes). Both are at schema_version 8. Migration 009 must be idempotent regardless of which 008 ran.

---

## Phase 1 — Schema & Change Tracking

Add sync-readiness columns to all tables, convert hard deletes to soft deletes, ensure `updated_at` is set on every write. Both repos updated in parallel.

### Migration 009

**Files:**
- `src-tauri/migrations/009_cloudkit_sync_prep.sql`
- `quill-ios/Quill/Resources/migrations/009_cloudkit_sync_prep.sql` (identical copy)

Each ALTER TABLE runs individually with errors ignored (column-may-exist). Extends the existing `version == 4 || version == 5` error-tolerance pattern to include `version == 9`.

| Table | `updated_at` | `deleted_at` | `ck_record_data` | Extra |
|-------|:---:|:---:|:---:|-------|
| books | exists | ADD | ADD | |
| highlights | ADD | ADD | ADD | backfill from `created_at` |
| bookmarks | ADD | ADD | ADD | backfill from `created_at` |
| vocab_words | exists | ADD | ADD | |
| collections | ADD | ADD | ADD | backfill from `created_at` |
| collection_books | ADD | ADD | ADD | also add `id TEXT`, `created_at`; backfill id with random hex |
| chats | exists | ADD | ADD | |
| chat_messages | ADD | ADD | ADD | backfill from `created_at` |
| translations | ADD | ADD | ADD | backfill from `created_at` |
| settings | ADD | — | ADD | k-v store, never deleted |
| book_settings | ADD | ADD | ADD | |

`ck_record_data` is a BLOB storing `CKRecord` system fields (encoded via `NSKeyedArchiver`). Contains the record's change tag (etag) needed for subsequent pushes.

`collection_books` has a composite PK `(collection_id, book_id)` and no `id`. CloudKit records need a unique identifier. Add `id TEXT` + unique index, backfill existing rows with `lower(hex(randomblob(16)))`.

### Migration runner updates

**Desktop** — `src-tauri/src/db.rs`:
- Add `(9, include_str!("../migrations/009_cloudkit_sync_prep.sql"))` to `MIGRATIONS`
- Extend error tolerance: `version == 4 || version == 5 || version == 9`
- Update test assertions: version 8 → 9

**iOS** — `quill-ios/Quill/Database/Database.swift`:
- Add `(9, "009_cloudkit_sync_prep")` to `migrations` array
- Extend error tolerance: `version == 4 || version == 5 || version == 9`

### Desktop write commands

**`src-tauri/src/commands/bookmarks.rs`:**
- `add_bookmark`, `add_highlight`: add `updated_at` to INSERT
- `remove_bookmark`, `remove_highlight`: DELETE → `UPDATE SET deleted_at`
- `update_highlight_note`, `update_highlight_color`: add `updated_at = ?`
- `list_bookmarks`, `list_highlights`: add `WHERE deleted_at IS NULL`

**`src-tauri/src/commands/books.rs`:**
- `delete_book`: hard DELETE → soft delete in transaction (book + all children: highlights, bookmarks, vocab_words, chats, chat_messages, translations, collection_books, book_settings)
- `list_books`, `get_book`: add `WHERE deleted_at IS NULL`

**`src-tauri/src/commands/collections.rs`:**
- `create_collection`: add `updated_at`
- `rename_collection`, `reorder_collections`: add `updated_at = ?`
- `delete_collection`: soft delete + cascade `collection_books`
- `add_book_to_collection`: generate UUID `id`, set `created_at`/`updated_at`
- `remove_book_from_collection`: soft delete
- All queries: add `WHERE deleted_at IS NULL`

**`src-tauri/src/commands/vocab.rs`:**
- `remove_vocab_word`: soft delete
- All queries: add `WHERE deleted_at IS NULL`

**`src-tauri/src/commands/chats.rs`:**
- `delete_chat`: soft delete + cascade messages
- `save_chat_message`: add `updated_at`
- All queries: add `WHERE deleted_at IS NULL`

**`src-tauri/src/commands/translation.rs`:**
- `save_translation`: add `updated_at`
- `remove_saved_translation`: soft delete
- `list_translations`: add `WHERE deleted_at IS NULL`

**`src-tauri/src/commands/settings.rs`:**
- `set_setting`, `set_settings_bulk`, `set_book_settings_bulk`: add `updated_at` to upsert

### iOS write operations

**`quill-ios/Quill/Database/Database.swift`:** All CRUD in one file. Apply identical patterns: `updated_at` on every INSERT/UPDATE, soft deletes, `WHERE deleted_at IS NULL` on all fetches, cascade soft-delete on book deletion.

### Model struct updates

**iOS** — Add `deletedAt: String?` and `ckRecordData: Data?` to all synced models. Add `updatedAt: String` where missing. Files: `Bookmark.swift`, `Highlight.swift`, `Collection.swift`, `Chat.swift`, `Translation.swift`, `Book.swift`, `VocabWord.swift`, `Setting.swift`.

**Desktop** — Add `deleted_at` and `ck_record_data` fields to Rust structs. `deleted_at` excluded from frontend serialization.

---

## Phase 2 — CloudKit Sync Engine (macOS)

### Tauri Swift plugin

```
src-tauri/
  swift/
    CloudKitPlugin/
      Package.swift
      Sources/CloudKitPlugin/
        Plugin.swift              — @_cdecl exports for swift-rs FFI
        SyncEngine.swift          — orchestrator: push, pull, full sync
        RecordMapper.swift        — SQLite row JSON <-> CKRecord
        ConflictResolver.swift    — per-field merge rules
        ZoneManager.swift         — QuillZone creation + subscription
        AssetManager.swift        — CKAsset upload/download for books/covers
        ChangeTokenStore.swift    — persist CKServerChangeToken to UserDefaults
        SyncModels.swift          — Codable types matching Rust-side JSON
```

Uses `swift-rs` crate for Rust/Swift FFI. Swift package compiles as a static library linked into the Tauri binary.

### Data flow across FFI

All data crosses the boundary as JSON strings.

**Push (local → CloudKit):**
1. Rust queries for rows where `updated_at > last_sync_time` or `deleted_at IS NOT NULL`
2. Rust serializes changed rows as JSON, grouped by record type
3. Rust → Swift: `cloudkit_push(json) -> result_json`
4. Swift maps to CKRecords, decodes existing `ck_record_data` for change tags
5. Swift calls `CKModifyRecordsOperation` with `.changedKeys` save policy
6. On `.serverRecordChanged` conflict → `ConflictResolver`, retry
7. Swift encodes saved records' system fields → returns `{ record_id, ck_record_data_base64 }`
8. Rust updates `ck_record_data` column

**Pull (CloudKit → local):**
1. Rust → Swift: `cloudkit_pull(change_token_base64) -> result_json`
2. Swift calls `CKFetchRecordZoneChangesOperation` with stored change token
3. Swift returns `{ changed: [...], deleted: [...], new_token_base64 }`
4. Rust applies changes with conflict resolution, hard-deletes confirmed deletions
5. Rust stores new change token

**Assets:**
- Upload: Rust passes file path to Swift, Swift creates `CKAsset`
- Download: Swift downloads to temp path, returns path, Rust moves to `books/`
- Files >50MB: skip, set `file_too_large` flag

### CloudKit zone

- Zone: `QuillZone` in private database
- Container: `iCloud.com.wycstudios.quill` (same as existing)
- Created on first sync enable, tracked in UserDefaults
- Subscription: `CKDatabaseSubscription` for push notifications

### CKRecord types (mirrored on both platforms)

```
Book:           id, title, author, description, genre, pages, status, progress,
                current_cfi, format, file_path, cover_path, file_hash,
                book_asset (CKAsset), cover_asset (CKAsset),
                created_at, updated_at, deleted_at

Highlight:      id, book (CKReference→Book), cfi_range, color, note, text_content,
                created_at, updated_at, deleted_at

Bookmark:       id, book (CKReference→Book), cfi, label,
                created_at, updated_at, deleted_at

VocabWord:      id, book (CKReference→Book), word, definition, context_sentence,
                cfi, mastery, review_count, next_review_at,
                created_at, updated_at, deleted_at

Collection:     id, name, sort_order, created_at, updated_at, deleted_at

CollectionBook: id, collection (CKReference), book (CKReference),
                created_at, updated_at, deleted_at

Chat:           id, book (CKReference→Book), title, model, pinned, metadata,
                created_at, updated_at, deleted_at

ChatMessage:    id, chat (CKReference→Chat), role, content, context, metadata,
                created_at, updated_at, deleted_at

Translation:    id, book (CKReference→Book), source_text, translated_text,
                target_language, cfi, created_at, updated_at, deleted_at

Setting:        key (record name = key), value, updated_at

BookSetting:    book_id + key (record name = composite), value,
                updated_at, deleted_at
```

### Conflict resolution (mirrored)

| Field | Rule |
|-------|------|
| `books.progress` | Take higher value (further reading wins) |
| `books.current_cfi` | Take the one with higher progress |
| `vocab_words.mastery` | Take higher value |
| `vocab_words.review_count` | Take higher value |
| `vocab_words.next_review_at` | Take earlier date (sooner review wins) |
| All other fields | Last-writer-wins by `updated_at` |

### Sync triggers (macOS)

- App launch: full pull
- Push notification: `CKDatabaseSubscription` → pull
- After local write: debounced push (2-second window)
- Manual: "Sync Now" → push + pull
- Periodic: every 5 min while open (fallback)

### Tauri commands

Add to `src-tauri/src/lib.rs` (behind `#[cfg(target_os = "macos")]`):
- `cloudkit_enable`, `cloudkit_disable`, `cloudkit_sync_now`, `cloudkit_status`, `cloudkit_last_synced`

### Settings key

`sync_backend`: `"none"` | `"icloud_file"` (legacy) | `"cloudkit"`

---

## Phase 3 — Migration & UI (macOS)

### Migration from file-based sync

Trigger: user has `sync_backend == "icloud_file"` or legacy `.icloud_enabled` marker.

1. Read all records from iCloud-synced `quill.db` (already the active DB)
2. Create `QuillZone`, upload all records as initial push
3. Upload book files as CKAssets (skip >50MB)
4. On success: set `sync_backend = "cloudkit"`, copy DB to local app data dir
5. Reopen DB from local path, stop using ubiquity container for DB
6. On second device: CloudKit pull populates local DB from scratch

Error handling: store progress marker, resume on failure, don't switch backend until complete.

### Settings UI

Replace `src/components/settings/ICloudSettings.tsx` → `SyncSettings.tsx`

Follows existing 73px row pattern:
- Row 1: "iCloud Sync" toggle
- Row 2: Sync status ("Last synced: 2 min ago" / "Syncing..." / error)
- Row 3: "Sync Now" button
- Row 4: Storage usage
- Note: "API keys and tokens are stored locally and never synced"
- Legacy users: migration banner with "Upgrade to CloudKit Sync"

### i18n

Add keys to `src/i18n/en.json` and `zh.json`:
```
settings.sync.title, settings.sync.enable, settings.sync.enableSub,
settings.sync.status, settings.sync.lastSynced, settings.sync.syncing,
settings.sync.syncNow, settings.sync.error, settings.sync.storage,
settings.sync.keysNote, settings.sync.migrate, settings.sync.migrateDesc,
settings.sync.migrating, settings.sync.migrateDone
```

---

## Phase 4 — iOS Sync Engine

### CloudKitSyncService

```
quill-ios/Quill/Services/
  CloudKitSyncService.swift        — @Observable orchestrator
  CloudKit/
    CKSyncEngine.swift             — push, pull, full sync
    CKRecordMapper.swift           — GRDB model <-> CKRecord
    CKConflictResolver.swift       — per-field merge (mirrors desktop)
    CKZoneManager.swift            — QuillZone + subscription
    CKAssetManager.swift           — book file upload/download
    CKChangeTokenStore.swift       — UserDefaults-backed token persistence
```

### Integration

**`QuillApp.swift`:**
- `@State private var cloudKitSync = CloudKitSyncService()`
- `.environment(cloudKitSync)`
- `onChange(of: scenePhase)`: if CloudKit enabled → `cloudKitSync.pull()`, else legacy refresh

**Push notifications:** register for remote notifications, handle → trigger pull

**Background fetch:** `BGAppRefreshTask` with identifier `com.wycstudios.quill.sync`

### Entitlement changes

`Quill/Quill.entitlements` and `QuillDebug.entitlements`:
- Add `CloudKit` to `com.apple.developer.icloud-services`
- Add `com.apple.developer.aps-environment` for push notifications

Apple Developer Portal: enable CloudKit capability for `iCloud.com.wycstudios.quill`.

### On-demand book download

Synced book without local file: show download icon → tap to download CKAsset → move to `books/`. Files >50MB (no CKAsset): show "Import locally" prompt.

---

## Phase 5 — Polish & Edge Cases

- **Account changes:** Listen for `CKAccountChanged`, reset tokens, re-sync or disable
- **Quota:** Check after each push, warn when approaching limit, stop asset uploads on exceed
- **Network errors:** Queue failed pushes, retry with exponential backoff (5s → 5min cap)
- **Bulk sync:** New device full pull with progress indicator, assets on-demand
- **Cleanup:** Purge `deleted_at` > 30 days every 24h
- **Performance:** Batch 400 records/op, debounce push 2s, suppress during reading
- **Settings filtering:** Sync allow-list (theme, language), never sync device-specific or secrets
- **Deprecation:** Migration prompt → remove file-based sync after 2 major versions

---

## Sequencing

```
Phase 1 ─── Schema + change tracking (both repos, parallel)
  │
  ├── Desktop: migration 009 + write commands + structs
  └── iOS: migration 009 + Database.swift + models
  │
Phase 2 ─── macOS CloudKit sync engine (Tauri Swift plugin + Rust FFI)
  │
Phase 3 ─── macOS migration UX + settings UI (depends on Phase 2)
  │
Phase 4 ─── iOS CloudKit sync engine (can parallel with Phase 2/3)
  │
Phase 5 ─── Polish (incremental, both platforms)
```

## Key files

### Desktop (quill)

| File | Phase | Changes |
|------|-------|---------|
| `src-tauri/migrations/009_cloudkit_sync_prep.sql` | 1 | New migration |
| `src-tauri/src/db.rs` | 1 | Add migration 9, error tolerance |
| `src-tauri/src/commands/bookmarks.rs` | 1 | updated_at, soft deletes, filters |
| `src-tauri/src/commands/books.rs` | 1 | Soft delete cascade, filters |
| `src-tauri/src/commands/collections.rs` | 1 | updated_at, soft deletes, UUID for junction |
| `src-tauri/src/commands/vocab.rs` | 1 | Soft deletes, filters |
| `src-tauri/src/commands/chats.rs` | 1 | Soft deletes, updated_at on messages |
| `src-tauri/src/commands/translation.rs` | 1 | updated_at, soft deletes, filters |
| `src-tauri/src/commands/settings.rs` | 1 | updated_at on upserts |
| `src-tauri/swift/CloudKitPlugin/` | 2 | New Swift plugin |
| `src-tauri/Cargo.toml` | 2 | swift-rs dependency |
| `src-tauri/src/lib.rs` | 2 | Register cloudkit commands |
| `src/components/settings/SyncSettings.tsx` | 3 | Replace ICloudSettings |
| `src/i18n/en.json`, `zh.json` | 3 | Sync i18n keys |

### iOS (quill-ios)

| File | Phase | Changes |
|------|-------|---------|
| `Quill/Resources/migrations/009_cloudkit_sync_prep.sql` | 1 | New migration |
| `Quill/Database/Database.swift` | 1 | Migration runner + all CRUD changes |
| `Quill/Models/*.swift` (8 files) | 1 | Add deletedAt, ckRecordData, updatedAt |
| `Quill/Services/CloudKitSyncService.swift` | 4 | New sync service |
| `Quill/Services/CloudKit/*.swift` (6 files) | 4 | Sync engine components |
| `Quill/QuillApp.swift` | 4 | Foreground hook, push, BGTask |
| `Quill/Quill.entitlements` | 4 | CloudKit + aps |
| `Quill/QuillDebug.entitlements` | 4 | Same |
