//! `ReplayEngine::tick()` — the converge step.
//!
//! Five phases per call:
//! 0. **Drain `_pending_publish`.** Any events the local `SyncWriter`
//!    committed to SQL but failed to append to the device log get
//!    appended here — as a single batched write (one `NSFileCoordinator`
//!    call) instead of per-event. Until they're in the log, peers don't
//!    see them — so this is the publish-retry path that bounds Step 3's
//!    commit-then-flush failure asymmetry.
//! 1. **Discover peers.** Walk `<shared>/logs/*.{jsonl,snapshot.json}` and
//!    bucket by device UUID. The local device is included — its snapshot
//!    is what pulls conflict-copy rows back into local SQL during migration
//!    apply-back, and re-applying its own log events is idempotent.
//! 2. **Read.** For each peer: read snapshot if `_replay_state` says it's
//!    new; read log events with id > `last_event_id` watermark. Peer log
//!    reads have a 30s timeout so iCloud-evicted files don't block
//!    indefinitely — timed-out peers are skipped and retried next tick.
//! 3. **Sort + apply.** Snapshots applied per-peer first (each updates its
//!    own watermarks). Events from every peer merged into one global vec
//!    sorted by `(ts, device)`, then applied one per transaction via the
//!    write connection. The separate read connection (`Db::reader()`)
//!    ensures frontend queries are never blocked by the replay engine.
//! 4. **Commit + advance event watermarks** to the max id seen per peer.
//!
//! Concurrent ticks are serialized by a process-wide mutex; the OS
//! scheduler decides which one runs first, but both produce the same end
//! state because every operation is idempotent.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use rusqlite::{params, Connection};
use tauri::Emitter;

use crate::db::Db;
use crate::error::{AppError, AppResult};

use super::events::{Event, EventBody};
use super::log::{self, EventLog};
use super::merge;
use super::peers;
use super::snapshot::{self, Snapshot};

/// Process-wide lock so two callers don't run `tick` concurrently. The lock
/// is purely for throughput hygiene — concurrent ticks are functionally safe
/// because every operation is idempotent — but they'd duplicate I/O work.
static TICK_MUTEX: Mutex<()> = Mutex::new(());

/// Acquire and immediately release TICK_MUTEX. Used by `sync_disable`
/// to wait for a cancelled tick to finish before starting copy-back.
pub fn tick_mutex_wait() {
    let _guard = TICK_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
}

/// Process-wide lock that serializes `flush_outbox` callers so the
/// outbox drain stays exactly-once. Without it, `SyncWriter::with_tx`'s
/// background flush worker and a concurrent watcher tick could both
/// read the same pending row before either deletes it, then each
/// append the same event to the device log under a fresh ULID — the
/// peer would apply the event twice. Most merges are idempotent (UUID
/// dedup, LWW), but some payload shapes are not safe to publish twice,
/// and even idempotent ones balloon the log. The mutex is entirely
/// outside `db.conn`, so a flush in flight does not block UI writes.
static FLUSH_OUTBOX_MUTEX: Mutex<()> = Mutex::new(());

/// Paths where a timed read stalled (timeout or in-flight). Keyed by
/// canonical path, value is the `Instant` the backoff expires. A path
/// in this set is skipped (no thread spawned) until the backoff
/// elapses. Prevents blocked-thread accumulation when `fs::read`
/// passes the `path.exists()` check but stalls inside the kernel
/// (e.g. iCloud file materialization in progress).
static STALLED_PATHS: Mutex<Option<HashMap<PathBuf, Instant>>> = Mutex::new(None);

/// Paths that currently have a reader thread blocked on `fs::read`.
/// Checked before spawning a new reader — if the previous thread is
/// still alive (timed out but not yet returned), we skip instead of
/// accumulating another blocked OS thread.
///
/// The spawned thread clears its entry via `on_thread_done` when
/// `fs::read` returns, regardless of success or error. On timeout the
/// entry stays set, preventing a duplicate thread until the original
/// completes. Combined with `STALLED_PATHS` backoff, this bounds
/// blocked threads to at most one per path.
static IN_FLIGHT: Mutex<Option<HashSet<PathBuf>>> = Mutex::new(None);

const STALL_BACKOFF: std::time::Duration = std::time::Duration::from_secs(120);

fn is_stalled(path: &Path) -> bool {
    let guard = STALLED_PATHS.lock().unwrap_or_else(|e| e.into_inner());
    match guard.as_ref() {
        Some(map) => map.get(path).is_some_and(|exp| Instant::now() < *exp),
        None => false,
    }
}

fn mark_stalled(path: &Path) {
    let mut guard = STALLED_PATHS.lock().unwrap_or_else(|e| e.into_inner());
    let map = guard.get_or_insert_with(HashMap::new);
    map.insert(path.to_path_buf(), Instant::now() + STALL_BACKOFF);
}

fn clear_stalled(path: &Path) {
    let mut guard = STALLED_PATHS.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(map) = guard.as_mut() {
        map.remove(path);
    }
}

fn is_in_flight(path: &Path) -> bool {
    let guard = IN_FLIGHT.lock().unwrap_or_else(|e| e.into_inner());
    guard.as_ref().is_some_and(|set| set.contains(path))
}

fn mark_in_flight(path: &Path) {
    let mut guard = IN_FLIGHT.lock().unwrap_or_else(|e| e.into_inner());
    let set = guard.get_or_insert_with(HashSet::new);
    set.insert(path.to_path_buf());
}

fn clear_in_flight(path: &Path) {
    let mut guard = IN_FLIGHT.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(set) = guard.as_mut() {
        set.remove(path);
    }
}

/// What `tick()` did, surfaced for the "Sync now" UI and for tests.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ReplayReport {
    pub outbox_flushed: usize,
    pub snapshots_applied: usize,
    pub events_applied: usize,
    pub peers_seen: usize,
}

#[derive(Clone, serde::Serialize)]
struct SyncProgress {
    applied: usize,
    total: usize,
}

pub struct ReplayEngine {
    pub shared_dir: PathBuf,
    pub self_device: String,
    /// Own log handle, shared with `SyncWriter`. `tick()` writes here when
    /// flushing the outbox.
    pub own_log: Arc<EventLog>,
    /// Set to `true` by `cancel()` to abort an in-flight tick early.
    /// Checked between events in Phase C so a `sync_disable` doesn't
    /// have to wait for a long replay to finish.
    cancelled: std::sync::atomic::AtomicBool,
}

impl ReplayEngine {
    pub fn new(shared_dir: PathBuf, self_device: String, own_log: Arc<EventLog>) -> Self {
        Self {
            shared_dir,
            self_device,
            own_log,
            cancelled: std::sync::atomic::AtomicBool::new(false),
        }
    }

    /// Signal any in-flight tick to stop after the current event.
    pub fn cancel(&self) {
        self.cancelled.store(true, std::sync::atomic::Ordering::SeqCst);
    }

    fn is_cancelled(&self) -> bool {
        self.cancelled.load(std::sync::atomic::Ordering::SeqCst)
    }

    /// Run a single replay pass.
    ///
    /// Takes `&Db` rather than `&mut Connection` so the SQLite mutex
    /// can be released around the slow iCloud I/O — `flush_outbox`,
    /// `write_own_manifest`, and `compact_own_log` all hit
    /// `NSFileCoordinator`, and holding `db.conn` across those waits
    /// previously serialized every UI write (`import_book` etc.)
    /// behind the watcher's tick.
    pub fn tick(&self, db: &Db) -> AppResult<ReplayReport> {
        self.tick_with_progress(db, None)
    }

    /// Like `tick` but emits `sync-progress` events via the provided
    /// AppHandle so the frontend can show a progress indicator during
    /// the initial sync. Watcher ticks pass `None` (silent).
    pub fn tick_with_progress(
        &self,
        db: &Db,
        app_handle: Option<&tauri::AppHandle>,
    ) -> AppResult<ReplayReport> {
        let _guard = TICK_MUTEX
            .lock()
            .map_err(|e| AppError::Other(format!("replay tick mutex poisoned: {e}")))?;

        self.cancelled.store(false, std::sync::atomic::Ordering::SeqCst);
        let started = std::time::Instant::now();

        if let Some(handle) = app_handle {
            let _ = handle.emit("sync-progress", SyncProgress { applied: 0, total: 0 });
        }

        // Phase 0 — drain the outbox into the device log. Manages its
        // own per-row locking; the slow `log.append` runs without
        // holding `db.conn`. Failures surface to the caller; peers
        // will see the local writes on the next successful tick.
        let outbox_flushed = flush_outbox(db, &self.own_log)?;

        // Phase 1 — discover peers (including self). Pure fs read.
        let peers = discover_peers(&self.shared_dir)?;
        let peers_seen = peers.len();

        ::log::info!(
            "sync: handshake peers={peers_seen} self={self_device}",
            self_device = self.self_device,
        );

        // Phase 2/3/4 — read peer files (no SQL lock), then apply in
        // one tx. The disk I/O for snapshots and peer logs lives
        // inside `apply_in_tx`'s "Phase A" so an iCloud-stalled or
        // large peer file does not stall any concurrent UI writes
        // behind the watcher tick. The PRAGMA wrap also lives inside
        // `apply_in_tx` so any error path still restores FK = ON.
        let (snapshots_applied, events_applied) =
            self.apply_in_tx(db, &peers, app_handle).inspect_err(|e| {
                ::log::error!("sync: batch apply failed: {e}");
            })?;

        if events_applied > 0 || snapshots_applied > 0 || outbox_flushed > 0 {
            ::log::info!(
                "sync: batch applied events={events_applied} snapshots={snapshots_applied} outbox_flushed={outbox_flushed} elapsed_ms={}",
                started.elapsed().as_millis(),
            );
        }

        // Stamp self's `_replay_state.updated_at` so the settings
        // UI's "Last sync" reflects every successful tick — not only
        // the ones that happened to move a peer watermark. A no-op
        // `sync_now` click (no peer changes, no outbox drain) still
        // proves the engine is healthy, and the UI deserves to show
        // that. Upserts a NULL-watermark self row on first call.
        {
            let conn = db
                .conn
                .lock()
                .map_err(|e| AppError::Other(format!("db conn mutex: {e}")))?;
            let now = chrono::Utc::now().timestamp_millis();
            conn.execute(
                "INSERT INTO _replay_state (peer_device, last_snapshot_id, last_event_id, updated_at)
                 VALUES (?1, NULL, NULL, ?2)
                 ON CONFLICT(peer_device) DO UPDATE SET updated_at = excluded.updated_at",
                params![self.self_device, now],
            )?;
        }
        // db.conn released — heartbeat and compaction below run on
        // iCloud without blocking concurrent UI writes.

        // Refresh own peer manifest's `last_seen` so other devices see
        // us as currently active. A failed heartbeat is non-fatal — peers
        // just see a stale `last_seen` until the next tick rewrites it.
        if let Err(e) = peers::write_own_manifest(
            &self.shared_dir,
            &self.self_device,
            &peers::device_name(),
            peers::current_platform(),
            env!("CARGO_PKG_VERSION"),
            chrono::Utc::now().timestamp_millis(),
        ) {
            ::log::warn!("sync: peer manifest refresh failed: {e}");
        }

        // Background compaction. Cheap probe; only runs the full
        // fold-and-truncate when one of the size/age thresholds trips.
        // Failures are non-fatal — the next tick will retry and the log
        // simply grows in the meantime.
        if snapshot::should_compact(&self.shared_dir, &self.self_device) {
            match snapshot::compact_own_log(&self.shared_dir, &self.own_log) {
                Ok(report) if report.snapshot_written => ::log::info!(
                    "sync: compacted own log — {} events folded, {} bytes freed",
                    report.events_folded, report.bytes_freed,
                ),
                Ok(_) => {}
                Err(e) => ::log::warn!("sync: compaction failed: {e}"),
            }
        }

        Ok(ReplayReport {
            outbox_flushed,
            snapshots_applied,
            events_applied,
            peers_seen,
        })
    }

    /// Snapshot apply + log-tail merge.
    ///
    /// Three phases — the conn lock is acquired and released per
    /// operation, same as the rest of the app (import_book, etc.),
    /// so the sync engine never starves frontend reads:
    ///
    /// - **Phase A — read** (no lock): deserialize peer snapshots
    ///   and log files from disk.
    /// - **Phase B — snapshots** (one write tx per peer, then read
    ///   watermarks via reader): apply each peer snapshot in its own
    ///   short-lived write tx, then read watermarks through
    ///   `db.reader()` to filter the event list.
    /// - **Phase C — events** (one tx per event): apply events one
    ///   at a time, advancing watermarks after each. Idempotent
    ///   events + per-event watermark means a crash mid-replay
    ///   resumes cleanly on the next tick.
    fn apply_in_tx(
        &self,
        db: &Db,
        peers: &BTreeMap<String, PeerFiles>,
        app_handle: Option<&tauri::AppHandle>,
    ) -> AppResult<(usize, usize)> {
        // -- Phase A — read everything from disk. No SQL lock held. --
        // Paths that previously timed out are skipped for STALL_BACKOFF
        // (2 min) to avoid spawning another blocked reader thread. Paths
        // with a reader thread still blocked from a prior tick are also
        // skipped (IN_FLIGHT) — at most one OS thread per path.
        let read_timeout = std::time::Duration::from_secs(30);
        let mut snapshots: Vec<(String, Snapshot)> = Vec::new();
        for (device, files) in peers {
            let Some(snap_path) = &files.snap_path else {
                continue;
            };
            if is_stalled(snap_path) || is_in_flight(snap_path) {
                ::log::debug!("sync: skipping stalled/in-flight snapshot {}", snap_path.display());
                continue;
            }
            mark_in_flight(snap_path);
            let snap_path_owned = snap_path.to_path_buf();
            match Snapshot::read_from_with_timeout(
                snap_path, read_timeout, mark_stalled, clear_stalled,
                move || clear_in_flight(&snap_path_owned),
            ) {
                Ok(Some(s)) => snapshots.push((device.clone(), s)),
                Ok(None) => {
                    if !is_stalled(snap_path) {
                        // No thread was spawned (evicted/missing) — clear now.
                        clear_in_flight(snap_path);
                    }
                    // If stalled: thread timed out and is still blocked.
                    // on_thread_done will clear in-flight when fs::read returns.
                }
                Err(e) => {
                    clear_in_flight(snap_path);
                    ::log::warn!(
                        "sync: skipping malformed snapshot {}: {e}",
                        snap_path.display()
                    );
                }
            }
        }
        let mut peer_logs: Vec<(String, Vec<Event>)> = Vec::new();
        for (device, files) in peers {
            let Some(log_path) = &files.log_path else {
                continue;
            };
            if is_stalled(log_path) || is_in_flight(log_path) {
                ::log::debug!("sync: skipping stalled/in-flight log {}", log_path.display());
                continue;
            }
            mark_in_flight(log_path);
            let log_path_owned = log_path.to_path_buf();
            let events = log::read_log_file_with_timeout(
                log_path, read_timeout, mark_stalled, clear_stalled,
                move || clear_in_flight(&log_path_owned),
            )?;
            if events.is_empty() {
                // No thread was spawned (evicted/missing) or read returned
                // empty — clear in-flight. If a thread timed out, on_stall
                // already fired and the thread's on_thread_done will clear
                // in-flight when fs::read eventually returns.
                if !is_stalled(log_path) {
                    clear_in_flight(log_path);
                }
            }
            peer_logs.push((device.clone(), events));
        }

        // -- Phase B — apply snapshots (one write tx per peer). --
        let mut snapshots_applied = 0usize;
        for (device, snap) in &snapshots {
            let mut conn = db
                .conn
                .lock()
                .map_err(|e| AppError::Other(format!("db conn mutex: {e}")))?;
            let tx = conn.transaction()?;
            match snap.apply_peer(&tx, device) {
                Ok(outcome) => {
                    tx.commit()?;
                    if matches!(
                        outcome,
                        super::snapshot::ApplyOutcome::Applied
                            | super::snapshot::ApplyOutcome::HeaderOnly
                    ) {
                        snapshots_applied += 1;
                    }
                }
                Err(e) => {
                    ::log::warn!(
                        "sync: skipping snapshot for peer {device} (will retry next tick): {e}"
                    );
                    let _ = tx.rollback();
                }
            }
            drop(conn);
        }

        // Read watermarks through the reader — no write lock needed.
        let mut all_events: Vec<Event> = Vec::new();
        {
            let reader = db.reader();
            for (device, events) in &peer_logs {
                let last_id = read_last_event_id(&reader, device)?;
                for ev in events {
                    if let Some(w) = last_id.as_deref() {
                        if ev.id.as_str() <= w {
                            continue;
                        }
                    }
                    all_events.push(ev.clone());
                }
            }
        }

        all_events.sort_by(|a, b| (a.ts, &a.device).cmp(&(b.ts, &b.device)));

        let total_events = all_events.len();
        if total_events == 0 {
            return Ok((snapshots_applied, 0));
        }

        if let Some(handle) = app_handle {
            let _ = handle.emit("sync-progress", SyncProgress { applied: 0, total: total_events });
        }

        // -- Phase C — apply events one at a time. --
        // FK stays ON (the connection default). If an event references
        // a parent that hasn't arrived yet (out-of-order peer delivery),
        // the INSERT fails and we skip it — the watermark doesn't
        // advance past it, so the next tick retries after the parent
        // lands.
        let mut events_applied = 0usize;
        for ev in &all_events {
            if self.is_cancelled() {
                ::log::info!("sync: tick cancelled after {events_applied}/{total_events} events");
                break;
            }
            let mut conn = db
                .conn
                .lock()
                .map_err(|e| AppError::Other(format!("db conn mutex: {e}")))?;
            let tx = conn.transaction()?;

            match merge::apply_event(&tx, ev) {
                Ok(()) => {
                    bump_event_watermark(&tx, &ev.device, &ev.id)?;
                    tx.commit()?;
                    events_applied += 1;
                    if let Some(handle) = app_handle {
                        let _ = handle.emit("sync-progress", SyncProgress {
                            applied: events_applied,
                            total: total_events,
                        });
                    }
                }
                Err(e) => {
                    ::log::warn!(
                        "sync: skipping event {} from {} (will retry next tick): {e}",
                        ev.id, ev.device
                    );
                    let _ = tx.rollback();
                }
            }
            drop(conn);
        }

        Ok((snapshots_applied, events_applied))
    }

}

/// Drain `_pending_publish` into `log` as a single batched write. All
/// pending rows are deserialized, appended atomically via
/// `append_batch_varied` (one `NSFileCoordinator` call, one fsync), then
/// bulk-deleted from the outbox. If the batch write fails, no rows are
/// deleted and the entire batch retries on the next call.
///
/// Shared between `ReplayEngine::tick` (Phase 0) and `SyncWriter::with_tx`
/// (post-commit step) so the publish-retry guarantee holds end-to-end.
///
/// **Single-flight via `FLUSH_OUTBOX_MUTEX`.** Concurrent callers (the
/// `SyncWriter` background worker + a watcher-driven `tick`) would
/// otherwise both read the same pending rows, both append, and both
/// delete — duplicating events in the device log. The mutex sits
/// outside `db.conn` so a flush in flight does not block UI writes.
pub fn flush_outbox(db: &Db, log: &EventLog) -> AppResult<usize> {
    let _guard = FLUSH_OUTBOX_MUTEX
        .lock()
        .map_err(|e| AppError::Other(format!("flush outbox mutex poisoned: {e}")))?;
    let pending = {
        let conn = db
            .conn
            .lock()
            .map_err(|e| AppError::Other(format!("db conn mutex: {e}")))?;
        read_outbox(&conn)?
    };
    if pending.is_empty() {
        return Ok(0);
    }

    // Deserialize all bodies up front so a malformed row fails before
    // any I/O. Per-event timestamps are preserved from the outbox row.
    let entries: Vec<(EventBody, i64)> = pending
        .iter()
        .map(|row| {
            let body: EventBody = serde_json::from_str(&row.body_json).map_err(|e| {
                AppError::Other(format!(
                    "outbox row {}: malformed body_json: {e}",
                    row.id
                ))
            })?;
            Ok((body, row.ts))
        })
        .collect::<AppResult<_>>()?;

    // Single coordinated write for all events — one NSFileCoordinator
    // call instead of N. This is the big win: 500 pending events go
    // from 500 × bird-latency to 1 × bird-latency.
    log.append_batch_varied(entries)?;

    // Bulk delete from outbox. The batch append already succeeded so
    // all rows are published; deleting them prevents re-publish on
    // the next flush.
    let conn = db
        .conn
        .lock()
        .map_err(|e| AppError::Other(format!("db conn mutex: {e}")))?;
    for row in &pending {
        conn.execute(
            "DELETE FROM _pending_publish WHERE id = ?1",
            params![row.id],
        )?;
    }
    drop(conn);

    Ok(pending.len())
}

// ---------------------------------------------------------------------------
// Peer discovery.
// ---------------------------------------------------------------------------

#[derive(Debug, Default, Clone)]
struct PeerFiles {
    log_path: Option<PathBuf>,
    snap_path: Option<PathBuf>,
}

/// Walk `<shared>/logs/` and bucket files by device UUID. Returns a sorted
/// map (BTreeMap) so iteration order is deterministic for tests.
///
/// Recognizes iCloud placeholders (`.foo.icloud`) alongside real files.
/// When only a placeholder exists, the peer entry carries the *real*
/// (non-placeholder) path so downstream readers can detect the eviction
/// and trigger a download.
fn discover_peers(shared_dir: &Path) -> AppResult<BTreeMap<String, PeerFiles>> {
    let logs_dir = shared_dir.join("logs");
    let mut peers: BTreeMap<String, PeerFiles> = BTreeMap::new();
    if !logs_dir.exists() {
        return Ok(peers);
    }
    for entry in fs::read_dir(&logs_dir)? {
        let entry = entry?;
        let path = entry.path();
        let name: String = match path.file_name().and_then(|n| n.to_str()) {
            Some(n) => n.to_string(),
            None => continue,
        };
        if let Some(device) = name.strip_suffix(".snapshot.json") {
            peers.entry(device.to_string()).or_default().snap_path = Some(path);
        } else if let Some(device) = name.strip_suffix(".jsonl") {
            peers.entry(device.to_string()).or_default().log_path = Some(path);
        } else if let Some(inner) = name.strip_prefix('.').and_then(|s| s.strip_suffix(".icloud")) {
            // iCloud placeholder: `.dev-uuid.jsonl.icloud` → real path `dev-uuid.jsonl`
            let real_path = logs_dir.join(inner);
            if let Some(device) = inner.strip_suffix(".snapshot.json") {
                peers.entry(device.to_string()).or_default().snap_path
                    .get_or_insert(real_path);
            } else if let Some(device) = inner.strip_suffix(".jsonl") {
                peers.entry(device.to_string()).or_default().log_path
                    .get_or_insert(real_path);
            }
        }
    }
    Ok(peers)
}

// ---------------------------------------------------------------------------
// Watermark + outbox SQL.
// ---------------------------------------------------------------------------

fn read_last_event_id(conn: &Connection, peer: &str) -> AppResult<Option<String>> {
    let v: Option<Option<String>> = conn
        .query_row(
            "SELECT last_event_id FROM _replay_state WHERE peer_device = ?1",
            params![peer],
            |r| r.get(0),
        )
        .map(Some)
        .or_else(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => Ok(None),
            other => Err(other),
        })?;
    Ok(v.flatten())
}

fn bump_event_watermark(tx: &rusqlite::Transaction, peer: &str, max_id: &str) -> AppResult<()> {
    let now = chrono::Utc::now().timestamp_millis();
    // INSERT or UPDATE; the WHERE clause on the UPDATE side enforces the
    // "never decrease" invariant.
    tx.execute(
        "INSERT INTO _replay_state (peer_device, last_snapshot_id, last_event_id, updated_at)
         VALUES (?1, NULL, ?2, ?3)
         ON CONFLICT(peer_device) DO UPDATE SET
           last_event_id = CASE
                              WHEN excluded.last_event_id > _replay_state.last_event_id
                                OR _replay_state.last_event_id IS NULL
                                  THEN excluded.last_event_id
                              ELSE _replay_state.last_event_id
                            END,
           updated_at    = excluded.updated_at",
        params![peer, max_id, now],
    )?;
    Ok(())
}

#[derive(Debug)]
struct OutboxRow {
    id: String,
    ts: i64,
    body_json: String,
}

fn read_outbox(conn: &Connection) -> AppResult<Vec<OutboxRow>> {
    // ORDER BY rowid preserves insertion order; the `id` column is a random
    // UUID and would shuffle related events that share a `created_at` (e.g.
    // a multi-event command emitting `book.import` + `highlight.add` in one
    // tx). The merge engine already converges on (ts, device) order across
    // peers, but cross-event causality inside a single device still needs
    // append-order preserved when we drain the outbox into the log.
    let mut stmt = conn
        .prepare("SELECT id, ts, body_json FROM _pending_publish ORDER BY rowid")?;
    let collected: Vec<OutboxRow> = stmt
        .query_map([], |r| {
            Ok(OutboxRow {
                id: r.get(0)?,
                ts: r.get(1)?,
                body_json: r.get(2)?,
            })
        })?
        .collect::<Result<_, _>>()?;
    Ok(collected)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Db;
    use crate::sync::events::*;
    use serde_json::Map;
    use std::sync::Arc;
    use tempfile::TempDir;

    /// Test harness: shared dir + local SQLite (wrapped in a Db so
    /// `engine.tick(&db)` can re-acquire the conn lock the same way
    /// production does) + own EventLog.
    struct Env {
        _dir: TempDir,
        shared: PathBuf,
        db: Db,
        engine: ReplayEngine,
    }

    impl Env {
        /// Convenience accessor for tests that want to do raw SQL
        /// without going through `with_tx`. Holds the lock for the
        /// returned guard's lifetime — keep the binding short-lived.
        fn conn(&self) -> std::sync::MutexGuard<'_, Connection> {
            self.db.conn.lock().unwrap()
        }
    }

    fn setup(self_device: &str) -> Env {
        let dir = TempDir::new().unwrap();
        let shared = dir.path().join("shared");
        let logs = shared.join("logs");
        fs::create_dir_all(&logs).unwrap();

        let conn = Connection::open_in_memory().unwrap();
        Db::run_migrations_on(&conn).unwrap();
        let conn = Arc::new(Mutex::new(conn));
        let db = Db {
            read_conn: conn.clone(),
            conn,
            data_dir: Arc::new(Mutex::new(dir.path().to_path_buf())),
        };

        let own_log_path = logs.join(format!("{self_device}.jsonl"));
        let own_log = Arc::new(EventLog::open(&own_log_path, self_device, false).unwrap());

        let engine = ReplayEngine::new(shared.clone(), self_device.to_string(), own_log);
        Env {
            _dir: dir,
            shared,
            db,
            engine,
        }
    }

    fn write_peer_log(shared: &Path, peer: &str, events: &[Event]) {
        let p = shared.join("logs").join(format!("{peer}.jsonl"));
        let mut bytes = Vec::new();
        for e in events {
            let line = serde_json::to_vec(e).unwrap();
            bytes.extend_from_slice(&line);
            bytes.push(b'\n');
        }
        fs::write(p, bytes).unwrap();
    }

    fn ev(ts: i64, device: &str, body: EventBody) -> Event {
        Event {
            id: format!("01HYZX0000000000000000{:04X}", ts as u16),
            ts,
            device: device.to_string(),
            v: EVENT_SCHEMA_VERSION,
            body,
            extra: Map::new(),
        }
    }

    fn import(id: &str) -> EventBody {
        EventBody::BookImport(BookImportPayload {
            id: id.into(),
            title: format!("Book {id}"),
            author: "Author".into(),
            description: None,
            cover_path: None,
            file_path: format!("books/{id}.epub"),
            format: "epub".into(),
            genre: None,
            pages: Some(100),
        })
    }

    // -----------------------------------------------------------------------
    // Outbox flush
    // -----------------------------------------------------------------------

    #[test]
    fn outbox_drains_into_own_log_and_advances_to_caller() {
        let env = setup("self");
        // Seed two outbox rows representing previously-committed SQL writes
        // whose log append failed.
        let body1 = import("b1");
        let body2 = import("b2");
        env.conn()
            .execute(
                "INSERT INTO _pending_publish (id, ts, body_json, created_at) VALUES (?1, ?2, ?3, ?4)",
                params![
                    uuid::Uuid::new_v4().to_string(),
                    1000_i64,
                    serde_json::to_string(&body1).unwrap(),
                    chrono::Utc::now().timestamp_millis(),
                ],
            )
            .unwrap();
        env.conn()
            .execute(
                "INSERT INTO _pending_publish (id, ts, body_json, created_at) VALUES (?1, ?2, ?3, ?4)",
                params![
                    uuid::Uuid::new_v4().to_string(),
                    1100_i64,
                    serde_json::to_string(&body2).unwrap(),
                    chrono::Utc::now().timestamp_millis(),
                ],
            )
            .unwrap();

        let report = env.engine.tick(&env.db).unwrap();
        assert_eq!(report.outbox_flushed, 2);

        // Outbox is empty.
        let n: i64 = env
            .conn()
            .query_row("SELECT COUNT(*) FROM _pending_publish", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 0);

        // Own log has both events; the events are then re-applied in this
        // same tick (own device is treated as a peer), so the books table
        // reflects them.
        let log_events = env.engine.own_log.read_all().unwrap();
        assert_eq!(log_events.len(), 2);

        let n_books: i64 = env
            .conn()
            .query_row("SELECT COUNT(*) FROM books", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n_books, 2);
    }

    /// Regression for the review finding on PR #209: two callers of
    /// `flush_outbox` racing on the same outbox row would each read,
    /// each append, and each delete — duplicating the device-log
    /// event. With the `FLUSH_OUTBOX_MUTEX` single-flight guard, the
    /// log must hold exactly one event after concurrent drains.
    #[test]
    fn concurrent_flush_outbox_does_not_double_publish() {
        use std::thread;

        let env = setup("self");
        let body = import("b1");
        env.conn()
            .execute(
                "INSERT INTO _pending_publish (id, ts, body_json, created_at) VALUES (?1, ?2, ?3, ?4)",
                params![
                    uuid::Uuid::new_v4().to_string(),
                    1000_i64,
                    serde_json::to_string(&body).unwrap(),
                    1000_i64,
                ],
            )
            .unwrap();

        let db = env.db.clone();
        let log = Arc::clone(&env.engine.own_log);
        let db2 = env.db.clone();
        let log2 = Arc::clone(&env.engine.own_log);

        // Two concurrent flush attempts. The mutex must serialize
        // them; the loser sees an empty outbox and is a no-op.
        let h1 = thread::spawn(move || flush_outbox(&db, &log).unwrap());
        let h2 = thread::spawn(move || flush_outbox(&db2, &log2).unwrap());
        let n1 = h1.join().unwrap();
        let n2 = h2.join().unwrap();
        assert_eq!(n1 + n2, 1, "exactly one flush wins; the other is a no-op");

        let log_events = env.engine.own_log.read_all().unwrap();
        assert_eq!(
            log_events.len(),
            1,
            "single-flight guard must prevent duplicate device-log events",
        );
    }

    // -----------------------------------------------------------------------
    // Peer log discovery + apply
    // -----------------------------------------------------------------------

    #[test]
    fn applies_events_from_a_single_peer_log() {
        let env = setup("self");
        let peer_events = vec![
            ev(1000, "peer-A", import("b1")),
            ev(
                1100,
                "peer-A",
                EventBody::HighlightAdd(HighlightPayload {
                    id: "h1".into(),
                    book_id: "b1".into(),
                    cfi_range: "cfi".into(),
                    color: "yellow".into(),
                    note: None,
                    text_content: None,
                }),
            ),
        ];
        write_peer_log(&env.shared, "peer-A", &peer_events);

        let report = env.engine.tick(&env.db).unwrap();
        assert_eq!(report.events_applied, 2);
        assert_eq!(report.peers_seen, 2, "peer-A + self");

        let n_books: i64 = env
            .conn()
            .query_row("SELECT COUNT(*) FROM books", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n_books, 1);

        // Watermark advanced to the max id from peer-A.
        let last: Option<String> = env
            .conn()
            .query_row(
                "SELECT last_event_id FROM _replay_state WHERE peer_device = 'peer-A'",
                [], |r| r.get(0),
            )
            .unwrap();
        assert_eq!(last.as_deref(), Some(peer_events[1].id.as_str()));
    }

    #[test]
    fn watermark_skips_already_applied_events_on_second_tick() {
        let env = setup("self");
        let peer_events = vec![ev(1000, "peer-A", import("b1"))];
        write_peer_log(&env.shared, "peer-A", &peer_events);

        let r1 = env.engine.tick(&env.db).unwrap();
        assert_eq!(r1.events_applied, 1);

        // Second tick — same log, no new events.
        let r2 = env.engine.tick(&env.db).unwrap();
        assert_eq!(r2.events_applied, 0, "watermark should suppress re-apply");

        // Append a new event to peer-A's log; tick picks it up.
        let mut more = peer_events.clone();
        more.push(ev(
            2000,
            "peer-A",
            EventBody::BookProgressSet {
                book: "b1".into(),
                progress: 50,
                cfi: Some("c50".into()),
            },
        ));
        write_peer_log(&env.shared, "peer-A", &more);

        let r3 = env.engine.tick(&env.db).unwrap();
        assert_eq!(r3.events_applied, 1);

        let progress: i32 = env
            .conn()
            .query_row("SELECT progress FROM books WHERE id = 'b1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(progress, 50);
    }

    #[test]
    fn cross_peer_events_apply_in_global_ts_order() {
        let env = setup("self");
        // Two peers write the same book progress at different ts.
        write_peer_log(&env.shared, "peer-A", &[
            ev(1000, "peer-A", import("b1")),
            ev(
                1500,
                "peer-A",
                EventBody::BookProgressSet {
                    book: "b1".into(),
                    progress: 25,
                    cfi: Some("cA".into()),
                },
            ),
        ]);
        write_peer_log(&env.shared, "peer-B", &[
            ev(
                2000,
                "peer-B",
                EventBody::BookProgressSet {
                    book: "b1".into(),
                    progress: 80,
                    cfi: Some("cB".into()),
                },
            ),
        ]);

        env.engine.tick(&env.db).unwrap();
        let progress: i32 = env
            .conn()
            .query_row("SELECT progress FROM books WHERE id = 'b1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(progress, 80, "later peer-B event wins");
    }

    // -----------------------------------------------------------------------
    // Snapshot pickup
    // -----------------------------------------------------------------------

    #[test]
    fn applies_peer_snapshot_then_log_tail() {
        let env = setup("self");
        // Build peer-A's snapshot + log split. Snapshot covers b1; the log
        // adds a highlight after the snapshot.
        let snap_events = vec![ev(1000, "peer-A", import("b1"))];
        let snap = Snapshot::from_events("peer-A", &snap_events).unwrap();
        let snap_path = env.shared.join("logs/peer-A.snapshot.json");
        snap.write_atomic(&snap_path).unwrap();

        let tail = vec![ev(
            2000,
            "peer-A",
            EventBody::HighlightAdd(HighlightPayload {
                id: "h1".into(),
                book_id: "b1".into(),
                cfi_range: "cfi".into(),
                color: "yellow".into(),
                note: None,
                text_content: None,
            }),
        )];
        write_peer_log(&env.shared, "peer-A", &tail);

        let report = env.engine.tick(&env.db).unwrap();
        assert!(report.snapshots_applied >= 1);
        assert_eq!(report.events_applied, 1);

        let n_books: i64 = env
            .conn()
            .query_row("SELECT COUNT(*) FROM books", [], |r| r.get(0))
            .unwrap();
        let n_hl: i64 = env
            .conn()
            .query_row("SELECT COUNT(*) FROM highlights", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n_books, 1);
        assert_eq!(n_hl, 1);
    }

    // -----------------------------------------------------------------------
    // Edge cases
    // -----------------------------------------------------------------------

    #[test]
    fn empty_shared_dir_is_a_noop() {
        let env = setup("self");
        let report = env.engine.tick(&env.db).unwrap();
        // Self log was created at setup → 1 peer (self).
        assert_eq!(report.peers_seen, 1);
        assert_eq!(report.events_applied, 0);
        assert_eq!(report.outbox_flushed, 0);
    }

    #[test]
    fn malformed_snapshot_is_skipped_not_fatal() {
        let env = setup("self");
        let bad = env.shared.join("logs/peer-X.snapshot.json");
        fs::write(&bad, b"{not valid json").unwrap();
        // Tick must not error; bad file is logged + skipped.
        let report = env.engine.tick(&env.db).unwrap();
        assert_eq!(report.snapshots_applied, 0);
        assert_eq!(report.events_applied, 0);
    }

    #[test]
    fn malformed_event_is_skipped_and_good_events_still_apply() {
        let env = setup("self");
        let events = vec![
            ev(1000, "peer-A", import("b1")),
            ev(
                2000,
                "peer-A",
                EventBody::BookMetadataSet {
                    book: "b1".into(),
                    field: "title".into(),
                    value: serde_json::json!(42), // wrong type — skipped
                },
            ),
        ];
        write_peer_log(&env.shared, "peer-A", &events);

        let report = env.engine.tick(&env.db).unwrap();
        // The import succeeds, the malformed metadata is skipped.
        assert_eq!(report.events_applied, 1);

        let n_books: i64 = env
            .conn()
            .query_row("SELECT COUNT(*) FROM books", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n_books, 1);
    }

    /// Regression for umbrella-PR review finding #3: every successful
    /// `tick()` must bump self's `_replay_state.updated_at` so the
    /// settings UI's "Last sync" reflects the most recent tick — not
    /// only the ones that happened to move a peer watermark. A no-op
    /// tick is still a successful tick from the user's perspective.
    #[test]
    fn tick_bumps_self_updated_at_even_on_noop() {
        let env = setup("self");

        // First tick — empty shared dir, nothing to apply. Self row
        // doesn't exist yet.
        let before = chrono::Utc::now().timestamp_millis();
        env.engine.tick(&env.db).unwrap();

        let row1: Option<i64> = env
            .conn()
            .query_row(
                "SELECT updated_at FROM _replay_state WHERE peer_device = 'self'",
                [],
                |r| r.get(0),
            )
            .ok();
        assert!(row1.is_some(), "first tick must upsert self into _replay_state");
        assert!(row1.unwrap() >= before);

        // Sleep a few millis so the second tick's timestamp is
        // visibly newer.
        std::thread::sleep(std::time::Duration::from_millis(5));
        env.engine.tick(&env.db).unwrap();

        let row2: i64 = env
            .conn()
            .query_row(
                "SELECT updated_at FROM _replay_state WHERE peer_device = 'self'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert!(
            row2 > row1.unwrap(),
            "second no-op tick must still bump self.updated_at ({row2} <= {})",
            row1.unwrap()
        );
    }

    #[test]
    fn tick_refreshes_own_peer_manifest() {
        let env = setup("self");
        let before = chrono::Utc::now().timestamp_millis();
        env.engine.tick(&env.db).unwrap();

        let manifest = peers::manifest_path(&env.shared, "self");
        assert!(manifest.exists(), "tick should publish own peer manifest");
        let bytes = fs::read(&manifest).unwrap();
        let parsed: peers::Peer = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(parsed.device_uuid, "self");
        assert!(
            parsed.last_seen >= before,
            "last_seen ({}) should be >= pre-tick ts ({before})",
            parsed.last_seen
        );
    }

    // -----------------------------------------------------------------------
    // iCloud placeholder discovery
    // -----------------------------------------------------------------------

    #[test]
    fn discover_peers_recognizes_icloud_placeholders() {
        let dir = tempfile::TempDir::new().unwrap();
        let shared = dir.path().join("shared");
        let logs = shared.join("logs");
        fs::create_dir_all(&logs).unwrap();

        // Real file for peer-A.
        fs::write(logs.join("peer-A.jsonl"), b"").unwrap();

        // iCloud placeholders only for peer-B (evicted by iCloud daemon).
        fs::write(logs.join(".peer-B.jsonl.icloud"), b"").unwrap();
        fs::write(logs.join(".peer-B.snapshot.json.icloud"), b"").unwrap();

        let peers = discover_peers(&shared).unwrap();

        assert!(peers.contains_key("peer-A"), "real file should be discovered");
        assert_eq!(peers["peer-A"].log_path.as_deref(), Some(logs.join("peer-A.jsonl").as_path()));

        assert!(peers.contains_key("peer-B"), "placeholder should be discovered");
        assert_eq!(
            peers["peer-B"].log_path.as_deref(),
            Some(logs.join("peer-B.jsonl").as_path()),
            "placeholder should derive the real (non-.icloud) path",
        );
        assert_eq!(
            peers["peer-B"].snap_path.as_deref(),
            Some(logs.join("peer-B.snapshot.json").as_path()),
        );
    }

    #[test]
    fn discover_peers_real_file_wins_over_placeholder() {
        let dir = tempfile::TempDir::new().unwrap();
        let shared = dir.path().join("shared");
        let logs = shared.join("logs");
        fs::create_dir_all(&logs).unwrap();

        // Both real file and placeholder exist (transient state during
        // iCloud download — daemon materializes the file then removes
        // the placeholder).
        fs::write(logs.join("peer-A.jsonl"), b"").unwrap();
        fs::write(logs.join(".peer-A.jsonl.icloud"), b"").unwrap();

        let peers = discover_peers(&shared).unwrap();
        assert_eq!(peers.len(), 1);
        assert!(peers.contains_key("peer-A"));
        // The real path should be set (both the real-file branch and
        // the placeholder branch produce the same path, but the
        // real-file branch uses direct assignment while the placeholder
        // branch uses get_or_insert, so neither clobbers the other).
        assert_eq!(
            peers["peer-A"].log_path.as_deref(),
            Some(logs.join("peer-A.jsonl").as_path()),
        );
    }

    // -----------------------------------------------------------------------
    // Stall + in-flight tracking
    // -----------------------------------------------------------------------

    #[test]
    fn stall_tracking_marks_and_clears() {
        let path = PathBuf::from("/tmp/quill-test-stall-tracking.jsonl");
        assert!(!is_stalled(&path));
        mark_stalled(&path);
        assert!(is_stalled(&path));
        clear_stalled(&path);
        assert!(!is_stalled(&path));
    }

    #[test]
    fn in_flight_tracking_marks_and_clears() {
        let path = PathBuf::from("/tmp/quill-test-in-flight-tracking.jsonl");
        assert!(!is_in_flight(&path));
        mark_in_flight(&path);
        assert!(is_in_flight(&path));
        clear_in_flight(&path);
        assert!(!is_in_flight(&path));
    }

    #[test]
    fn tick_skips_stalled_peer_log() {
        let env = setup("self");
        write_peer_log(&env.shared, "peer-A", &[ev(1000, "peer-A", import("b1"))]);

        // Mark peer-A's log as stalled. The path must match what
        // discover_peers returns.
        let stalled_path = env.shared.join("logs/peer-A.jsonl");
        mark_stalled(&stalled_path);

        let report = env.engine.tick(&env.db).unwrap();
        assert_eq!(
            report.events_applied, 0,
            "stalled peer log should be skipped",
        );
        let n_books: i64 = env
            .conn()
            .query_row("SELECT COUNT(*) FROM books", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n_books, 0, "no events applied → no books");

        // Clear stall — next tick picks it up.
        clear_stalled(&stalled_path);
        let report = env.engine.tick(&env.db).unwrap();
        assert_eq!(report.events_applied, 1);
    }

    #[test]
    fn tick_skips_in_flight_peer_log() {
        let env = setup("self");
        write_peer_log(&env.shared, "peer-A", &[ev(1000, "peer-A", import("b1"))]);

        let in_flight_path = env.shared.join("logs/peer-A.jsonl");
        mark_in_flight(&in_flight_path);

        let report = env.engine.tick(&env.db).unwrap();
        assert_eq!(
            report.events_applied, 0,
            "in-flight peer log should be skipped",
        );

        clear_in_flight(&in_flight_path);
        let report = env.engine.tick(&env.db).unwrap();
        assert_eq!(report.events_applied, 1);
    }

    #[test]
    fn successful_read_clears_in_flight() {
        let env = setup("self");
        write_peer_log(&env.shared, "peer-A", &[ev(1000, "peer-A", import("b1"))]);

        let log_path = env.shared.join("logs/peer-A.jsonl");
        // Tick reads the file successfully → on_thread_done clears in-flight.
        let report = env.engine.tick(&env.db).unwrap();
        assert_eq!(report.events_applied, 1);
        // Give the reader thread time to call on_thread_done.
        std::thread::sleep(std::time::Duration::from_millis(50));
        assert!(
            !is_in_flight(&log_path),
            "in-flight should be cleared after successful read",
        );
    }

}
