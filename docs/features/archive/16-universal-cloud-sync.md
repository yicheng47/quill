# 16 — Universal Cloud Sync

**Issue:** [#74](https://github.com/yicheng47/quill/issues/74)
**Status:** Planned
**Milestone:** 3 — Companion

## Motivation

Quill currently supports iCloud sync — macOS only. Windows users, and anyone who prefers a different cloud provider, have no way to sync their library across devices. This limits the audience and ties users to Apple's ecosystem.

The deeper principle: **your reading data belongs to you.** You should be able to choose where it lives — iCloud, Google Drive, OneDrive, Dropbox, or a self-hosted folder. Quill should not be the gatekeeper of your data. This is the vision behind data and view separation: Quill is the view layer, your cloud provider is the storage layer.

### Current architecture (already favorable)

The existing design makes this feasible:

- Book files (EPUB/PDF) and metadata (SQLite) live in a **single data directory**
- All paths in the DB are **relative** — the directory can be moved anywhere
- iCloud sync works by redirecting the data directory to iCloud's ubiquity container
- Secrets (API keys, tokens) are stored separately in a local-only `secrets.db` that never syncs

The generalization: abstract "iCloud container" into "any synced folder chosen by the user."

## Scope

### Bring Your Own Cloud (BYOC)

- Let the user choose a **custom data directory** — any folder on their filesystem
- If that folder is synced by Google Drive, OneDrive, Dropbox, or any other service, sync happens automatically
- Quill doesn't implement cloud provider APIs — it reads and writes to a local folder, the cloud provider handles the rest
- Migration: move existing library (books/, covers/, quill.db) to the chosen directory, same pattern as current iCloud migration

### Provider-agnostic storage abstraction

- Refactor the current iCloud-specific code (`src-tauri/src/icloud.rs`) into a generic storage backend
- The abstraction: `StorageBackend` with variants:
  - `Local` — default, app data directory (current behavior)
  - `ICloud` — current iCloud implementation (macOS only)
  - `Custom(path)` — user-chosen directory (cross-platform)
- Startup logic reads which backend is active and resolves the data directory accordingly
- Settings store the active backend and custom path

### Cross-platform considerations

| Platform | iCloud | Custom directory | Notes |
|----------|--------|-----------------|-------|
| macOS | Yes (native) | Yes | Google Drive, OneDrive, Dropbox all sync local folders |
| Windows | No | Yes | OneDrive built-in, Google Drive/Dropbox via desktop apps |
| Linux | No | Yes | Syncthing, rclone, Nextcloud, etc. |
| iOS | Yes (native) | Limited | Files app supports cloud providers, but sandboxing restricts arbitrary paths |

### SQLite + cloud sync safety

Cloud file sync and SQLite don't mix perfectly. Safeguards needed:

- **WAL checkpoint on exit** — flush WAL to main DB file before app closes (already implemented for iCloud)
- **WAL checkpoint on background** — periodic checkpoint while app is running
- **Lock detection** — detect if another device has the DB open (stale lock files from cloud sync)
- **Conflict handling** — if the cloud provider creates conflict copies (e.g., `quill (1).db`), detect and warn the user
- **Recommendation:** advise users not to run Quill on two devices simultaneously with the same synced directory. Display a clear warning in the UI.

### Settings & UI

- New setting: `storage_backend` — `"local"` | `"icloud"` | `"custom"`
- New setting: `custom_data_dir` — filesystem path (only when `storage_backend == "custom"`)
- Settings UI: "Library Storage" section replacing the current "iCloud" section
  - Radio/segmented control: Local / iCloud (macOS only) / Custom Folder
  - Folder picker for custom directory
  - Migration progress indicator
  - Warning about simultaneous multi-device access
  - "Secrets are always stored locally" note (carried over from iCloud settings)

### Out of scope

- Direct API integration with specific cloud providers (no Google/OneDrive/Dropbox SDKs)
- Real-time sync or conflict resolution (delegate to the cloud provider)
- iOS custom directory support (iOS sandboxing makes this impractical — iOS keeps iCloud for now)
- End-to-end encryption of synced data (future consideration)

## Implementation Phases

### Phase 1 — Storage abstraction
1. Refactor `src-tauri/src/icloud.rs` — extract a `StorageBackend` trait/enum with `data_dir()`, `is_available()`, `migrate_to()`, `migrate_from()`
2. Add `Custom` variant that accepts a user-chosen path
3. Update `src-tauri/src/lib.rs` startup logic to resolve data directory from the active backend
4. Store `storage_backend` and `custom_data_dir` in settings (or a separate local config, since settings DB itself may be moving)

### Phase 2 — Custom directory support
1. Add `set_storage_backend` and `get_storage_status` Tauri commands
2. Implement folder picker integration (Tauri's `dialog` plugin)
3. Implement migration: copy books/, covers/, quill.db to chosen directory, verify, switch
4. Handle migration rollback if something fails
5. Update asset protocol scope in Tauri config to include the custom path

### Phase 3 — UI & safety
1. Replace "iCloud" settings section with "Library Storage" section
2. Build the storage picker UI (Local / iCloud / Custom Folder)
3. Add simultaneous-access warning
4. Add conflict file detection (scan for `quill (1).db` etc.)
5. Periodic WAL checkpoint while app is running
6. i18n keys for all new strings

## Open Questions

- Should we support **linking** an existing cloud-synced library (no migration, just point to it)? Useful when a second device joins an already-synced folder.
- Should we bootstrap a fresh `quill.db` if the custom directory is empty, or require migration?
- How to handle the chicken-and-egg: settings are stored in `quill.db`, but the storage backend determines where `quill.db` lives. Need a local-only config for the backend choice (similar to how `.icloud_enabled` marker works today).

## Verification

- [ ] Can switch from Local to Custom Folder — library migrates correctly
- [ ] Can switch from iCloud to Custom Folder (macOS)
- [ ] Can switch back to Local — data copied back
- [ ] Books, highlights, vocab, chats all intact after migration
- [ ] Secrets remain local-only (never copied to synced directory)
- [ ] App starts correctly from custom directory after restart
- [ ] Syncing via Google Drive/OneDrive/Dropbox works when custom dir is inside their synced folder
- [ ] Warning displayed about simultaneous multi-device access
- [ ] Conflict files detected and surfaced to user
- [ ] WAL checkpoint runs on exit and periodically
