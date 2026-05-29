# 246 — Download Feedback for iCloud-Evicted Books

Issue: https://github.com/yicheng47/quill/issues/246

## Problem

When a user enables sync on a fresh device, book metadata arrives quickly via the event log, but the binaries (cover images, EPUB/PDF files) live in the iCloud Documents container and arrive as evicted placeholders (`.‹name›.icloud`). Two symptoms follow.

**1. The library grid shows blank cover cards that never fill in on their own.** This is the live bug. Covers already sync correctly at the data layer — `ingest_peer_covers` (`src-tauri/src/sync/replay.rs`) runs every replay tick, eagerly triggers `startDownloadingUbiquitousItemAtURL` for any evicted `covers/‹id›.img` placeholder, and on a later tick reads the materialized bytes into the `cover_data` BLOB. The frontend renders covers from that BLOB. The gap is purely the refresh signal: only the **initial** sync tick emits a frontend event (`sync-initial-tick-done`), and covers are almost never ingested on that first tick — they're still placeholders that were *just* triggered for download. They land on subsequent **watcher** ticks, and watcher ticks emit nothing. So the grid keeps showing title-only placeholder cards until the user manually navigates or relaunches, even though the covers are sitting in the DB.

**2. Opening a not-yet-downloaded book shows an indeterminate spinner with no progress.** `check_book_available` (`books.rs`) triggers the download and `Reader.tsx` polls every 2s, showing a spinner ("Downloading from iCloud…") with a 60s timeout. It works, but gives no sense of how long the wait will be.

### Scope decision

- **Fix symptom 1 now** — small, high-value, fixes the headline complaint.
- **Defer symptom 2's progress bar.** A real percentage is only obtainable from `NSMetadataQuery` + `NSMetadataUbiquitousItemPercentDownloadedKey`: iCloud materializes an evicted file atomically (placeholder → full file in one swap), so there's no partial file on disk to measure, and `NSURL` resource keys expose only a binary downloading *status*, not a percent. Bridging `NSMetadataQuery` from Rust needs a notification observer on a thread with a live run loop — meaningful `unsafe` objc2 work for a download that's usually only seconds long, where the spinner already covers the case. Documented in "Deferred" below so the design isn't lost.

## Fix

Emit a frontend event whenever a replay tick ingests one or more covers, and refresh the library grid when it fires. Because the grid renders from the `cover_data` BLOB and `list_books` already selects that column, a plain refresh re-renders the covers — no new query or data path needed.

### Backend

**`ReplayEngine` holds an optional `AppHandle`** (`src-tauri/src/sync/replay.rs`). This is deliberately separate from the `app_handle` parameter already threaded into `tick_with_progress`: that parameter drives the `sync-progress` modal and is `None` for watcher ticks (per the 236 design, watcher ticks are silent for the modal). Covers land precisely *on* watcher ticks, so the cover event must come from a handle the engine owns, independent of the modal path.

```rust
pub struct ReplayEngine {
    pub shared_dir: PathBuf,
    pub self_device: String,
    pub own_log: Arc<EventLog>,
    app_handle: Option<tauri::AppHandle>,   // NEW — for non-modal emits
    cancelled: std::sync::atomic::AtomicBool,
}

impl ReplayEngine {
    // `new` keeps its current signature (tests construct it with no handle).
    pub fn with_app_handle(mut self, handle: tauri::AppHandle) -> Self {
        self.app_handle = Some(handle);
        self
    }
}
```

In `tick_with_progress`, after the existing `ingest_peer_covers` call, emit when it ingested anything:

```rust
let covers_ingested = ingest_peer_covers(&self.shared_dir, db);
if covers_ingested > 0 {
    if let Some(handle) = &self.app_handle {
        let _ = handle.emit("sync-covers-ingested", covers_ingested);
    }
}
```

`ingest_peer_covers` itself is unchanged — it already returns the count and already triggers placeholder downloads.

**Set the handle at both engine construction sites:**

- `boot_sync_engine` (`src-tauri/src/lib.rs`) — has `app_handle: &tauri::AppHandle`; build with `ReplayEngine::new(...).with_app_handle(app_handle.clone())`.
- `sync_enable` (`src-tauri/src/commands/sync.rs`) — has `app: tauri::AppHandle`; same.

### Frontend

**`Home.tsx`** — add a listener mirroring the existing debounced `mcp:books-changed` handler. Covers fill in over a few watcher ticks, so debounce coalesces the burst into one reload.

```ts
useEffect(() => {
  let debounce: ReturnType<typeof setTimeout> | null = null;
  const unlisten = listen("sync-covers-ingested", () => {
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => refreshRef.current(), 500);
  });
  return () => {
    if (debounce) clearTimeout(debounce);
    unlisten.then((fn) => fn());
  };
}, []);
```

Only the book list needs refreshing — cover ingestion changes no counts or collections, so this does not call the counts/collections refreshers.

No i18n changes (no new user-facing strings) and no Reader changes (the spinner stays).

### Tests

`src-tauri/src/sync/replay.rs` — add a focused test for `ingest_peer_covers` (currently untested): seed a book row with `NULL cover_data`, write `covers/‹id›.img`, assert the BLOB is populated and the return count is 1; and a placeholder-only case returns 0 (download is triggered, ingestion deferred to the next tick). The emit path isn't unit-tested — `AppHandle` isn't constructible in unit tests, and the engine is built with no handle there, so the emit is simply skipped.

## Deferred — book download progress bar (symptom 2)

Sketch for a future pass, not built here:

- Enable `objc2-foundation` features `NSMetadata`, `NSNotification`, `NSPredicate` (`block2` is already on).
- On book open, start one `NSMetadataQuery` scoped to `NSMetadataQueryUbiquitousDataScope`, predicate matched to the file name, on a thread with a running `CFRunLoop`.
- Observe `NSMetadataQueryDidUpdateNotification` (block-based observer), read `NSMetadataUbiquitousItemPercentDownloadedKey`, emit `book-download-progress { book_id, percent }`.
- Tear the query down on completion, timeout, or reader-window close.
- Reader replaces the indeterminate spinner with a determinate bar driven by the event.

## Verification

1. Fresh device, enable sync with a multi-book library: books appear with blank cover cards, then covers fill in automatically within a tick or two — no manual navigation/relaunch.
2. `sync-progress` modal still behaves as before (no regression from the new engine field).
3. `cargo test` passes, including the new `ingest_peer_covers` test.
4. Local-only (sync off) and single-device users see no behavior change.
