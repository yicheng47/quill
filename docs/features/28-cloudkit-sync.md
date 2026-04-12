# 28 — CloudKit Sync

**Issue:** [#178](https://github.com/yicheng47/quill/issues/178)
**Status:** Planned
**Milestone:** 4 — Cross-Platform Sync
**Supersedes:** Partially replaces [16 — Universal Cloud Sync](16-universal-cloud-sync.md) for Apple platforms

## Motivation

Quill currently syncs by placing a raw SQLite file (`quill.db`) inside an iCloud ubiquity container. This is file-level sync — iCloud treats the entire database as an opaque blob. It works for single-device use but is fundamentally fragile:

- **No concurrent access** — two devices opening the same SQLite file via iCloud causes corruption. We warn users not to do this, but they will.
- **File-level conflicts** — if both devices write, iCloud creates `quill (1).db` instead of merging. Data is lost or duplicated silently.
- **WAL interference** — iCloud can sync `.db-wal` and `.db-shm` files out of order, corrupting the database. We mitigate this by using DELETE journal mode, but that sacrifices write performance.
- **No iOS file sync** — iOS sandboxing prevents sharing a ubiquity container directory the same way macOS does. The iOS app (quill-ios) currently has no sync at all.

Now that Quill ships on both macOS and iOS, we need real sync. CloudKit is the right answer for Apple platforms:

- **Record-level sync** — each book, highlight, vocab word, chat message is a separate CKRecord. Changes merge at the field level, not file level.
- **Built-in conflict resolution** — CloudKit returns `.serverRecordChanged` when there's a conflict, giving us both versions to resolve programmatically.
- **Push notifications** — `CKSubscription` notifies the app of remote changes instantly instead of polling.
- **Shared infrastructure** — same CloudKit container works for macOS (via Rust/Swift bridge or native Swift) and iOS (native Swift).
- **Automatic iCloud account** — no user signup, no auth flow. If you're signed into iCloud, it works.

### Relationship to spec 16 (Universal Cloud Sync)

Spec 16 proposed a BYOC (Bring Your Own Cloud) model: abstract the storage backend, let users pick any synced folder. That vision remains valid for non-Apple platforms (Windows, Linux, Android). But for Apple platforms, CloudKit is strictly better than file-based sync. This spec replaces the iCloud portion of spec 16; the custom-directory BYOC approach from spec 16 can coexist for non-Apple platforms later.

## Scope

### Data model mapping

Map each SQLite table to a CloudKit record type:

| SQLite Table | CK Record Type | Sync Strategy | Notes |
|-------------|----------------|---------------|-------|
| `books` | `Book` | Bidirectional | Metadata only — file_path, title, author, progress, status |
| `highlights` | `Highlight` | Bidirectional | CKReference to Book |
| `bookmarks` | `Bookmark` | Bidirectional | CKReference to Book |
| `vocab_words` | `VocabWord` | Bidirectional | SRS state must merge carefully (take latest review) |
| `collections` | `Collection` | Bidirectional | |
| `collection_books` | `CollectionBook` | Bidirectional | Junction record: CKReference to Collection + Book |
| `chats` / `chat_messages` | `Chat` / `ChatMessage` | Bidirectional | CKReference chain: Message → Chat → Book |
| `translations` | `Translation` | Bidirectional | CKReference to Book |
| `book_settings` | `BookSetting` | Bidirectional | CKReference to Book |
| `settings` | `Setting` | Bidirectional | App-level settings (non-sensitive only) |
| Book files (EPUB/PDF) | `CKAsset` on `Book` | Upload once | Large files — use CKAsset for books under 50MB, skip larger ones |
| Cover images | `CKAsset` on `Book` | Upload once | Thumbnail-sized, always sync |

**Not synced:** `secrets.db` (API keys, OAuth tokens) — these stay local-only, as today.

### Sync engine design

**Architecture:** Local-first with CloudKit as the remote source of truth.

1. **Local SQLite remains the primary store.** The app always reads from and writes to local SQLite. CloudKit is a replication layer, not the primary database.
2. **Change tracking:** Add `updated_at` (timestamp) and `ck_record_id` (CloudKit record system field data) columns to every synced table. On every local write, bump `updated_at`.
3. **Push changes:** After local writes, queue changed records for upload. Batch upload via `CKModifyRecordsOperation` with `.changedKeys` save policy (only send modified fields).
4. **Pull changes:** Use `CKFetchRecordZoneChangesOperation` with a stored server change token. On launch and on push notification, fetch all changes since last token.
5. **Conflict resolution:** Last-writer-wins by `updated_at` timestamp, with per-field merging where possible:
   - `books.progress` — take the higher value (further reading position wins)
   - `vocab_words.mastery_level` — take the higher value
   - `vocab_words.next_review_at` — take the earlier date (sooner review wins)
   - All other fields — last `updated_at` wins
6. **Soft deletes:** Add `deleted_at` column. Deleting a record sets `deleted_at` instead of removing it. Sync propagates the deletion, then a periodic cleanup removes records older than 30 days.

### CloudKit zone setup

- Use a **single custom record zone** (`QuillZone`) in the **private database**.
- Custom zones support `CKFetchRecordZoneChangesOperation` (atomic fetch of changes since token) — the default zone does not.
- Zone is created on first sync, stored in a local flag.

### Book file sync

Book files (EPUB/PDF) are the largest assets. Strategy:

- **Under 50MB:** Attach as `CKAsset` on the `Book` record. CloudKit supports assets up to 50MB in the private database.
- **Over 50MB:** Do not sync the file. Show a placeholder on the other device with a prompt to import locally. Most EPUBs are 1-10MB; this covers the vast majority.
- **On-demand download:** When a synced book appears on a new device, the file downloads in the background. Show a download indicator (similar to current iCloud evicted file handling).
- **Deduplication:** Use a content hash (`SHA-256` of the file) as a field on `Book`. If a book with the same hash already exists locally, skip the download.

### Platform implementation

| Component | macOS (Quill) | iOS (quill-ios) |
|-----------|---------------|-----------------|
| CloudKit API | Swift package called from Rust via `swift-bridge` or Tauri Swift plugin | Native Swift (SwiftUI) |
| Local DB | SQLite via `rusqlite` | SQLite via `GRDB.swift` or similar |
| Sync trigger | App launch + `CKSubscription` push + periodic (every 5 min) | App launch + `CKSubscription` push + background fetch |
| File storage | Local filesystem (app data dir) | App sandbox / shared container |

**Key decision: Swift bridge on macOS.** CloudKit is a Swift/ObjC framework with no Rust bindings. Options:
1. **`swift-bridge` crate** — compile a Swift package that wraps CloudKit, call from Rust. Most ergonomic, but adds build complexity.
2. **Tauri Swift plugin** — write the sync engine as a Tauri plugin in Swift. Clean separation.
3. **Standalone sync daemon** — a small Swift CLI that runs alongside Quill, communicates via IPC. Over-engineered for this.

Recommendation: **Tauri Swift plugin** — keeps the sync engine isolated, testable, and reusable.

### Migration from file-based iCloud sync

Users currently on file-based iCloud sync need a one-time migration:

1. Read all records from the iCloud-synced `quill.db`.
2. Upload each record to CloudKit with current timestamps.
3. Copy book files as CKAssets.
4. Once upload completes, switch `sync_backend` setting from `"icloud_file"` to `"cloudkit"`.
5. Move the local data directory back to local app data (stop using ubiquity container for the DB).
6. Book files can remain in the ubiquity container temporarily during the transition, with CloudKit taking over file management going forward.

### Settings & UI

- New setting: `sync_backend` — `"none"` | `"icloud_file"` (legacy) | `"cloudkit"`
- Settings UI: "Sync" section
  - Toggle: Enable iCloud Sync (maps to `cloudkit` backend)
  - Sync status indicator (last synced time, sync in progress, error state)
  - "Sync Now" button for manual trigger
  - Storage usage (CloudKit quota)
  - Legacy migration prompt (if currently using file-based sync)
  - Note: "API keys and tokens are stored locally and never synced"

### Out of scope

- Non-Apple sync (Android, Windows, Linux) — covered by spec 16's BYOC approach
- CloudKit sharing (shared libraries between users) — future feature
- End-to-end encryption beyond what CloudKit provides by default
- Sync for AI chat context/embeddings (too large, device-specific)

## Implementation Phases

### Phase 1 — Schema & change tracking
1. Add `updated_at`, `ck_record_data`, and `deleted_at` columns to all synced tables (new migration 008)
2. Add triggers or application-level hooks to bump `updated_at` on every INSERT/UPDATE
3. Update all Tauri commands that write data to set `updated_at`
4. Verify no existing functionality breaks with the new columns

### Phase 2 — CloudKit sync engine (macOS)
1. Create a Tauri Swift plugin (`tauri-plugin-cloudkit`) with the sync engine
2. Implement zone creation (`QuillZone` in private DB)
3. Implement record mapping: SQLite row ↔ CKRecord for each table
4. Implement push: upload changed records (since last push) to CloudKit
5. Implement pull: `CKFetchRecordZoneChangesOperation` with stored change token
6. Implement conflict resolution (per-field merge rules)
7. Implement soft delete propagation
8. Implement CKAsset upload/download for book files and covers
9. Subscribe to push notifications (`CKDatabaseSubscription`)
10. Unit tests with CloudKit mock / local container

### Phase 3 — Migration & UI (macOS)
1. Implement migration from file-based iCloud sync to CloudKit
2. Build "Sync" settings section (replace current iCloud section)
3. Add sync status indicators (last synced, in-progress, errors)
4. Add manual "Sync Now" trigger
5. i18n keys for all new strings
6. End-to-end testing: two Macs, enable sync, verify records appear on both

### Phase 4 — iOS sync engine
1. Implement the same sync engine in quill-ios (native Swift, no bridge needed)
2. Share the CloudKit record type definitions and conflict resolution logic between platforms
3. Implement background fetch for iOS (`BGAppRefreshTask`)
4. Test macOS ↔ iOS sync: create a highlight on Mac, verify it appears on iPhone and vice versa
5. Handle on-demand book file download on iOS (show progress, handle failures)

### Phase 5 — Polish & edge cases
1. Handle iCloud account changes (sign out, sign into different account)
2. Handle CloudKit quota exceeded
3. Handle network errors gracefully (queue changes, retry with exponential backoff)
4. Handle first-launch sync (new device joins existing library — bulk download)
5. Performance: batch operations, avoid syncing during active reading
6. Deprecate file-based iCloud sync (remove from settings, keep migration path)

## Open Questions

- **Shared sync engine code between macOS and iOS?** ~~Options: (a) Swift package shared between both projects, (b) duplicated code.~~ **Decision: shared Swift package.** The CloudKit sync engine is pure Swift on both platforms — macOS wraps it in a Tauri plugin, iOS calls it directly. A shared `QuillSync` Swift package contains: record ↔ model mapping, conflict resolution, change token management, CKRecord operations. Platform-specific code (Tauri bridge on macOS, BGAppRefreshTask on iOS) stays in each project.
- **CloudKit container ID?** Currently the iCloud container is `iCloud.com.wycstudios.quill`. CloudKit uses the same container — confirm this works or if a separate CloudKit container is needed.
- **Quota limits?** CloudKit private DB has per-user limits (~1GB default, grows with iCloud plan). Need to track usage and warn users approaching limits, especially with many large book files.
- **GRDB on iOS?** quill-ios may or may not be using GRDB. If it's using a different SQLite wrapper, ensure the schema and migration approach are compatible.
- **Deprecation timeline for file-based sync?** How long to support both backends? Suggestion: keep migration path for 2 major versions, then remove file-based sync code.

## Verification

- [ ] New columns (`updated_at`, `ck_record_data`, `deleted_at`) added without breaking existing functionality
- [ ] CloudKit zone created successfully on first sync
- [ ] Records upload to CloudKit after local writes
- [ ] Records download from CloudKit on pull
- [ ] Conflict resolution works: edit same highlight on two devices, both edits preserved or LWW applied correctly
- [ ] Book progress sync: read further on one device, progress updates on the other
- [ ] Book file sync: import a book on Mac, it appears on iPhone
- [ ] Large book (>50MB) is not synced, placeholder shown on other device
- [ ] Soft delete propagates: delete a highlight on one device, it disappears on the other
- [ ] Migration from file-based iCloud sync completes without data loss
- [ ] Secrets (API keys) are never uploaded to CloudKit
- [ ] Push notifications trigger immediate sync
- [ ] App handles no-network gracefully (queues changes, syncs when back online)
- [ ] iCloud account change detected and handled (re-sync or reset)
- [ ] CloudKit quota warning shown when approaching limits
