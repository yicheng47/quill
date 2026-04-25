//! `ReplayEngine::tick()` — the converge step.
//!
//! Five phases per call:
//! 0. **Drain `_pending_publish`.** Any events the local `SyncWriter`
//!    committed to SQL but failed to append to the device log get appended
//!    here. Until they're in the log, peers don't see them — so this is the
//!    publish-retry path that bounds Step 3's commit-then-flush failure
//!    asymmetry. (See [`docs/impls/sync/31-sync-known-problems.md`] §1.)
//! 1. **Discover peers.** Walk `<shared>/logs/*.{jsonl,snapshot.json}` and
//!    bucket by device UUID. The local device is included — its snapshot
//!    is what pulls conflict-copy rows back into local SQL during migration
//!    apply-back, and re-applying its own log events is idempotent.
//! 2. **Read.** For each peer: read snapshot if `_replay_state` says it's
//!    new; read log events with id > `last_event_id` watermark.
//! 3. **Sort + apply.** Snapshots applied per-peer first (each updates its
//!    own watermarks). Events from every peer merged into one global vec
//!    sorted by `(ts, device)`, then `merge::apply_event` runs them in one
//!    SQL transaction.
//! 4. **Commit + advance event watermarks** to the max id seen per peer.
//!
//! Foreign keys are toggled OFF before BEGIN and ON after COMMIT — see the
//! `merge` module's docstring for why. Concurrent ticks are serialized by a
//! process-wide mutex; the OS scheduler decides which one runs first, but
//! both produce the same end state because every operation is idempotent.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use rusqlite::{params, Connection};

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

/// What `tick()` did, surfaced for the "Sync now" UI and for tests.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ReplayReport {
    pub outbox_flushed: usize,
    pub snapshots_applied: usize,
    pub events_applied: usize,
    pub peers_seen: usize,
}

pub struct ReplayEngine {
    pub shared_dir: PathBuf,
    pub self_device: String,
    /// Own log handle, shared with `SyncWriter`. `tick()` writes here when
    /// flushing the outbox.
    pub own_log: Arc<EventLog>,
}

impl ReplayEngine {
    pub fn new(shared_dir: PathBuf, self_device: String, own_log: Arc<EventLog>) -> Self {
        Self {
            shared_dir,
            self_device,
            own_log,
        }
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
        let _guard = TICK_MUTEX
            .lock()
            .map_err(|e| AppError::Other(format!("replay tick mutex poisoned: {e}")))?;

        // Phase 0 — drain the outbox into the device log. Manages its
        // own per-row locking; the slow `log.append` runs without
        // holding `db.conn`. Failures surface to the caller; peers
        // will see the local writes on the next successful tick.
        let outbox_flushed = flush_outbox(db, &self.own_log)?;

        // Phase 1 — discover peers (including self). Pure fs read.
        let peers = discover_peers(&self.shared_dir)?;
        let peers_seen = peers.len();

        // Phase 2/3/4 — read peer files, apply in one tx, advance
        // watermarks. FK off mirrors the merge engine's contract;
        // orphan rows from out-of-order delivery are tolerated until
        // parents arrive. The pragma must be restored even if the
        // merge work errors mid-way, otherwise the shared connection
        // silently loses FK enforcement for every subsequent command.
        let (snapshots_applied, events_applied) = {
            let mut conn = db
                .conn
                .lock()
                .map_err(|e| AppError::Other(format!("db conn mutex: {e}")))?;
            conn.execute_batch("PRAGMA foreign_keys = OFF;")?;
            let inner = self.apply_in_tx(&mut conn, &peers);
            let restore = conn.execute_batch("PRAGMA foreign_keys = ON;");
            let counts = match (inner, restore) {
                (Ok(counts), Ok(())) => counts,
                (Err(e), _) => return Err(e),
                (Ok(_), Err(e)) => return Err(AppError::Db(e)),
            };

            // Stamp self's `_replay_state.updated_at` so the settings
            // UI's "Last sync" reflects every successful tick — not
            // only the ones that happened to move a peer watermark.
            // A no-op `sync_now` click (no peer changes, no outbox
            // drain) still proves the engine is healthy, and the UI
            // deserves to show that. Upserts a NULL-watermark self
            // row on first call.
            let now = chrono::Utc::now().timestamp_millis();
            conn.execute(
                "INSERT INTO _replay_state (peer_device, last_snapshot_id, last_event_id, updated_at)
                 VALUES (?1, NULL, NULL, ?2)
                 ON CONFLICT(peer_device) DO UPDATE SET updated_at = excluded.updated_at",
                params![self.self_device, now],
            )?;
            counts
        };
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
            eprintln!("sync: peer manifest refresh failed: {e}");
        }

        // Background compaction. Cheap probe; only runs the full
        // fold-and-truncate when one of the size/age thresholds trips.
        // Failures are non-fatal — the next tick will retry and the log
        // simply grows in the meantime.
        if snapshot::should_compact(&self.shared_dir, &self.self_device) {
            match snapshot::compact_own_log(&self.shared_dir, &self.own_log) {
                Ok(report) if report.snapshot_written => eprintln!(
                    "sync: compacted own log — {} events folded, {} bytes freed",
                    report.events_folded, report.bytes_freed,
                ),
                Ok(_) => {}
                Err(e) => eprintln!("sync: compaction failed: {e}"),
            }
        }

        Ok(ReplayReport {
            outbox_flushed,
            snapshots_applied,
            events_applied,
            peers_seen,
        })
    }

    /// Inner helper for `tick`: snapshot apply + log-tail merge inside a
    /// single SQL transaction. Returns `(snapshots_applied, events_applied)`
    /// counts. Caller is responsible for toggling `PRAGMA foreign_keys`
    /// around the call so any error here doesn't leak FK = OFF.
    fn apply_in_tx(
        &self,
        conn: &mut Connection,
        peers: &BTreeMap<String, PeerFiles>,
    ) -> AppResult<(usize, usize)> {
        let mut snapshots_applied = 0usize;
        let mut events_applied = 0usize;
        let mut peer_max_event: BTreeMap<String, String> = BTreeMap::new();

        let tx = conn.transaction()?;

        // 3a. Apply snapshots first. Each snapshot apply updates its own
        //     `_replay_state.last_snapshot_id` (and `last_event_id` if the
        //     snapshot moves the watermark forward). Doing them before the
        //     log tails means the per-peer `last_event_id` we read in 3b
        //     reflects any snapshot bump.
        for (device, files) in peers {
            let Some(snap_path) = &files.snap_path else {
                continue;
            };
            let snap = match Snapshot::read_from(snap_path) {
                Ok(s) => s,
                Err(e) => {
                    eprintln!(
                        "sync: skipping malformed snapshot {}: {e}",
                        snap_path.display()
                    );
                    continue;
                }
            };
            let outcome = snap.apply_peer(&tx, device)?;
            if matches!(
                outcome,
                super::snapshot::ApplyOutcome::Applied
                    | super::snapshot::ApplyOutcome::HeaderOnly
            ) {
                snapshots_applied += 1;
            }
        }

        // 3b. Read each peer's log tail past its (possibly just-bumped)
        //     watermark. Collect, sort by `(ts, device)`, apply.
        let mut all_events: Vec<Event> = Vec::new();
        for (device, files) in peers {
            let Some(log_path) = &files.log_path else {
                continue;
            };
            let last_id = read_last_event_id(&tx, device)?;
            let events = log::read_log_file_after(log_path, last_id.as_deref())?;
            for ev in events {
                all_events.push(ev);
            }
        }
        all_events.sort_by(|a, b| (a.ts, &a.device).cmp(&(b.ts, &b.device)));

        for ev in &all_events {
            merge::apply_event(&tx, ev)?;
            let entry = peer_max_event.entry(ev.device.clone()).or_default();
            if ev.id > *entry {
                *entry = ev.id.clone();
            }
            events_applied += 1;
        }

        // 4. Advance each peer's last_event_id watermark to the highest id
        //    we just consumed. Monotonic: never go backward.
        for (device, max_id) in &peer_max_event {
            bump_event_watermark(&tx, device, max_id)?;
        }

        tx.commit()?;
        Ok((snapshots_applied, events_applied))
    }

}

/// Drain `_pending_publish` into `log`. Each row is re-serialized into an
/// `EventBody`, appended (which mints a fresh ULID), and on success deleted
/// from the outbox. If the append fails, the row stays put for the next
/// caller to retry.
///
/// Shared between `ReplayEngine::tick` (Phase 0) and `SyncWriter::with_tx`
/// (post-commit step) so the publish-retry guarantee holds end-to-end:
/// every committed-but-not-yet-published event lands in the device log on
/// the next successful flush from either path.
///
/// **Locking discipline.** Takes `&Db` (not `&mut Connection`) so we can
/// release the SQLite mutex around `log.append`. On macOS that append
/// goes through `NSFileCoordinator` and synchronously waits for Apple's
/// `bird` daemon — often several seconds. Holding `db.conn` across that
/// wait would serialize every UI write behind the watcher's tick, which
/// is exactly the "import spinner hangs" symptom users hit. Per-row
/// lock/unlock is cheap relative to the iCloud I/O.
pub fn flush_outbox(db: &Db, log: &EventLog) -> AppResult<usize> {
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

    let mut flushed = 0usize;
    for row in &pending {
        let body: EventBody = serde_json::from_str(&row.body_json).map_err(|e| {
            AppError::Other(format!(
                "outbox row {}: malformed body_json: {e}",
                row.id
            ))
        })?;
        // Slow part — runs WITHOUT holding db.conn so concurrent UI
        // writes (import_book, highlight.add, etc.) are not blocked.
        log.append(body, row.ts)?;
        // Per-row delete: if a later append in this batch fails, the
        // earlier rows are already published and can be removed cleanly.
        let conn = db
            .conn
            .lock()
            .map_err(|e| AppError::Other(format!("db conn mutex: {e}")))?;
        conn.execute(
            "DELETE FROM _pending_publish WHERE id = ?1",
            params![row.id],
        )?;
        drop(conn);
        flushed += 1;
    }
    Ok(flushed)
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
        }
        // Anything else (e.g. `*.tmp` from in-progress writes) is skipped.
    }
    Ok(peers)
}

// ---------------------------------------------------------------------------
// Watermark + outbox SQL.
// ---------------------------------------------------------------------------

fn read_last_event_id(tx: &rusqlite::Transaction, peer: &str) -> AppResult<Option<String>> {
    let v: Option<Option<String>> = tx
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
        let db = Db {
            conn: Arc::new(Mutex::new(conn)),
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
        let mut env = setup("self");
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

    // -----------------------------------------------------------------------
    // Peer log discovery + apply
    // -----------------------------------------------------------------------

    #[test]
    fn applies_events_from_a_single_peer_log() {
        let mut env = setup("self");
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
        let mut env = setup("self");
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
        let mut env = setup("self");
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
        let mut env = setup("self");
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
        let mut env = setup("self");
        let report = env.engine.tick(&env.db).unwrap();
        // Self log was created at setup → 1 peer (self).
        assert_eq!(report.peers_seen, 1);
        assert_eq!(report.events_applied, 0);
        assert_eq!(report.outbox_flushed, 0);
    }

    #[test]
    fn malformed_snapshot_is_skipped_not_fatal() {
        let mut env = setup("self");
        let bad = env.shared.join("logs/peer-X.snapshot.json");
        fs::write(&bad, b"{not valid json").unwrap();
        // Tick must not error; bad file is logged + skipped.
        let report = env.engine.tick(&env.db).unwrap();
        assert_eq!(report.snapshots_applied, 0);
        assert_eq!(report.events_applied, 0);
    }

    #[test]
    fn fk_pragma_restored_even_when_merge_errors() {
        // Regression for PR #189 finding #4: a malformed event inside the
        // log triggers an error inside `apply_in_tx`, which used to skip
        // the `PRAGMA foreign_keys = ON` restore. Inject one (a
        // book.metadata.set with a number where a string is expected) and
        // assert the connection's FK pragma is back to ON after tick
        // returns Err.
        let mut env = setup("self");
        let bad = vec![
            ev(1000, "peer-A", import("b1")),
            ev(
                2000,
                "peer-A",
                EventBody::BookMetadataSet {
                    book: "b1".into(),
                    field: "title".into(),
                    value: serde_json::json!(42), // wrong type — apply_book_metadata returns Err
                },
            ),
        ];
        write_peer_log(&env.shared, "peer-A", &bad);

        // Pre-set FK ON so the restore is observable.
        env.conn().execute_batch("PRAGMA foreign_keys = ON;").unwrap();
        let result = env.engine.tick(&env.db);
        assert!(result.is_err(), "malformed metadata event should propagate");

        let fk: i64 = env
            .conn()
            .query_row("PRAGMA foreign_keys", [], |r| r.get(0))
            .unwrap();
        assert_eq!(fk, 1, "FK must be restored to ON even after a tick error");
    }

    /// Regression for umbrella-PR review finding #3: every successful
    /// `tick()` must bump self's `_replay_state.updated_at` so the
    /// settings UI's "Last sync" reflects the most recent tick — not
    /// only the ones that happened to move a peer watermark. A no-op
    /// tick is still a successful tick from the user's perspective.
    #[test]
    fn tick_bumps_self_updated_at_even_on_noop() {
        let mut env = setup("self");

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
        let mut env = setup("self");
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

    #[test]
    fn fk_pragma_restored_after_tick() {
        let mut env = setup("self");
        env.conn().execute_batch("PRAGMA foreign_keys = ON;").unwrap();
        env.engine.tick(&env.db).unwrap();
        let fk: i64 = env
            .conn()
            .query_row("PRAGMA foreign_keys", [], |r| r.get(0))
            .unwrap();
        assert_eq!(fk, 1, "FK should be restored to ON after tick");
    }
}
