//! `SyncWriter` — the chokepoint every mutating command goes through.
//!
//! Two responsibilities:
//!
//! 1. **One transaction per command.** `with_tx` opens a SQL transaction,
//!    runs the caller's closure with `(tx, events)`, writes the collected
//!    `EventBody` values into the local `_pending_publish` outbox **inside
//!    the same transaction**, commits, then flushes `_pending_publish` into
//!    the per-device log (one fsync). Order is deliberate — see the spec
//!    Step 3 / `31-sync-known-problems.md` §1 for the failure-mode
//!    rationale: SQL commit succeeds and log append fails ⇒ retried by the
//!    next successful flush (own outbox or `ReplayEngine::tick`); the
//!    inverted order would leak events to peers without a local row.
//!
//!    The caller passes `ts: i64` so the outbox row, the published event,
//!    and the SQL `updated_at` all share one logical timestamp. Letting
//!    the writer mint its own `now_ms` (as a previous revision did) caused
//!    snapshot-equivalence drift: any command that crosses a millisecond
//!    boundary between picking its `now` and entering `with_tx` would
//!    write SQL with one ts and emit an event with another, leaving local
//!    state ≠ replayed state on peers.
//!
//! 2. **Per-book progress throttle (opt-in).** `book.progress.set` fires
//!    on every page turn — without coalescing the log would balloon during
//!    a single reading session. `should_emit_progress(book_id)` returns
//!    `true` at most once per 2-second window per book; callers (only
//!    `update_reading_progress` today) gate the event push on it. SQL is
//!    always written, so the local view stays current; peers see updates
//!    roughly every 2 s.
//!
//!    The throttle is **deliberately not applied inside `with_tx`**.
//!    Doing so would silently drop progress events synthesized by
//!    semantic transitions like `mark_finished` if the user clicked
//!    Finish within 2 s of the last page turn — peers would end up with
//!    `status = finished` and stale progress. Keeping the throttle on
//!    the noisy call site only is what makes that distinction safe.
//!
//! When sync is **disabled** (`set_log(None)`), the events vec is filled
//! by the closure but discarded after the SQL commit — zero outbox writes,
//! zero log writes. The exact same closure works in both modes; commands
//! don't branch on sync state.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use rusqlite::{params, Transaction};

use crate::db::Db;
use crate::error::{AppError, AppResult};

use super::events::EventBody;
use super::log::EventLog;
use super::replay;

/// Minimum gap between two `book.progress.set` events for the same book
/// before the second one is allowed through. See the throttle discussion
/// in the module docstring.
const PROGRESS_THROTTLE_MS: i64 = 2_000;

pub struct SyncWriter {
    /// UUID of this device. Stamped into LWW row writes via the closure
    /// (callers read it from `self_device()` and pass to the SQL UPDATE).
    /// Sync writers don't drive the column on their own — every command
    /// already builds its own SQL, so the writer just exposes the value.
    self_device: String,
    /// `Some(log)` when sync is enabled, `None` otherwise. Flipped by
    /// `set_log` from the sync_enable / sync_disable command handlers
    /// (Chunk 7) — until then it stays `None` and `with_tx` is a pure
    /// SQL pass-through.
    log: Mutex<Option<Arc<EventLog>>>,
    /// Per-book leading-edge throttle for `book.progress.set`. Key: book
    /// id. Value: unix millis of the most recent event we let through.
    progress_throttle: Mutex<HashMap<String, i64>>,
}

impl SyncWriter {
    pub fn new(self_device: String) -> Self {
        Self {
            self_device,
            log: Mutex::new(None),
            progress_throttle: Mutex::new(HashMap::new()),
        }
    }

    pub fn self_device(&self) -> &str {
        &self.self_device
    }

    /// Toggle sync on/off. `Some(log)` means "events get queued and
    /// flushed"; `None` means "events are collected by closures and then
    /// discarded after commit". Called from `sync_enable` /
    /// `sync_disable` in Chunk 7.
    pub fn set_log(&self, log: Option<Arc<EventLog>>) {
        let mut guard = self.log.lock().expect("SyncWriter log mutex poisoned");
        *guard = log;
    }

    /// Test/probe accessor — `true` when an `EventLog` is wired up.
    pub fn is_sync_enabled(&self) -> bool {
        self.log
            .lock()
            .map(|g| g.is_some())
            .unwrap_or(false)
    }

    /// Run `f` inside a SQL transaction; queue any events the closure
    /// pushes into `_pending_publish` at timestamp `ts`; commit; then
    /// flush the outbox to the device log if sync is enabled.
    ///
    /// `ts` is the command's own logical timestamp (typically the same
    /// `chrono::Utc::now().timestamp_millis()` it stamps onto SQL
    /// `updated_at`). Reusing one ts across SQL writes, the outbox row,
    /// and the published event preserves the snapshot-equivalence
    /// invariant: replaying our own log on a peer must produce the same
    /// row state we have locally.
    ///
    /// Returns whatever the closure returns. Errors from `f`, the SQL
    /// commit, or the outbox insert all roll the transaction back — both
    /// SQL and event emission are tied together. Errors from the **post-
    /// commit** log append are logged but not propagated: the row is
    /// already in `_pending_publish`, so the next successful flush (this
    /// command, the next command, or `ReplayEngine::tick`) republishes it.
    /// Surfacing those errors to the caller would force every UI write to
    /// handle an iCloud transient as a hard failure.
    pub fn with_tx<F, R>(&self, db: &Db, ts: i64, f: F) -> AppResult<R>
    where
        F: FnOnce(&Transaction, &mut Vec<EventBody>) -> AppResult<R>,
    {
        // Snapshot the log handle once. Holding the log mutex across the
        // SQL transaction would serialize every writer; cloning the Arc
        // and dropping the lock keeps writers parallel.
        let log_snapshot = self
            .log
            .lock()
            .map_err(|e| AppError::Other(format!("SyncWriter log mutex: {e}")))?
            .clone();
        let sync_enabled = log_snapshot.is_some();

        // Phase 1 — closure + outbox enqueue + commit, all under one
        // db.conn lock.
        let result = {
            let conn = db
                .conn
                .lock()
                .map_err(|e| AppError::Other(format!("db conn mutex: {e}")))?;
            let tx = conn.unchecked_transaction()?;
            let mut events: Vec<EventBody> = Vec::new();
            let result = f(&tx, &mut events)?;

            if sync_enabled && !events.is_empty() {
                // `created_at` is just bookkeeping for the outbox row's
                // own lifecycle; we use the same `ts` so a single command
                // produces a single bookkeeping timestamp. The publish ts
                // (`ts` column) is what flows out to peers.
                for body in &events {
                    let id = uuid::Uuid::new_v4().to_string();
                    let body_json = serde_json::to_string(body).map_err(|e| {
                        AppError::Other(format!("event serialize: {e}"))
                    })?;
                    tx.execute(
                        "INSERT INTO _pending_publish (id, ts, body_json, created_at)
                         VALUES (?1, ?2, ?3, ?2)",
                        params![id, ts, body_json],
                    )?;
                }
            }
            // events is dropped here when sync is disabled — no disk cost.

            tx.commit()?;
            result
        }; // db.conn lock released.

        // Phase 2 — post-commit flush. Best effort; failures just leave
        // rows in the outbox for the next caller to retry.
        if let Some(log) = log_snapshot {
            let mut conn = db
                .conn
                .lock()
                .map_err(|e| AppError::Other(format!("db conn mutex: {e}")))?;
            if let Err(e) = replay::flush_outbox(&mut conn, &log) {
                eprintln!("sync: post-commit outbox flush failed: {e}");
            }
        }

        Ok(result)
    }

    /// Per-book leading-edge throttle for `book.progress.set`. Returns
    /// `true` if the caller should emit a progress event for `book_id`
    /// now (and records the emission); `false` if we're inside the 2 s
    /// window since the last allowed emit.
    ///
    /// Live in the call site, not inside `with_tx`, so semantic-
    /// transition commands like `mark_finished` are never accidentally
    /// throttled — see the throttle discussion in the module docstring.
    pub fn should_emit_progress(&self, book_id: &str) -> bool {
        let now_ms = chrono::Utc::now().timestamp_millis();
        let mut throttle = match self.progress_throttle.lock() {
            // Poisoned mutex → fail open; never silently lose progress
            // emits because of an unrelated panic in another command.
            Err(_) => return true,
            Ok(g) => g,
        };
        if let Some(last) = throttle.get(book_id).copied() {
            if now_ms - last < PROGRESS_THROTTLE_MS {
                return false;
            }
        }
        throttle.insert(book_id.to_string(), now_ms);
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sync::events::{BookImportPayload, HighlightPayload};
    use rusqlite::Connection;
    use tempfile::TempDir;

    fn setup_db() -> (TempDir, Db) {
        let dir = TempDir::new().unwrap();
        let db = Db::init(dir.path()).unwrap();
        (dir, db)
    }

    fn enable_sync(writer: &SyncWriter, dir: &std::path::Path) -> Arc<EventLog> {
        let log_path = dir.join("logs").join(format!("{}.jsonl", writer.self_device()));
        let log = Arc::new(EventLog::open(&log_path, writer.self_device(), false).unwrap());
        writer.set_log(Some(log.clone()));
        log
    }

    fn outbox_count(conn: &Connection) -> i64 {
        conn.query_row("SELECT COUNT(*) FROM _pending_publish", [], |r| r.get(0))
            .unwrap()
    }

    fn book_count(conn: &Connection) -> i64 {
        conn.query_row("SELECT COUNT(*) FROM books", [], |r| r.get(0)).unwrap()
    }

    fn import_body(id: &str) -> EventBody {
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

    fn insert_book_row(tx: &Transaction, id: &str, ts: i64, device: &str) -> AppResult<()> {
        tx.execute(
            "INSERT INTO books
             (id, title, author, file_path, format, status, progress, created_at, updated_at, updated_by_device)
             VALUES (?1, 'T', 'A', 'books/x.epub', 'epub', 'unread', 0, ?2, ?2, ?3)",
            params![id, ts, device],
        )?;
        Ok(())
    }

    // -------- behaviour with sync DISABLED --------

    #[test]
    fn sync_disabled_commits_sql_and_drops_events() {
        let (_dir, db) = setup_db();
        let writer = SyncWriter::new("dev-A".into());

        let body = import_body("b1");
        writer
            .with_tx(&db, 1_000, |tx, events| {
                insert_book_row(tx, "b1", 1_000, "dev-A")?;
                events.push(body);
                Ok(())
            })
            .unwrap();

        let conn = db.conn.lock().unwrap();
        assert_eq!(book_count(&conn), 1);
        assert_eq!(outbox_count(&conn), 0, "outbox stays empty when sync is off");
    }

    #[test]
    fn sync_disabled_propagates_closure_error_and_rolls_back() {
        let (_dir, db) = setup_db();
        let writer = SyncWriter::new("dev-A".into());

        let result: AppResult<()> = writer.with_tx(&db, 1_000, |tx, _events| {
            insert_book_row(tx, "b1", 1_000, "dev-A")?;
            Err(AppError::Other("boom".into()))
        });
        assert!(result.is_err());

        let conn = db.conn.lock().unwrap();
        assert_eq!(book_count(&conn), 0, "tx must roll back on closure error");
    }

    // -------- behaviour with sync ENABLED --------

    #[test]
    fn sync_enabled_writes_outbox_then_drains_to_log() {
        let (dir, db) = setup_db();
        let writer = SyncWriter::new("dev-A".into());
        let log = enable_sync(&writer, dir.path());

        writer
            .with_tx(&db, 1_000, |tx, events| {
                insert_book_row(tx, "b1", 1_000, "dev-A")?;
                events.push(import_body("b1"));
                Ok(())
            })
            .unwrap();

        let conn = db.conn.lock().unwrap();
        assert_eq!(book_count(&conn), 1);
        assert_eq!(outbox_count(&conn), 0, "post-commit flush should drain the outbox");

        let events = log.read_all().unwrap();
        assert_eq!(events.len(), 1);
        match &events[0].body {
            EventBody::BookImport(p) => assert_eq!(p.id, "b1"),
            other => panic!("expected BookImport, got {other:?}"),
        }
        assert_eq!(events[0].device, "dev-A");
    }

    /// Regression for finding #5 in PR #191 review: the timestamp the
    /// caller passes into `with_tx` must match the `ts` field stamped onto
    /// every emitted event. A previous revision minted its own `now_ms`
    /// inside `with_tx`, so any command that crossed a millisecond
    /// boundary between picking its `now` and entering `with_tx` would
    /// write SQL `updated_at = T0` and emit an event with `ts = T1`,
    /// breaking snapshot equivalence on replayed peers.
    #[test]
    fn published_event_ts_equals_caller_ts() {
        let (dir, db) = setup_db();
        let writer = SyncWriter::new("dev-A".into());
        let log = enable_sync(&writer, dir.path());

        // Sleep before calling `with_tx` so the wall clock is guaranteed
        // to be past `caller_ts` by the time the writer runs — if the
        // writer minted its own ts the test would catch it.
        let caller_ts = chrono::Utc::now().timestamp_millis();
        std::thread::sleep(std::time::Duration::from_millis(5));

        writer
            .with_tx(&db, caller_ts, |tx, events| {
                insert_book_row(tx, "b1", caller_ts, "dev-A")?;
                events.push(import_body("b1"));
                Ok(())
            })
            .unwrap();

        let events = log.read_all().unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(
            events[0].ts, caller_ts,
            "event ts must equal the caller's ts (snapshot-equivalence invariant)"
        );

        let conn = db.conn.lock().unwrap();
        let updated_at: i64 = conn
            .query_row("SELECT updated_at FROM books WHERE id = 'b1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(
            updated_at, caller_ts,
            "SQL updated_at and event ts must match — they're the same logical value",
        );
    }

    #[test]
    fn sync_enabled_multi_event_batch_appends_in_order() {
        let (dir, db) = setup_db();
        let writer = SyncWriter::new("dev-A".into());
        let log = enable_sync(&writer, dir.path());

        writer
            .with_tx(&db, 1_000, |tx, events| {
                insert_book_row(tx, "b1", 1_000, "dev-A")?;
                tx.execute(
                    "INSERT INTO highlights
                     (id, book_id, cfi_range, color, created_at, updated_at, updated_by_device)
                     VALUES ('h1', 'b1', 'cfi', 'yellow', ?1, ?1, ?2)",
                    params![1_000_i64, "dev-A"],
                )?;
                events.push(import_body("b1"));
                events.push(EventBody::HighlightAdd(HighlightPayload {
                    id: "h1".into(),
                    book_id: "b1".into(),
                    cfi_range: "cfi".into(),
                    color: "yellow".into(),
                    note: None,
                    text_content: None,
                }));
                Ok(())
            })
            .unwrap();

        let events = log.read_all().unwrap();
        assert_eq!(events.len(), 2);
        assert!(matches!(events[0].body, EventBody::BookImport(_)));
        assert!(matches!(events[1].body, EventBody::HighlightAdd(_)));
    }

    /// Regression for the asymmetric-failure rationale in the spec:
    /// pre-existing rows in `_pending_publish` (left over from a prior
    /// `commit ok / append fail`) get drained on the next successful
    /// `with_tx` call, even if that call's own events list is empty.
    #[test]
    fn sync_enabled_drains_pre_existing_outbox_rows_on_next_call() {
        let (dir, db) = setup_db();
        let writer = SyncWriter::new("dev-A".into());
        let log = enable_sync(&writer, dir.path());

        // Simulate a previous failed flush by stuffing a row into the outbox
        // by hand.
        let body = import_body("b-orphan");
        let body_json = serde_json::to_string(&body).unwrap();
        {
            let conn = db.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO _pending_publish (id, ts, body_json, created_at)
                 VALUES (?1, ?2, ?3, ?2)",
                params![uuid::Uuid::new_v4().to_string(), 500_i64, body_json],
            )
            .unwrap();
            assert_eq!(outbox_count(&conn), 1);
        }

        // A subsequent unrelated write triggers the post-commit flush even
        // though it pushes no events itself.
        writer
            .with_tx(&db, 1_000, |tx, _events| {
                insert_book_row(tx, "b1", 1_000, "dev-A")?;
                Ok(())
            })
            .unwrap();

        let conn = db.conn.lock().unwrap();
        assert_eq!(outbox_count(&conn), 0);
        let log_events = log.read_all().unwrap();
        assert_eq!(log_events.len(), 1);
        match &log_events[0].body {
            EventBody::BookImport(p) => assert_eq!(p.id, "b-orphan"),
            other => panic!("expected the orphan event to flush, got {other:?}"),
        }
    }

    // -------- progress throttle (now opt-in via should_emit_progress) --------

    #[test]
    fn should_emit_progress_first_call_returns_true() {
        let writer = SyncWriter::new("dev-A".into());
        assert!(writer.should_emit_progress("b1"));
    }

    #[test]
    fn should_emit_progress_collapses_rapid_calls_to_one_per_window() {
        let writer = SyncWriter::new("dev-A".into());
        // 10 rapid checks within the same window — first is true, rest false.
        let allowed: usize = (0..10)
            .filter(|_| writer.should_emit_progress("b1"))
            .count();
        assert_eq!(allowed, 1, "rapid checks should coalesce to one per book");
    }

    #[test]
    fn should_emit_progress_is_per_book() {
        let writer = SyncWriter::new("dev-A".into());
        // Each book carries its own deadline.
        assert!(writer.should_emit_progress("b1"));
        assert!(writer.should_emit_progress("b2"));
        assert!(!writer.should_emit_progress("b1"));
        assert!(!writer.should_emit_progress("b2"));
    }

    /// Regression for finding #1 in PR #191 review: an event the closure
    /// pushes is published verbatim — `with_tx` does not silently filter
    /// `BookProgressSet` events. The throttle is now opt-in via
    /// `should_emit_progress`, so semantic transitions like
    /// `mark_finished` (which synthesize a progress event after the user
    /// just turned a page) cannot be silently swallowed.
    #[test]
    fn with_tx_does_not_drop_progress_events_inside_throttle_window() {
        let (dir, db) = setup_db();
        let writer = SyncWriter::new("dev-A".into());
        let log = enable_sync(&writer, dir.path());

        // Seed.
        writer
            .with_tx(&db, 1_000, |tx, events| {
                insert_book_row(tx, "b1", 1_000, "dev-A")?;
                events.push(import_body("b1"));
                Ok(())
            })
            .unwrap();

        // First simulated page-turn: caller asks the throttle whether to
        // emit (true), pushes the event.
        assert!(writer.should_emit_progress("b1"));
        writer
            .with_tx(&db, 2_000, |tx, events| {
                tx.execute(
                    "UPDATE books SET progress = 50, updated_at = ?1, updated_by_device = ?2 WHERE id = 'b1'",
                    params![2_000_i64, "dev-A"],
                )?;
                events.push(EventBody::BookProgressSet {
                    book: "b1".into(),
                    progress: 50,
                    cfi: Some("c50".into()),
                });
                Ok(())
            })
            .unwrap();

        // A semantic transition like mark_finished arrives inside the
        // throttle window. It deliberately does not consult the throttle
        // — and `with_tx` must publish the event regardless.
        writer
            .with_tx(&db, 2_100, |tx, events| {
                tx.execute(
                    "UPDATE books SET status='finished', progress=100, updated_at=?1, updated_by_device=?2 WHERE id='b1'",
                    params![2_100_i64, "dev-A"],
                )?;
                events.push(EventBody::BookStatusSet {
                    book: "b1".into(),
                    status: "finished".into(),
                });
                events.push(EventBody::BookProgressSet {
                    book: "b1".into(),
                    progress: 100,
                    cfi: Some("c50".into()),
                });
                Ok(())
            })
            .unwrap();

        // Log: import + first progress + status + finished progress = 4.
        let events = log.read_all().unwrap();
        assert_eq!(events.len(), 4, "all four events must publish");
        let progress_events: Vec<&EventBody> = events
            .iter()
            .map(|e| &e.body)
            .filter(|b| matches!(b, EventBody::BookProgressSet { .. }))
            .collect();
        assert_eq!(
            progress_events.len(),
            2,
            "both the page-turn and the mark-finished progress events must reach peers"
        );
    }
}
