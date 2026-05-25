# 236 — Sync Progress Indicator

GitHub Issue: https://github.com/yicheng47/quill/issues/236

## Motivation

First sync on a new device with a large iCloud library (500+ books) shows no progress — the app appears frozen or crashed. Users delete the app data thinking it's broken, which triggers re-migration from iCloud and makes the problem worse. The sync engine processes events in the background but gives zero UI feedback.

## Scope

### In scope

- **Modal overlay during initial sync**: when the background initial tick applies peer events, show a blocking modal with a progress bar ("Syncing library... 47/500 books"). Nothing to browse on a fresh device anyway — honest progress sets correct expectations.
- **Backend progress events**: the initial tick emits `sync-progress` Tauri events with `{ applied, total }` counts as it processes peer events. The total is known after Phase B (snapshot apply + event filtering), before Phase C (per-event application).
- **Completion transition**: modal dismisses when the tick finishes, frontend refreshes the library, and books appear immediately.
- **Error handling**: if the tick fails mid-way, dismiss the modal with a brief error toast. Partial progress is preserved (watermarks are per-event), and the next tick resumes.

### Out of scope

- Progress for iCloud file downloads (Apple's daemon, no per-file tracking API)
- Cancel/pause sync
- Per-book detail within the sync progress
- Progress bar for incremental watcher ticks (fast, don't need UI)

## Implementation Phases

### Phase 1 — Backend: emit progress events

Modify `ReplayEngine::apply_in_tx` Phase C to emit `sync-progress` events via the `AppHandle`. Pass the handle into `boot_sync_engine`'s background thread (already done for `sync-initial-tick-done`).

Event shape:
```json
{ "applied": 47, "total": 500 }
```

Emit after each successful event apply. The `total` count comes from the filtered+sorted event list built in Phase B.

Also emit a `sync-initial-tick-start` event with `{ "total": N }` before Phase C begins, so the frontend knows to show the modal (only when `total > 0`).

### Phase 2 — Frontend: sync progress modal

- Listen for `sync-initial-tick-start` in `Home.tsx`. When `total > 0`, show a modal overlay with a progress bar.
- Update the progress bar on each `sync-progress` event.
- Dismiss on `sync-initial-tick-done` (already emitted) and refresh the library.
- Style: centered modal with the Quill logo, progress bar, and "Syncing library... N/M books" text. Same visual language as the existing import overlay.

### Phase 3 — Polish

- Skip the modal for small syncs (e.g., `total < 10` — fast enough to not need it).
- Add a brief fade-out animation on dismiss.
- Show elapsed time if sync takes longer than 5s.

## Verification

- Import 500 books on device A, enable sync, launch device B fresh → modal appears with progress, completes, library shows all books.
- Import 5 books on device A → device B syncs silently (below threshold), no modal.
- Kill the app mid-sync, relaunch → modal reappears, resumes from last watermark.
- Sync with no peer changes → no modal shown.
