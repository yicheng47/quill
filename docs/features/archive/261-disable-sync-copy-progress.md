# 261 - Disable Sync Copy-to-Local Progress

GitHub issue: https://github.com/yicheng47/quill/issues/265

## Motivation

Stopping iCloud sync on desktop currently performs a potentially large copy-back from the iCloud container into local app storage. That work can involve many books/covers and iCloud-evicted placeholder files. Without a visible progress flow, the operation looks stuck; if placeholders are encountered, the current path triggers downloads but then fails, forcing the user to retry manually.

Users need a clear, deliberate "copy files to this Mac" disable path that explains what is happening, keeps the UI responsive, and treats evicted iCloud files as work to localize rather than an immediate hard failure.

## Scope

Add an explicit disable-sync flow for "copy files to this Mac."

In scope:

- Disable confirmation copy that makes clear Quill will copy the iCloud library back to local storage before turning sync off.
- Blocking progress UI while files are being localized/copied, with current/total progress and a short status label.
- Backend progress events for the copy-back operation, separate from replay's `sync-progress` events.
- Placeholder handling that triggers iCloud downloads for evicted files and keeps the copy-back operation waiting/retrying while progress remains visible.
- Preserve the current safety invariant: sync is not marked off and `data_dir` is not repointed local until required book/cover files are present locally.
- Clear error if iCloud cannot materialize required files after a bounded wait/retry period.

Out of scope:

- "Stop syncing but keep files in iCloud" fast path. That requires decoupling sync intent from blob storage location and should be a separate feature.
- Deleting iCloud data after disabling sync.
- Background copy-back that lets the user continue using the app while storage is partially localized.

## Implementation Phases

1. Add a backend copy-back progress model.
   - Count copy-back work across iCloud `books/` and `covers/`, ignoring non-library metadata directories.
   - Emit `sync-disable-progress` events with phase, copied count, total count, and current file name/path.
   - Replace direct `copy_dir_contents` calls in `sync_disable` with a progress-aware copy helper.

2. Localize iCloud placeholders during copy-back.
   - Detect `.icloud` placeholder entries.
   - Trigger download for their real file paths.
   - Wait/retry for the real file to materialize instead of failing immediately.
   - If files remain placeholders after the bounded wait, return a clear error and leave sync enabled.

3. Add blocking settings UI.
   - When disabling sync, show a modal that cannot be dismissed while copy-back is active.
   - Show progress percentage, copied/total count, and the current phase.
   - Keep the existing top-row busy state for the toggle.
   - On completion, refresh sync status and close the modal.
   - On error, close progress and show the existing retryable error UI.

4. Update copy text.
   - Disable confirmation should say the library will be copied to this Mac first.
   - Progress modal should make clear iCloud may need to download evicted files before copying.

## Verification

- Enable sync, then disable with all iCloud files local: progress reaches 100%, sync turns off, `data_dir` points local, books/covers open.
- Disable with one or more evicted iCloud files: Quill triggers downloads, progress remains visible, and disable completes once files materialize.
- If iCloud cannot materialize a file within the bounded wait, disable returns an error, sync remains enabled, and `data_dir` remains iCloud.
- Large library: progress updates steadily and settings UI does not appear frozen.
- Re-run disable after a partial previous copy: already-local files are skipped or counted as complete, and remaining files copy correctly.
