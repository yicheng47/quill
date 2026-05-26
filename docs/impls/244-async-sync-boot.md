# 244 — Async Sync Boot

PR: https://github.com/yicheng47/quill/pull/244

## Problem

`boot_sync_engine` runs in `setup()` on the main thread. It touches iCloud paths (`EventLog::open`, `watcher::spawn`, initial tick) that can stall for seconds when files are evicted or `bird` daemon is busy. This blocks the Tauri webview from rendering → white screen on launch.

## Solution

Move all iCloud I/O to a background thread. `setup()` registers `SyncState::new(None, None)` immediately and returns. A `sync-boot` thread calls `boot_sync_engine` which opens the log, creates the engine, spawns the watcher, wires the writer, and kicks off the initial tick.

## Sync Architecture Overview

The sync engine uses an **event-sourced CRDT** model over iCloud:

### Data flow

```
User action → SQL write + outbox insert (local, fast)
                    ↓
           Background flush → append to device JSONL log (iCloud)
                    ↓
           Peer reads log → replay events → merge into local SQL
```

### Key concepts

- **Event log** (`<device>.jsonl`): append-only JSONL file per device in iCloud. Every mutation (import, highlight, progress update) is serialized as an event.
- **Snapshot** (`<device>.snapshot.json`): periodic compaction of the event log. Contains the full materialized state for one device. Peers use it to bootstrap without replaying the entire log history.
- **Watermarks** (`_replay_state` table): per-peer `last_event_id` tracking which events have been applied. Prevents re-applying old events.
- **Outbox** (`_pending_publish` table): events that were committed to SQL but haven't been flushed to the iCloud log yet. Drained by `flush_outbox` on each tick.
- **Tombstones** (`_tombstones` table): records of deleted entities. Prevents a peer snapshot from re-inserting a deleted book.
- **LWW merge** (last-writer-wins): conflicts are resolved by `(updated_at, updated_by_device)` tuple comparison. The newer write wins.

### Tick phases

Each replay tick runs five phases:

0. **Flush outbox** — drain `_pending_publish` into the device log (batched, one `NSFileCoordinator` call)
1. **Discover peers** — scan `<shared>/logs/` for peer log/snapshot files
2. **Read** — read peer snapshots and logs from disk (with 30s timeout, iCloud placeholder detection)
3. **Apply** — snapshots applied per-peer (one tx each), events sorted by `(ts, device)` and applied one-at-a-time with per-event watermark advance
4. **Housekeeping** — update own manifest, run compaction if thresholds met

### Write path

```
Command (import_book, add_highlight, etc.)
  → SyncWriter.with_tx()
    → SQL write + outbox insert (one transaction, fast)
    → Background thread: flush_outbox → append to iCloud log
```

The user gets instant response. iCloud I/O is fire-and-forget.

## Writes During Boot

While the boot thread is running, `SyncWriter` is already in queue-only mode (`should_queue = true`). Any user writes safely queue into `_pending_publish`. The first successful tick after boot drains them.

## Quit During Sync

Safe by design. Watermarks advance per-event, so the next launch resumes from the last committed event. Outbox rows survive in SQLite. The EventLog skips malformed trailing lines from interrupted writes.

## Frontend

`LibrarySyncSettings` listens for `sync-status-changed` and refreshes `sync_status` when the background boot completes, so the UI transitions from "paused" to "active".
