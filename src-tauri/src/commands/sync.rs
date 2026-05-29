//! Sync commands exposed to the frontend.
//!
//! - `sync_status` — read-only snapshot for the settings UI.
//! - `sync_enable` — move binaries to iCloud, stamp marker, boot engine.
//! - `sync_disable` — stop engine, copy binaries back, remove marker.
//! - `sync_now` — manual replay tick.
//! - `sync_compact` — trigger log compaction.
//! - `sync_remove_peer` — remove a peer's log/snapshot/manifest.

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
use crate::sync::replay::{self as replay, ReplayEngine, ReplayReport};
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
    pub fn new(engine: Option<Arc<ReplayEngine>>, watcher: Option<WatcherHandle>) -> Self {
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
    /// false, available = false, sync_enabled = true`.
    pub available: bool,
    /// True when the user has enabled iCloud sync via the settings toggle.
    pub sync_enabled: bool,
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
    let sync_enabled = sync::migration::is_sync_enabled(&local.0);
    let shared_dir = sync::migration::recorded_data_dir(&local.0)
        .or_else(icloud::icloud_data_dir);
    let available = icloud::icloud_data_dir().is_some_and(|p| p.exists())
        || icloud::is_icloud_available();
    let enabled = sync_state.engine_snapshot()?.is_some();

    // Peer list + outbox count when the user has sync enabled (even
    // if the engine hasn't booted yet — e.g. during async boot or
    // offline queue-only mode). Skip when fully disabled.
    let (peer_infos, pending_events, last_replay_at) = if sync_enabled {
        let peers = match shared_dir.as_ref() {
            Some(dir) => peers::list_peers(dir, &device.device_uuid).unwrap_or_else(|e| {
                log::warn!("sync_status: list_peers failed: {e}");
                Vec::new()
            }),
            None => Vec::new(),
        };
        let infos: Vec<PeerInfo> = peers
            .into_iter()
            .map(|p| PeerInfo {
                device_uuid: p.device_uuid,
                name: p.name,
                platform: p.platform,
                app_version: p.app_version,
                last_seen: p.last_seen,
                pending_events: 0,
            })
            .collect();
        let pending = count_local_outbox(&db).unwrap_or(0);
        let last = read_last_replay_at(&db).unwrap_or(None);
        (infos, pending, last)
    } else {
        (Vec::new(), 0, None)
    };

    Ok(SyncStatus {
        enabled,
        available,
        sync_enabled,
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
    app: tauri::AppHandle,
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
        .filter(|p| p.parent().is_some_and(|parent| parent.exists()))
        .ok_or_else(|| AppError::Other("iCloud is not available — sign in to iCloud and try again".into()))?;

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

    let engine = Arc::new(
        ReplayEngine::new(
            icloud_dir.clone(),
            device.device_uuid.clone(),
            Arc::clone(&log),
        )
        .with_app_handle(app.clone()),
    );

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

    sync::migration::write_sync_settings(&local.0, Some(&icloud_dir))?;

    {
        let mut data_dir = db
            .data_dir
            .lock()
            .map_err(|e| AppError::Other(format!("data_dir mutex: {e}")))?;
        *data_dir = icloud_dir.clone();
    }

    // Wire the writer's queue immediately so any commands the user
    // fires off during the binary move below durably persist into
    // `_pending_publish`. The log handle stays None until move
    // completes — we don't want to publish to peers before our
    // binaries are visible to them. If the move fails, this leaves
    // the writer in queue-only mode (correct for the partial state).
    sync_writer.set_should_queue(true);

    // First-time enable: move local binaries into the ubiquity container
    // so peers can read them. Re-enable after a disable just shuffles
    // whatever the user has imported in the meantime — usually a no-op
    // since the binaries are already in iCloud.
    //
    // Move runs BEFORE the SyncState engine/watcher store so that a
    // move failure leaves `engine_snapshot()` returning None — which
    // means the early-guard at the top of `sync_enable` re-enters
    // cleanly on the user's next click. The previous order stored
    // engine first, so the guard short-circuited every retry to
    // `Ok(())` and the leftover blobs stayed stranded until restart.
    // Launch-time `reconcile_local_blobs_to_ubiquity` still backstops
    // restart recovery; this fix gives the user a working in-session
    // retry too. PR #190's seventh review pass.
    move_dir_contents(&local.0.join("books"), &icloud_dir.join("books"))?;
    move_dir_contents(&local.0.join("covers"), &icloud_dir.join("covers"))?;

    // Move succeeded — wire the log so post-commit flushes drain to
    // peers, and store the engine + watcher in app state so the rest
    // of the app sees sync as on.
    sync_writer.set_log(Some(Arc::clone(&log)));
    sync_writer.spawn_cover_writer();
    sync_writer.backfill_cover_files(&db);
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

    // Fire the initial tick on a background thread so sync_enable
    // returns immediately — the UI stays responsive while the tick
    // applies peer snapshots and events. Same pattern as startup boot.
    let bg_db = db.inner().clone();
    let bg_handle = app.clone();
    std::thread::Builder::new()
        .name("sync-enable-tick".into())
        .spawn(move || {
            let result = engine.tick_with_progress(&bg_db, Some(&bg_handle));
            let _ = tauri::Emitter::emit(&bg_handle, "sync-initial-tick-done", ());
            if let Err(e) = result {
                log::warn!("sync_enable: initial tick failed: {e}");
            }
        })
        .ok();

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
    let engine = sync_state.engine_snapshot()?;

    // Stop new watcher ticks first, then cancel any tick already in
    // flight before joining the watcher thread.
    let old_watcher = {
        let mut g = sync_state
            .watcher
            .lock()
            .map_err(|e| AppError::Other(format!("watcher mutex: {e}")))?;
        if let Some(watcher) = g.as_ref() {
            watcher.request_stop();
        }
        g.take()
    };
    let had_watcher = old_watcher.is_some();
    if let Some(engine) = engine.as_ref() {
        engine.cancel();
    }
    drop(old_watcher);
    replay::tick_mutex_wait();

    // ---- Phase 1: fallible binary copy-back with no durable state change ----
    // If this fails (e.g. iCloud-evicted files, disk full), return an
    // error without touching any session or marker state. The user
    // sees "disable failed, please retry" and the system is still in
    // the "sync on" state — matching reality. The previous shape tore
    // down engine + writer first, so a mid-copy failure produced a
    // session that thought sync was off while the marker stayed on,
    // which then silently re-enabled on the next launch.

    let ubiquity_dir = sync::migration::recorded_data_dir(&local.0)
        .or_else(icloud::icloud_data_dir);
    let copy_result = if let Some(ub) = ubiquity_dir.as_ref() {
        copy_dir_contents(&ub.join("books"), &local.0.join("books"))
            .and_then(|_| copy_dir_contents(&ub.join("covers"), &local.0.join("covers")))
    } else {
        Ok(())
    };
    if let Err(e) = copy_result {
        if had_watcher {
            if let (Some(ub), Some(engine)) = (ubiquity_dir.as_ref(), engine.as_ref()) {
                match watcher::spawn(ub.clone(), db.inner().clone(), Arc::clone(engine)) {
                    Ok(watcher) => match sync_state.watcher.lock() {
                        Ok(mut g) => *g = Some(watcher),
                        Err(lock_err) => {
                            log::error!("sync_disable: failed to restore watcher: {lock_err}");
                        }
                    },
                    Err(restart_err) => {
                        log::error!(
                            "sync_disable: failed to restore watcher after copy-back error: {restart_err}"
                        );
                    }
                }
            }
        }
        return Err(e);
    }

    // ---- Phase 2: teardown + marker removal ----
    // Every step from here is non-fatal or explicitly logged. The
    // fallible copy-back above succeeded, so we're committed to
    // turning sync off.

    // Watcher already dropped above. Drop the engine.
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
    sync_writer.set_cover_tx(None);

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
            log::warn!("sync_disable: failed to remove own peer manifest: {e}");
        }
    }

    sync::migration::remove_sync_settings(&local.0)?;

    // Final sweep: if the async boot thread installed an engine/watcher
    // between our initial snapshot and the marker removal, clear it now.
    // Without this, a boot that races with disable can leave a watcher
    // thread alive after sync is "off."
    {
        let mut eg = sync_state.engine.lock()
            .map_err(|e| AppError::Other(format!("engine mutex: {e}")))?;
        let mut wg = sync_state.watcher.lock()
            .map_err(|e| AppError::Other(format!("watcher mutex: {e}")))?;
        if eg.is_some() || wg.is_some() {
            log::warn!("sync_disable: boot thread installed engine during disable — clearing");
            *eg = None;
            *wg = None;
            sync_writer.set_log(None);
        }
    }

    Ok(())
}

#[tauri::command]
pub fn sync_cancel(
    app: tauri::AppHandle,
    sync_state: State<'_, SyncState>,
) -> AppResult<()> {
    if let Some(engine) = sync_state.engine_snapshot()? {
        engine.cancel();
    }
    let _ = tauri::Emitter::emit(&app, "sync-initial-tick-done", ());
    Ok(())
}

#[tauri::command]
pub fn sync_now(
    app: tauri::AppHandle,
    db: State<'_, Db>,
    sync_state: State<'_, SyncState>,
) -> AppResult<SyncNowResult> {
    let engine = sync_state
        .engine_snapshot()?
        .ok_or_else(|| AppError::Other("sync is not enabled on this device".into()))?;
    let result = engine.tick_with_progress(&db, Some(&app));
    let _ = tauri::Emitter::emit(&app, "sync-initial-tick-done", ());
    Ok(result?.into())
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

/// Remove a peer device's footprint from the shared folder. Deletes
/// the peer's manifest, event log, and snapshot. Used by the settings
/// UI's per-device trash button to clean up orphaned entries (e.g. an
/// uninstalled app whose UUID is still publishing a stale `last_seen`).
///
/// Idempotent — re-deleting an already-removed peer returns Ok. No-op
/// when the device_uuid matches the local device (defense in depth;
/// the UI doesn't render self in the peer list to begin with).
///
/// Resolves the shared dir the same way `sync_status` does so the
/// command works whether or not the engine is currently booted in this
/// process. Returns an error only when no shared dir can be resolved
/// (iCloud unavailable AND no recorded marker).
#[tauri::command]
pub fn sync_remove_peer(
    device_uuid: String,
    local: State<'_, LocalDir>,
    device: State<'_, DeviceIdentity>,
) -> AppResult<()> {
    let shared_dir = sync::migration::recorded_data_dir(&local.0)
        .or_else(icloud::icloud_data_dir)
        .ok_or_else(|| AppError::Other("iCloud shared folder is not available".into()))?;
    peers::delete_peer(&shared_dir, &device_uuid, &device.device_uuid)
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

fn count_local_outbox(db: &Db) -> AppResult<i64> {
    let conn = db.reader();
    let n: i64 = conn
        .query_row("SELECT COUNT(*) FROM _pending_publish", [], |r| r.get(0))
        .unwrap_or(0);
    Ok(n)
}

fn read_last_replay_at(db: &Db) -> AppResult<Option<i64>> {
    let conn = db.reader();
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
                log::warn!(
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
