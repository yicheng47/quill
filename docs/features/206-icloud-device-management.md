# 206 — iCloud Device Management

**GitHub Issue:** https://github.com/yicheng47/quill/issues/206

## Motivation

Desktop Quill's iCloud sync settings show every device that has ever registered in the shared iCloud container under "Other devices," but there's no way to remove one. Uninstalled apps, prior installs that re-registered after a reinstall, and wiped Macs all leave their manifest + log + snapshot behind indefinitely — the user has no UI path to clean them up.

The iOS app already shipped this: a trash button per peer row with a confirmation alert, backed by `Sync.removePeer(deviceUUID:)` that deletes the peer's three files (`<uuid>.json` manifest, `<uuid>.jsonl` log, `<uuid>.snapshot.json`) from the shared folder. This spec brings the same affordance to desktop, matching the iOS copy and behavior.

Also fits cleanly with the per-device event-log model (spec 31): peers are just files in the shared folder, so "remove device" is a bounded file-delete operation with no distributed coordination required.

## Scope

### In scope

- **Backend `delete_peer`** in `src-tauri/src/sync/peers.rs` — deletes the manifest, `<uuid>.jsonl` log, and `<uuid>.snapshot.json` for a given device UUID. Idempotent (no error when files are already absent). Refuses to delete self (early return, not an error — matches iOS guard).
- **Tauri command `sync_remove_peer(device_uuid)`** in `src-tauri/src/commands/sync.rs`, registered in `lib.rs`. Resolves shared dir via the same path the existing `sync_status` command uses. Returns `AppResult<()>`.
- **Trash button per peer row** in `src/components/settings/LibrarySyncSettings.tsx`. Disabled while `busy`. Self does not appear in the peer list (backend filters), so no self-delete guard is needed in UI.
- **Confirmation modal** — destructive action styling, matches the existing Modal primitive used elsewhere in settings. Copy mirrors iOS: names the device, explains what gets deleted (iCloud files for that device only), what's preserved (local books), and that the peer will reappear if it opens Quill again.
- **i18n keys** added to `src/i18n/en.json` and `src/i18n/zh.json` under `settings.librarySync.*`.
- **Status refresh** after successful removal so the row disappears immediately.

### Out of scope

- **Bulk "clear all stale peers" action.** Per-row is enough; stale peers are rare.
- **Automatic pruning by `lastSeen` age.** Explicit user action only.
- **iOS changes.** Already shipped.
- **Removing the device's binary assets** (`books/<id>.epub`, `covers/<id>.jpg`). Those are shared across all devices in the folder — not per-peer — so peer removal must not touch them.
- **Undo.** Once files are deleted from iCloud, they're gone. The peer can re-register by launching Quill on that device again; no undo needed.

## Key decisions

- **Three files, not two.** iOS's `Peers.deletePeer` covers manifest + log + snapshot. Desktop must match exactly — missing either the log or snapshot leaves orphan data that confuses replay on other peers. The names are:
  - `devices/<uuid>.json` — manifest
  - `logs/<uuid>.jsonl` — event log
  - `logs/<uuid>.snapshot.json` — compacted snapshot (may or may not exist)
- **Idempotent file delete.** Use `fs::remove_file` and swallow `ErrorKind::NotFound`. Any other I/O error propagates as `AppError`.
- **Self-guard in backend, not UI.** UI already doesn't render the self row (backend `list_peers` filters it), but add a defensive early-return in `delete_peer` so a caller with a stale UUID can't accidentally nuke their own data. Matches iOS (`guard deviceUUID != selfDevice else { return }`).
- **Confirmation is required.** Single-click destructive actions are a footgun; match iOS's alert dialog pattern with a separate Modal.
- **Copy is translated literally from iOS.** Don't rewrite — consistency across platforms matters more than a cleverer line.
- **No loading state on the trash button itself** — the operation is fast (three file deletes), and the modal is already the user's indication that something is happening. The whole settings panel's existing `busy` state disables the button during the call, which is enough.

## Implementation Phases

### Phase 1 — Backend

1. Add `delete_peer(shared_dir: &Path, device_uuid: &str, own_uuid: &str) -> AppResult<()>` to `src-tauri/src/sync/peers.rs`. Early-return if `device_uuid == own_uuid`. Compute the three paths; for each, `fs::remove_file` and swallow `NotFound`.
2. Add `#[tauri::command] pub fn sync_remove_peer(device_uuid: String, sync_state: State<'_, SyncState>) -> AppResult<()>` to `src-tauri/src/commands/sync.rs`. Resolve shared dir via the same helper used by `sync_status`; resolve own UUID from the device module. Call `peers::delete_peer`. Return `Ok(())`.
3. Register `sync_remove_peer` in `src-tauri/src/lib.rs` tauri builder.
4. Unit tests in `peers.rs`:
   - Deletes all three files when present.
   - Deletes when only some files exist (partial prior cleanup).
   - No-op on self UUID.
   - No error when files already absent (idempotent retry).
   - Subsequent `list_peers` call does not include the removed UUID.

### Phase 2 — Frontend

1. Add trash-icon button to each peer row in `LibrarySyncSettings.tsx`. Use `lucide-react` `Trash2`.
2. State: `pendingRemoval: PeerInfo | null`. Clicking trash sets it.
3. Confirmation Modal rendered when `pendingRemoval !== null`. Two buttons: Cancel (clears state) and Remove (destructive). On Remove: `await invoke("sync_remove_peer", { deviceUuid: pendingRemoval.device_uuid })`, then re-fetch status, then clear `pendingRemoval`. Surface errors via the existing error-handling path for this settings panel.
4. New i18n keys (add to both `en.json` and `zh.json`):
   - `settings.librarySync.removeDevice` — "Remove device" (button aria-label / tooltip)
   - `settings.librarySync.removeDeviceTitle` — "Remove {{name}} from sync?"
   - `settings.librarySync.removeDeviceBody` — "This device's log, snapshot, and manifest in iCloud will be deleted. Any books already synced to this device are kept. The other device will reappear here if it opens Quill again and re-registers."
   - `settings.librarySync.remove` — "Remove"
   - `settings.librarySync.cancel` — "Cancel" (reuse an existing common cancel key if one exists)

### Phase 3 — Polish

- Verify button alignment matches the rest of the peer row on both light and dark themes.
- Verify modal close on Escape and on backdrop click (whatever the Modal primitive already does).
- Smoke test with a real multi-device iCloud shared folder: create a fake peer manifest/log, confirm removal wipes all three files.

## Verification

- [ ] Trash button appears on every peer row in "Other devices." Self is not listed (pre-existing backend behavior), so self-delete is not reachable from UI.
- [ ] Clicking trash opens a confirmation modal showing the peer's name.
- [ ] Confirming deletes the peer's manifest (`devices/<uuid>.json`), log (`logs/<uuid>.jsonl`), and snapshot (`logs/<uuid>.snapshot.json`) from the iCloud shared folder.
- [ ] The peer row disappears after confirmation (status is refreshed).
- [ ] Binary assets (`books/`, `covers/`) are untouched.
- [ ] Calling `sync_remove_peer` again on an already-removed UUID returns Ok (idempotent).
- [ ] If the removed device opens Quill again, it re-registers and reappears in the list.
- [ ] The call refuses to touch self — if tested directly via invoke with the local device_uuid, it returns Ok without deleting anything.
- [ ] Both English and Chinese translations render correctly (confirmation title, body, buttons, trash tooltip).
- [ ] No new console errors or Rust warnings from `cargo check`.
- [ ] Existing unit tests still pass (`cargo test -p quill`).
