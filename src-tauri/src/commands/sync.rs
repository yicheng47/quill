//! Sync commands exposed to the frontend.
//!
//! Surface area for the per-device event-log sync (issue #185):
//!
//! - `sync_status` — read-only snapshot for the settings UI, including
//!   the peer manifest list.
//! - `sync_enable` — first-time enable: ensure iCloud subdirs, move
//!   local binaries into the ubiquity container, stamp the migration
//!   marker, publish the device manifest, open the EventLog, and boot
//!   the replay engine + watcher in this process. Idempotent — calling
//!   it while sync is already on is a cheap no-op.
//! - `sync_disable` — stop the engine + watcher, stop publishing,
//!   copy binaries back to local, remove markers and own manifest.
//!   Symmetric with the today's `icloud_disable` UX.
//! - `sync_now` — manual replay tick (Chunk 6 shipped this; the
//!   `SyncState` indirection is the only code change here).
//! - `sync_revert_to_legacy` — placeholder for the 30-day grace-window
//!   rollback to the legacy file-sync model. Stubbed in v1 because the
//!   legacy implementation has been removed; tracked for v1.1 if a real
//!   user actually needs it.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::State;

use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::icloud;
use crate::sync::device::DeviceIdentity;
use crate::sync::log::EventLog;
use crate::sync::peers;
use crate::sync::replay::{ReplayEngine, ReplayReport};
use crate::sync::snapshot::{self, CompactReport, Snapshot};
// `Snapshot` is referenced from the `publish_bootstrap_snapshot` helper.
use crate::sync::watcher::{self, WatcherHandle};
use crate::sync::writer::SyncWriter;
use crate::{sync, LocalDir};

/// Live sync engine + watcher handles, swappable from `sync_enable` /
/// `sync_disable`. Stored in Tauri state once at setup and read by
/// every sync-aware command. We can't put `Option<Arc<ReplayEngine>>`
/// in state directly because Tauri state is read-only after `manage`
/// — the `Mutex` is what makes `enable` and `disable` swap them.
pub struct SyncState {
    pub engine: Mutex<Option<Arc<ReplayEngine>>>,
    /// `WatcherHandle` is dropped on `sync_disable`; the `Drop` impl
    /// signals the watcher thread to stop and joins it.
    pub watcher: Mutex<Option<WatcherHandle>>,
}

impl SyncState {
    pub fn new(
        engine: Option<Arc<ReplayEngine>>,
        watcher: Option<WatcherHandle>,
    ) -> Self {
        Self {
            engine: Mutex::new(engine),
            watcher: Mutex::new(watcher),
        }
    }

    /// Lock-free read for `sync_now` and `sync_status`. Holding the
    /// mutex across an entire replay tick would serialize unrelated
    /// commands, so we clone the `Arc` out and drop the lock.
    pub fn engine_snapshot(&self) -> AppResult<Option<Arc<ReplayEngine>>> {
        Ok(self
            .engine
            .lock()
            .map_err(|e| AppError::Other(format!("sync engine mutex: {e}")))?
            .as_ref()
            .map(Arc::clone))
    }
}

/// Wire shape for the settings UI. Matches the JSON described in
/// `docs/impls/sync/31-sync.md` Step 9. Camel-cased on the frontend
/// via serde's default snake_case → the React component reads
/// `device_uuid`, `last_seen`, etc. directly.
#[derive(Debug, Serialize)]
pub struct SyncStatus {
    /// True when the engine is booted in this process (writes are
    /// publishing to the log, watcher is running). Not the same as
    /// "iCloud is signed in" — see `available`.
    pub enabled: bool,
    /// True when this Mac currently has access to an iCloud container.
    /// `enabled` requires `available` but not the other way around —
    /// a migrated user with iCloud temporarily down has `enabled =
    /// false, available = false, migration_complete = true`.
    pub available: bool,
    /// True once the legacy file-sync migration has run successfully.
    /// Used by the UI to decide whether to show the migration banner.
    pub migration_complete: bool,
    pub shared_dir: Option<String>,
    pub device_uuid: String,
    pub device_name: String,
    pub peers: Vec<PeerInfo>,
    pub pending_events: i64,
    pub last_replay_at: Option<i64>,
}

#[derive(Debug, Serialize)]
pub struct PeerInfo {
    pub device_uuid: String,
    pub name: String,
    pub platform: String,
    pub app_version: String,
    pub last_seen: i64,
    /// Number of events from this peer that haven't been applied to
    /// our local DB yet (peer log line count − our `_replay_state`
    /// watermark). Approximate — counts the line bytes, not
    /// individual events. Good enough for the UI's "N pending" pill.
    pub pending_events: i64,
}

/// JSON-friendly mirror of `ReplayReport`. We keep it explicit (rather
/// than deriving `Serialize` on `ReplayReport` directly) so internal
/// renames don't leak into the wire shape.
#[derive(Debug, Serialize)]
pub struct SyncNowResult {
    pub outbox_flushed: usize,
    pub snapshots_applied: usize,
    pub events_applied: usize,
    pub peers_seen: usize,
}

impl From<ReplayReport> for SyncNowResult {
    fn from(r: ReplayReport) -> Self {
        Self {
            outbox_flushed: r.outbox_flushed,
            snapshots_applied: r.snapshots_applied,
            events_applied: r.events_applied,
            peers_seen: r.peers_seen,
        }
    }
}

/// JSON shape for the "Compact log" button feedback. Mirrors
/// `CompactReport` from `sync::snapshot`.
#[derive(Debug, Serialize)]
pub struct SyncCompactResult {
    pub events_folded: usize,
    pub snapshot_written: bool,
    pub bytes_freed: i64,
}

impl From<CompactReport> for SyncCompactResult {
    fn from(r: CompactReport) -> Self {
        Self {
            events_folded: r.events_folded,
            snapshot_written: r.snapshot_written,
            bytes_freed: r.bytes_freed,
        }
    }
}

#[tauri::command]
pub fn sync_status(
    local: State<'_, LocalDir>,
    db: State<'_, Db>,
    device: State<'_, DeviceIdentity>,
    sync_state: State<'_, SyncState>,
) -> AppResult<SyncStatus> {
    let migration_complete = sync::migration::is_migration_complete(&local.0);
    let shared_dir = sync::migration::recorded_data_dir(&local.0)
        .or_else(icloud::icloud_data_dir_deterministic);
    let available = icloud::icloud_data_dir().is_some();
    let enabled = sync_state.engine_snapshot()?.is_some();

    // Peer list + per-peer pending events. Both are cheap reads off
    // the shared folder; both can fail individually without making
    // the whole status call hard-fail (settings UI just shows fewer
    // peers / `pending = 0`).
    let peers = match shared_dir.as_ref() {
        Some(dir) => peers::list_peers(dir, &device.device_uuid).unwrap_or_else(|e| {
            eprintln!("sync_status: list_peers failed: {e}");
            Vec::new()
        }),
        None => Vec::new(),
    };
    let watermarks = read_watermarks(&db).unwrap_or_default();
    let peer_infos: Vec<PeerInfo> = peers
        .into_iter()
        .map(|p| {
            let pending = match shared_dir.as_ref() {
                Some(dir) => count_pending_for_peer(dir, &p.device_uuid, watermarks.iter()
                    .find(|(d, _)| d == &p.device_uuid)
                    .and_then(|(_, w)| w.as_deref())),
                None => 0,
            };
            PeerInfo {
                device_uuid: p.device_uuid,
                name: p.name,
                platform: p.platform,
                app_version: p.app_version,
                last_seen: p.last_seen,
                pending_events: pending,
            }
        })
        .collect();

    let pending_events = count_local_outbox(&db).unwrap_or(0);
    let last_replay_at = read_last_replay_at(&db).unwrap_or(None);

    Ok(SyncStatus {
        enabled,
        available,
        migration_complete,
        shared_dir: shared_dir.map(|p| p.to_string_lossy().into_owned()),
        device_uuid: device.device_uuid.clone(),
        device_name: peers::device_name(),
        peers: peer_infos,
        pending_events,
        last_replay_at,
    })
}

#[tauri::command]
pub fn sync_enable(
    local: State<'_, LocalDir>,
    db: State<'_, Db>,
    device: State<'_, DeviceIdentity>,
    sync_writer: State<'_, SyncWriter>,
    sync_state: State<'_, SyncState>,
) -> AppResult<()> {
    // Idempotent — already on means already on.
    if sync_state.engine_snapshot()?.is_some() {
        return Ok(());
    }

    // ---- Phase 1: fallible preparation with no durable state writes ----
    // Everything that can fail (iCloud discovery, snapshot generation,
    // log open, watcher spawn) happens here FIRST so we never return an
    // error after the user's disk has been told "sync is on". If any
    // step below this line fails, the durable state is still "sync
    // off" and the user can retry with a clean slate.

    let icloud_dir = icloud::icloud_data_dir()
        .ok_or_else(|| AppError::Other("iCloud is not available".into()))?;
    icloud::ensure_downloaded(&icloud_dir)?;

    fs::create_dir_all(icloud_dir.join("logs"))?;
    fs::create_dir_all(icloud_dir.join("devices"))?;
    fs::create_dir_all(icloud_dir.join("books"))?;
    fs::create_dir_all(icloud_dir.join("covers"))?;

    // Open the EventLog. `EventLog::open` touches the log file with
    // `create(true).append(true)` — technically a mutation, but an
    // empty log file is recoverable: nothing references it until we
    // write the manifest, so an orphan empty jsonl is indistinguishable
    // from "sync was never enabled." Still rolled back on failure below.
    let log_path = icloud_dir
        .join("logs")
        .join(format!("{}.jsonl", device.device_uuid));
    let log = Arc::new(EventLog::open(&log_path, &device.device_uuid, true)?);

    let engine = Arc::new(ReplayEngine::new(
        icloud_dir.clone(),
        device.device_uuid.clone(),
        Arc::clone(&log),
    ));

    // Watcher spawn is the most likely failure point — do it before
    // any durable write. If it fails, we abort cleanly; the log file
    // creation above is orphaned but harmless.
    let watcher_handle =
        watcher::spawn(icloud_dir.clone(), db.inner().clone(), Arc::clone(&engine))?;

    // ---- Phase 2: durable-state commit ----
    // Order is load-bearing: small idempotent files first, then the
    // marker (the "we are on" commit), then `data_dir` repoint
    // (in-memory but the source of truth for blob path resolution),
    // then the binary move LAST.
    //
    // `move_dir_contents` is a real move, not a copy — it `fs::rename`s
    // within a filesystem and falls back to `copy + remove` cross-
    // device. If we moved first and then a later step failed, the
    // books would already be in iCloud while `data_dir` still
    // resolved against local — the library would appear empty until
    // the next launch booted the engine. Doing the move after
    // `data_dir` repoint means a partial-move failure still leaves
    // the app correctly resolving the moved entries out of iCloud;
    // only the un-moved tail in local is invisible until a retry.
    // PR #190's fourth-pass review caught the pre-fix order, where
    // every iCloud-side write between the move and the data_dir
    // update was a potential data-loss path.

    publish_bootstrap_snapshot(&db, &icloud_dir, &device.device_uuid)?;

    peers::write_own_manifest(
        &icloud_dir,
        &device.device_uuid,
        &peers::device_name(),
        peers::current_platform(),
        env!("CARGO_PKG_VERSION"),
        chrono::Utc::now().timestamp_millis(),
    )?;

    sync::migration::write_marker(&local.0, Some(&icloud_dir))?;

    {
        let mut data_dir = db
            .data_dir
            .lock()
            .map_err(|e| AppError::Other(format!("data_dir mutex: {e}")))?;
        *data_dir = icloud_dir.clone();
    }

    // Wire the writer + store engine/watcher in state. These are
    // in-memory only; infallible past the mutex-poisoning edge.
    sync_writer.set_should_queue(true);
    sync_writer.set_log(Some(Arc::clone(&log)));

    {
        let mut g = sync_state
            .engine
            .lock()
            .map_err(|e| AppError::Other(format!("engine mutex: {e}")))?;
        *g = Some(Arc::clone(&engine));
    }
    {
        let mut g = sync_state
            .watcher
            .lock()
            .map_err(|e| AppError::Other(format!("watcher mutex: {e}")))?;
        *g = Some(watcher_handle);
    }

    // First-time enable: move local binaries into the ubiquity container
    // so peers can read them. Re-enable after a disable just shuffles
    // whatever the user has imported in the meantime — usually a no-op
    // since the binaries are already in iCloud.
    move_dir_contents(&local.0.join("books"), &icloud_dir.join("books"))?;
    move_dir_contents(&local.0.join("covers"), &icloud_dir.join("covers"))?;

    // Fire an initial tick now that the engine is fully wired. Failure
    // is non-fatal — the watcher will retry on the next event, and a
    // fresh-enable session doesn't have leftover outbox rows or peer
    // tails that would get stuck pending.
    {
        let mut conn = db
            .conn
            .lock()
            .map_err(|e| AppError::Other(format!("db conn mutex: {e}")))?;
        if let Err(e) = engine.tick(&mut conn) {
            eprintln!("sync_enable: initial tick failed: {e}");
        }
    }

    Ok(())
}

#[tauri::command]
pub fn sync_disable(
    local: State<'_, LocalDir>,
    db: State<'_, Db>,
    device: State<'_, DeviceIdentity>,
    sync_writer: State<'_, SyncWriter>,
    sync_state: State<'_, SyncState>,
) -> AppResult<()> {
    // ---- Phase 1: fallible binary copy-back with no state change ----
    // If this fails (e.g. iCloud-evicted files, disk full), return an
    // error without touching any session or marker state. The user
    // sees "disable failed, please retry" and the system is still in
    // the "sync on" state — matching reality. The previous shape tore
    // down engine + writer first, so a mid-copy failure produced a
    // session that thought sync was off while the marker stayed on,
    // which then silently re-enabled on the next launch.

    let ubiquity_dir = sync::migration::recorded_data_dir(&local.0)
        .or_else(icloud::icloud_data_dir_deterministic);
    if let Some(ub) = ubiquity_dir.as_ref() {
        copy_dir_contents(&ub.join("books"), &local.0.join("books"))?;
        copy_dir_contents(&ub.join("covers"), &local.0.join("covers"))?;
    }

    // ---- Phase 2: teardown + marker removal ----
    // Every step from here is non-fatal or explicitly logged. The
    // fallible copy-back above succeeded, so we're committed to
    // turning sync off.

    // Drop the watcher first. Drop signals stop + joins the thread —
    // no further fs events will trigger ticks while we mutate state.
    {
        let mut g = sync_state
            .watcher
            .lock()
            .map_err(|e| AppError::Other(format!("watcher mutex: {e}")))?;
        *g = None;
    }
    // Drop the engine. The Arc may still be held by a tick in flight
    // (sync_now), but `set_log(None)` below stops new outbox flushes
    // from finding a log handle; the in-flight tick finishes against
    // its captured Arc and that's the end of it.
    {
        let mut g = sync_state
            .engine
            .lock()
            .map_err(|e| AppError::Other(format!("engine mutex: {e}")))?;
        *g = None;
    }

    // Stop publishing. Future `with_tx` calls neither queue into
    // `_pending_publish` nor try to drain it.
    sync_writer.set_log(None);
    sync_writer.set_should_queue(false);

    // Repoint data_dir at local now that the binary copy-back has
    // finished. Mid-flight reads during phase 1 still resolved
    // against iCloud, which is correct (the files haven't moved yet).
    {
        let mut data_dir = db
            .data_dir
            .lock()
            .map_err(|e| AppError::Other(format!("data_dir mutex: {e}")))?;
        *data_dir = local.0.clone();
    }

    // Remove the manifest so other peers don't see a stuck "Last
    // seen" — they'll just see this device drop off the list. Best-
    // effort; failure is logged but doesn't block disable.
    if let Some(ub) = ubiquity_dir.as_ref() {
        if let Err(e) = peers::delete_own_manifest(ub, &device.device_uuid) {
            eprintln!("sync_disable: failed to remove own peer manifest: {e}");
        }
    }

    // Remove markers. Both legacy (`.icloud_enabled`) and new (`.migration_complete`).
    sync::migration::remove_marker(&local.0)?;
    let legacy_marker = local.0.join(".icloud_enabled");
    let _ = fs::remove_file(&legacy_marker);

    Ok(())
}

#[tauri::command]
pub fn sync_now(
    db: State<'_, Db>,
    sync_state: State<'_, SyncState>,
) -> AppResult<SyncNowResult> {
    let engine = sync_state
        .engine_snapshot()?
        .ok_or_else(|| AppError::Other("sync is not enabled on this device".into()))?;
    let mut conn = db
        .conn
        .lock()
        .map_err(|e| AppError::Other(format!("db conn mutex: {e}")))?;
    let report = engine.tick(&mut conn)?;
    Ok(report.into())
}

/// Manually trigger a compaction of the device's own log. Folds the
/// existing snapshot + every log event into a fresh snapshot, then
/// truncates the log. Idempotent — pressing the button on an already-
/// compacted log returns `events_folded = 0`.
///
/// Returns an error when sync isn't enabled in this process — the
/// settings UI surfaces it as a toast.
#[tauri::command]
pub fn sync_compact(sync_state: State<'_, SyncState>) -> AppResult<SyncCompactResult> {
    let engine = sync_state
        .engine_snapshot()?
        .ok_or_else(|| AppError::Other("sync is not enabled on this device".into()))?;
    let report = snapshot::compact_own_log(&engine.shared_dir, &engine.own_log)?;
    Ok(report.into())
}

/// Placeholder for the 30-day grace-window rollback to legacy file-sync.
/// The legacy implementation has been removed in this chunk, so the
/// rollback can't actually restore old behavior — return a clear
/// error rather than pretend. If a real user needs this we'll layer
/// it back as a tagged-release recovery tool.
#[tauri::command]
pub fn sync_revert_to_legacy() -> AppResult<()> {
    Err(AppError::Other(
        "Reverting to legacy iCloud file-sync is not supported in this version. \
         To stop syncing, use the Sync toggle above."
            .into(),
    ))
}

// ---------------------------------------------------------------------------
// Helpers — kept private to this module since they're only used here.
// ---------------------------------------------------------------------------

/// Snapshot the current local DB into `<shared>/logs/<uuid>.snapshot.json`
/// so peers can bootstrap from it. Called by `sync_enable` for both
/// first-time enable and re-enable after disable.
///
/// Why on every enable, not just first-time:
/// - **First-time enable.** The local DB has every book/highlight/chat
///   the user ever created locally; sync was off when they were
///   written, so no `book.import` / `highlight.add` events exist for
///   those rows. Without a snapshot, peers see an empty library.
/// - **Re-enable after disable.** During disable, `should_queue` is
///   off in `SyncWriter`, so any rows the user added or edited while
///   sync was off never made it into the outbox. A fresh snapshot
///   captures that delta and republishes it.
///
/// The snapshot replaces the previous one. Peers detect a new
/// `snapshot.id` and apply it via `apply_peer` — idempotent under the
/// LWW + tombstone rules in `merge.rs`, so this is safe even when
/// peers have already seen most of the entities individually.
fn publish_bootstrap_snapshot(
    db: &Db,
    shared_dir: &Path,
    device_uuid: &str,
) -> AppResult<()> {
    let path = shared_dir
        .join("logs")
        .join(format!("{device_uuid}.snapshot.json"));
    let conn = db
        .conn
        .lock()
        .map_err(|e| AppError::Other(format!("db conn mutex: {e}")))?;
    let snap = Snapshot::from_legacy_db(&conn, device_uuid)?;
    snap.write_atomic(&path)?;
    Ok(())
}

fn read_watermarks(db: &Db) -> AppResult<Vec<(String, Option<String>)>> {
    let conn = db
        .conn
        .lock()
        .map_err(|e| AppError::Other(format!("db conn mutex: {e}")))?;
    let mut stmt = conn.prepare(
        "SELECT peer_device, last_event_id FROM _replay_state",
    )?;
    let rows = stmt
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?)))?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

fn count_local_outbox(db: &Db) -> AppResult<i64> {
    let conn = db
        .conn
        .lock()
        .map_err(|e| AppError::Other(format!("db conn mutex: {e}")))?;
    let n: i64 = conn
        .query_row("SELECT COUNT(*) FROM _pending_publish", [], |r| r.get(0))
        .unwrap_or(0);
    Ok(n)
}

fn read_last_replay_at(db: &Db) -> AppResult<Option<i64>> {
    let conn = db
        .conn
        .lock()
        .map_err(|e| AppError::Other(format!("db conn mutex: {e}")))?;
    let v: Option<i64> = conn
        .query_row(
            "SELECT MAX(updated_at) FROM _replay_state",
            [],
            |r| r.get(0),
        )
        .ok()
        .flatten();
    Ok(v)
}

/// Cheap "lines past the watermark" counter for one peer's log.
/// Reads the file, splits on `\n`, and counts entries with `id >`
/// the stored watermark via a string compare on the JSON `"id"`
/// field. Returns 0 on any read/parse error — the count is purely
/// for the settings UI's "pending" pill.
fn count_pending_for_peer(shared_dir: &Path, peer: &str, watermark: Option<&str>) -> i64 {
    let log_path = shared_dir.join("logs").join(format!("{peer}.jsonl"));
    let bytes = match fs::read(&log_path) {
        Ok(b) => b,
        Err(_) => return 0,
    };
    let mut count = 0i64;
    for line in bytes.split(|&b| b == b'\n') {
        if line.is_empty() {
            continue;
        }
        // Pull "id":"..." with a permissive substring search instead
        // of full JSON parse — this runs every status poll and we
        // don't want to deserialize every event for an approximate
        // count.
        let s = match std::str::from_utf8(line) {
            Ok(s) => s,
            Err(_) => continue,
        };
        let id_start = match s.find(r#""id":""#) {
            Some(i) => i + 6,
            None => continue,
        };
        let id_end = match s[id_start..].find('"') {
            Some(i) => id_start + i,
            None => continue,
        };
        let id = &s[id_start..id_end];
        let past_watermark = match watermark {
            Some(w) => id > w,
            None => true,
        };
        if past_watermark {
            count += 1;
        }
    }
    count
}

/// True when `name` matches the iCloud-evicted-placeholder pattern
/// `.<realname>.icloud`. macOS replaces the contents of an evicted
/// file with a tiny stub at this name; the real file disappears from
/// `read_dir` until a download is triggered. Treating placeholders as
/// "the file is here, just not downloaded" is what keeps the sync
/// disable/re-enable cycle from clobbering local copies.
fn is_icloud_placeholder(name: &std::ffi::OsStr) -> bool {
    match name.to_str() {
        Some(s) => s.starts_with('.') && s.ends_with(".icloud"),
        None => false,
    }
}

/// Move every entry under `src` into `dst`, creating `dst` if needed.
/// Renames within the same filesystem, falls back to copy + remove
/// across filesystems. Skipped when `src` doesn't exist.
///
/// **iCloud placeholder handling:** for every source entry we also
/// check whether `dst` holds either the real file OR an evicted
/// placeholder (`<dst>/.foo.epub.icloud` for `<src>/foo.epub`). If
/// either is present we skip the move. Without this check, an evicted
/// peer file at `dst/.foo.epub.icloud` made `dst/foo.epub` look
/// missing, so `move_dir_contents` clobbered our real local copy on
/// top of the placeholder — local lost the file, iCloud kept the
/// placeholder + the now-moved real file. The smoke test caught
/// exactly this against a 1.1G iCloud library with evicted contents.
fn move_dir_contents(src: &Path, dst: &Path) -> AppResult<()> {
    if !src.exists() {
        return Ok(());
    }
    fs::create_dir_all(dst)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let target = dst.join(entry.file_name());
        if target.exists() {
            // Don't clobber peer-imported books that already share a
            // filename with ours (rare; UUID-suffixed filenames make
            // this unlikely).
            continue;
        }
        if let Some(p) = icloud_placeholder_for(&target) {
            if p.exists() {
                // Evicted iCloud placeholder lives at `.<name>.icloud`;
                // the real entry isn't present at the destination but
                // logically the file IS there from iCloud's view. Skip
                // so we don't move our real local copy on top of the
                // placeholder and lose it from local.
                continue;
            }
        }
        if let Err(rename_err) = fs::rename(entry.path(), &target) {
            // Cross-device rename → copy then remove.
            fs::copy(entry.path(), &target)?;
            if let Err(e) = fs::remove_file(entry.path()) {
                eprintln!(
                    "sync_enable: failed to remove source after copy ({}): {e} (rename err: {rename_err})",
                    entry.path().display()
                );
            }
        }
    }
    Ok(())
}

/// Copy every entry from `src` to `dst`, skipping clashes. Skipped
/// when `src` doesn't exist.
///
/// **iCloud placeholder handling:** evicted iCloud entries appear in
/// `read_dir` as tiny stub files named `.<realname>.icloud`. Copying
/// the stub to local would silently corrupt the local copy — the user
/// would then open what looks like a book and get unreadable bytes.
/// We detect placeholders, trigger a background iCloud download for
/// each, copy every non-placeholder entry, and finally **return an
/// error** if any placeholders were encountered.
///
/// Returning Err is load-bearing for `sync_disable`: the caller's `?`
/// aborts before the marker removal / `data_dir` repoint, so sync
/// stays on and the user can retry after iCloud has finished
/// materialising the files. Without this, disable would silently
/// finish with `data_dir` pointing at local while some books were
/// only in iCloud — making them unreachable until re-enable. PR
/// #190's fifth review pass caught the silent-skip path.
fn copy_dir_contents(src: &Path, dst: &Path) -> AppResult<()> {
    if !src.exists() {
        return Ok(());
    }
    fs::create_dir_all(dst)?;
    let mut skipped = Vec::new();
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let name = entry.file_name();
        if is_icloud_placeholder(&name) {
            // Trigger background download for the real file even on
            // the failing path: by the time the user retries disable,
            // iCloud may have materialised some/all of them.
            #[cfg(target_os = "macos")]
            if let Some(real) = icloud_real_from_placeholder(src, entry.file_name()) {
                crate::icloud::trigger_download_file(&real);
            }
            skipped.push(name);
            continue;
        }
        let target = dst.join(&name);
        if target.exists() {
            continue;
        }
        fs::copy(entry.path(), &target)?;
    }
    if !skipped.is_empty() {
        return Err(AppError::Other(format!(
            "Cannot disable sync: {} iCloud-evicted file(s) under {} \
             aren't downloaded yet. iCloud downloads have been triggered; \
             please retry disable in a moment.",
            skipped.len(),
            src.display(),
        )));
    }
    Ok(())
}

/// `<dir>/foo.epub` → `<dir>/.foo.epub.icloud`. None when the path
/// has no parent or the filename isn't valid UTF-8.
fn icloud_placeholder_for(real: &Path) -> Option<PathBuf> {
    let parent = real.parent()?;
    let name = real.file_name()?.to_str()?;
    Some(parent.join(format!(".{name}.icloud")))
}

/// `<dir>/.foo.epub.icloud` → `<dir>/foo.epub`. None when the
/// filename doesn't match the placeholder pattern.
#[cfg(target_os = "macos")]
fn icloud_real_from_placeholder(parent: &Path, placeholder_name: std::ffi::OsString) -> Option<PathBuf> {
    let s = placeholder_name.to_str()?;
    if !s.starts_with('.') || !s.ends_with(".icloud") {
        return None;
    }
    let real = &s[1..s.len() - ".icloud".len()];
    Some(parent.join(real))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn move_dir_contents_skips_missing_src() {
        let tmp = TempDir::new().unwrap();
        let src = tmp.path().join("src");
        let dst = tmp.path().join("dst");
        move_dir_contents(&src, &dst).unwrap();
        assert!(!dst.exists(), "dst should not be created when src is missing");
    }

    #[test]
    fn move_dir_contents_moves_files() {
        let tmp = TempDir::new().unwrap();
        let src = tmp.path().join("src");
        let dst = tmp.path().join("dst");
        fs::create_dir_all(&src).unwrap();
        fs::write(src.join("a.epub"), b"a").unwrap();
        fs::write(src.join("b.epub"), b"b").unwrap();

        move_dir_contents(&src, &dst).unwrap();
        assert!(dst.join("a.epub").exists());
        assert!(dst.join("b.epub").exists());
        assert!(!src.join("a.epub").exists());
        assert!(!src.join("b.epub").exists());
    }

    #[test]
    fn move_dir_contents_skips_clashing_files() {
        let tmp = TempDir::new().unwrap();
        let src = tmp.path().join("src");
        let dst = tmp.path().join("dst");
        fs::create_dir_all(&src).unwrap();
        fs::create_dir_all(&dst).unwrap();
        fs::write(src.join("a.epub"), b"local").unwrap();
        fs::write(dst.join("a.epub"), b"peer").unwrap();

        move_dir_contents(&src, &dst).unwrap();
        // Existing dst entry is preserved; src entry is left untouched
        // because we don't overwrite peers' files.
        assert_eq!(fs::read(dst.join("a.epub")).unwrap(), b"peer");
        assert!(src.join("a.epub").exists());
    }

    /// Regression for the smoke-test finding: a file present at `dst`
    /// only as an iCloud-evicted placeholder (`<dst>/.foo.epub.icloud`)
    /// should make `move_dir_contents` skip the matching `src` entry,
    /// not move it on top of the placeholder. Before this fix, the
    /// re-enable cycle on a real iCloud library moved 5 local files
    /// into iCloud (which still had them as placeholders), leaving
    /// local without those files and iCloud holding both the
    /// placeholder and the moved real copy.
    #[test]
    fn move_dir_contents_skips_when_icloud_placeholder_at_dst() {
        let tmp = TempDir::new().unwrap();
        let src = tmp.path().join("local");
        let dst = tmp.path().join("icloud");
        fs::create_dir_all(&src).unwrap();
        fs::create_dir_all(&dst).unwrap();
        fs::write(src.join("real.epub"), b"local-real-content").unwrap();
        fs::write(dst.join(".real.epub.icloud"), b"icloud-stub").unwrap();

        move_dir_contents(&src, &dst).unwrap();

        assert!(
            src.join("real.epub").exists(),
            "src must keep the real file when dst has only an iCloud placeholder",
        );
        assert!(
            dst.join(".real.epub.icloud").exists(),
            "the iCloud placeholder must remain at dst",
        );
        assert!(
            !dst.join("real.epub").exists(),
            "we must not have moved the real file on top of the placeholder",
        );
    }

    /// Regression for the same smoke-test finding, copy direction:
    /// an iCloud-evicted entry in `src` (`.foo.epub.icloud`) is a
    /// stub, not real content. Copying it as if it were the real file
    /// would silently corrupt the local library. We skip it AND
    /// return Err, so `sync_disable` aborts Phase 1 (markers stay,
    /// `data_dir` stays at iCloud) instead of finishing with books
    /// only in iCloud and the app resolving against local.
    #[test]
    fn copy_dir_contents_returns_err_on_icloud_placeholder_entries() {
        let tmp = TempDir::new().unwrap();
        let src = tmp.path().join("icloud");
        let dst = tmp.path().join("local");
        fs::create_dir_all(&src).unwrap();
        fs::write(src.join("good.epub"), b"good").unwrap();
        fs::write(src.join(".evicted.epub.icloud"), b"stub").unwrap();

        let result = copy_dir_contents(&src, &dst);
        assert!(
            result.is_err(),
            "must Err when placeholders are present so disable aborts cleanly",
        );

        // The good file is still copied (we did the work), but the
        // stub is NOT copied under either name.
        assert!(dst.join("good.epub").exists(), "real file must copy");
        assert!(
            !dst.join(".evicted.epub.icloud").exists(),
            "placeholder stub must not be copied to local — that'd masquerade as the real file",
        );
        assert!(
            !dst.join("evicted.epub").exists(),
            "no fake real file should land at the translated name either",
        );
    }

    #[test]
    fn is_icloud_placeholder_pattern_matching() {
        use std::ffi::OsStr;
        assert!(is_icloud_placeholder(OsStr::new(".foo.epub.icloud")));
        assert!(is_icloud_placeholder(OsStr::new(".x.icloud")));
        assert!(!is_icloud_placeholder(OsStr::new("foo.epub")));
        assert!(!is_icloud_placeholder(OsStr::new(".dotfile")));
        assert!(!is_icloud_placeholder(OsStr::new(".icloud.txt")));
    }

    #[test]
    fn copy_dir_contents_copies_files_and_keeps_src() {
        let tmp = TempDir::new().unwrap();
        let src = tmp.path().join("src");
        let dst = tmp.path().join("dst");
        fs::create_dir_all(&src).unwrap();
        fs::write(src.join("a.epub"), b"a").unwrap();

        copy_dir_contents(&src, &dst).unwrap();
        assert!(dst.join("a.epub").exists());
        assert!(src.join("a.epub").exists(), "copy must not delete source");
    }

    #[test]
    fn count_pending_for_peer_handles_missing_log() {
        let tmp = TempDir::new().unwrap();
        let n = count_pending_for_peer(tmp.path(), "nope", None);
        assert_eq!(n, 0);
    }

    #[test]
    fn count_pending_for_peer_counts_lines_past_watermark() {
        let tmp = TempDir::new().unwrap();
        let logs = tmp.path().join("logs");
        fs::create_dir_all(&logs).unwrap();
        let log = logs.join("peer-A.jsonl");
        let payload = r#""ts":1,"device":"peer-A","v":1,"type":"x","payload":{}"#;
        let lines = format!(
            r#"{{"id":"01HZA00000000000000000A001",{payload}}}
{{"id":"01HZA00000000000000000A002",{payload}}}
{{"id":"01HZA00000000000000000A003",{payload}}}
"#,
        );
        fs::write(&log, lines).unwrap();

        // No watermark — count all 3.
        assert_eq!(count_pending_for_peer(tmp.path(), "peer-A", None), 3);
        // Past id-A001 — count 2.
        assert_eq!(
            count_pending_for_peer(tmp.path(), "peer-A", Some("01HZA00000000000000000A001")),
            2
        );
        // Past the last id — count 0.
        assert_eq!(
            count_pending_for_peer(tmp.path(), "peer-A", Some("01HZA00000000000000000A003")),
            0
        );
    }

    #[test]
    fn sync_revert_to_legacy_returns_error_in_v1() {
        let result = sync_revert_to_legacy();
        assert!(result.is_err());
    }

    /// Regression for PR #193's review finding: enabling sync on a
    /// non-empty local library must publish a snapshot so peers can
    /// see the existing rows. Without this, the user toggles sync on
    /// and other devices see an empty library — every book they ever
    /// imported locally stays invisible to peers.
    ///
    /// We test the snapshot helper directly (bypassing the Tauri
    /// State plumbing) since the snapshot publish is the only
    /// behavior the regression covers; the rest of `sync_enable`
    /// (binary move, marker write, engine boot) is exercised by
    /// integration testing on a real iCloud account.
    #[test]
    fn publish_bootstrap_snapshot_publishes_existing_local_rows() {
        use crate::sync::snapshot::Snapshot;

        let tmp = TempDir::new().unwrap();
        let local = tmp.path().join("local");
        let shared = tmp.path().join("shared");
        fs::create_dir_all(&local).unwrap();
        fs::create_dir_all(shared.join("logs")).unwrap();

        // Seed a non-empty local library.
        let db = crate::db::Db::init(&local).unwrap();
        {
            let conn = db.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO books
                 (id, title, author, file_path, format, status, progress,
                  created_at, updated_at, updated_by_device)
                 VALUES ('b1', 'Existing Book', 'Author', 'books/b1.epub',
                         'epub', 'unread', 0, 1000, 1000, 'self')",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO highlights
                 (id, book_id, cfi_range, color, created_at, updated_at, updated_by_device)
                 VALUES ('h1', 'b1', 'cfi', 'yellow', 1000, 1000, 'self')",
                [],
            )
            .unwrap();
        }

        // Snapshot bootstrap.
        publish_bootstrap_snapshot(&db, &shared, "self").unwrap();

        // The snapshot must exist and round-trip onto a fresh peer DB
        // with the seeded rows visible — same path peer devices use
        // when they pick up the snapshot via `apply_peer`.
        let snap_path = shared.join("logs").join("self.snapshot.json");
        assert!(snap_path.exists());
        let snap = Snapshot::read_from(&snap_path).unwrap();

        let peer_dir = tmp.path().join("peer");
        fs::create_dir_all(&peer_dir).unwrap();
        let peer_db = crate::db::Db::init(&peer_dir).unwrap();
        {
            let mut conn = peer_db.conn.lock().unwrap();
            let tx = conn.transaction().unwrap();
            snap.apply_peer(&tx, "self").unwrap();
            tx.commit().unwrap();
        }
        let conn = peer_db.conn.lock().unwrap();
        let title: String = conn
            .query_row(
                "SELECT title FROM books WHERE id = 'b1'",
                [],
                |r| r.get(0),
            )
            .expect("peer should see the bootstrapped book");
        assert_eq!(title, "Existing Book");
        let n_hl: i64 = conn
            .query_row("SELECT COUNT(*) FROM highlights", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n_hl, 1, "peer should see the bootstrapped highlight");
    }

    /// Companion regression: re-enable after disable picks up edits
    /// the user made while sync was off. Sync_disable turns
    /// `should_queue` off, so events made while disabled don't
    /// accumulate in `_pending_publish` — without a fresh snapshot
    /// on re-enable they'd never reach peers.
    #[test]
    fn publish_bootstrap_snapshot_picks_up_edits_made_while_disabled() {
        use crate::sync::snapshot::Snapshot;

        let tmp = TempDir::new().unwrap();
        let local = tmp.path().join("local");
        let shared = tmp.path().join("shared");
        fs::create_dir_all(&local).unwrap();
        fs::create_dir_all(shared.join("logs")).unwrap();

        let db = crate::db::Db::init(&local).unwrap();
        {
            let conn = db.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO books
                 (id, title, author, file_path, format, status, progress,
                  created_at, updated_at, updated_by_device)
                 VALUES ('b1', 'Pre-disable', 'Author', 'books/b1.epub',
                         'epub', 'unread', 0, 1000, 1000, 'self')",
                [],
            )
            .unwrap();
        }
        publish_bootstrap_snapshot(&db, &shared, "self").unwrap();
        let first_id = Snapshot::read_from(&shared.join("logs/self.snapshot.json"))
            .unwrap()
            .id;

        // Simulate edits made while sync was disabled — direct SQL,
        // no events emitted.
        {
            let conn = db.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO books
                 (id, title, author, file_path, format, status, progress,
                  created_at, updated_at, updated_by_device)
                 VALUES ('b2', 'Added while disabled', 'Author',
                         'books/b2.epub', 'epub', 'unread', 0, 2000, 2000, 'self')",
                [],
            )
            .unwrap();
        }

        // Re-enable.
        publish_bootstrap_snapshot(&db, &shared, "self").unwrap();
        let second = Snapshot::read_from(&shared.join("logs/self.snapshot.json")).unwrap();
        assert_ne!(second.id, first_id, "re-enable must mint a new snapshot id");

        // Apply on a peer; it should see both books.
        let peer_dir = tmp.path().join("peer");
        fs::create_dir_all(&peer_dir).unwrap();
        let peer_db = crate::db::Db::init(&peer_dir).unwrap();
        {
            let mut conn = peer_db.conn.lock().unwrap();
            let tx = conn.transaction().unwrap();
            second.apply_peer(&tx, "self").unwrap();
            tx.commit().unwrap();
        }
        let conn = peer_db.conn.lock().unwrap();
        let n: i64 = conn
            .query_row("SELECT COUNT(*) FROM books", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 2, "peer should see both pre- and post-disable books");
    }
}
