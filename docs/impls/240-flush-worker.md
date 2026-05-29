# 240 — Dedicated Flush Worker Thread

Issue: https://github.com/yicheng47/quill/issues/240

## Problem

`SyncWriter::with_tx` runs a post-commit step that drains the `_pending_publish` outbox into the device log (`flush_outbox`). When sync is enabled it does this by **spawning a fresh `std::thread` per call** (`src-tauri/src/sync/writer.rs`, Phase 2):

```rust
if let Some(log) = log_snapshot {
    if self.flush_inline_for_tests.load(Ordering::SeqCst) {
        // inline (tests only)
    } else {
        let db = db.clone();
        std::thread::spawn(move || {        // ← one thread per write
            let _ = replay::flush_outbox(&db, &log);
        });
    }
}
```

The spawn is gated only on the log being open — there is **no `events.is_empty()` guard**. So it fires on *every* mutating command while sync is on, including transactions that queued nothing. The hot path is ordinary reading: `update_reading_progress` runs on every page turn and always writes SQL inside `with_tx`. The 2-second `should_emit_progress` throttle only decides whether a `BookProgressSet` event is *queued*; it does not gate the thread. So fast paging spawns one flush thread per turn, most of which lock `FLUSH_OUTBOX_MUTEX`, read an empty outbox, and exit.

This is **correct** — `FLUSH_OUTBOX_MUTEX` (single-flight) plus delete-after-append make `flush_outbox` exactly-once, so redundant drains are harmless no-ops. The cost is pure overhead: repeated thread create/teardown and lock contention during write bursts (batch import, rapid page turns). It is not a leak — the threads are short-lived and serialized by the mutex, so they never pile up. Bounded, but wasteful.

## Fix

Replace the per-write spawn with **one long-lived flush worker** that `with_tx` signals over a channel. The channel buffer coalesces a burst of signals into a single drain.

This mirrors the existing `cover-writer` thread exactly (`spawn_cover_writer` / `set_cover_tx`), including its lifecycle: spawned when sync turns on, torn down when sync turns off, re-spawned on re-enable. Because the worker is recreated per enable, it can capture the current `EventLog` directly — no need to make the log field shareable.

### `SyncWriter` (`src-tauri/src/sync/writer.rs`)

New field + setter, parallel to `cover_tx`:

```rust
/// Signal channel to the long-lived `sync-flush` worker. `Some` while
/// sync is enabled. A unit send means "outbox may be dirty — drain it."
flush_tx: Mutex<Option<mpsc::Sender<()>>>,

pub fn set_flush_tx(&self, tx: Option<mpsc::Sender<()>>) {
    *self.flush_tx.lock().expect("flush_tx mutex") = tx;
}
```

The worker — one thread, captures `db` + the current `log`, drains on each signal and coalesces backlog:

```rust
pub fn spawn_flush_worker(&self, db: Db, log: Arc<EventLog>) {
    let (tx, rx) = mpsc::channel::<()>();
    std::thread::Builder::new()
        .name("sync-flush".into())
        .spawn(move || {
            // Block for a signal, collapse any that piled up while busy,
            // then drain once. flush_outbox is exactly-once, so an extra
            // coalesced drain is a cheap no-op.
            while rx.recv().is_ok() {
                while rx.try_recv().is_ok() {}
                if let Err(e) = replay::flush_outbox(&db, &log) {
                    log::warn!("sync: flush worker drain failed: {e}");
                }
            }
        })
        .ok();
    self.set_flush_tx(Some(tx));
}
```

The worker exits when the sender is dropped (`set_flush_tx(None)` on disable, or replacement on re-enable) — `rx.recv()` returns `Err`.

`with_tx` Phase 2 becomes a non-blocking signal:

```rust
if self.flush_inline_for_tests.load(Ordering::SeqCst) {
    // Tests drain synchronously so asserts don't race a worker.
    if let Some(log) = log_snapshot {
        if let Err(e) = replay::flush_outbox(db, &log) {
            log::warn!("sync: post-commit outbox flush failed: {e}");
        }
    }
} else if let Ok(guard) = self.flush_tx.lock() {
    // Production: poke the persistent worker. If no worker is running
    // (queue-only mode, sync off), the row stays durable in
    // _pending_publish and the next signal or replay tick drains it —
    // same guarantee the old per-write spawn had when iCloud was down.
    if let Some(tx) = guard.as_ref() {
        let _ = tx.send(());
    }
}
```

### Lifecycle wiring

- **Boot** (`boot_sync_engine`, `src-tauri/src/lib.rs`) — after `set_log` + `spawn_cover_writer`, add `sync_writer.spawn_flush_worker(db.clone(), Arc::clone(&log))`.
- **Enable** (`sync_enable`, `src-tauri/src/commands/sync.rs`) — same, after `spawn_cover_writer` / `backfill_cover_files`.
- **Disable** (`sync_disable`) — add `set_flush_tx(None)` next to the existing `set_cover_tx(None)`, and in the race-cleanup sweep alongside `set_log(None)`.
- **MCP** (`mcp_stdio_main`) — unchanged. The MCP subprocess is queue-only (no `set_log`, no engine), so it never spawned flush threads and needs no worker; the main app's replay tick drains its outbox rows.

### Tests

`writer.rs` — existing tests use `flush_inline_for_tests`, so they keep exercising the inline drain unchanged. Add one test that exercises the real worker: spawn it (inline off), run a `with_tx` that queues an event, and poll until the outbox empties and the event reaches the log — proving the signal→coalesce→drain path works end to end.

## Out of scope

- The `should_emit_progress` throttle and the 2s coalescing of `BookProgressSet` events — unchanged; this only touches *how* the drain is scheduled, not *what* gets published.
- Any change to `flush_outbox` itself or `FLUSH_OUTBOX_MUTEX`.

## Verification

1. `cargo test sync::` passes, including the new worker test.
2. Reading a book (many fast page turns) with sync on spawns no per-turn threads — the single `sync-flush` worker handles all drains.
3. Enable → disable → re-enable leaves exactly one `sync-flush` worker running while enabled, and none after disable.
4. A write made while iCloud is transiently unreachable still reaches peers on the next successful drain (durability unchanged).
