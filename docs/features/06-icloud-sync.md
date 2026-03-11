# iCloud Sync

**Version:** 0.1
**Date:** March 11, 2026
**Status:** Design

---

## 1. Motivation

Quill currently stores all data locally in `~/Library/Application Support/com.jason.quill/` — a SQLite database, EPUB files, and cover images. Users with multiple Macs have no way to sync their library, reading progress, bookmarks, or highlights between devices.

iCloud Drive sync lets users seamlessly access their entire Quill library across all their Macs with zero configuration beyond toggling a switch.

---

## 2. Approach

Move the app's data directory into an iCloud Drive **ubiquity container** (`~/Library/Mobile Documents/iCloud~com~jason~quill/Documents/`). iCloud Drive handles file-level sync automatically.

This is the simplest viable approach and works well for a reading app where only one device is actively used at a time. Many successful apps (Bear, iA Writer, DEVONthink) use this pattern.

**Key prerequisite**: Requires an Apple Developer account ($99/year) with iCloud capability enabled. Without code signing, the iCloud APIs return `nil` and the app falls back to local storage gracefully.

---

## 3. What Syncs (and What Doesn't)

| Data | Syncs? | Reason |
|------|--------|--------|
| EPUB files (`books/`) | Yes | Core library data |
| Cover images (`covers/`) | Yes | Core library data |
| SQLite database (`quill.db`) | Yes | Reading progress, bookmarks, highlights, collections, settings |
| OAuth tokens (`oauth_*`) | **No** | Security: tokens are device-specific |
| API keys (`ai_api_key`) | **No** | Security: user may use different keys per machine |
| iCloud enabled preference | **No** | Local-only, stored outside the synced directory |

---

## 4. UX Design

### Settings Page — iCloud Sync Section

A new section in Settings between "Reading Preferences" and "Appearance":

- **Icon**: Cloud (lucide-react)
- **Title**: "iCloud Sync"
- **Subtitle**: "Sync your books, reading progress, and highlights across your Macs"
- **Toggle**: Enable / Disable
  - Disabled (greyed out) when iCloud is unavailable on the system
  - When unavailable: muted text "Sign in to iCloud on your Mac to enable sync"
- **Note**: "API keys and login tokens are stored locally and will not sync"
- **Loading state**: Spinner while migration is in progress (moving files to/from iCloud)
- **Error state**: Red banner if migration fails

---

## 5. Implementation Phases

### Phase 1: Relative Paths (prerequisite) — DONE

Currently `books.file_path` and `books.cover_path` store **absolute paths** (e.g. `/Users/alice/Library/.../books/abc.epub`). These break across devices because usernames differ.

**Changes:**
- Add `data_dir: Mutex<PathBuf>` field to `Db` struct with a `resolve_path()` helper
- Store relative paths on import: `books/{uuid}.epub`, `covers/{uuid}.ext`
- Resolve to absolute on read (before returning to frontend)
- One-time migration of existing absolute paths to relative on startup

**Files:**
- `src-tauri/src/db.rs`
- `src-tauri/src/commands/books.rs`
- `src-tauri/src/epub.rs`

### Phase 2: Secrets Separation — DONE

OAuth tokens and API keys must NOT sync to iCloud.

**Changes:**
- Create a second local-only SQLite DB (`secrets.db`) at the local `app_data_dir`
- Move OAuth token storage (`save_tokens`, `load_tokens`, `clear_tokens`) to use Secrets
- Redirect `ai_api_key` reads/writes to Secrets
- Register `Secrets` as Tauri managed state

**Files:**
- `src-tauri/src/secrets.rs` (new)
- `src-tauri/src/ai/oauth.rs`
- `src-tauri/src/commands/ai.rs`
- `src-tauri/src/commands/settings.rs`
- `src-tauri/src/lib.rs`

### Phase 3: iCloud Module (Rust backend)

**Changes:**
- Add `objc2` / `objc2-foundation` dependencies for NSFileManager FFI
- Create `icloud.rs` with:
  - `get_icloud_container_url()` — FFI to `NSFileManager.url(forUbiquityContainerIdentifier:)`
  - `migrate_to_icloud()` — WAL checkpoint, close DB, move files, reopen
  - `migrate_from_icloud()` — Copy files back to local, reopen DB
  - `ensure_downloaded()` — Trigger download of evicted cloud-only files
- Create `Entitlements.plist` with `com.apple.developer.ubiquity-container-identifiers`
- Update `tauri.conf.json` with entitlements reference and expanded asset protocol scope
- Update `capabilities/default.json` with iCloud fs scope

**Files:**
- `src-tauri/src/icloud.rs` (new)
- `src-tauri/Entitlements.plist` (new)
- `src-tauri/Cargo.toml`
- `src-tauri/tauri.conf.json`
- `src-tauri/capabilities/default.json`

### Phase 4: iCloud Commands & App Init

**Changes:**
- Create Tauri commands: `icloud_status`, `icloud_enable`, `icloud_disable`
- iCloud-aware app startup: check `.icloud_enabled` marker → resolve data directory
- WAL checkpoint on app exit for safe sync

**Files:**
- `src-tauri/src/commands/icloud.rs` (new)
- `src-tauri/src/commands/mod.rs`
- `src-tauri/src/lib.rs`

### Phase 5: Frontend

**Changes:**
- Add "iCloud Sync" section to SettingsPage with toggle, status, and error handling
- State: `icloudAvailable`, `icloudEnabled`, `icloudLoading`, `icloudError`
- On mount: `invoke("icloud_status")`
- On toggle: `invoke("icloud_enable")` / `invoke("icloud_disable")`

**Files:**
- `src/pages/SettingsPage.tsx`

---

## 6. SQLite + iCloud Drive Safety

The key risk with SQLite in iCloud Drive is WAL/SHM file sync issues when two devices write simultaneously. Mitigations:

1. **Single-device active use** — Quill is a reading app; only one Mac reads at a time
2. **WAL checkpoint on quit** — Flush WAL to main DB before app closes, reducing sync window
3. **Periodic checkpoint** — During reading, checkpoint every ~30s after progress updates
4. **Graceful fallback** — If iCloud is unavailable, the app works fully in local mode

---

## 7. Files Summary

| Action | File |
|--------|------|
| Modify | `src-tauri/src/db.rs` — add `data_dir` field, `resolve_path()` helper |
| Modify | `src-tauri/src/commands/books.rs` — relative paths, resolve on read |
| Modify | `src-tauri/src/epub.rs` — return relative cover path |
| Create | `src-tauri/src/secrets.rs` — local-only secrets DB |
| Modify | `src-tauri/src/ai/oauth.rs` — use Secrets store |
| Modify | `src-tauri/src/commands/ai.rs` — read api_key from Secrets |
| Modify | `src-tauri/src/commands/settings.rs` — redirect sensitive keys |
| Create | `src-tauri/src/icloud.rs` — NSFileManager FFI, migration logic |
| Create | `src-tauri/Entitlements.plist` — iCloud entitlement |
| Create | `src-tauri/src/commands/icloud.rs` — Tauri commands |
| Modify | `src-tauri/src/commands/mod.rs` — add icloud module |
| Modify | `src-tauri/src/lib.rs` — iCloud-aware init, register commands, WAL checkpoint on exit |
| Modify | `src-tauri/tauri.conf.json` — entitlements, expanded asset scope |
| Modify | `src-tauri/capabilities/default.json` — fs scope for iCloud path |
| Modify | `src-tauri/Cargo.toml` — objc2 dependencies |
| Modify | `src/pages/SettingsPage.tsx` — iCloud Sync toggle section |

---

## 8. Verification

1. `cargo build` passes
2. Without iCloud entitlement: app works identically to current behavior (local fallback)
3. Import a book → DB stores relative path `books/{uuid}.epub`, reader still loads correctly
4. Existing books with absolute paths auto-migrate to relative on startup
5. OAuth tokens stored in `secrets.db`, not in main `quill.db`
6. Enable iCloud toggle → files move to `~/Library/Mobile Documents/iCloud~com~jason~quill/Documents/`
7. Disable iCloud → files copy back to local, app works normally
8. Cover images and EPUBs load correctly via asset protocol at both local and iCloud paths
9. Multi-device: import book on Mac A, wait for iCloud sync, launch on Mac B → book appears
