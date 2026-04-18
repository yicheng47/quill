//! Snapshots — frozen materialized state of one peer's log, used for both
//! compaction (own log → snapshot) and bootstrap (peer snapshot → local DB).
//!
//! A snapshot is a JSON file at `<shared>/logs/<device>.snapshot.json` with
//! the shape:
//!
//! ```jsonc
//! {
//!   "v": 1,
//!   "device": "<uuid>",
//!   "id": "<latest event ULID included>",
//!   "generated_at": <unix millis>,
//!   "truncated_before": "<event id>" | null,   // null for migration snapshots
//!   "state": { "books": {...}, "highlights": {...}, ..., "tombstones": {...} }
//! }
//! ```
//!
//! `apply_peer` is the inverse: ingest a peer's snapshot into local SQLite
//! under the same merge rules as `merge::apply_event`. Per-row LWW (compare
//! `(updated_at, updated_by_device)` tuples), tombstones win over inserts,
//! `_replay_state` watermarks are updated monotonically. See Step 6 of
//! `docs/impls/sync/31-sync.md` for the apply procedure.

use std::collections::BTreeMap;
use std::fs;
use std::io::Write;
use std::path::Path;

use rusqlite::{params, Connection, Transaction};
use serde::{Deserialize, Serialize};
use ulid::Ulid;

use crate::db::Db;
use crate::error::{AppError, AppResult};

use super::events::Event;
use super::log::EventLog;
use super::merge;

/// Compaction is triggered when the log crosses any of these
/// thresholds. The numbers are the spec's defaults — small enough
/// that a chatty session doesn't bloat the log, large enough that
/// a casual reader almost never trips compaction inside a single
/// session.
pub const COMPACT_LOG_BYTE_THRESHOLD: u64 = 2 * 1024 * 1024; // 2 MB
pub const COMPACT_LOG_EVENT_THRESHOLD: usize = 5_000;
pub const COMPACT_AGE_THRESHOLD_MS: i64 = 30 * 24 * 60 * 60 * 1_000; // 30 days

pub const SNAPSHOT_SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Snapshot {
    pub v: u32,
    pub device: String,
    /// ULID of the last event included in `state`. For a from-log snapshot
    /// this is the highest event id from the source log; for migration
    /// snapshots it's a freshly-minted ULID.
    pub id: String,
    pub generated_at: i64,
    /// Compaction watermark — events with id `<= truncated_before` in the
    /// source log can safely be discarded after the snapshot lands. `None`
    /// for migration snapshots, which are written before any log exists.
    pub truncated_before: Option<String>,
    pub state: SnapshotState,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct SnapshotState {
    #[serde(default)]
    pub books: BTreeMap<String, BookRow>,
    #[serde(default)]
    pub highlights: BTreeMap<String, HighlightRow>,
    #[serde(default)]
    pub bookmarks: BTreeMap<String, BookmarkRow>,
    #[serde(default)]
    pub vocab_words: BTreeMap<String, VocabRow>,
    #[serde(default)]
    pub translations: BTreeMap<String, TranslationRow>,
    #[serde(default)]
    pub collections: BTreeMap<String, CollectionRow>,
    /// Keyed by `"<collection_id>:<book_id>"` — the same composite key the
    /// merge engine uses for tombstones.
    #[serde(default)]
    pub collection_books: BTreeMap<String, CollectionBookRow>,
    #[serde(default)]
    pub chats: BTreeMap<String, ChatRow>,
    #[serde(default)]
    pub chat_messages: BTreeMap<String, ChatMessageRow>,
    /// `entity` (the same string in `_tombstones.entity`) → list of ids.
    #[serde(default)]
    pub tombstones: BTreeMap<String, Vec<TombstoneRow>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct BookRow {
    pub title: String,
    pub author: String,
    pub description: Option<String>,
    pub cover_path: Option<String>,
    pub file_path: String,
    pub genre: Option<String>,
    pub pages: Option<i64>,
    pub format: String,
    pub status: String,
    pub progress: i32,
    pub current_cfi: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    pub updated_by_device: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct HighlightRow {
    pub book_id: String,
    pub cfi_range: String,
    pub color: String,
    pub note: Option<String>,
    pub text_content: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    pub updated_by_device: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct BookmarkRow {
    pub book_id: String,
    pub cfi: String,
    pub label: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct VocabRow {
    pub book_id: String,
    pub word: String,
    pub definition: String,
    pub context_sentence: Option<String>,
    pub cfi: Option<String>,
    pub mastery: String,
    pub review_count: i64,
    pub next_review_at: Option<i64>,
    pub created_at: i64,
    pub updated_at: i64,
    pub updated_by_device: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TranslationRow {
    pub book_id: String,
    pub source_text: String,
    pub translated_text: String,
    pub target_language: String,
    pub cfi: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CollectionRow {
    pub name: String,
    pub sort_order: i32,
    pub created_at: i64,
    pub updated_at: i64,
    pub updated_by_device: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CollectionBookRow {
    pub collection_id: String,
    pub book_id: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub updated_by_device: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ChatRow {
    pub book_id: String,
    pub title: String,
    pub model: Option<String>,
    pub pinned: bool,
    pub metadata: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    pub updated_by_device: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ChatMessageRow {
    pub chat_id: String,
    pub role: String,
    pub content: String,
    pub context: Option<String>,
    pub metadata: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TombstoneRow {
    pub id: String,
    pub ts: i64,
}

/// What `compact_own_log` did. Surfaced so the replay tick can log
/// it and the "Compact log" button can show feedback.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct CompactReport {
    /// Number of log events folded into the new snapshot. Zero when
    /// the log was already empty (no-op).
    pub events_folded: usize,
    /// True when a fresh snapshot file replaced the previous one.
    pub snapshot_written: bool,
    /// Bytes the log shrank by minus bytes the snapshot grew by. Can
    /// be negative on the first compaction (snapshot is brand new and
    /// larger than the log it replaces).
    pub bytes_freed: i64,
}

/// Outcome reported back to the replay engine after a peer snapshot is
/// processed. Mirrors the watermark advance written into `_replay_state`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ApplyOutcome {
    /// Snapshot id matches `_replay_state.last_snapshot_id` — no-op.
    AlreadyApplied,
    /// Snapshot id `<=` `_replay_state.last_event_id`; we've already seen
    /// every event this snapshot summarises individually. Watermarks are
    /// advanced to `last_snapshot_id = snapshot.id` so we don't re-parse it.
    HeaderOnly,
    /// Snapshot rows applied; `last_snapshot_id` set, `last_event_id` bumped
    /// to `MAX(prev, snapshot.id)`.
    Applied,
}

impl Snapshot {
    /// Build a snapshot from an event sequence. Used by compaction (own log
    /// → own snapshot) and by tests. Folds events into an in-memory DB via
    /// `merge::apply_event`, then dumps the materialized rows back out as
    /// the snapshot state.
    ///
    /// `events` should already be in `(ts, device)` order — the same order
    /// `ReplayEngine::tick()` uses. The snapshot's `id` and
    /// `truncated_before` are set to the lexicographically largest event id
    /// seen (callers that want a more conservative truncation point can
    /// override `truncated_before` on the returned struct).
    pub fn from_events(device: &str, events: &[Event]) -> AppResult<Self> {
        let mut conn = Connection::open_in_memory()?;
        // Match the FK posture of the replay engine — see merge.rs module
        // doc for why FK is off during apply.
        Db::run_migrations_on(&conn)?;
        conn.execute_batch("PRAGMA foreign_keys = OFF;")?;
        {
            let tx = conn.transaction()?;
            for ev in events {
                merge::apply_event(&tx, ev)?;
            }
            tx.commit()?;
        }

        let state = dump_state(&conn)?;
        let max_id = events
            .iter()
            .map(|e| e.id.clone())
            .max()
            .unwrap_or_else(|| Ulid::nil().to_string());

        Ok(Snapshot {
            v: SNAPSHOT_SCHEMA_VERSION,
            device: device.to_string(),
            id: max_id.clone(),
            generated_at: chrono::Utc::now().timestamp_millis(),
            truncated_before: Some(max_id),
            state,
        })
    }

    /// Build a snapshot directly from an open quill.db (legacy file-sync
    /// or freshly-migrated local DB). Skips the merge-engine roundtrip
    /// because the DB already holds the materialized state — we just dump
    /// every synced table.
    ///
    /// `id` is freshly minted (no log exists yet — peers will treat this
    /// as a brand-new snapshot id in their `_replay_state` watermarks).
    /// `truncated_before` is `None` so peers don't try to truncate a tail
    /// that doesn't exist on this device.
    ///
    /// Used by `migration::run_migration` to bootstrap the per-device log
    /// from a legacy DB. Caller is responsible for ensuring `conn` has
    /// already been migrated to the current schema (Db::init does this).
    pub fn from_legacy_db(conn: &Connection, device: &str) -> AppResult<Self> {
        let state = dump_state(conn)?;
        let id = Ulid::new().to_string();
        Ok(Snapshot {
            v: SNAPSHOT_SCHEMA_VERSION,
            device: device.to_string(),
            id,
            generated_at: chrono::Utc::now().timestamp_millis(),
            truncated_before: None,
            state,
        })
    }

    /// Atomic write — temp file, fsync, rename, parent-dir fsync.
    /// Crash-safe: when this returns, the snapshot's contents AND its
    /// new directory entry are both on disk. Without the parent-dir
    /// fsync, a power loss between `rename` and the next implicit
    /// directory flush can resurrect the previous snapshot at the
    /// path — which would silently corrupt compaction (the caller
    /// would proceed to truncate the source log against a snapshot
    /// that's no longer on disk).
    pub fn write_atomic(&self, path: &Path) -> AppResult<()> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        let tmp = path.with_extension("snapshot.json.tmp");
        let bytes = serde_json::to_vec(self)
            .map_err(|e| AppError::Other(format!("snapshot serialize: {e}")))?;
        let mut f = fs::OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .open(&tmp)?;
        f.write_all(&bytes)?;
        f.sync_all()?;
        drop(f);
        fs::rename(&tmp, path)?;
        fsync_parent_dir(path)?;
        Ok(())
    }

    pub fn read_from(path: &Path) -> AppResult<Self> {
        let bytes = fs::read(path)?;
        serde_json::from_slice(&bytes)
            .map_err(|e| AppError::Other(format!("snapshot parse: {e}")))
    }

    /// Apply this snapshot into local SQLite. Idempotent under repeated
    /// application; tombstones in `state.tombstones` are written first so
    /// the entity rows that follow can short-circuit on the local-tombstone
    /// check. Watermarks are advanced per Step 6 of the spec.
    ///
    /// `peer_device` is the keyed `_replay_state.peer_device` — usually
    /// `self.device`, but the caller passes it explicitly so this works for
    /// the migration apply-back case (where the snapshot's `device` is the
    /// migrating device but `_replay_state` still treats it as a peer).
    pub fn apply_peer(&self, tx: &Transaction, peer_device: &str) -> AppResult<ApplyOutcome> {
        let prior: Option<(Option<String>, Option<String>)> = tx
            .query_row(
                "SELECT last_snapshot_id, last_event_id
                 FROM _replay_state WHERE peer_device = ?1",
                params![peer_device],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .map(Some)
            .or_else(|e| match e {
                rusqlite::Error::QueryReturnedNoRows => Ok(None),
                other => Err(other),
            })?;

        let prior_snap = prior.as_ref().and_then(|(s, _)| s.clone());
        let prior_event = prior.as_ref().and_then(|(_, e)| e.clone());

        if prior_snap.as_deref() == Some(self.id.as_str()) {
            return Ok(ApplyOutcome::AlreadyApplied);
        }

        // Spec step 4b: snapshot summarises events we've already individually
        // applied — skip rows but bump last_snapshot_id so we don't re-parse.
        if prior_event.as_deref().is_some_and(|e| e >= self.id.as_str()) {
            upsert_replay_state(tx, peer_device, Some(&self.id), prior_event.as_deref())?;
            return Ok(ApplyOutcome::HeaderOnly);
        }

        // Spec step 5: tombstones first. Route every entry through
        // `merge::cascade_delete` so a snapshot ingest scrubs the same
        // child rows that the corresponding event-path delete would have
        // — otherwise applying a peer snapshot leaves orphan highlights
        // for a deleted book, stranded `collection_books` joins for a
        // removed pair, etc.
        for (entity, list) in &self.state.tombstones {
            for t in list {
                merge::cascade_delete(tx, entity, &t.id, t.ts)?;
                merge::insert_tombstone(tx, entity, &t.id, t.ts)?;
            }
        }

        for (id, row) in &self.state.books {
            if merge::is_tombstoned(tx, merge::entity::BOOK, id)? {
                continue;
            }
            upsert_book(tx, id, row)?;
        }
        for (id, row) in &self.state.highlights {
            if merge::is_tombstoned(tx, merge::entity::HIGHLIGHT, id)? {
                continue;
            }
            upsert_highlight(tx, id, row)?;
        }
        for (id, row) in &self.state.bookmarks {
            if merge::is_tombstoned(tx, merge::entity::BOOKMARK, id)? {
                continue;
            }
            insert_bookmark(tx, id, row)?;
        }
        for (id, row) in &self.state.vocab_words {
            if merge::is_tombstoned(tx, merge::entity::VOCAB, id)? {
                continue;
            }
            upsert_vocab(tx, id, row)?;
        }
        for (id, row) in &self.state.translations {
            if merge::is_tombstoned(tx, merge::entity::TRANSLATION, id)? {
                continue;
            }
            insert_translation(tx, id, row)?;
        }
        for (id, row) in &self.state.collections {
            if merge::is_tombstoned(tx, merge::entity::COLLECTION, id)? {
                continue;
            }
            upsert_collection(tx, id, row)?;
        }
        for (key, row) in &self.state.collection_books {
            if merge::is_tombstoned(tx, merge::entity::COLLECTION_BOOK, key)? {
                continue;
            }
            upsert_collection_book(tx, row)?;
        }
        for (id, row) in &self.state.chats {
            if merge::is_tombstoned(tx, merge::entity::CHAT, id)? {
                continue;
            }
            upsert_chat(tx, id, row)?;
        }
        for (id, row) in &self.state.chat_messages {
            if merge::is_tombstoned(tx, merge::entity::CHAT_MESSAGE, id)? {
                continue;
            }
            insert_chat_message(tx, id, row)?;
        }

        // Watermarks: last_snapshot_id moves to this snapshot's id;
        // last_event_id is monotonic — never decrease.
        let new_event_id = match prior_event.as_deref() {
            Some(prev) if prev > self.id.as_str() => prior_event.clone(),
            _ => Some(self.id.clone()),
        };
        upsert_replay_state(tx, peer_device, Some(&self.id), new_event_id.as_deref())?;
        Ok(ApplyOutcome::Applied)
    }
}

/// Open the parent directory of `path` and `fsync` it. POSIX requires
/// this for a preceding `rename` to actually survive a power cut: the
/// data write + `fsync` makes the temp file durable, the rename
/// updates the in-memory directory, but the directory entry only
/// hits the disk when the directory itself is fsynced. Without it,
/// `compact_own_log` could leave the empty log entry durable while
/// the snapshot's new directory entry is still in cache, dropping
/// every event the log held.
///
/// Best-effort no-op on Windows — we don't ship sync there in v1, and
/// `File::open(parent)` on a directory has different semantics that
/// would need a separate `CreateFileW` path.
#[cfg(unix)]
fn fsync_parent_dir(path: &Path) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        let dir = fs::File::open(parent)?;
        dir.sync_all()?;
    }
    Ok(())
}

#[cfg(not(unix))]
fn fsync_parent_dir(_path: &Path) -> std::io::Result<()> {
    Ok(())
}

// ---------------------------------------------------------------------------
// Compaction — fold prior snapshot + log into a fresh snapshot, truncate log.
// ---------------------------------------------------------------------------

/// True when the device's own log meets any compaction threshold:
/// size > 2 MB, > 5000 events, or last snapshot is older than 30 days
/// (and the log has at least one event to fold). Cheap — only `stat`s
/// the log + reads the snapshot header, never the full event stream.
///
/// `false` when the log doesn't exist yet (fresh enable, no events
/// emitted) or every threshold is below the limit.
pub fn should_compact(shared_dir: &Path, device: &str) -> bool {
    let log_path = shared_dir
        .join("logs")
        .join(format!("{device}.jsonl"));
    let snap_path = shared_dir
        .join("logs")
        .join(format!("{device}.snapshot.json"));

    let Ok(meta) = fs::metadata(&log_path) else {
        return false;
    };
    if meta.len() > COMPACT_LOG_BYTE_THRESHOLD {
        return true;
    }

    // Cheap line count via byte scan — avoids deserializing every event
    // just to decide whether compaction is needed.
    let log_lines = match fs::read(&log_path) {
        Ok(b) => b.iter().filter(|&&c| c == b'\n').count(),
        Err(_) => 0,
    };
    if log_lines > COMPACT_LOG_EVENT_THRESHOLD {
        return true;
    }
    if log_lines == 0 {
        return false;
    }

    // The age trigger only applies when a snapshot exists. The
    // first-snapshot case is owned by `sync_enable` /
    // `migration::run_migration`; if neither has run yet, compaction
    // staying out of the way is the right move (compacting an empty
    // pre-bootstrap state would just publish a snapshot of nothing).
    if let Ok(snap) = Snapshot::read_from(&snap_path) {
        let now = chrono::Utc::now().timestamp_millis();
        if now - snap.generated_at > COMPACT_AGE_THRESHOLD_MS {
            return true;
        }
    }

    false
}

/// Compact the device's own log: fold the existing snapshot + every
/// event currently in the log into a fresh snapshot, then truncate
/// the log to events past the new watermark (typically empty).
///
/// Concurrency: the entire read-fold-write-truncate sequence runs
/// inside `EventLog::with_locked_log`, so concurrent `append`s from
/// `SyncWriter` block until compaction finishes. Compaction is rare
/// (every few minutes/days at most) so the brief stall is fine.
///
/// Idempotent: running compaction twice on an unchanged log is a
/// no-op the second time (log is already empty after the first run).
pub fn compact_own_log(
    shared_dir: &Path,
    log_handle: &EventLog,
) -> AppResult<CompactReport> {
    let device = log_handle.device().to_string();
    let snap_path = shared_dir
        .join("logs")
        .join(format!("{device}.snapshot.json"));

    let pre_log_size = fs::metadata(log_handle.path()).map(|m| m.len() as i64).unwrap_or(0);
    let pre_snap_size = fs::metadata(&snap_path).map(|m| m.len() as i64).unwrap_or(0);

    let report = log_handle.with_locked_log(|log_path, events| {
        if events.is_empty() {
            return Ok(CompactReport::default());
        }

        // Fold the prior snapshot (if any) + every log event into a
        // fresh in-memory DB, then dump as the new snapshot. Same
        // engine merge::apply_event uses for peer events — guarantees
        // the snapshot reflects the same state a peer would compute.
        let prior = if snap_path.exists() {
            Some(Snapshot::read_from(&snap_path)?)
        } else {
            None
        };

        let mut conn = Connection::open_in_memory()?;
        Db::run_migrations_on(&conn)?;
        conn.execute_batch("PRAGMA foreign_keys = OFF;")?;
        {
            let tx = conn.transaction()?;
            if let Some(s) = &prior {
                s.apply_peer(&tx, &device)?;
            }
            for ev in events {
                merge::apply_event(&tx, ev)?;
            }
            tx.commit()?;
        }
        let state = dump_state(&conn)?;

        // The new snapshot's watermark is the highest event id we
        // just folded. After truncation the log is empty, so any
        // peer reading the snapshot has no log tail to consume —
        // exactly the post-compaction invariant we want.
        let new_truncated = events
            .iter()
            .map(|e| e.id.clone())
            .max()
            .or_else(|| prior.as_ref().and_then(|s| s.truncated_before.clone()));

        let new_snap = Snapshot {
            v: SNAPSHOT_SCHEMA_VERSION,
            device: device.clone(),
            id: new_truncated
                .clone()
                .unwrap_or_else(|| Ulid::new().to_string()),
            generated_at: chrono::Utc::now().timestamp_millis(),
            truncated_before: new_truncated,
            state,
        };
        // Step 1: durably commit the new snapshot. `write_atomic`
        // includes a parent-dir fsync — when it returns, the snapshot's
        // directory entry survives a power cut. THIS MUST HAPPEN
        // BEFORE the log is truncated; otherwise a crash window where
        // the empty-log rename is durable but the snapshot rename is
        // not loses every event the log held.
        new_snap.write_atomic(&snap_path)?;

        // Step 2: truncate the log. Atomic temp + rename + fsync of
        // the empty file AND the parent dir so the truncation itself
        // is durable. Without these fsyncs, a crash here can come
        // back with the old log contents — fine for correctness
        // (next compaction folds them again, idempotent) but breaks
        // the storage-reclamation contract this function is here to
        // provide.
        let tmp = log_path.with_extension("jsonl.tmp");
        let f = fs::OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .open(&tmp)?;
        f.sync_all()?;
        drop(f);
        fs::rename(&tmp, log_path)?;
        fsync_parent_dir(log_path)?;

        Ok(CompactReport {
            events_folded: events.len(),
            snapshot_written: true,
            bytes_freed: 0, // computed below
        })
    })?;

    if !report.snapshot_written {
        return Ok(report);
    }

    let post_log_size = fs::metadata(log_handle.path()).map(|m| m.len() as i64).unwrap_or(0);
    let post_snap_size = fs::metadata(&snap_path).map(|m| m.len() as i64).unwrap_or(0);
    Ok(CompactReport {
        bytes_freed: (pre_log_size - post_log_size) - (post_snap_size - pre_snap_size),
        ..report
    })
}

// ---------------------------------------------------------------------------
// Per-table upserts. INSERT … ON CONFLICT … DO UPDATE WHERE pattern: insert if
// new, otherwise let LWW decide. Append-only tables use INSERT OR IGNORE
// (their rows are immutable post-creation).
// ---------------------------------------------------------------------------

fn upsert_book(tx: &Transaction, id: &str, r: &BookRow) -> AppResult<()> {
    tx.execute(
        "INSERT INTO books
         (id, title, author, description, cover_path, file_path, genre, pages,
          format, status, progress, current_cfi, created_at, updated_at, updated_by_device)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)
         ON CONFLICT(id) DO UPDATE SET
           title=excluded.title,
           author=excluded.author,
           description=excluded.description,
           cover_path=excluded.cover_path,
           file_path=excluded.file_path,
           genre=excluded.genre,
           pages=excluded.pages,
           format=excluded.format,
           status=excluded.status,
           progress=excluded.progress,
           current_cfi=excluded.current_cfi,
           updated_at=excluded.updated_at,
           updated_by_device=excluded.updated_by_device
         WHERE (books.updated_at, books.updated_by_device)
             < (excluded.updated_at, excluded.updated_by_device)",
        params![
            id, r.title, r.author, r.description, r.cover_path, r.file_path,
            r.genre, r.pages, r.format, r.status, r.progress, r.current_cfi,
            r.created_at, r.updated_at, r.updated_by_device,
        ],
    )?;
    Ok(())
}

fn upsert_highlight(tx: &Transaction, id: &str, r: &HighlightRow) -> AppResult<()> {
    tx.execute(
        "INSERT INTO highlights
         (id, book_id, cfi_range, color, note, text_content,
          created_at, updated_at, updated_by_device)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
         ON CONFLICT(id) DO UPDATE SET
           color=excluded.color,
           note=excluded.note,
           text_content=excluded.text_content,
           updated_at=excluded.updated_at,
           updated_by_device=excluded.updated_by_device
         WHERE (highlights.updated_at, highlights.updated_by_device)
             < (excluded.updated_at, excluded.updated_by_device)",
        params![
            id, r.book_id, r.cfi_range, r.color, r.note, r.text_content,
            r.created_at, r.updated_at, r.updated_by_device,
        ],
    )?;
    Ok(())
}

fn insert_bookmark(tx: &Transaction, id: &str, r: &BookmarkRow) -> AppResult<()> {
    tx.execute(
        "INSERT OR IGNORE INTO bookmarks
         (id, book_id, cfi, label, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![id, r.book_id, r.cfi, r.label, r.created_at, r.updated_at],
    )?;
    Ok(())
}

fn upsert_vocab(tx: &Transaction, id: &str, r: &VocabRow) -> AppResult<()> {
    tx.execute(
        "INSERT INTO vocab_words
         (id, book_id, word, definition, context_sentence, cfi,
          mastery, review_count, next_review_at,
          created_at, updated_at, updated_by_device)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
         ON CONFLICT(id) DO UPDATE SET
           mastery=excluded.mastery,
           review_count=excluded.review_count,
           next_review_at=excluded.next_review_at,
           updated_at=excluded.updated_at,
           updated_by_device=excluded.updated_by_device
         WHERE (vocab_words.updated_at, vocab_words.updated_by_device)
             < (excluded.updated_at, excluded.updated_by_device)",
        params![
            id, r.book_id, r.word, r.definition, r.context_sentence, r.cfi,
            r.mastery, r.review_count, r.next_review_at,
            r.created_at, r.updated_at, r.updated_by_device,
        ],
    )?;
    Ok(())
}

fn insert_translation(tx: &Transaction, id: &str, r: &TranslationRow) -> AppResult<()> {
    tx.execute(
        "INSERT OR IGNORE INTO translations
         (id, book_id, source_text, translated_text, target_language, cfi,
          created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![
            id, r.book_id, r.source_text, r.translated_text, r.target_language,
            r.cfi, r.created_at, r.updated_at,
        ],
    )?;
    Ok(())
}

fn upsert_collection(tx: &Transaction, id: &str, r: &CollectionRow) -> AppResult<()> {
    tx.execute(
        "INSERT INTO collections
         (id, name, sort_order, created_at, updated_at, updated_by_device)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(id) DO UPDATE SET
           name=excluded.name,
           sort_order=excluded.sort_order,
           updated_at=excluded.updated_at,
           updated_by_device=excluded.updated_by_device
         WHERE (collections.updated_at, collections.updated_by_device)
             < (excluded.updated_at, excluded.updated_by_device)",
        params![id, r.name, r.sort_order, r.created_at, r.updated_at, r.updated_by_device],
    )?;
    Ok(())
}

fn upsert_collection_book(tx: &Transaction, r: &CollectionBookRow) -> AppResult<()> {
    tx.execute(
        "INSERT INTO collection_books
         (collection_id, book_id, created_at, updated_at, updated_by_device)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(collection_id, book_id) DO UPDATE SET
           updated_at=excluded.updated_at,
           updated_by_device=excluded.updated_by_device
         WHERE (collection_books.updated_at, collection_books.updated_by_device)
             < (excluded.updated_at, excluded.updated_by_device)",
        params![r.collection_id, r.book_id, r.created_at, r.updated_at, r.updated_by_device],
    )?;
    Ok(())
}

fn upsert_chat(tx: &Transaction, id: &str, r: &ChatRow) -> AppResult<()> {
    tx.execute(
        "INSERT INTO chats
         (id, book_id, title, model, pinned, metadata, created_at, updated_at, updated_by_device)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
         ON CONFLICT(id) DO UPDATE SET
           title=excluded.title,
           model=excluded.model,
           pinned=excluded.pinned,
           metadata=excluded.metadata,
           updated_at=excluded.updated_at,
           updated_by_device=excluded.updated_by_device
         WHERE (chats.updated_at, chats.updated_by_device)
             < (excluded.updated_at, excluded.updated_by_device)",
        params![
            id, r.book_id, r.title, r.model, r.pinned as i64, r.metadata,
            r.created_at, r.updated_at, r.updated_by_device,
        ],
    )?;
    Ok(())
}

fn insert_chat_message(tx: &Transaction, id: &str, r: &ChatMessageRow) -> AppResult<()> {
    tx.execute(
        "INSERT OR IGNORE INTO chat_messages
         (id, chat_id, role, content, context, metadata, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![id, r.chat_id, r.role, r.content, r.context, r.metadata, r.created_at, r.updated_at],
    )?;
    Ok(())
}

fn upsert_replay_state(
    tx: &Transaction,
    peer: &str,
    last_snapshot: Option<&str>,
    last_event: Option<&str>,
) -> AppResult<()> {
    let now = chrono::Utc::now().timestamp_millis();
    tx.execute(
        "INSERT INTO _replay_state (peer_device, last_snapshot_id, last_event_id, updated_at)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(peer_device) DO UPDATE SET
           last_snapshot_id = excluded.last_snapshot_id,
           last_event_id = excluded.last_event_id,
           updated_at = excluded.updated_at",
        params![peer, last_snapshot, last_event, now],
    )?;
    Ok(())
}

// ---------------------------------------------------------------------------
// State dump — read every synced table out of `conn` into a SnapshotState.
// Used by `Snapshot::from_events`.
// ---------------------------------------------------------------------------

fn dump_state(conn: &Connection) -> AppResult<SnapshotState> {
    let mut state = SnapshotState::default();

    // books
    let mut stmt = conn.prepare(
        "SELECT id, title, author, description, cover_path, file_path, genre, pages,
                format, status, progress, current_cfi,
                created_at, updated_at, updated_by_device
         FROM books",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok((
            r.get::<_, String>(0)?,
            BookRow {
                title: r.get(1)?,
                author: r.get(2)?,
                description: r.get(3)?,
                cover_path: r.get(4)?,
                file_path: r.get(5)?,
                genre: r.get(6)?,
                pages: r.get(7)?,
                format: r.get(8)?,
                status: r.get(9)?,
                progress: r.get(10)?,
                current_cfi: r.get(11)?,
                created_at: r.get(12)?,
                updated_at: r.get(13)?,
                updated_by_device: r.get(14)?,
            },
        ))
    })?;
    for row in rows {
        let (id, b) = row?;
        state.books.insert(id, b);
    }
    drop(stmt);

    // highlights
    let mut stmt = conn.prepare(
        "SELECT id, book_id, cfi_range, color, note, text_content,
                created_at, updated_at, updated_by_device FROM highlights",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok((
            r.get::<_, String>(0)?,
            HighlightRow {
                book_id: r.get(1)?,
                cfi_range: r.get(2)?,
                color: r.get(3)?,
                note: r.get(4)?,
                text_content: r.get(5)?,
                created_at: r.get(6)?,
                updated_at: r.get(7)?,
                updated_by_device: r.get(8)?,
            },
        ))
    })?;
    for row in rows {
        let (id, h) = row?;
        state.highlights.insert(id, h);
    }
    drop(stmt);

    // bookmarks
    let mut stmt = conn.prepare(
        "SELECT id, book_id, cfi, label, created_at, updated_at FROM bookmarks",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok((
            r.get::<_, String>(0)?,
            BookmarkRow {
                book_id: r.get(1)?,
                cfi: r.get(2)?,
                label: r.get(3)?,
                created_at: r.get(4)?,
                updated_at: r.get(5)?,
            },
        ))
    })?;
    for row in rows {
        let (id, b) = row?;
        state.bookmarks.insert(id, b);
    }
    drop(stmt);

    // vocab_words
    let mut stmt = conn.prepare(
        "SELECT id, book_id, word, definition, context_sentence, cfi,
                mastery, review_count, next_review_at,
                created_at, updated_at, updated_by_device FROM vocab_words",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok((
            r.get::<_, String>(0)?,
            VocabRow {
                book_id: r.get(1)?,
                word: r.get(2)?,
                definition: r.get(3)?,
                context_sentence: r.get(4)?,
                cfi: r.get(5)?,
                mastery: r.get(6)?,
                review_count: r.get(7)?,
                next_review_at: r.get(8)?,
                created_at: r.get(9)?,
                updated_at: r.get(10)?,
                updated_by_device: r.get(11)?,
            },
        ))
    })?;
    for row in rows {
        let (id, v) = row?;
        state.vocab_words.insert(id, v);
    }
    drop(stmt);

    // translations
    let mut stmt = conn.prepare(
        "SELECT id, book_id, source_text, translated_text, target_language, cfi,
                created_at, updated_at FROM translations",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok((
            r.get::<_, String>(0)?,
            TranslationRow {
                book_id: r.get(1)?,
                source_text: r.get(2)?,
                translated_text: r.get(3)?,
                target_language: r.get(4)?,
                cfi: r.get(5)?,
                created_at: r.get(6)?,
                updated_at: r.get(7)?,
            },
        ))
    })?;
    for row in rows {
        let (id, t) = row?;
        state.translations.insert(id, t);
    }
    drop(stmt);

    // collections
    let mut stmt = conn.prepare(
        "SELECT id, name, sort_order, created_at, updated_at, updated_by_device FROM collections",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok((
            r.get::<_, String>(0)?,
            CollectionRow {
                name: r.get(1)?,
                sort_order: r.get(2)?,
                created_at: r.get(3)?,
                updated_at: r.get(4)?,
                updated_by_device: r.get(5)?,
            },
        ))
    })?;
    for row in rows {
        let (id, c) = row?;
        state.collections.insert(id, c);
    }
    drop(stmt);

    // collection_books — composite key
    let mut stmt = conn.prepare(
        "SELECT collection_id, book_id, created_at, updated_at, updated_by_device
         FROM collection_books",
    )?;
    let rows = stmt.query_map([], |r| {
        let col: String = r.get(0)?;
        let book: String = r.get(1)?;
        Ok((
            format!("{col}:{book}"),
            CollectionBookRow {
                collection_id: col,
                book_id: book,
                created_at: r.get(2)?,
                updated_at: r.get(3)?,
                updated_by_device: r.get(4)?,
            },
        ))
    })?;
    for row in rows {
        let (key, cb) = row?;
        state.collection_books.insert(key, cb);
    }
    drop(stmt);

    // chats
    let mut stmt = conn.prepare(
        "SELECT id, book_id, title, model, pinned, metadata,
                created_at, updated_at, updated_by_device FROM chats",
    )?;
    let rows = stmt.query_map([], |r| {
        let pinned: i64 = r.get(4)?;
        Ok((
            r.get::<_, String>(0)?,
            ChatRow {
                book_id: r.get(1)?,
                title: r.get(2)?,
                model: r.get(3)?,
                pinned: pinned != 0,
                metadata: r.get(5)?,
                created_at: r.get(6)?,
                updated_at: r.get(7)?,
                updated_by_device: r.get(8)?,
            },
        ))
    })?;
    for row in rows {
        let (id, c) = row?;
        state.chats.insert(id, c);
    }
    drop(stmt);

    // chat_messages
    let mut stmt = conn.prepare(
        "SELECT id, chat_id, role, content, context, metadata, created_at, updated_at
         FROM chat_messages",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok((
            r.get::<_, String>(0)?,
            ChatMessageRow {
                chat_id: r.get(1)?,
                role: r.get(2)?,
                content: r.get(3)?,
                context: r.get(4)?,
                metadata: r.get(5)?,
                created_at: r.get(6)?,
                updated_at: r.get(7)?,
            },
        ))
    })?;
    for row in rows {
        let (id, m) = row?;
        state.chat_messages.insert(id, m);
    }
    drop(stmt);

    // _tombstones
    let mut stmt = conn.prepare("SELECT entity, id, ts FROM _tombstones")?;
    let rows = stmt.query_map([], |r| {
        Ok((
            r.get::<_, String>(0)?,
            TombstoneRow {
                id: r.get(1)?,
                ts: r.get(2)?,
            },
        ))
    })?;
    for row in rows {
        let (entity, t) = row?;
        state.tombstones.entry(entity).or_default().push(t);
    }

    Ok(state)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sync::events::*;
    use crate::sync::merge;
    use rusqlite::Connection;
    use tempfile::TempDir;

    fn open_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        Db::run_migrations_on(&conn).unwrap();
        conn.execute_batch("PRAGMA foreign_keys=OFF;").unwrap();
        conn
    }

    fn ev(ts: i64, device: &str, body: EventBody) -> Event {
        Event {
            id: format!("01HYZX0000000000000000{:04X}", ts as u16),
            ts,
            device: device.to_string(),
            v: EVENT_SCHEMA_VERSION,
            body,
            extra: serde_json::Map::new(),
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

    fn apply_to(conn: &mut Connection, events: &[Event]) {
        let tx = conn.transaction().unwrap();
        for e in events {
            merge::apply_event(&tx, e).unwrap();
        }
        tx.commit().unwrap();
    }

    #[test]
    fn write_then_read_roundtrip() {
        let tmp = TempDir::new().unwrap();
        let snap = Snapshot {
            v: SNAPSHOT_SCHEMA_VERSION,
            device: "dev-A".into(),
            id: "01HYZX0000000000000000FFFF".into(),
            generated_at: 1_714_770_000_000,
            truncated_before: Some("01HYZX0000000000000000FFFF".into()),
            state: SnapshotState::default(),
        };
        let path = tmp.path().join("logs/dev-A.snapshot.json");
        snap.write_atomic(&path).unwrap();

        let read = Snapshot::read_from(&path).unwrap();
        assert_eq!(read, snap);
    }

    /// `from_legacy_db` reads a fully-migrated quill.db (v11 schema) and
    /// produces a snapshot byte-equivalent to one built from the events
    /// that would have produced the same DB state. This is the
    /// migration-snapshot bootstrap path: the legacy DB is the source of
    /// truth, dump_state pulls every row out, peers see the snapshot as
    /// if it were any other compaction.
    #[test]
    fn from_legacy_db_dumps_existing_rows() {
        let tmp = TempDir::new().unwrap();
        let db = crate::db::Db::init(tmp.path()).unwrap();
        // Seed a few rows directly via SQL — same shape the legacy file
        // sync would have left behind after migration 011 backfilled
        // updated_by_device='migration'.
        {
            let conn = db.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO books
                 (id, title, author, file_path, format, status, progress, created_at, updated_at, updated_by_device)
                 VALUES ('b1', 'War and Peace', 'Tolstoy', 'books/wp.epub', 'epub', 'reading', 42, 1000, 1500, 'migration')",
                [],
            ).unwrap();
            conn.execute(
                "INSERT INTO highlights
                 (id, book_id, cfi_range, color, created_at, updated_at, updated_by_device)
                 VALUES ('h1', 'b1', 'epubcfi(/6/4!/2)', 'yellow', 1100, 1100, 'migration')",
                [],
            ).unwrap();
        }

        let snap = {
            let conn = db.conn.lock().unwrap();
            Snapshot::from_legacy_db(&conn, "dev-MIGRATING").unwrap()
        };

        assert_eq!(snap.device, "dev-MIGRATING");
        assert_eq!(snap.truncated_before, None, "legacy snapshots have no log to truncate");
        assert!(!snap.id.is_empty(), "id should be a freshly-minted ULID");
        assert_eq!(snap.state.books.len(), 1);
        assert_eq!(snap.state.highlights.len(), 1);
        let book = snap.state.books.get("b1").unwrap();
        assert_eq!(book.title, "War and Peace");
        assert_eq!(book.progress, 42);
        assert_eq!(book.updated_by_device, "migration");
    }

    /// End-to-end migration round trip: a legacy DB → snapshot →
    /// apply_peer onto a fresh local DB yields the same row state.
    /// This is the read-back path Step 7 relies on for conflict-copy
    /// merging (the migrating device replays its own snapshot to absorb
    /// rows that only existed in conflict copies).
    #[test]
    fn from_legacy_db_then_apply_peer_round_trips() {
        let src = TempDir::new().unwrap();
        let src_db = crate::db::Db::init(src.path()).unwrap();
        {
            let conn = src_db.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO books
                 (id, title, author, file_path, format, status, progress, created_at, updated_at, updated_by_device)
                 VALUES ('b1', 'T', 'A', 'books/x.epub', 'epub', 'unread', 0, 1000, 1000, 'migration')",
                [],
            ).unwrap();
        }
        let snap = {
            let conn = src_db.conn.lock().unwrap();
            Snapshot::from_legacy_db(&conn, "dev-A").unwrap()
        };

        // Fresh local DB on a different device.
        let dst = TempDir::new().unwrap();
        let dst_db = crate::db::Db::init(dst.path()).unwrap();
        {
            let mut conn = dst_db.conn.lock().unwrap();
            let tx = conn.transaction().unwrap();
            snap.apply_peer(&tx, "dev-A").unwrap();
            tx.commit().unwrap();
        }

        let count: i64 = {
            let conn = dst_db.conn.lock().unwrap();
            conn.query_row("SELECT COUNT(*) FROM books", [], |r| r.get(0)).unwrap()
        };
        assert_eq!(count, 1);
    }

    #[test]
    fn from_events_captures_db_state() {
        let events = vec![
            ev(1000, "dev-A", import("b1")),
            ev(
                1100,
                "dev-A",
                EventBody::HighlightAdd(HighlightPayload {
                    id: "h1".into(),
                    book_id: "b1".into(),
                    cfi_range: "epubcfi(/6/4!/2)".into(),
                    color: "yellow".into(),
                    note: None,
                    text_content: None,
                }),
            ),
            ev(
                1200,
                "dev-A",
                EventBody::HighlightColorSet {
                    id: "h1".into(),
                    color: "pink".into(),
                },
            ),
        ];
        let snap = Snapshot::from_events("dev-A", &events).unwrap();
        assert_eq!(snap.state.books.len(), 1);
        assert_eq!(snap.state.highlights.len(), 1);
        let h = snap.state.highlights.get("h1").unwrap();
        assert_eq!(h.color, "pink");
        assert_eq!(h.updated_at, 1200);
    }

    #[test]
    fn apply_peer_bootstraps_empty_local_db() {
        // Build a snapshot from peer-A's events; apply to a fresh peer-B DB;
        // assert peer-B's SQL state matches.
        let events = vec![
            ev(1000, "dev-A", import("b1")),
            ev(
                1100,
                "dev-A",
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
        let snap = Snapshot::from_events("dev-A", &events).unwrap();

        let mut local = open_db();
        let outcome = {
            let tx = local.transaction().unwrap();
            let outcome = snap.apply_peer(&tx, "dev-A").unwrap();
            tx.commit().unwrap();
            outcome
        };
        assert_eq!(outcome, ApplyOutcome::Applied);

        let n_books: i64 = local
            .query_row("SELECT COUNT(*) FROM books", [], |r| r.get(0))
            .unwrap();
        let n_hl: i64 = local
            .query_row("SELECT COUNT(*) FROM highlights", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n_books, 1);
        assert_eq!(n_hl, 1);

        let (snap_id, ev_id): (Option<String>, Option<String>) = local
            .query_row(
                "SELECT last_snapshot_id, last_event_id FROM _replay_state WHERE peer_device = 'dev-A'",
                [], |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(snap_id, Some(snap.id.clone()));
        assert_eq!(ev_id, Some(snap.id.clone()));
    }

    #[test]
    fn apply_peer_already_applied_is_short_circuit() {
        let events = vec![ev(1000, "dev-A", import("b1"))];
        let snap = Snapshot::from_events("dev-A", &events).unwrap();
        let mut local = open_db();
        {
            let tx = local.transaction().unwrap();
            snap.apply_peer(&tx, "dev-A").unwrap();
            tx.commit().unwrap();
        }
        let outcome = {
            let tx = local.transaction().unwrap();
            let o = snap.apply_peer(&tx, "dev-A").unwrap();
            tx.commit().unwrap();
            o
        };
        assert_eq!(outcome, ApplyOutcome::AlreadyApplied);
    }

    #[test]
    fn apply_peer_header_only_when_log_tail_already_ahead() {
        // Peer event tail watermark is already past the snapshot's id —
        // every event the snapshot summarises has been individually applied.
        let events = vec![ev(1000, "dev-A", import("b1"))];
        let snap = Snapshot::from_events("dev-A", &events).unwrap();
        let later_event_id = "01HYZX9999999999999999FFFF"; // sorts after snap.id

        let mut local = open_db();
        // Pre-seed _replay_state as if A's log tail had already been read.
        local
            .execute(
                "INSERT INTO _replay_state (peer_device, last_snapshot_id, last_event_id, updated_at)
                 VALUES ('dev-A', NULL, ?1, ?2)",
                params![later_event_id, chrono::Utc::now().timestamp_millis()],
            )
            .unwrap();

        let outcome = {
            let tx = local.transaction().unwrap();
            let o = snap.apply_peer(&tx, "dev-A").unwrap();
            tx.commit().unwrap();
            o
        };
        assert_eq!(outcome, ApplyOutcome::HeaderOnly);

        // No rows applied; tail watermark preserved (monotonic non-decrease).
        let n_books: i64 = local
            .query_row("SELECT COUNT(*) FROM books", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n_books, 0);
        let (snap_id, ev_id): (Option<String>, Option<String>) = local
            .query_row(
                "SELECT last_snapshot_id, last_event_id FROM _replay_state WHERE peer_device = 'dev-A'",
                [], |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(snap_id, Some(snap.id.clone()));
        assert_eq!(ev_id.as_deref(), Some(later_event_id));
    }

    #[test]
    fn apply_peer_respects_local_tombstone() {
        let events = vec![
            ev(1000, "dev-A", import("b1")),
            ev(
                1100,
                "dev-A",
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
        let snap = Snapshot::from_events("dev-A", &events).unwrap();

        // Local user (peer-B) deleted the highlight before the snapshot arrived.
        let mut local = open_db();
        merge::insert_tombstone(
            &local.transaction().unwrap(),
            merge::entity::HIGHLIGHT,
            "h1",
            500,
        )
        .unwrap();
        // Need to commit the tombstone before applying snapshot.
        local
            .execute(
                "INSERT OR IGNORE INTO _tombstones (entity, id, ts) VALUES ('highlight', 'h1', 500)",
                [],
            )
            .unwrap();

        {
            let tx = local.transaction().unwrap();
            snap.apply_peer(&tx, "dev-A").unwrap();
            tx.commit().unwrap();
        }
        let n: i64 = local
            .query_row("SELECT COUNT(*) FROM highlights WHERE id = 'h1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 0, "local tombstone should suppress snapshot insertion");
    }

    #[test]
    fn apply_peer_lww_preserves_newer_local_value() {
        // Local DB has progress=80 (newer), peer snapshot has progress=10
        // (older). Apply must NOT overwrite the newer local value.
        let mut local = open_db();
        apply_to(
            &mut local,
            &[
                ev(1000, "dev-B", import("b1")),
                ev(
                    5000,
                    "dev-B",
                    EventBody::BookProgressSet {
                        book: "b1".into(),
                        progress: 80,
                        cfi: Some("c80".into()),
                    },
                ),
            ],
        );

        let peer_events = vec![
            ev(1000, "dev-A", import("b1")),
            ev(
                2000,
                "dev-A",
                EventBody::BookProgressSet {
                    book: "b1".into(),
                    progress: 10,
                    cfi: Some("c10".into()),
                },
            ),
        ];
        let snap = Snapshot::from_events("dev-A", &peer_events).unwrap();
        {
            let tx = local.transaction().unwrap();
            snap.apply_peer(&tx, "dev-A").unwrap();
            tx.commit().unwrap();
        }
        let progress: i32 = local
            .query_row("SELECT progress FROM books WHERE id = 'b1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(progress, 80, "newer local value survives older snapshot");
    }

    // -----------------------------------------------------------------------
    // Regression for PR #189 finding #1: snapshot tombstones must scrub the
    // same child rows the event-path delete would have. Two scenarios:
    //
    //   a. `book.delete` from a peer leaves no orphan highlights/bookmarks/
    //      vocab/etc. when ingested via snapshot.
    //   b. `collection.book.remove` from a peer drops the join row, even
    //      though the composite-key tombstone has no single-column id.
    // -----------------------------------------------------------------------

    #[test]
    fn snapshot_tombstone_for_book_removes_local_children() {
        // Local-A imported b1 and added a highlight + bookmark + vocab.
        // Peer-B's snapshot says b1 was deleted. Apply must scrub the
        // children, not just leave them dangling.
        let mut local = open_db();
        apply_to(
            &mut local,
            &[
                ev(1000, "dev-A", import("b1")),
                ev(
                    1100,
                    "dev-A",
                    EventBody::HighlightAdd(HighlightPayload {
                        id: "h1".into(),
                        book_id: "b1".into(),
                        cfi_range: "cfi".into(),
                        color: "yellow".into(),
                        note: None,
                        text_content: None,
                    }),
                ),
                ev(
                    1200,
                    "dev-A",
                    EventBody::BookmarkAdd(BookmarkPayload {
                        id: "bm1".into(),
                        book_id: "b1".into(),
                        cfi: "cfi".into(),
                        label: None,
                    }),
                ),
            ],
        );

        // Peer-B's snapshot reflects: imported b1, then deleted it.
        let peer_events = vec![
            ev(900, "dev-B", import("b1")),
            ev(2000, "dev-B", EventBody::BookDelete { id: "b1".into() }),
        ];
        let snap = Snapshot::from_events("dev-B", &peer_events).unwrap();

        {
            let tx = local.transaction().unwrap();
            snap.apply_peer(&tx, "dev-B").unwrap();
            tx.commit().unwrap();
        }

        for table in ["books", "highlights", "bookmarks"] {
            let n: i64 = local
                .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0))
                .unwrap();
            assert_eq!(
                n, 0,
                "snapshot tombstone for book must cascade to {table}"
            );
        }
        let tomb: i64 = local
            .query_row(
                "SELECT COUNT(*) FROM _tombstones WHERE entity = 'book' AND id = 'b1'",
                [], |r| r.get(0),
            )
            .unwrap();
        assert_eq!(tomb, 1);
    }

    #[test]
    fn snapshot_tombstone_for_collection_book_removes_join_row() {
        // Local-A has the join row (c1, b1). Peer-B's snapshot includes a
        // composite-key tombstone for the same pair. The join row must be
        // gone after apply.
        let mut local = open_db();
        apply_to(
            &mut local,
            &[
                ev(1000, "dev-A", import("b1")),
                ev(
                    1100,
                    "dev-A",
                    EventBody::CollectionCreate {
                        id: "c1".into(),
                        name: "Top".into(),
                        sort_order: 0,
                    },
                ),
                ev(
                    1200,
                    "dev-A",
                    EventBody::CollectionBookAdd {
                        collection: "c1".into(),
                        book: "b1".into(),
                    },
                ),
            ],
        );

        let peer_events = vec![
            ev(900, "dev-B", import("b1")),
            ev(
                950,
                "dev-B",
                EventBody::CollectionCreate {
                    id: "c1".into(),
                    name: "Top".into(),
                    sort_order: 0,
                },
            ),
            ev(
                1000,
                "dev-B",
                EventBody::CollectionBookAdd {
                    collection: "c1".into(),
                    book: "b1".into(),
                },
            ),
            ev(
                2000,
                "dev-B",
                EventBody::CollectionBookRemove {
                    collection: "c1".into(),
                    book: "b1".into(),
                },
            ),
        ];
        let snap = Snapshot::from_events("dev-B", &peer_events).unwrap();
        {
            let tx = local.transaction().unwrap();
            snap.apply_peer(&tx, "dev-B").unwrap();
            tx.commit().unwrap();
        }
        let n: i64 = local
            .query_row(
                "SELECT COUNT(*) FROM collection_books WHERE collection_id = 'c1' AND book_id = 'b1'",
                [], |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            n, 0,
            "composite-key snapshot tombstone must drop the join row"
        );
    }

    #[test]
    fn snapshot_equivalence_events_vs_snapshot_yields_same_state() {
        // Apply event set X directly to DB1; build snapshot from X and apply
        // to DB2; compare every row.
        let events = vec![
            ev(1000, "dev-A", import("b1")),
            ev(1100, "dev-B", import("b2")),
            ev(
                1200,
                "dev-A",
                EventBody::HighlightAdd(HighlightPayload {
                    id: "h1".into(),
                    book_id: "b1".into(),
                    cfi_range: "cfi".into(),
                    color: "yellow".into(),
                    note: Some("note".into()),
                    text_content: None,
                }),
            ),
            ev(
                1300,
                "dev-A",
                EventBody::CollectionCreate {
                    id: "c1".into(),
                    name: "Top".into(),
                    sort_order: 0,
                },
            ),
            ev(
                1400,
                "dev-A",
                EventBody::CollectionBookAdd {
                    collection: "c1".into(),
                    book: "b1".into(),
                },
            ),
            ev(
                1500,
                "dev-B",
                EventBody::HighlightDelete { id: "h1".into() },
            ),
        ];

        let mut db1 = open_db();
        apply_to(&mut db1, &events);

        let snap = Snapshot::from_events("dev-A", &events).unwrap();
        let mut db2 = open_db();
        {
            let tx = db2.transaction().unwrap();
            snap.apply_peer(&tx, "dev-A").unwrap();
            tx.commit().unwrap();
        }

        let dump = |db: &Connection, table: &str| -> Vec<String> {
            let mut stmt = db
                .prepare(&format!("SELECT * FROM {table} ORDER BY 1, 2"))
                .unwrap();
            let cols = stmt.column_count();
            stmt.query_map([], |r| {
                let mut s = String::new();
                for i in 0..cols {
                    let v: rusqlite::types::Value = r.get(i)?;
                    s.push_str(&format!("{v:?}|"));
                }
                Ok(s)
            })
            .unwrap()
            .map(|r| r.unwrap())
            .collect()
        };

        for table in [
            "books",
            "highlights",
            "bookmarks",
            "vocab_words",
            "translations",
            "collections",
            "collection_books",
            "chats",
            "chat_messages",
            "_tombstones",
        ] {
            assert_eq!(
                dump(&db1, table),
                dump(&db2, table),
                "{table} differs between event-direct and snapshot-applied"
            );
        }
    }

    // -----------------------------------------------------------------------
    // Compaction
    // -----------------------------------------------------------------------

    /// Helper: write events to a real on-disk EventLog so compact_own_log
    /// can be exercised end-to-end.
    fn seed_log(shared: &Path, device: &str, bodies: Vec<EventBody>) -> EventLog {
        let log_path = shared.join("logs").join(format!("{device}.jsonl"));
        let log = EventLog::open(&log_path, device, false).unwrap();
        for (i, body) in bodies.into_iter().enumerate() {
            log.append(body, 1_000 + i as i64).unwrap();
        }
        log
    }

    #[test]
    fn should_compact_returns_false_for_missing_log() {
        let tmp = TempDir::new().unwrap();
        assert!(!should_compact(tmp.path(), "nope"));
    }

    #[test]
    fn should_compact_returns_false_for_empty_log() {
        let tmp = TempDir::new().unwrap();
        let shared = tmp.path();
        std::fs::create_dir_all(shared.join("logs")).unwrap();
        let _log = EventLog::open(
            &shared.join("logs/dev-A.jsonl"),
            "dev-A",
            false,
        )
        .unwrap();
        assert!(!should_compact(shared, "dev-A"));
    }

    #[test]
    fn should_compact_false_for_small_log_without_snapshot() {
        // The first-snapshot case is owned by sync_enable /
        // migration::run_migration. should_compact deliberately stays
        // out of the way until the size/count/age triggers fire on a
        // log that's actually become unwieldy.
        let tmp = TempDir::new().unwrap();
        let shared = tmp.path();
        std::fs::create_dir_all(shared.join("logs")).unwrap();
        let _log = seed_log(shared, "dev-A", vec![import("b1")]);
        assert!(!should_compact(shared, "dev-A"));
    }

    #[test]
    fn should_compact_true_when_event_count_exceeds_threshold() {
        let tmp = TempDir::new().unwrap();
        let shared = tmp.path();
        std::fs::create_dir_all(shared.join("logs")).unwrap();

        // Drop a 5001-line file directly; cheaper than appending 5001
        // events through EventLog. The byte-scan inside should_compact
        // doesn't care about content as long as the lines parse-skip
        // cleanly later (they don't here, but should_compact uses the
        // raw newline count, not a parse).
        let log_path = shared.join("logs/dev-A.jsonl");
        let mut buf = Vec::with_capacity(5001 * 8);
        for i in 0..5001 {
            buf.extend_from_slice(format!("{{\"x\":{i}}}\n").as_bytes());
        }
        std::fs::write(&log_path, &buf).unwrap();

        // Write a fresh-enough snapshot so the age threshold doesn't
        // trip first.
        let snap_path = shared.join("logs/dev-A.snapshot.json");
        let snap = Snapshot {
            v: SNAPSHOT_SCHEMA_VERSION,
            device: "dev-A".into(),
            id: "01HZA0000000000000000000F0".into(),
            generated_at: chrono::Utc::now().timestamp_millis(),
            truncated_before: None,
            state: SnapshotState::default(),
        };
        snap.write_atomic(&snap_path).unwrap();

        assert!(should_compact(shared, "dev-A"));
    }

    #[test]
    fn compact_own_log_truncates_log_and_writes_snapshot() {
        let tmp = TempDir::new().unwrap();
        let shared = tmp.path();
        std::fs::create_dir_all(shared.join("logs")).unwrap();
        let log = seed_log(
            shared,
            "dev-A",
            vec![import("b1"), import("b2"), import("b3")],
        );

        let report = compact_own_log(shared, &log).unwrap();
        assert_eq!(report.events_folded, 3);
        assert!(report.snapshot_written);

        // Log is now empty.
        let bytes = std::fs::read(log.path()).unwrap();
        assert_eq!(bytes.len(), 0, "log should be truncated to zero");

        // Snapshot exists with all three books.
        let snap_path = shared.join("logs/dev-A.snapshot.json");
        let snap = Snapshot::read_from(&snap_path).unwrap();
        assert_eq!(snap.state.books.len(), 3);
        assert!(snap.truncated_before.is_some());
    }

    #[test]
    fn compact_own_log_is_noop_on_empty_log() {
        let tmp = TempDir::new().unwrap();
        let shared = tmp.path();
        std::fs::create_dir_all(shared.join("logs")).unwrap();
        let log_path = shared.join("logs/dev-A.jsonl");
        let log = EventLog::open(&log_path, "dev-A", false).unwrap();

        let report = compact_own_log(shared, &log).unwrap();
        assert_eq!(report.events_folded, 0);
        assert!(!report.snapshot_written);
        assert!(!shared.join("logs/dev-A.snapshot.json").exists());
    }

    #[test]
    fn compact_own_log_idempotent_when_run_twice() {
        let tmp = TempDir::new().unwrap();
        let shared = tmp.path();
        std::fs::create_dir_all(shared.join("logs")).unwrap();
        let log = seed_log(shared, "dev-A", vec![import("b1"), import("b2")]);

        let r1 = compact_own_log(shared, &log).unwrap();
        assert_eq!(r1.events_folded, 2);

        // Second run sees an empty log → no snapshot rewrite.
        let r2 = compact_own_log(shared, &log).unwrap();
        assert_eq!(r2.events_folded, 0);
        assert!(!r2.snapshot_written);
    }

    #[test]
    fn compact_then_apply_yields_same_state_as_replay() {
        // Round-trip equivalence: apply N events directly to DB1; on
        // a separate device, compact (events → snapshot + truncated
        // log), then `apply_peer` the resulting snapshot to DB2.
        // Both DBs must end up with byte-identical row state.
        let tmp = TempDir::new().unwrap();
        let shared = tmp.path();
        std::fs::create_dir_all(shared.join("logs")).unwrap();

        let bodies = vec![
            import("b1"),
            import("b2"),
            EventBody::HighlightAdd(HighlightPayload {
                id: "h1".into(),
                book_id: "b1".into(),
                cfi_range: "cfi".into(),
                color: "yellow".into(),
                note: None,
                text_content: None,
            }),
            EventBody::CollectionCreate {
                id: "c1".into(),
                name: "Top".into(),
                sort_order: 0,
            },
            EventBody::CollectionBookAdd {
                collection: "c1".into(),
                book: "b1".into(),
            },
        ];

        // Direct-replay path: write events to a log, then read them
        // out and apply via merge::apply_event.
        let log = seed_log(shared, "dev-A", bodies);
        let events = log.read_all().unwrap();
        let mut db_direct = open_db();
        apply_to(&mut db_direct, &events);

        // Compaction path: compact the log → snapshot, then apply the
        // snapshot to a fresh DB.
        compact_own_log(shared, &log).unwrap();
        let snap =
            Snapshot::read_from(&shared.join("logs/dev-A.snapshot.json")).unwrap();
        let mut db_via_snap = open_db();
        {
            let tx = db_via_snap.transaction().unwrap();
            snap.apply_peer(&tx, "dev-A").unwrap();
            tx.commit().unwrap();
        }

        let dump = |db: &Connection, table: &str| -> Vec<String> {
            let mut stmt = db
                .prepare(&format!("SELECT * FROM {table} ORDER BY 1, 2"))
                .unwrap();
            let cols = stmt.column_count();
            stmt.query_map([], |r| {
                let mut s = String::new();
                for i in 0..cols {
                    let v: rusqlite::types::Value = r.get(i)?;
                    s.push_str(&format!("{v:?}|"));
                }
                Ok(s)
            })
            .unwrap()
            .map(|r| r.unwrap())
            .collect()
        };

        for table in [
            "books",
            "highlights",
            "collections",
            "collection_books",
        ] {
            assert_eq!(
                dump(&db_direct, table),
                dump(&db_via_snap, table),
                "{table} state differs after compaction roundtrip",
            );
        }
    }

    /// Regression for PR #194's review finding: compaction must NOT
    /// truncate the source log if the snapshot write fails. The
    /// fold-and-truncate sequence has to commit the new snapshot
    /// durably before the log loses its events — otherwise a crash
    /// window between snapshot rename and log truncate can lose
    /// already-published events.
    ///
    /// Direct simulation of a power loss is hard from a unit test,
    /// but the proxy-bug we can reliably exercise is "snapshot
    /// write fails." If the code truncates the log anyway, that's
    /// the same data-loss path; fixing it (committing snapshot
    /// durably first, propagating any error) closes the crash
    /// window too.
    #[test]
    fn compact_keeps_log_when_snapshot_write_fails() {
        let tmp = TempDir::new().unwrap();
        let shared = tmp.path();
        std::fs::create_dir_all(shared.join("logs")).unwrap();
        let log = seed_log(
            shared,
            "dev-A",
            vec![import("b1"), import("b2"), import("b3")],
        );
        let original_log_bytes = std::fs::read(log.path()).unwrap();
        assert!(!original_log_bytes.is_empty());

        // Make the snapshot write fail by occupying the destination
        // path with a directory: the temp write succeeds, but the
        // final `fs::rename(tmp, dst)` returns EISDIR. This short-
        // circuits `write_atomic` with an error before the log
        // truncate runs — exactly the failure mode we need to prove
        // doesn't take the log down with it.
        let snap_dst = shared.join("logs/dev-A.snapshot.json");
        std::fs::create_dir_all(&snap_dst).unwrap();

        let result = compact_own_log(shared, &log);
        assert!(
            result.is_err(),
            "compaction must propagate snapshot write failure"
        );

        // Source log must still have every event we seeded — losing
        // them here would mean peers never see them.
        let preserved = std::fs::read(log.path()).unwrap();
        assert_eq!(
            preserved, original_log_bytes,
            "log must be untouched when snapshot write fails"
        );
    }

    #[test]
    fn second_compaction_picks_up_new_events_via_prior_snapshot() {
        // After compaction the snapshot holds the old state and the log
        // is empty. New events arrive → second compaction must fold the
        // prior snapshot AND the new events into a fresh snapshot.
        let tmp = TempDir::new().unwrap();
        let shared = tmp.path();
        std::fs::create_dir_all(shared.join("logs")).unwrap();
        let log = seed_log(shared, "dev-A", vec![import("b1")]);

        compact_own_log(shared, &log).unwrap();
        // New event lands after the first compaction.
        log.append(import("b2"), 9_999).unwrap();
        compact_own_log(shared, &log).unwrap();

        let snap =
            Snapshot::read_from(&shared.join("logs/dev-A.snapshot.json")).unwrap();
        assert_eq!(snap.state.books.len(), 2, "fresh snapshot must include both books");
    }
}
