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

/// Run `f` while holding TICK_MUTEX, so no replay tick can interleave
/// with it. The rebuild wipe runs under this lock: a tick caught
/// between the wipe's table clears and its own per-event watermark
/// bump would record event ids for rows the wipe just deleted, and the
/// rebuild replay would then skip those events forever.
pub fn with_tick_lock<T>(f: impl FnOnce() -> T) -> T {
    let _guard = TICK_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
    f()
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
    /// True when `cancel()` cut this tick short. Captured while the
    /// tick still holds TICK_MUTEX — the engine-global flag is reset
    /// by whichever tick starts next, so callers deciding on
    /// completion (the rebuild's marker clear) must read this field,
    /// never the live flag.
    pub cancelled: bool,
}

/// Abstract work units for the sync chip — snapshot rows plus raw log
/// events, not user-facing counts. The frontend renders `applied/total`
/// as a percentage.
#[derive(Clone, serde::Serialize)]
struct SyncProgress {
    applied: usize,
    total: usize,
}

fn emit_progress(app_handle: Option<&tauri::AppHandle>, update: Option<(usize, usize)>) {
    if let (Some(handle), Some((applied, total))) = (app_handle, update) {
        let _ = handle.emit("sync-progress", SyncProgress { applied, total });
    }
}

/// Emit `sync-progress` at most every this many snapshot rows, so a
/// large snapshot doesn't flood the webview event loop.
const PROGRESS_EMIT_EVERY: usize = 25;

/// Work-unit bookkeeping for one tick's `sync-progress` stream. The
/// denominator is fixed up front — every snapshot row plus every raw log
/// event read in Phase A — so the reported fraction can only move
/// forward; Phase B can never claim 100% while Phase C work remains.
/// Log events the post-snapshot watermarks filter out are credited as
/// completed work in `events_known` (the snapshot already covered them),
/// and a short-circuited or failed peer snapshot is credited whole in
/// `peer_done` — either way that share of the tick's work is behind us.
/// Returned pairs are `(applied, total)` to emit; `None` means don't
/// emit (throttled, or a tick with no work at all).
struct SyncProgressLedger {
    snapshot_units: usize,
    raw_events: usize,
    /// Completed units: finished peer snapshots + filtered/applied events.
    done: usize,
    /// Rows walked inside the current peer's snapshot apply.
    in_flight: usize,
    /// Rows since the last throttled emit.
    since_emit: usize,
}

impl SyncProgressLedger {
    fn new(snapshot_units: usize, raw_events: usize) -> Self {
        Self { snapshot_units, raw_events, done: 0, in_flight: 0, since_emit: 0 }
    }

    fn total(&self) -> usize {
        self.snapshot_units + self.raw_events
    }

    fn begin(&self) -> Option<(usize, usize)> {
        (self.total() > 0).then(|| (0, self.total()))
    }

    fn snapshot_rows(&mut self, n: usize) -> Option<(usize, usize)> {
        self.in_flight += n;
        self.since_emit += n;
        if self.since_emit < PROGRESS_EMIT_EVERY {
            return None;
        }
        self.since_emit = 0;
        Some((self.done + self.in_flight, self.total()))
    }

    fn peer_done(&mut self, units: usize) -> Option<(usize, usize)> {
        self.done += units;
        self.in_flight = 0;
        self.since_emit = 0;
        (self.total() > 0).then(|| (self.done, self.total()))
    }

    fn events_known(&mut self, surviving: usize) -> Option<(usize, usize)> {
        self.done = self.snapshot_units + self.raw_events.saturating_sub(surviving);
        (self.total() > 0).then(|| (self.done, self.total()))
    }

    fn event_applied(&mut self) -> Option<(usize, usize)> {
        self.done += 1;
        Some((self.done, self.total()))
    }
}

pub struct ReplayEngine {
    pub shared_dir: PathBuf,
    pub self_device: String,
    /// Own log handle, shared with `SyncWriter`. `tick()` writes here when
    /// flushing the outbox.
    pub own_log: Arc<EventLog>,
    /// Handle for emitting non-modal frontend events (e.g.
    /// `sync-covers-ingested`) from any tick — including the silent
    /// watcher ticks where covers actually land. Deliberately separate
    /// from `tick_with_progress`'s `app_handle` parameter, which drives
    /// the `sync-progress` modal and is `None` for watcher ticks.
    app_handle: Option<tauri::AppHandle>,
    /// Set to `true` by `cancel()` to abort an in-flight tick early.
    /// Checked between events in Phase C so a `sync_disable` doesn't
    /// have to wait for a long replay to finish.
    cancelled: std::sync::atomic::AtomicBool,
    /// Monotonic count of user cancel requests (`sync_cancel`).
    /// Unlike `cancelled`, this is never reset: the rebuild captures
    /// the value when it enters its serialized state machine and
    /// compares at safe boundaries — any increment observed
    /// mid-operation means the user cancelled *this* operation. A
    /// tick starting cannot launder it, and a later rebuild request
    /// cannot erase a cancel aimed at the active one (the flaws of a
    /// resettable boolean).
    cancel_generation: std::sync::atomic::AtomicU64,
}

impl ReplayEngine {
    pub fn new(shared_dir: PathBuf, self_device: String, own_log: Arc<EventLog>) -> Self {
        Self {
            shared_dir,
            self_device,
            own_log,
            app_handle: None,
            cancelled: std::sync::atomic::AtomicBool::new(false),
            cancel_generation: std::sync::atomic::AtomicU64::new(0),
        }
    }

    /// Attach an `AppHandle` so ticks can emit non-modal frontend events.
    /// Set at both engine boot sites (`boot_sync_engine`, `sync_enable`).
    pub fn with_app_handle(mut self, handle: tauri::AppHandle) -> Self {
        self.app_handle = Some(handle);
        self
    }

    /// Signal any in-flight tick to stop after the current event.
    pub fn cancel(&self) {
        self.cancelled.store(true, std::sync::atomic::Ordering::SeqCst);
    }

    fn is_cancelled(&self) -> bool {
        self.cancelled.load(std::sync::atomic::Ordering::SeqCst)
    }

    pub fn bump_cancel_generation(&self) {
        self.cancel_generation
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    }

    pub fn cancel_generation(&self) -> u64 {
        self.cancel_generation.load(std::sync::atomic::Ordering::SeqCst)
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

        let covers_ingested = ingest_peer_covers(&self.shared_dir, db);
        if covers_ingested > 0 {
            // Covers land on watcher ticks (the placeholder triggered for
            // download a tick or two earlier), which pass `None` for the
            // modal `app_handle`. Use the engine-held handle so the grid
            // refreshes when covers fill in — otherwise blank cards persist
            // until the user navigates or relaunches.
            if let Some(handle) = &self.app_handle {
                let _ = handle.emit("sync-covers-ingested", covers_ingested);
            }
        }

        if events_applied > 0 || snapshots_applied > 0 || outbox_flushed > 0 || covers_ingested > 0 {
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
            // Still under TICK_MUTEX (`_guard` lives to the end of this
            // function): no other tick can have reset the flag between
            // the Phase C break and this read.
            cancelled: self.is_cancelled(),
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
        let snapshot_units: usize = snapshots.iter().map(|(_, s)| s.work_units()).sum();
        let raw_events: usize = peer_logs.iter().map(|(_, events)| events.len()).sum();
        let mut ledger = SyncProgressLedger::new(snapshot_units, raw_events);
        emit_progress(app_handle, ledger.begin());
        let mut snapshots_applied = 0usize;
        for (device, snap) in &snapshots {
            let mut conn = db
                .conn
                .lock()
                .map_err(|e| AppError::Other(format!("db conn mutex: {e}")))?;
            let tx = conn.transaction()?;
            let outcome = snap.apply_peer_with_progress(&tx, device, &mut |n| {
                emit_progress(app_handle, ledger.snapshot_rows(n));
            });
            match outcome {
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
            emit_progress(app_handle, ledger.peer_done(snap.work_units()));
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
        emit_progress(app_handle, ledger.events_known(total_events));
        if total_events == 0 {
            return Ok((snapshots_applied, 0));
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
                    emit_progress(app_handle, ledger.event_applied());
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
    flush_outbox_locked(db, log)
}

/// Drain the outbox, re-apply the device's own log, and run `publish`
/// — all under `FLUSH_OUTBOX_MUTEX`, so no other flush can append to
/// the own log mid-sequence. Used by the rebuild's bootstrap publish:
/// the snapshot it writes mints an id newer than every event in the
/// own log, and `apply_peer` advances the self watermark to that id —
/// any own event still unapplied at that point (a delete whose
/// tombstone hasn't landed) would be masked forever. Sealing the log
/// while settling and publishing guarantees no such event can exist
/// below the snapshot id. Events queued to the outbox during the seal
/// are safe: they get ULIDs newer than the snapshot id when
/// eventually flushed, so the replay applies them normally.
///
/// The full log is re-applied rather than the tail above the self
/// watermark: a normal tick skips events that fail to apply while a
/// later success still max-bumps the watermark, so the watermark can
/// sit past a failed event (a hole) and is not proof of application.
/// Own-event re-application is idempotent (LWW + tombstones) and the
/// log is compaction-bounded, so the full pass is cheap.
pub fn publish_with_own_state_settled(
    db: &Db,
    own_log: &EventLog,
    publish: impl FnOnce() -> AppResult<()>,
) -> AppResult<()> {
    let _guard = FLUSH_OUTBOX_MUTEX
        .lock()
        .map_err(|e| AppError::Other(format!("flush outbox mutex poisoned: {e}")))?;
    flush_outbox_locked(db, own_log)?;

    let mut events = own_log.read_all()?;
    events.sort_by(|a, b| (a.ts, &a.id).cmp(&(b.ts, &b.id)));
    for ev in &events {
        let mut conn = db
            .conn
            .lock()
            .map_err(|e| AppError::Other(format!("db conn mutex: {e}")))?;
        let tx = conn.transaction()?;
        if let Err(e) = merge::apply_event(&tx, ev) {
            // Fail closed: skipping and publishing anyway would mint a
            // snapshot whose id masks this still-unapplied event —
            // the exact resurrection class the seal exists to prevent.
            // The caller aborts before any marker/wipe.
            let _ = tx.rollback();
            return Err(AppError::Other(format!(
                "rebuild fold: own event {} failed to apply — aborting before publish: {e}",
                ev.id
            )));
        }
        bump_event_watermark(&tx, &ev.device, &ev.id)?;
        tx.commit()?;
    }

    publish()
}

fn flush_outbox_locked(db: &Db, log: &EventLog) -> AppResult<usize> {
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

fn ingest_peer_covers(shared_dir: &Path, db: &Db) -> usize {
    let covers_dir = shared_dir.join("covers");
    let entries = match std::fs::read_dir(&covers_dir) {
        Ok(e) => e,
        Err(_) => return 0,
    };

    // Phase 1: collect candidates using quick SQL checks and metadata stats.
    // Recognizes both real files (foo.img) and iCloud placeholders (.foo.img.icloud).
    let (candidates, deferred) = {
        let Ok(conn) = db.read_conn.lock() else { return 0 };
        let mut deferred = 0usize;
        let candidates: Vec<(String, PathBuf)> = entries
            .flatten()
            .filter_map(|entry| {
                let name = entry.file_name();
                let name_str = name.to_string_lossy();
                let (book_id, path) = if let Some(id) = name_str.strip_suffix(".img") {
                    (id.to_string(), entry.path())
                } else if name_str.starts_with('.') && name_str.ends_with(".img.icloud") {
                    let inner = &name_str[1..name_str.len() - 7]; // strip leading '.' and trailing '.icloud'
                    let id = inner.strip_suffix(".img")?.to_string();
                    let real_path = covers_dir.join(format!("{id}.img"));
                    crate::icloud::trigger_download_file(&real_path);
                    deferred += 1;
                    return None; // skip this tick, file will be available next tick
                } else {
                    return None;
                };
                let has_cover: bool = conn
                    .query_row(
                        "SELECT cover_data IS NOT NULL AND LENGTH(cover_data) > 0 FROM books WHERE id = ?1",
                        rusqlite::params![&book_id],
                        |r| r.get(0),
                    )
                    .unwrap_or(true);
                if has_cover {
                    None
                } else if crate::icloud::is_dataless_file(&path) {
                    crate::icloud::trigger_download_file(&path);
                    deferred += 1;
                    None
                } else {
                    Some((book_id, path))
                }
            })
            .collect();
        (candidates, deferred)
    };

    if deferred > 0 {
        ::log::info!(
            "sync: {deferred} cover(s) not yet downloaded — requested from iCloud"
        );
    }

    if candidates.is_empty() {
        return 0;
    }

    // Phases 2/3: read without a DB lock, then briefly lock to persist each cover.
    let mut ingested = 0usize;
    for (book_id, path) in candidates {
        let Ok(bytes) = std::fs::read(&path) else {
            continue;
        };
        if bytes.is_empty() {
            continue;
        }
        let Ok(conn) = db.conn.lock() else {
            return ingested;
        };
        if conn
            .execute(
                "UPDATE books SET cover_data = ?1 WHERE id = ?2 AND (cover_data IS NULL OR LENGTH(cover_data) = 0)",
                rusqlite::params![&bytes, &book_id],
            )
            .is_ok_and(|n| n > 0)
        {
            ingested += 1;
            ::log::info!("sync: ingested cover for book {book_id}");
        }
    }
    ingested
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

    // -----------------------------------------------------------------------
    // Cover ingestion
    // -----------------------------------------------------------------------

    fn insert_book_no_cover(conn: &Connection, id: &str) {
        conn.execute(
            "INSERT INTO books
             (id, title, author, file_path, format, status, progress, created_at, updated_at, updated_by_device)
             VALUES (?1, 'T', 'A', 'books/x.epub', 'epub', 'unread', 0, 1, 1, 'peer-A')",
            params![id],
        )
        .unwrap();
    }

    #[test]
    fn ingest_peer_covers_reads_file_into_blob() {
        let env = setup("self");
        insert_book_no_cover(&env.conn(), "b1");

        let covers = env.shared.join("covers");
        fs::create_dir_all(&covers).unwrap();
        fs::write(covers.join("b1.img"), b"\x89PNG fake cover bytes").unwrap();

        let ingested = ingest_peer_covers(&env.shared, &env.db);
        assert_eq!(ingested, 1, "the one new cover file should be ingested");

        let blob: Vec<u8> = env
            .conn()
            .query_row("SELECT cover_data FROM books WHERE id = 'b1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(blob, b"\x89PNG fake cover bytes");
    }

    #[test]
    fn ingest_peer_covers_persists_each_materialized_cover() {
        let env = setup("self");
        insert_book_no_cover(&env.conn(), "b1");
        insert_book_no_cover(&env.conn(), "b2");

        let covers = env.shared.join("covers");
        fs::create_dir_all(&covers).unwrap();
        fs::write(covers.join("b1.img"), b"first cover").unwrap();
        fs::write(covers.join("b2.img"), b"second cover").unwrap();

        let ingested = ingest_peer_covers(&env.shared, &env.db);
        assert_eq!(ingested, 2);

        let conn = env.conn();
        let first: Vec<u8> = conn
            .query_row("SELECT cover_data FROM books WHERE id = 'b1'", [], |r| r.get(0))
            .unwrap();
        let second: Vec<u8> = conn
            .query_row("SELECT cover_data FROM books WHERE id = 'b2'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(first, b"first cover");
        assert_eq!(second, b"second cover");
    }

    #[test]
    fn ingest_peer_covers_skips_books_that_already_have_a_blob() {
        let env = setup("self");
        {
            let conn = env.conn();
            insert_book_no_cover(&conn, "b1");
            conn.execute("UPDATE books SET cover_data = ?1 WHERE id = 'b1'", params![b"existing"])
                .unwrap();
        }

        let covers = env.shared.join("covers");
        fs::create_dir_all(&covers).unwrap();
        fs::write(covers.join("b1.img"), b"newer bytes").unwrap();

        let ingested = ingest_peer_covers(&env.shared, &env.db);
        assert_eq!(ingested, 0, "a book that already has a cover BLOB is left untouched");

        let blob: Vec<u8> = env
            .conn()
            .query_row("SELECT cover_data FROM books WHERE id = 'b1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(blob, b"existing", "existing BLOB must not be overwritten");
    }

    #[test]
    fn ingest_peer_covers_defers_placeholder_only_covers() {
        let env = setup("self");
        insert_book_no_cover(&env.conn(), "b1");

        // Only an iCloud placeholder exists — the real .img isn't materialized
        // yet. Ingestion triggers a download and defers to a later tick.
        let covers = env.shared.join("covers");
        fs::create_dir_all(&covers).unwrap();
        fs::write(covers.join(".b1.img.icloud"), b"placeholder").unwrap();

        let ingested = ingest_peer_covers(&env.shared, &env.db);
        assert_eq!(ingested, 0, "placeholder-only cover is deferred, not ingested");

        let blob: Option<Vec<u8>> = env
            .conn()
            .query_row("SELECT cover_data FROM books WHERE id = 'b1'", [], |r| r.get(0))
            .unwrap();
        assert!(blob.is_none(), "no bytes should be written from a placeholder");
    }

    /// Regression for #299: a tick with both snapshot rows and a log tail
    /// must keep one fixed denominator across Phase B and Phase C, so the
    /// fraction never hits 100% while events are still pending (a naive
    /// per-phase denominator did, and the frontend's monotonic clamp then
    /// pinned the chip at 100%).
    #[test]
    fn progress_ledger_holds_denominator_across_phases() {
        // Issue-#299 shape: 382 snapshot rows, 300 raw log events of which
        // 247 survive the post-snapshot watermark filter.
        fn push(emits: &mut Vec<(usize, usize)>, update: Option<(usize, usize)>) {
            if let Some(pair) = update {
                emits.push(pair);
            }
        }
        let mut ledger = SyncProgressLedger::new(382, 300);
        let mut emits: Vec<(usize, usize)> = Vec::new();

        push(&mut emits, ledger.begin());
        for _ in 0..382 {
            push(&mut emits, ledger.snapshot_rows(1));
        }
        push(&mut emits, ledger.peer_done(382));
        let phase_b_emits = emits.len();
        push(&mut emits, ledger.events_known(247));
        for _ in 0..247 {
            push(&mut emits, ledger.event_applied());
        }

        assert_eq!(emits.first(), Some(&(0, 682)));
        assert_eq!(emits.last(), Some(&(682, 682)));
        assert!(
            emits[..phase_b_emits].iter().all(|(applied, _)| *applied < 682),
            "Phase B alone must not reach 100%"
        );
        let mut prev = (0, 682);
        for pair in &emits {
            assert_eq!(pair.1, 682, "denominator must not move mid-tick");
            assert!(pair.0 <= pair.1);
            assert!(pair.0 >= prev.0, "applied must be monotonic: {prev:?} -> {pair:?}");
            prev = *pair;
        }
    }

    #[test]
    fn progress_ledger_credits_short_circuits_and_filtered_events() {
        let mut ledger = SyncProgressLedger::new(10, 5);
        assert_eq!(ledger.begin(), Some((0, 15)));
        // Peer snapshot short-circuits: no rows walked, whole credit on
        // completion so the fraction doesn't stall.
        assert_eq!(ledger.peer_done(10), Some((10, 15)));
        // Every raw event is behind the watermark — credited as done.
        assert_eq!(ledger.events_known(0), Some((15, 15)));
    }

    #[test]
    fn progress_ledger_throttles_row_emits() {
        let mut ledger = SyncProgressLedger::new(100, 0);
        let emitted: Vec<_> = (0..100).filter_map(|_| ledger.snapshot_rows(1)).collect();
        assert_eq!(emitted, vec![(25, 100), (50, 100), (75, 100), (100, 100)]);
    }

    #[test]
    fn progress_ledger_no_work_emits_nothing() {
        let ledger = SyncProgressLedger::new(0, 0);
        assert_eq!(ledger.begin(), None);
        assert_eq!(SyncProgressLedger::new(0, 0).peer_done(0), None);
        assert_eq!(SyncProgressLedger::new(0, 0).events_known(0), None);
    }

    // -----------------------------------------------------------------------
    // Rebuild support (#300): per-invocation cancel verdict + sealed publish
    // -----------------------------------------------------------------------

    /// A cancel landing mid-tick must be captured in that tick's
    /// report while it still holds the tick mutex — a follow-up tick
    /// resetting the engine-global flag (the watcher race) must not
    /// launder the verdict.
    ///
    /// Seam: a large peer log makes Phase C long; polling the books
    /// count observes committed per-event transactions, so once a row
    /// is visible the tick is provably past its flag reset and mid
    /// Phase C — the cancel cannot be swallowed, and thousands of
    /// events remain for it to break on.
    #[test]
    fn cancel_mid_tick_is_captured_in_the_report() {
        const TOTAL: usize = 20_000;
        let env = setup("self");
        let events: Vec<Event> = (0..TOTAL)
            .map(|i| ev(1000 + i as i64, "peer-A", import(&format!("b{i}"))))
            .collect();
        write_peer_log(&env.shared, "peer-A", &events);

        let report = std::thread::scope(|s| {
            let handle = s.spawn(|| env.engine.tick(&env.db));
            // Bounded, fail-fast wait: break when Phase C is observably
            // applying, fail loudly if the worker exits first (early
            // tick error, or it raced through all 20k events) or if
            // nothing happens within the deadline — never hang.
            let started = std::time::Instant::now();
            loop {
                assert!(
                    !handle.is_finished(),
                    "tick finished before the cancel could land — seam broken",
                );
                let n: i64 = env
                    .conn()
                    .query_row("SELECT COUNT(*) FROM books", [], |r| r.get(0))
                    .unwrap();
                if n > 0 {
                    break;
                }
                assert!(
                    started.elapsed() < std::time::Duration::from_secs(60),
                    "tick never started applying events",
                );
                std::thread::sleep(std::time::Duration::from_millis(1));
            }
            env.engine.cancel();
            handle.join().unwrap()
        })
        .unwrap();

        assert!(report.cancelled, "mid-tick cancel must be captured in the report");
        assert!(
            report.events_applied < TOTAL,
            "Phase C must break early ({} applied)",
            report.events_applied
        );

        // The follow-up tick resets the engine flag, finishes the
        // remainder, and the captured verdict is unaffected.
        let follow_up = env.engine.tick(&env.db).unwrap();
        assert!(!follow_up.cancelled);
        assert_eq!(report.events_applied + follow_up.events_applied, TOTAL);
        assert!(report.cancelled);
    }

    /// The rebuild's sealed publish must fold every own event that is
    /// not yet applied locally — still queued in the outbox, or already
    /// in the own log — before the publish closure runs, so tombstones
    /// for recent deletes exist when the bootstrap snapshot is minted.
    #[test]
    fn publish_with_own_state_settled_folds_unapplied_own_events() {
        let env = setup("self");
        {
            let conn = env.conn();
            insert_book_no_cover(&conn, "b1");
            insert_book_no_cover(&conn, "b2");
            conn.execute("DELETE FROM books WHERE id = 'b1'", []).unwrap();
            conn.execute("DELETE FROM books WHERE id = 'b2'", []).unwrap();
        }
        // b1's delete already reached the own log (the flush worker
        // ran); b2's is still queued in the outbox. Neither has been
        // applied locally, so neither has a tombstone yet.
        env.engine
            .own_log
            .append_batch_varied(vec![(EventBody::BookDelete { id: "b1".into() }, 2000)])
            .unwrap();
        env.conn()
            .execute(
                "INSERT INTO _pending_publish (id, ts, body_json, created_at)
                 VALUES (?1, 2100, ?2, 2100)",
                params![
                    uuid::Uuid::new_v4().to_string(),
                    serde_json::to_string(&EventBody::BookDelete { id: "b2".into() }).unwrap(),
                ],
            )
            .unwrap();

        publish_with_own_state_settled(&env.db, &env.engine.own_log, || {
            let conn = env.db.conn.lock().unwrap();
            let n: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM _tombstones WHERE entity = 'book'
                     AND id IN ('b1', 'b2')",
                    [],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(n, 2, "both tombstones must exist before the publish runs");
            Ok(())
        })
        .unwrap();

        let outbox: i64 = env
            .conn()
            .query_row("SELECT COUNT(*) FROM _pending_publish", [], |r| r.get(0))
            .unwrap();
        assert_eq!(outbox, 0, "the seal drains the outbox first");
        assert_eq!(env.engine.own_log.read_all().unwrap().len(), 2);
    }

    /// Round-3 finding 1: an own event that fails to apply must abort
    /// the sealed publish — publishing anyway would mint a snapshot
    /// whose id masks the still-unapplied event, the resurrection
    /// class the seal exists to prevent.
    #[test]
    fn sealed_publish_aborts_on_own_event_apply_failure() {
        let env = setup("self");
        // Wrong value type — merge::apply_event returns Err (same
        // shape as malformed_event_is_skipped_and_good_events_still_apply).
        env.engine
            .own_log
            .append_batch_varied(vec![(
                EventBody::BookMetadataSet {
                    book: "b1".into(),
                    field: "title".into(),
                    value: serde_json::json!(42),
                },
                2000,
            )])
            .unwrap();

        let published = std::cell::Cell::new(false);
        let result = publish_with_own_state_settled(&env.db, &env.engine.own_log, || {
            published.set(true);
            Ok(())
        });

        assert!(result.is_err(), "an apply failure must abort the sealed publish");
        assert!(!published.get(), "the publish closure must not run");
    }

}
