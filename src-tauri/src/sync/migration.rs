//! One-shot migration from the legacy file-sync (shipped DB as a binary
//! file through iCloud) to the per-device event log.
//!
//! Triggered on launch when (a) the legacy `.icloud_enabled` marker exists
//! and (b) the new `.migration_complete` marker does not. Idempotent: a
//! second run after success is a no-op (caller checks the marker), and a
//! crash mid-flight leaves the source DB and ubiquity files untouched
//! until the very last step (the marker write + retire), so the next
//! launch re-runs cleanly.
//!
//! ## Procedure
//!
//! 1. Copy `<ubiquity>/quill.db` → `<local>/quill.db` (bit-exact). The
//!    ubiquity DB stays in place — the retire step at the end renames it
//!    to `quill.db.migrated-<iso>` only after the rest of the migration
//!    has succeeded.
//! 2. Open the local DB. `Db::init` runs migrations 1-11, so a legacy
//!    file at any older schema is brought forward to the per-device-log
//!    shape (`updated_by_device`, `_pending_publish`, `_replay_state`,
//!    `_tombstones`).
//! 3. Build a `Snapshot::from_legacy_db` from the local DB. This is the
//!    materialized view that becomes the bootstrap for every peer.
//! 4. Write the snapshot to `<ubiquity>/logs/<device>.snapshot.json` and
//!    create an empty `<ubiquity>/logs/<device>.jsonl` log file. Atomic
//!    via temp + fsync + rename so a crash here doesn't leave a partial
//!    snapshot for peers to consume.
//! 5. Write the `<local>/.migration_complete` marker. From this point on,
//!    launch flow knows to skip migration and just open the local DB +
//!    replay tick.
//! 6. Retire the ubiquity DB (rename to `quill.db.migrated-<iso>`).
//!    Idempotent — if a previous run already retired it, this is a no-op.
//!
//! Conflict-copy merge (`quill (1).db`, `quill (2).db`) is **not yet
//! implemented** in v1 — see TODO inline. v1 only handles the single-DB
//! case. Conflict copies become a Chunk 6.5 follow-up if real users hit
//! the divergence.
//!
//! See `docs/impls/sync/31-sync.md` Step 7 for the spec.

use std::fs;
use std::path::{Path, PathBuf};

use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::sync::log::EventLog;
use crate::sync::snapshot::Snapshot;

/// Marker written to `<local>/.migration_complete` after a successful
/// migration. Lives next to `.icloud_enabled`. Presence means "DB is
/// already local; per-device log lives in iCloud".
pub const MIGRATION_COMPLETE_MARKER: &str = ".migration_complete";

/// What `run_migration` did, surfaced for tests and logging.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct MigrationOutcome {
    pub copied_db: bool,
    pub wrote_snapshot: bool,
    pub created_log: bool,
    pub retired_files: usize,
}

pub fn migration_complete_path(local_dir: &Path) -> PathBuf {
    local_dir.join(MIGRATION_COMPLETE_MARKER)
}

pub fn is_migration_complete(local_dir: &Path) -> bool {
    migration_complete_path(local_dir).exists()
}

/// Migrate from legacy file-sync to per-device event log.
///
/// `local_dir` is the always-local app data directory (`<app_data>` in
/// the spec). `ubiquity_dir` is the iCloud Documents container. After a
/// successful run:
///
/// - `<local>/quill.db` is the new home of the DB (bit-exact copy of
///   the source, then auto-migrated to v11 by `Db::init`).
/// - `<ubiquity>/logs/<device>.snapshot.json` holds the bootstrap snapshot.
/// - `<ubiquity>/logs/<device>.jsonl` exists but is empty.
/// - `<local>/.migration_complete` exists.
/// - `<ubiquity>/quill.db*` are renamed to `quill.db.migrated-<iso>`.
///
/// On any failure the error is returned and no marker is written; the
/// next launch will retry. Partial state (e.g. snapshot written but
/// marker missing) is harmless because peers ignore unfamiliar
/// snapshots until they're advertised by an active log, and the next
/// run overwrites the snapshot anyway.
pub fn run_migration(
    local_dir: &Path,
    ubiquity_dir: &Path,
    device_id: &str,
) -> AppResult<MigrationOutcome> {
    let mut outcome = MigrationOutcome::default();

    // 0. Sanity: nothing to migrate if the marker is already there. This
    //    arm makes the function safe to call without the caller checking
    //    first; callers that DO check still benefit because we double-
    //    check before doing any IO.
    if is_migration_complete(local_dir) {
        // Self-healing retire — if a previous run wrote the marker but
        // crashed before retire, finish the job now.
        outcome.retired_files = retire_ubiquity_db(ubiquity_dir)?;
        return Ok(outcome);
    }

    let ubiquity_db = ubiquity_dir.join("quill.db");
    let local_db = local_dir.join("quill.db");

    // 1. Copy ubiquity → local. If local already exists from a partial
    //    previous attempt we leave it (Db::init below validates schema).
    //    If ubiquity doesn't exist there's nothing to migrate — write
    //    the marker so we don't try again every launch.
    if !ubiquity_db.exists() {
        fs::create_dir_all(local_dir)?;
        fs::write(migration_complete_path(local_dir), b"")?;
        return Ok(outcome);
    }
    if !local_db.exists() {
        fs::create_dir_all(local_dir)?;
        fs::copy(&ubiquity_db, &local_db)?;
        outcome.copied_db = true;
    }

    // 2. Open the local DB — Db::init applies migrations 1-11, so a
    //    legacy v8 / v9 / v10 file is brought to the current schema
    //    before we read it.
    let db = Db::init(&local_dir.to_path_buf())?;

    // 3. Build the snapshot from the now-migrated local DB.
    let snap = {
        let conn = db
            .conn
            .lock()
            .map_err(|e| AppError::Other(format!("db conn mutex: {e}")))?;
        Snapshot::from_legacy_db(&conn, device_id)?
    };

    // 4. Write snapshot + empty log into the ubiquity logs dir.
    let logs_dir = ubiquity_dir.join("logs");
    fs::create_dir_all(&logs_dir)?;
    let snap_path = logs_dir.join(format!("{device_id}.snapshot.json"));
    snap.write_atomic(&snap_path)?;
    outcome.wrote_snapshot = true;

    let log_path = logs_dir.join(format!("{device_id}.jsonl"));
    if !log_path.exists() {
        // EventLog::open creates the file if missing. We don't write any
        // events; the file exists so peers and `discover_peers` can find
        // us as a participant.
        let _ = EventLog::open(&log_path, device_id, false)?;
        outcome.created_log = true;
    }

    // 5. Mark complete BEFORE retiring the ubiquity DB. If retire fails
    //    we still want the next launch to skip the migration body and
    //    just retry retire (the self-healing arm above).
    fs::write(migration_complete_path(local_dir), b"")?;

    // 6. Retire ubiquity quill.db*.
    outcome.retired_files = retire_ubiquity_db(ubiquity_dir)?;

    Ok(outcome)
}

/// Rename `<ubiquity>/quill.db*` → `quill.db.migrated-<iso>`. Globs over
/// `quill.db`, `quill.db-wal`, `quill.db-shm`, and conflict copies like
/// `quill (1).db`. Idempotent — already-migrated files are skipped.
/// Returns the number of files renamed.
///
/// Called from `run_migration` step 6 and from the launch self-healing
/// arm. Safe to call on every launch.
pub fn retire_ubiquity_db(ubiquity_dir: &Path) -> AppResult<usize> {
    let ts = chrono::Utc::now().format("%Y%m%dT%H%M%SZ").to_string();
    let mut renamed = 0usize;
    let entries = match fs::read_dir(ubiquity_dir) {
        Ok(e) => e,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(0),
        Err(e) => return Err(AppError::Io(e)),
    };
    for entry in entries {
        let entry = entry?;
        let path = entry.path();
        let name = match path.file_name().and_then(|n| n.to_str()) {
            Some(n) => n.to_string(),
            None => continue,
        };
        if !is_legacy_db_file(&name) {
            continue;
        }
        let new_name = format!("{name}.migrated-{ts}");
        let new_path = ubiquity_dir.join(&new_name);
        // Best-effort rename; iCloud can transiently fail with EXDEV /
        // permission errors. Log and move on rather than fail the whole
        // migration.
        match fs::rename(&path, &new_path) {
            Ok(()) => renamed += 1,
            Err(e) => eprintln!(
                "sync: failed to retire ubiquity file {name:?}: {e}; will retry next launch"
            ),
        }
    }
    Ok(renamed)
}

/// True if `name` looks like a legacy file-sync DB artifact that should
/// be retired by the migration. Matches:
/// - `quill.db`, `quill.db-wal`, `quill.db-shm`
/// - conflict copies: `quill (1).db`, `quill (2).db-wal`, etc.
///
/// Already-retired files (`quill.db.migrated-*`) are intentionally NOT
/// matched — that's what makes retire idempotent.
fn is_legacy_db_file(name: &str) -> bool {
    if !name.starts_with("quill") {
        return false;
    }
    if name.contains(".migrated-") {
        return false;
    }
    let after_quill = &name["quill".len()..];
    if after_quill == ".db" || after_quill == ".db-wal" || after_quill == ".db-shm" {
        return true;
    }
    // Conflict-copy form: `quill (N).db`, `quill (N).db-wal`, etc.
    if let Some(stripped) = after_quill.strip_prefix(" (") {
        if let Some(close_paren) = stripped.find(')') {
            let n = &stripped[..close_paren];
            if !n.is_empty() && n.chars().all(|c| c.is_ascii_digit()) {
                let suffix = &stripped[close_paren + 1..];
                return suffix == ".db" || suffix == ".db-wal" || suffix == ".db-shm";
            }
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;
    use tempfile::TempDir;

    fn seed_legacy_db(path: &Path) {
        let conn = Connection::open(path).unwrap();
        conn.execute_batch("PRAGMA journal_mode=DELETE;").unwrap();
        // Pretend this is a v11-shaped file-sync DB (matches what the
        // user has after upgrading through migrations 1-11 normally).
        Db::run_migrations_on(&conn).unwrap();
        conn.execute(
            "INSERT INTO books
             (id, title, author, file_path, format, status, progress, created_at, updated_at, updated_by_device)
             VALUES ('b1', 'War and Peace', 'Tolstoy', 'books/wp.epub', 'epub', 'reading', 42, 1000, 1500, 'migration')",
            [],
        ).unwrap();
        conn.execute(
            "INSERT INTO highlights
             (id, book_id, cfi_range, color, created_at, updated_at, updated_by_device)
             VALUES ('h1', 'b1', 'cfi', 'yellow', 1100, 1100, 'migration')",
            [],
        ).unwrap();
    }

    fn count(db_path: &Path, table: &str) -> i64 {
        let conn = Connection::open(db_path).unwrap();
        conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0))
            .unwrap()
    }

    #[test]
    fn run_migration_first_run_writes_artifacts_and_retires_db() {
        let local = TempDir::new().unwrap();
        let ubiquity = TempDir::new().unwrap();
        let dev = "dev-MIGRATING";

        seed_legacy_db(&ubiquity.path().join("quill.db"));
        // WAL/SHM siblings the iCloud daemon may have left behind.
        fs::write(ubiquity.path().join("quill.db-wal"), b"wal").unwrap();
        fs::write(ubiquity.path().join("quill.db-shm"), b"shm").unwrap();

        let outcome = run_migration(local.path(), ubiquity.path(), dev).unwrap();

        assert!(outcome.copied_db);
        assert!(outcome.wrote_snapshot);
        assert!(outcome.created_log);
        assert!(outcome.retired_files >= 1);

        // Local DB exists and carries the seeded rows.
        assert!(local.path().join("quill.db").exists());
        assert_eq!(count(&local.path().join("quill.db"), "books"), 1);

        // Snapshot + log artifacts.
        assert!(ubiquity
            .path()
            .join("logs")
            .join(format!("{dev}.snapshot.json"))
            .exists());
        assert!(ubiquity
            .path()
            .join("logs")
            .join(format!("{dev}.jsonl"))
            .exists());

        // Marker.
        assert!(is_migration_complete(local.path()));

        // Ubiquity DB retired (renamed, not in place).
        assert!(!ubiquity.path().join("quill.db").exists());
        let mut migrated = 0;
        for entry in fs::read_dir(ubiquity.path()).unwrap() {
            let name = entry.unwrap().file_name().into_string().unwrap();
            if name.contains(".migrated-") {
                migrated += 1;
            }
        }
        assert!(migrated >= 1, "at least one retired file expected");
    }

    #[test]
    fn run_migration_is_idempotent_after_marker_set() {
        let local = TempDir::new().unwrap();
        let ubiquity = TempDir::new().unwrap();
        let dev = "dev-MIGRATING";

        seed_legacy_db(&ubiquity.path().join("quill.db"));
        run_migration(local.path(), ubiquity.path(), dev).unwrap();

        // Re-add a fake stray ubiquity DB to simulate a peer reverting
        // (not realistic in production, but proves the self-healing
        // retire arm runs on every call).
        fs::write(ubiquity.path().join("quill.db"), b"stray").unwrap();

        let outcome = run_migration(local.path(), ubiquity.path(), dev).unwrap();
        // Marker arm short-circuits → didn't copy/snapshot/create_log,
        // but DID retire the stray.
        assert!(!outcome.copied_db);
        assert!(!outcome.wrote_snapshot);
        assert!(!outcome.created_log);
        assert!(outcome.retired_files >= 1);
        assert!(!ubiquity.path().join("quill.db").exists());
    }

    #[test]
    fn run_migration_with_no_ubiquity_db_writes_marker_and_skips() {
        let local = TempDir::new().unwrap();
        let ubiquity = TempDir::new().unwrap();

        let outcome = run_migration(local.path(), ubiquity.path(), "dev-X").unwrap();
        assert!(!outcome.copied_db);
        assert!(is_migration_complete(local.path()));
    }

    #[test]
    fn retire_ubiquity_db_renames_main_wal_shm_and_conflict_copies() {
        let dir = TempDir::new().unwrap();
        for name in [
            "quill.db",
            "quill.db-wal",
            "quill.db-shm",
            "quill (1).db",
            "quill (2).db-wal",
            "secrets.db",
            "covers",
        ] {
            // `covers/` is a directory — it shouldn't be renamed. Files
            // get a single byte each.
            let p = dir.path().join(name);
            if name == "covers" {
                fs::create_dir(&p).unwrap();
            } else {
                fs::write(&p, b"x").unwrap();
            }
        }

        let renamed = retire_ubiquity_db(dir.path()).unwrap();
        assert_eq!(
            renamed, 5,
            "only quill.db family + conflict copies should retire"
        );
        assert!(!dir.path().join("quill.db").exists());
        assert!(!dir.path().join("quill.db-wal").exists());
        assert!(!dir.path().join("quill.db-shm").exists());
        assert!(!dir.path().join("quill (1).db").exists());
        assert!(!dir.path().join("quill (2).db-wal").exists());
        // Unrelated files are untouched.
        assert!(dir.path().join("secrets.db").exists());
        assert!(dir.path().join("covers").is_dir());
    }

    #[test]
    fn retire_ubiquity_db_skips_already_retired_files() {
        let dir = TempDir::new().unwrap();
        fs::write(
            dir.path().join("quill.db.migrated-20260101T000000Z"),
            b"x",
        )
        .unwrap();
        let renamed = retire_ubiquity_db(dir.path()).unwrap();
        assert_eq!(renamed, 0);
        assert!(dir
            .path()
            .join("quill.db.migrated-20260101T000000Z")
            .exists());
    }

    #[test]
    fn retire_ubiquity_db_missing_dir_is_a_noop() {
        let dir = TempDir::new().unwrap();
        let missing = dir.path().join("nope");
        let renamed = retire_ubiquity_db(&missing).unwrap();
        assert_eq!(renamed, 0);
    }

    #[test]
    fn is_legacy_db_file_matches_expected_set() {
        assert!(is_legacy_db_file("quill.db"));
        assert!(is_legacy_db_file("quill.db-wal"));
        assert!(is_legacy_db_file("quill.db-shm"));
        assert!(is_legacy_db_file("quill (1).db"));
        assert!(is_legacy_db_file("quill (12).db-wal"));

        assert!(!is_legacy_db_file("quill.db.migrated-20260101T000000Z"));
        assert!(!is_legacy_db_file("secrets.db"));
        assert!(!is_legacy_db_file("books"));
        assert!(!is_legacy_db_file("quill"));
        assert!(
            !is_legacy_db_file("quill ().db"),
            "empty parens isn't a real conflict copy"
        );
    }
}
