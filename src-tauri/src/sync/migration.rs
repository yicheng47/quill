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
//! Conflict-copy merge (`quill (1).db`, `quill (2).db`) is
//! **deliberately not implemented** in v1. Those files are artifacts of
//! the old whole-DB iCloud file-sync design and belong with it; the
//! event-log design has no equivalent representation. Detected conflict
//! copies are retired alongside the primary DB and a warning is logged
//! so a user with divergent libraries sees something concrete in the
//! console / report. Given the early-release scope and small user count
//! we accept the data-loss risk on this rare path; if a real user hits
//! it we'll write a one-off recovery tool. Tracked as the v1 trade-off
//! in PR #192's review.
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
    /// True when ubiquity/quill.db is currently an iCloud-evicted
    /// placeholder (`.quill.db.icloud`). The migration deferred and
    /// will retry next launch — the marker is intentionally NOT
    /// written. Surfaced separately from `copied_db = false` so callers
    /// can distinguish "nothing to migrate" from "wait for download".
    pub deferred_for_download: bool,
    /// Number of `quill (N).db*` conflict copies retired without merge.
    /// Counted separately so the log line at the call site can flag
    /// the data-loss risk to the user.
    pub conflict_copies_discarded: usize,
}

pub fn migration_complete_path(local_dir: &Path) -> PathBuf {
    local_dir.join(MIGRATION_COMPLETE_MARKER)
}

pub fn is_migration_complete(local_dir: &Path) -> bool {
    migration_complete_path(local_dir).exists()
}

/// Read the data_dir path that was active at migration time. Returns
/// `Some(path)` when the marker file holds a non-empty path string,
/// `None` for legacy markers (empty file from earlier Chunk 6 builds)
/// or when the marker is missing. Callers that need a stable
/// post-migration path must combine this with a deterministic
/// fallback (`icloud::icloud_data_dir_deterministic`) so the result
/// doesn't flip launch-to-launch when iCloud is temporarily down.
pub fn recorded_data_dir(local_dir: &Path) -> Option<PathBuf> {
    let bytes = fs::read(migration_complete_path(local_dir)).ok()?;
    let s = String::from_utf8(bytes).ok()?;
    let trimmed = s.trim();
    if trimmed.is_empty() {
        return None;
    }
    Some(PathBuf::from(trimmed))
}

/// Persist the marker with the absolute path of the binaries directory
/// so future launches resolve `books/`, `covers/` against the same
/// location regardless of whether iCloud is currently reachable. Empty
/// `data_dir` (passed when there was no legacy DB to migrate) writes
/// an empty marker — the launch-flow chain will fall back to the
/// deterministic iCloud path for that case.
pub fn write_marker(local_dir: &Path, data_dir: Option<&Path>) -> AppResult<()> {
    let bytes: Vec<u8> = match data_dir {
        Some(p) => p.to_string_lossy().into_owned().into_bytes(),
        None => Vec::new(),
    };
    fs::write(migration_complete_path(local_dir), bytes)?;
    Ok(())
}

/// Remove the `.migration_complete` marker. Used by `sync_disable` so
/// the next launch treats this device as un-synced and skips engine
/// boot. Idempotent — missing marker is fine.
pub fn remove_marker(local_dir: &Path) -> AppResult<()> {
    let path = migration_complete_path(local_dir);
    match fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(AppError::Io(e)),
    }
}

/// Resolve the iCloud Documents directory at launch time. `Some(path)`
/// when the launch flow should treat this install as having iCloud
/// sync "on" in some form (either legacy file-sync pending migration,
/// or post-migration / new-UI-enabled); `None` when sync is cleanly
/// off. Prefers the path recorded in the migration marker (stable
/// across launches) over the deterministic location (fallback for
/// legacy markers from pre-PR #192 builds or the untouched
/// `.icloud_enabled`-only case).
///
/// Taking the legacy-marker presence as a parameter keeps this helper
/// testable without pulling in macOS-only `icloud::is_icloud_enabled`.
pub fn resolve_ubiquity_dir(
    local_dir: &Path,
    legacy_marker_present: bool,
) -> Option<PathBuf> {
    let migration_done = is_migration_complete(local_dir);
    if !legacy_marker_present && !migration_done {
        return None;
    }
    recorded_data_dir(local_dir).or_else(crate::icloud::icloud_data_dir_deterministic)
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

    // 1a. ubiquity_dir itself is missing → iCloud container hasn't
    //     materialized yet (cold boot, signed-out account, daemon
    //     race). Defer without writing the marker. Critical: we MUST
    //     NOT mark complete here — if we did, the launch flow would
    //     create a fresh empty local DB on this launch, and the next
    //     launch (iCloud back) would see `local/quill.db` exists,
    //     skip the copy step, snapshot the empty file, and retire
    //     the real legacy DB. The user's library would be gone.
    //     (Reviewed in PR #192.)
    if !ubiquity_dir.exists() {
        outcome.deferred_for_download = true;
        return Ok(outcome);
    }

    // 1b. Resolve the source DB. Three cases:
    //
    //    a. `quill.db` is on disk → copy → migrate.
    //    b. `quill.db` is missing AND `.quill.db.icloud` placeholder is
    //       present → file is iCloud-evicted. Trigger a download and
    //       BAIL WITHOUT WRITING THE MARKER so the next launch retries.
    //       Users who haven't opened the app in months commonly land
    //       here — the iCloud daemon evicts cold files. Without this
    //       arm we'd silently skip migration forever (the next launch
    //       would see the marker and never retry), and the
    //       self-healing retire path in lib.rs would later rename the
    //       freshly-downloaded `quill.db` away as a "stray".
    //    c. Neither file present → no legacy data exists. Mark complete.
    if !ubiquity_db.exists() {
        let placeholder = match crate::icloud::icloud_placeholder_path(&ubiquity_db) {
            Some(p) => p,
            None => {
                // Pathological case (root path with no parent). Treat
                // as "nothing to migrate".
                fs::create_dir_all(local_dir)?;
                write_marker(local_dir, None)?;
                return Ok(outcome);
            }
        };
        if placeholder.exists() {
            // Ask the iCloud daemon to download. No-op on non-macOS;
            // best-effort on macOS (failures are logged in
            // `trigger_download_file`). Either way we return without a
            // marker so next launch tries again.
            crate::icloud::trigger_download_file(&ubiquity_db);
            outcome.deferred_for_download = true;
            return Ok(outcome);
        }
        // No legacy data to migrate. Mark complete with no recorded
        // path so the launch flow falls back to the deterministic
        // iCloud path (or local on non-macOS).
        fs::create_dir_all(local_dir)?;
        write_marker(local_dir, None)?;
        return Ok(outcome);
    }

    // ALWAYS copy ubiquity → local — never skip just because local_db
    // already exists. A leftover local DB might be:
    //   - A partially-migrated file from a crashed prior run.
    //   - A "tentative" DB created by a prior launch that opened
    //     local while migration was deferred (iCloud unreachable at
    //     boot). Any session writes against that DB are sacrificed
    //     to preserve the legacy library — the alternative would be
    //     snapshotting the empty/tentative local file and retiring
    //     the real legacy DB, which is unrecoverable data loss.
    //   - A stale file from a past failed migration where the marker
    //     was never written.
    // In all three cases, copying ubiquity → local is the right move:
    // ubiquity holds the source-of-truth library, and we're about to
    // retire it anyway.
    fs::create_dir_all(local_dir)?;
    fs::copy(&ubiquity_db, &local_db)?;
    outcome.copied_db = true;

    // 2. Open the local DB — Db::init applies migrations 1-11, so a
    //    legacy v8 / v9 / v10 file is brought to the current schema
    //    before we read it.
    let db = Db::init(local_dir)?;

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
    //
    //    The marker stores the absolute ubiquity path so the launch
    //    flow always resolves blob paths against the same dir, even if
    //    iCloud is offline at next launch (path resolution is decoupled
    //    from path availability — IO will fail visibly instead of
    //    silently flipping data_dir).
    write_marker(local_dir, Some(ubiquity_dir))?;

    // 6. Retire ubiquity quill.db*.
    let report = retire_ubiquity_db_with_report(ubiquity_dir)?;
    outcome.retired_files = report.renamed;
    outcome.conflict_copies_discarded = report.conflict_copies_discarded;

    Ok(outcome)
}

/// What `retire_ubiquity_db` did. Pulled out as a struct so the
/// migration outcome can flag conflict-copy discards without changing
/// the simpler `retire_ubiquity_db` callers.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct RetireReport {
    pub renamed: usize,
    pub conflict_copies_discarded: usize,
}

/// Rename `<ubiquity>/quill.db*` → `quill.db.migrated-<iso>`. Globs over
/// `quill.db`, `quill.db-wal`, `quill.db-shm`, and conflict copies like
/// `quill (1).db`. Idempotent — already-migrated files are skipped.
/// Returns the number of files renamed.
///
/// Called from `run_migration` step 6 and from the launch self-healing
/// arm. Safe to call on every launch.
pub fn retire_ubiquity_db(ubiquity_dir: &Path) -> AppResult<usize> {
    Ok(retire_ubiquity_db_with_report(ubiquity_dir)?.renamed)
}

/// Same as `retire_ubiquity_db` but surfaces the conflict-copy count
/// separately so `run_migration` can flag the data-loss risk. See the
/// module docstring for why we deliberately discard conflict copies in
/// v1 instead of merging them.
pub fn retire_ubiquity_db_with_report(ubiquity_dir: &Path) -> AppResult<RetireReport> {
    let ts = chrono::Utc::now().format("%Y%m%dT%H%M%SZ").to_string();
    let mut report = RetireReport::default();
    let entries = match fs::read_dir(ubiquity_dir) {
        Ok(e) => e,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(report),
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
        let is_conflict = is_conflict_copy(&name);
        let new_name = format!("{name}.migrated-{ts}");
        let new_path = ubiquity_dir.join(&new_name);
        // Best-effort rename; iCloud can transiently fail with EXDEV /
        // permission errors. Log and move on rather than fail the whole
        // migration.
        match fs::rename(&path, &new_path) {
            Ok(()) => {
                report.renamed += 1;
                if is_conflict {
                    report.conflict_copies_discarded += 1;
                    // Loud warning so a migrating user sees something
                    // concrete in the console — conflict copies are
                    // deliberately discarded in v1 (see module doc).
                    eprintln!(
                        "sync: WARNING — discarding legacy conflict copy {name:?} \
                         without merging. Any rows unique to this file are lost. \
                         The retired file remains at {new_name:?} for manual recovery."
                    );
                }
            }
            Err(e) => eprintln!(
                "sync: failed to retire ubiquity file {name:?}: {e}; will retry next launch"
            ),
        }
    }
    Ok(report)
}

/// Subset of `is_legacy_db_file` — true only for `quill (N).db*`.
/// `quill.db` / `quill.db-wal` / `quill.db-shm` are NOT conflict copies.
fn is_conflict_copy(name: &str) -> bool {
    if !name.starts_with("quill (") {
        return false;
    }
    is_legacy_db_file(name)
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

    // -----------------------------------------------------------------
    // resolve_ubiquity_dir — launch-flow gate. Regression for the
    // umbrella PR review finding #1: new-UI enablers never get
    // `.icloud_enabled` written, so the gate must accept
    // `.migration_complete` on its own or sync dies on restart.
    // -----------------------------------------------------------------

    #[test]
    fn resolve_ubiquity_dir_none_when_no_markers() {
        let local = TempDir::new().unwrap();
        assert_eq!(resolve_ubiquity_dir(local.path(), false), None);
    }

    #[test]
    fn resolve_ubiquity_dir_returns_recorded_path_for_new_ui_enabler() {
        let local = TempDir::new().unwrap();
        // Simulate `sync_enable` having written the marker with an
        // explicit ubiquity path. `.icloud_enabled` is deliberately
        // absent — the bug was that legacy-only gating left these
        // users with None.
        let recorded = TempDir::new().unwrap();
        write_marker(local.path(), Some(recorded.path())).unwrap();

        let resolved = resolve_ubiquity_dir(local.path(), false).expect("must resolve");
        assert_eq!(resolved, recorded.path());
    }

    #[test]
    fn resolve_ubiquity_dir_returns_recorded_path_for_legacy_only_user() {
        let local = TempDir::new().unwrap();
        // Legacy user: only `.icloud_enabled` is present (no marker).
        // On macOS the deterministic fallback resolves to the real
        // container path; on other platforms it's None — either way
        // the gate itself opens because the legacy marker is true.
        let resolved = resolve_ubiquity_dir(local.path(), true);
        #[cfg(target_os = "macos")]
        assert!(resolved.is_some(), "legacy marker on macOS should resolve");
        #[cfg(not(target_os = "macos"))]
        assert!(resolved.is_none(), "no deterministic fallback off macOS");
    }

    #[test]
    fn resolve_ubiquity_dir_prefers_recorded_over_legacy_fallback() {
        let local = TempDir::new().unwrap();
        let recorded = TempDir::new().unwrap();
        write_marker(local.path(), Some(recorded.path())).unwrap();

        // Legacy marker also present — still prefer the recorded
        // path, not the deterministic iCloud fallback.
        let resolved = resolve_ubiquity_dir(local.path(), true).unwrap();
        assert_eq!(resolved, recorded.path());
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

        // Marker present AND records the ubiquity path so the next
        // launch resolves binaries against the same directory even if
        // iCloud is offline at boot.
        assert!(is_migration_complete(local.path()));
        assert_eq!(
            recorded_data_dir(local.path()).as_deref(),
            Some(ubiquity.path()),
            "marker must record the absolute ubiquity path for stable resolution"
        );

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
    fn run_migration_with_empty_ubiquity_dir_writes_marker_and_skips() {
        let local = TempDir::new().unwrap();
        let ubiquity = TempDir::new().unwrap();
        // ubiquity dir EXISTS (TempDir created it) but contains no
        // legacy DB and no placeholder → genuinely no data to migrate.
        let outcome = run_migration(local.path(), ubiquity.path(), "dev-X").unwrap();
        assert!(!outcome.copied_db);
        assert!(!outcome.deferred_for_download);
        assert!(is_migration_complete(local.path()));
    }

    /// Regression for the first-launch-without-iCloud finding (PR #192
    /// 4th-round review): if `ubiquity_dir` itself doesn't exist
    /// (iCloud container hasn't materialized yet — cold boot, signed-
    /// out account, daemon race), `run_migration` MUST defer without
    /// writing the marker. Writing the marker would let the next
    /// launch open a fresh empty local DB which the *next* migration
    /// would then snapshot and use to retire the real legacy DB —
    /// permanent data loss.
    #[test]
    fn run_migration_defers_when_ubiquity_dir_missing() {
        let local = TempDir::new().unwrap();
        let tmp = TempDir::new().unwrap();
        let ubiquity = tmp.path().join("not-yet-materialized");
        // Don't create the directory.
        assert!(!ubiquity.exists());

        let outcome = run_migration(local.path(), &ubiquity, "dev-X").unwrap();
        assert!(outcome.deferred_for_download);
        assert!(!outcome.copied_db);
        assert!(
            !is_migration_complete(local.path()),
            "marker MUST NOT be written when ubiquity is unreachable — \
             otherwise next launch would open a fresh local DB and the \
             migration after that would retire the real legacy DB"
        );
    }

    /// Regression for the same finding's second arm: if a tentative
    /// local DB exists from a prior deferred-migration launch (or a
    /// crashed previous attempt), `run_migration` must clobber it
    /// with the real ubiquity DB — never snapshot the local file and
    /// retire ubiquity. The legacy library is the source of truth.
    #[test]
    fn run_migration_clobbers_tentative_local_db_with_ubiquity() {
        let local = TempDir::new().unwrap();
        let ubiquity = TempDir::new().unwrap();
        let dev = "dev-MIGRATING";

        // Seed legacy ubiquity DB with one book.
        seed_legacy_db(&ubiquity.path().join("quill.db"));

        // Simulate a tentative local DB created during a previous
        // launch where iCloud was unreachable. Different content from
        // the legacy DB so the test can tell which one survived.
        let conn = Connection::open(local.path().join("quill.db")).unwrap();
        Db::run_migrations_on(&conn).unwrap();
        conn.execute(
            "INSERT INTO books
             (id, title, author, file_path, format, status, progress, created_at, updated_at, updated_by_device)
             VALUES ('tentative', 'Imported during wedge', 'X', 'books/x.epub', 'epub', 'reading', 0, 1, 1, 'wedge')",
            [],
        ).unwrap();
        drop(conn);

        run_migration(local.path(), ubiquity.path(), dev).unwrap();

        // Local now mirrors the legacy library — the tentative row is
        // gone, the legacy `b1` row is present.
        let local_conn = Connection::open(local.path().join("quill.db")).unwrap();
        let has_legacy: bool = local_conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM books WHERE id = 'b1')",
                [],
                |r| r.get(0),
            )
            .unwrap();
        let has_tentative: bool = local_conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM books WHERE id = 'tentative')",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert!(has_legacy, "real legacy book must survive the migration");
        assert!(
            !has_tentative,
            "tentative wedge-session writes are deliberately sacrificed \
             so the legacy library wins the conflict"
        );
    }

    /// Regression for the data_dir-stability follow-up on PR #192.
    /// Markers from the first Chunk 6 build are empty files; loading
    /// them must NOT spuriously return `Some(<empty path>)`. Returning
    /// `None` lets the launch flow fall back to the deterministic
    /// iCloud path instead of resolving against `""`.
    #[test]
    fn recorded_data_dir_is_none_for_legacy_empty_marker() {
        let local = TempDir::new().unwrap();
        // Simulate the legacy marker: empty file at .migration_complete.
        fs::write(migration_complete_path(local.path()), b"").unwrap();
        assert!(is_migration_complete(local.path()));
        assert_eq!(recorded_data_dir(local.path()), None);
    }

    /// Round-trip: the path written by `write_marker` is what
    /// `recorded_data_dir` reads back. This is the contract the launch
    /// flow relies on for stable post-migration data_dir resolution.
    #[test]
    fn recorded_data_dir_round_trips_through_marker() {
        let local = TempDir::new().unwrap();
        let data_dir = std::path::Path::new("/tmp/some/icloud/path");
        write_marker(local.path(), Some(data_dir)).unwrap();
        assert_eq!(
            recorded_data_dir(local.path()).as_deref(),
            Some(data_dir),
        );
    }

    /// Regression for review finding #2: a `.quill.db.icloud` placeholder
    /// (file is iCloud-evicted, not yet downloaded) must NOT cause the
    /// migration to short-circuit with the marker. We bail without the
    /// marker so the next launch retries after iCloud finishes pulling
    /// the real file down.
    #[test]
    fn run_migration_with_icloud_placeholder_defers_and_skips_marker() {
        let local = TempDir::new().unwrap();
        let ubiquity = TempDir::new().unwrap();
        // No quill.db, but a placeholder marking it as evicted.
        fs::write(ubiquity.path().join(".quill.db.icloud"), b"placeholder").unwrap();

        let outcome = run_migration(local.path(), ubiquity.path(), "dev-X").unwrap();
        assert!(outcome.deferred_for_download);
        assert!(!outcome.copied_db);
        assert!(!outcome.wrote_snapshot);
        assert!(
            !is_migration_complete(local.path()),
            "marker must NOT be written when the source is evicted — \
             we need next launch to retry"
        );
    }

    /// Regression for review finding #3: conflict copies are
    /// deliberately retired without merging in v1. The migration
    /// outcome surfaces the count so the launch-flow log can flag it.
    /// This test pins both sides of the contract: detection and
    /// counting.
    #[test]
    fn run_migration_counts_discarded_conflict_copies() {
        let local = TempDir::new().unwrap();
        let ubiquity = TempDir::new().unwrap();
        let dev = "dev-MIGRATING";

        seed_legacy_db(&ubiquity.path().join("quill.db"));
        // Two conflict copies with their own seeded DBs (data we
        // intentionally drop on the floor).
        seed_legacy_db(&ubiquity.path().join("quill (1).db"));
        seed_legacy_db(&ubiquity.path().join("quill (2).db"));

        let outcome = run_migration(local.path(), ubiquity.path(), dev).unwrap();
        assert_eq!(
            outcome.conflict_copies_discarded, 2,
            "both quill (N).db files should be counted as discarded"
        );
        // Both files should have been retired (renamed) — none left in
        // place.
        assert!(!ubiquity.path().join("quill (1).db").exists());
        assert!(!ubiquity.path().join("quill (2).db").exists());
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
