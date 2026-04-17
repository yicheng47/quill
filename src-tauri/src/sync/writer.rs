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
//! 2. **Per-book progress throttle.** `book.progress.set` fires on every
//!    page turn — without coalescing the log would balloon during a single
//!    reading session. We apply a leading-edge throttle keyed on `book_id`:
//!    the first event in any 2-second window emits, subsequent ones in the
//!    same window are dropped. SQL is always written, so the local view
//!    stays current; peers see updates roughly every 2 s. The spec calls
//!    for trailing-edge debounce ("only the last call in the window
//!    appends"), but trailing-edge needs a background timer to flush the
//!    final pending event. Leading-edge is functionally equivalent for the
//!    "10 calls → 1 event" contract and avoids the timer; the worst-case
//!    drift is one window's worth of staleness from peers' perspective. If
//!    we ever need the trailing semantics, swap the throttle map for a
//!    `HashMap<String, JoinHandle<()>>` and re-publish on each call.
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
    /// pushes into `_pending_publish`; commit; then flush the outbox to
    /// the device log if sync is enabled.
    ///
    /// Returns whatever the closure returns. Errors from `f`, the SQL
    /// commit, or the outbox insert all roll the transaction back — both
    /// SQL and event emission are tied together. Errors from the **post-
    /// commit** log append are logged but not propagated: the row is
    /// already in `_pending_publish`, so the next successful flush (this
    /// command, the next command, or `ReplayEngine::tick`) republishes it.
    /// Surfacing those errors to the caller would force every UI write to
    /// handle an iCloud transient as a hard failure.
    pub fn with_tx<F, R>(&self, db: &Db, f: F) -> AppResult<R>
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

        let now_ms = chrono::Utc::now().timestamp_millis();

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
                let filtered = self.apply_throttle(events, now_ms);
                for body in &filtered {
                    let id = uuid::Uuid::new_v4().to_string();
                    let body_json = serde_json::to_string(body).map_err(|e| {
                        AppError::Other(format!("event serialize: {e}"))
                    })?;
                    tx.execute(
                        "INSERT INTO _pending_publish (id, ts, body_json, created_at)
                         VALUES (?1, ?2, ?3, ?2)",
                        params![id, now_ms, body_json],
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

    /// Drop `book.progress.set` events that fall inside an active
    /// throttle window, leave everything else untouched.
    fn apply_throttle(&self, events: Vec<EventBody>, now_ms: i64) -> Vec<EventBody> {
        let mut throttle = match self.progress_throttle.lock() {
            Ok(g) => g,
            Err(_) => return events, // poisoned mutex → fail open, never lose events
        };
        let mut out = Vec::with_capacity(events.len());
        for ev in events {
            if let EventBody::BookProgressSet { book, .. } = &ev {
                if let Some(last) = throttle.get(book).copied() {
                    if now_ms - last < PROGRESS_THROTTLE_MS {
                        continue;
                    }
                }
                throttle.insert(book.clone(), now_ms);
            }
            out.push(ev);
        }
        out
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
        let db = Db::init(&dir.path().to_path_buf()).unwrap();
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
            .with_tx(&db, |tx, events| {
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

        let result: AppResult<()> = writer.with_tx(&db, |tx, _events| {
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
            .with_tx(&db, |tx, events| {
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

    #[test]
    fn sync_enabled_multi_event_batch_appends_in_order() {
        let (dir, db) = setup_db();
        let writer = SyncWriter::new("dev-A".into());
        let log = enable_sync(&writer, dir.path());

        writer
            .with_tx(&db, |tx, events| {
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
            .with_tx(&db, |tx, _events| {
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

    // -------- per-book progress throttle --------

    #[test]
    fn progress_throttle_collapses_rapid_calls_into_one_event() {
        let (dir, db) = setup_db();
        let writer = SyncWriter::new("dev-A".into());
        let log = enable_sync(&writer, dir.path());

        // Seed the book.
        writer
            .with_tx(&db, |tx, events| {
                insert_book_row(tx, "b1", 1_000, "dev-A")?;
                events.push(import_body("b1"));
                Ok(())
            })
            .unwrap();
        assert_eq!(log.read_all().unwrap().len(), 1);

        // 10 rapid progress updates — only the first is allowed through;
        // the next nine fall inside the 2 s throttle window.
        for i in 0..10 {
            writer
                .with_tx(&db, |tx, events| {
                    tx.execute(
                        "UPDATE books SET progress = ?1, updated_at = ?2, updated_by_device = ?3 WHERE id = ?4",
                        params![i, 2_000 + i as i64, "dev-A", "b1"],
                    )?;
                    events.push(EventBody::BookProgressSet {
                        book: "b1".into(),
                        progress: i,
                        cfi: Some(format!("c{i}")),
                    });
                    Ok(())
                })
                .unwrap();
        }

        // SQL has the latest progress (9) — throttle never blocks SQL writes.
        let conn = db.conn.lock().unwrap();
        let progress: i32 = conn
            .query_row("SELECT progress FROM books WHERE id = 'b1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(progress, 9);
        drop(conn);

        // Log: import + exactly one progress event = 2.
        let events = log.read_all().unwrap();
        assert_eq!(events.len(), 2, "rapid progress writes should coalesce to 1");
        assert!(matches!(events[0].body, EventBody::BookImport(_)));
        assert!(matches!(events[1].body, EventBody::BookProgressSet { .. }));
    }

    #[test]
    fn progress_throttle_is_per_book() {
        let (dir, db) = setup_db();
        let writer = SyncWriter::new("dev-A".into());
        let log = enable_sync(&writer, dir.path());

        // Two books, two progress updates each — every event passes
        // because the throttle key is per-book.
        for id in ["b1", "b2"] {
            writer
                .with_tx(&db, |tx, events| {
                    insert_book_row(tx, id, 1_000, "dev-A")?;
                    events.push(import_body(id));
                    Ok(())
                })
                .unwrap();
        }
        for id in ["b1", "b2"] {
            writer
                .with_tx(&db, |tx, events| {
                    tx.execute(
                        "UPDATE books SET progress = 50, updated_at = ?1, updated_by_device = ?2 WHERE id = ?3",
                        params![2_000_i64, "dev-A", id],
                    )?;
                    events.push(EventBody::BookProgressSet {
                        book: id.into(),
                        progress: 50,
                        cfi: None,
                    });
                    Ok(())
                })
                .unwrap();
        }

        let n_progress = log
            .read_all()
            .unwrap()
            .into_iter()
            .filter(|e| matches!(e.body, EventBody::BookProgressSet { .. }))
            .count();
        assert_eq!(n_progress, 2, "throttle is per-book — both should pass");
    }

    /// Non-progress events bypass the throttle entirely. A burst of rapid
    /// highlight writes must produce one event per call.
    #[test]
    fn throttle_does_not_apply_to_other_event_types() {
        let (dir, db) = setup_db();
        let writer = SyncWriter::new("dev-A".into());
        let log = enable_sync(&writer, dir.path());

        writer
            .with_tx(&db, |tx, events| {
                insert_book_row(tx, "b1", 1_000, "dev-A")?;
                events.push(import_body("b1"));
                Ok(())
            })
            .unwrap();

        for i in 0..5 {
            let id = format!("h{i}");
            let id_clone = id.clone();
            writer
                .with_tx(&db, |tx, events| {
                    tx.execute(
                        "INSERT INTO highlights
                         (id, book_id, cfi_range, color, created_at, updated_at, updated_by_device)
                         VALUES (?1, 'b1', 'cfi', 'yellow', ?2, ?2, ?3)",
                        params![id_clone, 2_000_i64 + i, "dev-A"],
                    )?;
                    events.push(EventBody::HighlightAdd(HighlightPayload {
                        id,
                        book_id: "b1".into(),
                        cfi_range: "cfi".into(),
                        color: "yellow".into(),
                        note: None,
                        text_content: None,
                    }));
                    Ok(())
                })
                .unwrap();
        }

        let n_highlights = log
            .read_all()
            .unwrap()
            .into_iter()
            .filter(|e| matches!(e.body, EventBody::HighlightAdd(_)))
            .count();
        assert_eq!(n_highlights, 5);
    }
}
