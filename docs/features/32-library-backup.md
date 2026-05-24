# 32 — Library Backup

**Issue:** [#228](https://github.com/yicheng47/quill/issues/228)
**Status:** Planned

## Motivation

Users accumulate ebooks over years — many from sources that no longer exist. If the local library is lost (disk failure, accidental deletion, app reinstall), those files are gone. Quill should let users back up their book files to a user-chosen location (local NAS, external drive, any mounted folder) so they always have a recoverable copy.

This is distinct from sync (spec #31): backup is **one-way, file-level** — copy book and cover files out. No event logs, no bidirectional merge, no reading-state transfer. Think Time Machine for your library, not iCloud sync.

## Scope

### In scope

- User picks a backup destination folder (any mounted path — NAS share, external drive, Dropbox folder, etc.)
- One-way copy of book files (epub/pdf) and cover images to the destination
- Manual "Backup now" button in settings
- Optional auto-backup: runs when a book is added or removed
- Incremental: only copies new/changed files, skips files already present at the destination
- Settings UI: destination picker, auto-backup toggle, last backup timestamp, backup status

### Out of scope

- Restoring from backup (manual — user drags files back into Quill to re-import)
- Backing up reading state, highlights, bookmarks, vocab (that's sync territory)
- Scheduling (cron-style daily backups) — auto-on-change is sufficient
- Remote/cloud API integration (S3, FTP) — if it's mounted as a folder, it works
- Encryption or compression — files are copied as-is

## Implementation Phases

### Phase 1 — Manual backup

- Settings UI: folder picker for backup destination, "Backup now" button, progress indicator
- Backend: iterate `books/` and `covers/` dirs, copy missing files to destination using the same relative path structure
- Incremental: skip files where destination has same name + size
- Store `backup_destination` and `last_backup_at` in settings table

### Phase 2 — Auto-backup

- Toggle in settings (default off): "Automatically back up when library changes"
- After `import_book` or `delete_book`, trigger an incremental backup in the background
- For deletes: optionally remove the file from backup destination (or leave it — safer default)
- Debounce: if multiple imports happen in quick succession, batch into one backup pass

## Verification

- [ ] Pick a NAS share as destination → "Backup now" → all book files + covers appear at destination
- [ ] Import a new book → auto-backup copies it to destination within seconds
- [ ] Re-run backup with no changes → completes instantly (incremental skip)
- [ ] Destination folder is offline/unmounted → clear error message, no crash
- [ ] Unset destination → auto-backup stops, manual button disabled
- [ ] Large library (100+ books) → progress indicator updates, no UI freeze
