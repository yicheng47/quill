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
use std::thread;
use std::time::{Duration, Instant};

use rusqlite::params;
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

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

#[cfg(not(test))]
const DISABLE_COPY_PLACEHOLDER_TIMEOUT: Duration = Duration::from_secs(120);
#[cfg(test)]
const DISABLE_COPY_PLACEHOLDER_TIMEOUT: Duration = Duration::from_millis(50);
#[cfg(not(test))]
const DISABLE_COPY_PLACEHOLDER_POLL: Duration = Duration::from_millis(500);
#[cfg(test)]
const DISABLE_COPY_PLACEHOLDER_POLL: Duration = Duration::from_millis(5);

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

#[derive(Debug, Clone, Serialize)]
pub struct SyncDisableProgress {
    pub phase: String,
    pub copied: usize,
    pub total: usize,
    pub current: Option<String>,
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
pub async fn sync_status(
    local: State<'_, LocalDir>,
    db: State<'_, Db>,
    device: State<'_, DeviceIdentity>,
    sync_state: State<'_, SyncState>,
) -> AppResult<SyncStatus> {
    let local_dir = local.0.clone();
    let db = db.inner().clone();
    let device_uuid = device.device_uuid.clone();
    let enabled = sync_state.engine_snapshot()?.is_some();

    tokio::task::spawn_blocking(move || {
        let sync_enabled = sync::migration::is_sync_enabled(&local_dir);
        let shared_dir = sync::migration::recorded_data_dir(&local_dir)
            .or_else(icloud::icloud_data_dir);
        let available = icloud::icloud_data_dir().is_some_and(|p| p.exists())
            || icloud::is_icloud_available();

        // Peer list + outbox count when the user has sync enabled (even
        // if the engine hasn't booted yet — e.g. during async boot or
        // offline queue-only mode). Skip when fully disabled.
        let (peer_infos, pending_events, last_replay_at) = if sync_enabled {
            let peers = match shared_dir.as_ref() {
                Some(dir) => peers::list_peers(dir, &device_uuid).unwrap_or_else(|e| {
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
            device_uuid,
            device_name: peers::device_name(),
            peers: peer_infos,
            pending_events,
            last_replay_at,
        })
    })
    .await
    .map_err(|e| AppError::Other(format!("sync_status worker failed: {e}")))?
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

    publish_bootstrap_snapshot_unless_rebuild_pending(&db, &icloud_dir, &device.device_uuid)?;

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
    sync_writer.spawn_flush_worker(db.inner().clone(), Arc::clone(&log));
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
            // Same rebuild-resume check as the boot path: a rebuild
            // cancelled earlier this session followed by a disable /
            // re-enable must still converge, not tick over a wiped
            // library with a stranded marker.
            let result = if rebuild_marker_set(&bg_db) {
                log::info!("sync_enable: rebuild marker set — resuming rebuild from iCloud");
                run_rebuild_replay(&bg_db, &engine, Some(&bg_handle))
            } else {
                engine.tick_with_progress(&bg_db, Some(&bg_handle))
            };
            let _ = tauri::Emitter::emit(&bg_handle, "sync-initial-tick-done", ());
            if let Err(e) = result {
                log::warn!("sync_enable: initial tick failed: {e}");
            }
        })
        .ok();

    Ok(())
}

#[tauri::command]
pub async fn sync_disable(
    app: AppHandle,
    local: State<'_, LocalDir>,
    db: State<'_, Db>,
    device: State<'_, DeviceIdentity>,
    sync_writer: State<'_, SyncWriter>,
    sync_state: State<'_, SyncState>,
) -> AppResult<()> {
    let engine = sync_state.engine_snapshot()?;
    let local_dir = local.0.clone();
    log::info!("sync_disable: requested");

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
    log::info!(
        "sync_disable: watcher stopped had_engine={} had_watcher={}",
        engine.is_some(),
        had_watcher
    );

    // ---- Phase 1: fallible binary copy-back with no durable state change ----
    // If this fails (e.g. iCloud-evicted files, disk full), return an
    // error without touching any session or marker state. The user
    // sees "disable failed, please retry" and the system is still in
    // the "sync on" state — matching reality. The previous shape tore
    // down engine + writer first, so a mid-copy failure produced a
    // session that thought sync was off while the marker stayed on,
    // which then silently re-enabled on the next launch.

    let ubiquity_dir = sync::migration::recorded_data_dir(&local_dir)
        .or_else(icloud::icloud_data_dir);
    let copy_result = if let Some(ub) = ubiquity_dir.as_ref() {
        log::info!("sync_disable: copy-back starting");
        let app = app.clone();
        let jobs = vec![
            (ub.join("books"), local_dir.join("books")),
            (ub.join("covers"), local_dir.join("covers")),
        ];
        tokio::task::spawn_blocking(move || copy_disable_files_with_progress(&app, &jobs))
            .await
            .map_err(|e| AppError::Other(format!("sync_disable copy worker failed: {e}")))?
    } else {
        log::warn!("sync_disable: no iCloud shared dir resolved; skipping copy-back");
        Ok(())
    };
    if let Err(e) = copy_result {
        log::warn!("sync_disable: copy-back failed; keeping sync enabled: {e}");
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
    log::info!("sync_disable: copy-back complete; tearing down sync");

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
    sync_writer.set_flush_tx(None);

    // Repoint data_dir at local now that the binary copy-back has
    // finished. Mid-flight reads during phase 1 still resolved
    // against iCloud, which is correct (the files haven't moved yet).
    {
        let mut data_dir = db
            .data_dir
            .lock()
            .map_err(|e| AppError::Other(format!("data_dir mutex: {e}")))?;
        *data_dir = local_dir.clone();
    }

    // Remove the manifest so other peers don't see a stuck "Last
    // seen" — they'll just see this device drop off the list. Best-
    // effort; failure is logged but doesn't block disable.
    if let Some(ub) = ubiquity_dir.as_ref() {
        if let Err(e) = peers::delete_own_manifest(ub, &device.device_uuid) {
            log::warn!("sync_disable: failed to remove own peer manifest: {e}");
        }
    }

    sync::migration::remove_sync_settings(&local_dir)?;

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
            sync_writer.set_flush_tx(None);
        }
    }

    log::info!("sync_disable: completed; sync is off and data_dir is local");
    Ok(())
}

#[tauri::command]
pub fn sync_cancel(
    app: tauri::AppHandle,
    sync_state: State<'_, SyncState>,
) -> AppResult<()> {
    if let Some(engine) = sync_state.engine_snapshot()? {
        engine.cancel();
        // Operation-scoped cancel signal: the monotonic generation
        // survives the tick-start flag reset, so a rebuild aborts (or
        // keeps its resume marker) even when the cancel lands between
        // its ticks — e.g. during the bootstrap publish.
        engine.bump_cancel_generation();
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

/// Rebuild the local materialized view from the shared folder. A
/// one-way pull: publish local state first (outbox drain + bootstrap
/// snapshot) so it is durable in iCloud, then wipe the synced tables
/// and every replay watermark, then replay everything from scratch.
/// Nothing in the shared folder is deleted or rewritten beyond the
/// device's own log/snapshot/manifest. See
/// `docs/features/300-rebuild-from-icloud.md`.
///
/// Refuses when the engine is not running this session (queue-only
/// mode included), matching `sync_now` / `sync_compact` — the wipe
/// must never run without a live engine to replay the data back.
#[tauri::command]
pub async fn sync_rebuild(
    app: tauri::AppHandle,
    db: State<'_, Db>,
    sync_state: State<'_, SyncState>,
) -> AppResult<SyncNowResult> {
    let engine = sync_state
        .engine_snapshot()?
        .ok_or_else(|| AppError::Other("sync is not enabled on this device".into()))?;
    let db = db.inner().clone();

    tokio::task::spawn_blocking(move || {
        let result = run_rebuild(&db, &engine, Some(&app));
        let _ = tauri::Emitter::emit(&app, "sync-initial-tick-done", ());
        Ok(result?.into())
    })
    .await
    .map_err(|e| AppError::Other(format!("sync_rebuild worker failed: {e}")))?
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
// Rebuild-from-iCloud core. `pub(crate)` where lib.rs's boot path needs
// to resume an interrupted rebuild; see the state machine in
// `docs/impls/300-rebuild-from-icloud.md`.
// ---------------------------------------------------------------------------

/// `settings` KV key marking a rebuild whose wipe + full replay has not
/// completed. The `settings` table is local-only and preserved by the
/// wipe, so the marker survives a crash or quit at any point and never
/// syncs to peers.
const REBUILD_MARKER_KEY: &str = "sync_rebuild_pending";

/// Serializes the whole rebuild state machine — marker check, publish
/// half, wipe + replay — across the command and both resume entry
/// points. Without it, two concurrent rebuilds could both pass the
/// marker check, and the slower one would publish the already-wiped DB
/// over the only complete recovery snapshot.
static REBUILD_MUTEX: Mutex<()> = Mutex::new(());

/// The synced tables the wipe clears, children before parents.
/// `_replay_state` is cleared alongside them in the same transaction.
/// Deliberately absent: `settings`, `book_settings`, `schema_version`,
/// `_tombstones` (locally-deleted entities must not resurrect during
/// the replay), `_pending_publish` (unflushed local writes must
/// survive so the replay's Phase 0 can still publish them), and
/// `translations` — a legacy table with no replay source (snapshots
/// don't carry it and its events are no-ops since #263), so wiping it
/// would be unrecoverable deletion; it's also already dropped on DBs
/// stamped by the since-deleted dev migration 14.
const WIPE_TABLES: [&str; 8] = [
    "chat_messages",
    "chats",
    "collection_books",
    "collections",
    "vocab_words",
    "bookmarks",
    "highlights",
    "books",
];

pub(crate) fn rebuild_marker_set(db: &Db) -> bool {
    db.reader()
        .query_row(
            "SELECT value FROM settings WHERE key = ?1",
            params![REBUILD_MARKER_KEY],
            |r| r.get::<_, String>(0),
        )
        .map(|v| v == "true")
        .unwrap_or(false)
}

fn set_rebuild_marker(db: &Db) -> AppResult<()> {
    let conn = db
        .conn
        .lock()
        .map_err(|e| AppError::Other(format!("db conn mutex: {e}")))?;
    conn.execute(
        "INSERT INTO settings (key, value) VALUES (?1, 'true')
         ON CONFLICT(key) DO UPDATE SET value = 'true'",
        params![REBUILD_MARKER_KEY],
    )?;
    Ok(())
}

fn clear_rebuild_marker(db: &Db) -> AppResult<()> {
    let conn = db
        .conn
        .lock()
        .map_err(|e| AppError::Other(format!("db conn mutex: {e}")))?;
    conn.execute(
        "DELETE FROM settings WHERE key = ?1",
        params![REBUILD_MARKER_KEY],
    )?;
    Ok(())
}

/// One write transaction clearing the synced tables and every replay
/// watermark. Runs under the tick lock so a concurrent tick can't
/// interleave: a tick's per-event watermark bump landing after our
/// deletes would record ids for rows we just removed, and the rebuild
/// replay would then skip those events forever.
///
/// The write connection runs with `PRAGMA foreign_keys=OFF` (see
/// `Db::init_split`; the merge engine does its cascades explicitly),
/// so `DELETE FROM books` cannot cascade into the preserved
/// `book_settings`.
pub(crate) fn wipe_synced_tables(db: &Db) -> AppResult<()> {
    replay::with_tick_lock(|| {
        let mut conn = db
            .conn
            .lock()
            .map_err(|e| AppError::Other(format!("db conn mutex: {e}")))?;
        let tx = conn.transaction()?;
        for table in WIPE_TABLES {
            tx.execute(&format!("DELETE FROM {table}"), [])?;
        }
        tx.execute("DELETE FROM _replay_state", [])?;
        tx.commit()?;
        Ok(())
    })
}

/// The wipe + replay half of a rebuild. Shared by `sync_rebuild` and
/// the boot-path resume (a set marker means a prior rebuild's publish
/// is already durable in the shared folder, so resuming only needs
/// this half). Clears the marker only when the replay ran to
/// completion — an error or a `sync_cancel` mid-replay leaves it set
/// so the next launch resumes.
pub(crate) fn run_rebuild_replay(
    db: &Db,
    engine: &ReplayEngine,
    app_handle: Option<&AppHandle>,
) -> AppResult<ReplayReport> {
    let _flight = REBUILD_MUTEX
        .lock()
        .map_err(|e| AppError::Other(format!("rebuild mutex: {e}")))?;
    let cancel_gen = engine.cancel_generation();
    run_rebuild_replay_locked(db, engine, app_handle, cancel_gen)
}

/// `cancel_gen` is the generation captured when this operation entered
/// the serialized state machine. A cancel landing anywhere after that
/// capture — including the window between the last pre-marker gate and
/// the replay tick's start, where the tick's own flag reset would
/// launder it — bumps the generation and forces the cancelled verdict,
/// so the marker is retained and the rebuild resumes on next launch.
fn run_rebuild_replay_locked(
    db: &Db,
    engine: &ReplayEngine,
    app_handle: Option<&AppHandle>,
    cancel_gen: u64,
) -> AppResult<ReplayReport> {
    // Ask any in-flight watcher tick to wind down so the wipe isn't
    // queued behind a long replay. Our own tick below resets the flag;
    // this internal interrupt deliberately does not bump the user
    // cancel generation.
    engine.cancel();
    wipe_synced_tables(db)?;
    let mut report = engine.tick_with_progress(db, app_handle)?;
    if engine.cancel_generation() != cancel_gen {
        report.cancelled = true;
    }
    settle_rebuild_marker(db, &report)?;
    Ok(report)
}

/// Marker decision after the rebuild replay. Reads the cancellation
/// verdict from the tick's own report — captured while the tick still
/// held TICK_MUTEX — never from the engine-global flag: the own-log
/// and snapshot writes queue a watcher tick that resets that flag the
/// moment our tick releases the mutex, which would let a cancelled
/// rebuild clear its marker and lose the resume.
fn settle_rebuild_marker(db: &Db, report: &ReplayReport) -> AppResult<()> {
    if report.cancelled {
        return Ok(());
    }
    clear_rebuild_marker(db)
}

/// Full rebuild sequence: fold + publish → set the marker → wipe +
/// replay, single-flight under `REBUILD_MUTEX`.
///
/// The publish half starts with a full tick rather than a bare outbox
/// flush: a local delete whose event has not yet been *applied*
/// locally (still queued, or flushed to the own log by the background
/// worker but not yet replayed) has no `_tombstones` row, and absence
/// from the bootstrap snapshot does not encode deletion — the
/// snapshot's watermark would mask the delete event while an older
/// peer `*.add` resurrects the row. The tick materializes those
/// tombstones in bulk, and the snapshot itself is then published via
/// `publish_with_own_state_settled`, which seals the own log and folds
/// any event that raced in between — no own event below the snapshot
/// id can be left unapplied.
///
/// When the marker is already set, a prior rebuild's publish is
/// already durable and the local DB may be wiped or partial —
/// re-publishing would overwrite the only complete recovery snapshot
/// with that partial state. Every entry point therefore skips
/// straight to the wipe + replay half.
///
/// User cancellation is tracked by the engine's monotonic cancel
/// generation, captured once the operation holds `REBUILD_MUTEX`. Any
/// increment observed afterwards (`sync_cancel` bumps it) means this
/// operation was cancelled — the tick-scoped flag is reset at every
/// tick start and would launder a cancel landing during the publish,
/// and a resettable boolean could be cleared by a second queued
/// rebuild request. Cancels from before the capture are stale and
/// ignored. Both pre-marker gates abort with nothing wiped and no
/// marker set; a cancel after the marker is written retains it.
pub(crate) fn run_rebuild(
    db: &Db,
    engine: &ReplayEngine,
    app_handle: Option<&AppHandle>,
) -> AppResult<ReplayReport> {
    let _flight = REBUILD_MUTEX
        .lock()
        .map_err(|e| AppError::Other(format!("rebuild mutex: {e}")))?;
    let cancel_gen = engine.cancel_generation();
    if !rebuild_marker_set(db) {
        let pre = engine.tick_with_progress(db, app_handle)?;
        if pre.cancelled || engine.cancel_generation() != cancel_gen {
            return Ok(ReplayReport { cancelled: true, ..pre });
        }
        replay::publish_with_own_state_settled(db, &engine.own_log, || {
            publish_bootstrap_snapshot(db, &engine.shared_dir, &engine.self_device)
        })?;
        // The publish can be slow (full-DB dump + coordinated write);
        // last exit before the marker commits us to the wipe.
        if engine.cancel_generation() != cancel_gen {
            return Ok(ReplayReport { cancelled: true, ..pre });
        }
        set_rebuild_marker(db)?;
    }
    run_rebuild_replay_locked(db, engine, app_handle, cancel_gen)
}

/// `sync_enable`'s bootstrap publish, gated on the rebuild marker.
/// Enabling while a rebuild is pending (cancel → disable → re-enable)
/// must not snapshot the wiped/partial DB over the pre-wipe snapshot;
/// the enable-tick thread's resume completes the rebuild instead.
fn publish_bootstrap_snapshot_unless_rebuild_pending(
    db: &Db,
    shared_dir: &Path,
    device_uuid: &str,
) -> AppResult<()> {
    if rebuild_marker_set(db) {
        log::info!("sync_enable: rebuild pending — keeping the pre-wipe bootstrap snapshot");
        return Ok(());
    }
    publish_bootstrap_snapshot(db, shared_dir, device_uuid)
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

struct DisableCopyProgressEmitter {
    app: Option<AppHandle>,
    copied: usize,
    total: usize,
}

impl DisableCopyProgressEmitter {
    fn new(app: Option<AppHandle>, total: usize) -> Self {
        Self {
            app,
            copied: 0,
            total,
        }
    }

    fn emit(&self, phase: &str, current: Option<String>) {
        if let Some(app) = self.app.as_ref() {
            let _ = app.emit(
                "sync-disable-progress",
                SyncDisableProgress {
                    phase: phase.to_string(),
                    copied: self.copied,
                    total: self.total,
                    current,
                },
            );
        }
    }

    fn complete(&mut self, phase: &str, current: Option<String>) {
        self.copied = self.copied.saturating_add(1).min(self.total);
        self.emit(phase, current);
    }
}

fn copy_disable_files_with_progress(
    app: &AppHandle,
    jobs: &[(PathBuf, PathBuf)],
) -> AppResult<()> {
    let total = jobs
        .iter()
        .try_fold(0usize, |acc, (src, _)| count_copy_entries(src).map(|n| acc + n))?;
    log::info!("sync_disable: copy-back total_files={total}");
    let mut progress = DisableCopyProgressEmitter::new(Some(app.clone()), total);
    progress.emit("preparing", None);
    for (src, dst) in jobs {
        copy_dir_contents_with_progress(src, dst, Some(&mut progress))?;
    }
    progress.emit("done", None);
    log::info!(
        "sync_disable: copy-back finished copied_files={} total_files={}",
        progress.copied,
        progress.total
    );
    Ok(())
}

fn count_copy_entries(src: &Path) -> AppResult<usize> {
    if !src.exists() {
        return Ok(0);
    }
    let mut total = 0usize;
    for entry in fs::read_dir(src)? {
        let _ = entry?;
        total += 1;
    }
    Ok(total)
}

fn display_file_name(path: &Path) -> String {
    path.file_name()
        .and_then(|name| name.to_str())
        .map(String::from)
        .unwrap_or_else(|| path.to_string_lossy().into_owned())
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
/// We detect placeholders, trigger iCloud download for their real file,
/// wait for materialization, then copy the real bytes.
///
/// Returning Err is load-bearing for `sync_disable`: the caller's `?`
/// aborts before the marker removal / `data_dir` repoint, so sync
/// stays on if iCloud cannot materialize a file within the bounded wait.
/// Without this, disable would silently finish with `data_dir` pointing
/// at local while some books were only in iCloud — making them
/// unreachable until re-enable. PR #190's fifth review pass caught the
/// silent-skip path.
#[cfg(test)]
fn copy_dir_contents(src: &Path, dst: &Path) -> AppResult<()> {
    copy_dir_contents_with_progress(src, dst, None)
}

fn copy_dir_contents_with_progress(
    src: &Path,
    dst: &Path,
    mut progress: Option<&mut DisableCopyProgressEmitter>,
) -> AppResult<()> {
    if !src.exists() {
        return Ok(());
    }
    fs::create_dir_all(dst)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let name = entry.file_name();
        if is_icloud_placeholder(&name) {
            let real = icloud_real_from_placeholder(src, name)
                .ok_or_else(|| AppError::Other(format!("invalid iCloud placeholder under {}", src.display())))?;
            let file_name = real
                .file_name()
                .ok_or_else(|| AppError::Other(format!("invalid iCloud file path: {}", real.display())))?;
            let target = dst.join(file_name);
            if target.exists() {
                if let Some(p) = progress.as_deref_mut() {
                    p.complete("skipped", Some(display_file_name(&target)));
                }
                continue;
            }
            if let Some(p) = progress.as_deref() {
                p.emit("downloading", Some(display_file_name(&real)));
            }
            icloud::trigger_download_file(&real);
            wait_for_icloud_file(&real)?;
            copy_one_disable_file(&real, &target, progress.as_deref_mut())?;
            continue;
        }
        copy_one_disable_file(&entry.path(), &dst.join(&name), progress.as_deref_mut())?;
    }
    Ok(())
}

fn copy_one_disable_file(
    src: &Path,
    dst: &Path,
    progress: Option<&mut DisableCopyProgressEmitter>,
) -> AppResult<()> {
    let name = display_file_name(src);
    if dst.exists() {
        if let Some(p) = progress {
            p.complete("skipped", Some(name));
        }
        return Ok(());
    }
    if let Some(p) = progress.as_deref() {
        p.emit("copying", Some(name.clone()));
    }
    fs::copy(src, dst)?;
    if let Some(p) = progress {
        p.complete("copying", Some(name));
    }
    Ok(())
}

fn wait_for_icloud_file(path: &Path) -> AppResult<()> {
    let started = Instant::now();
    log::info!(
        "sync_disable: waiting for iCloud download file={}",
        display_file_name(path)
    );
    while !path.exists() {
        if started.elapsed() >= DISABLE_COPY_PLACEHOLDER_TIMEOUT {
            log::warn!(
                "sync_disable: iCloud download timed out file={} elapsed_ms={}",
                display_file_name(path),
                started.elapsed().as_millis()
            );
            return Err(AppError::Other(format!(
                "Cannot disable sync: iCloud has not downloaded {} yet. Downloads have been triggered; try again once iCloud finishes.",
                path.display(),
            )));
        }
        icloud::trigger_download_file(path);
        thread::sleep(DISABLE_COPY_PLACEHOLDER_POLL);
    }
    log::info!(
        "sync_disable: iCloud download materialized file={} elapsed_ms={}",
        display_file_name(path),
        started.elapsed().as_millis()
    );
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
    /// would silently corrupt the local library. If iCloud never
    /// materializes the real file, disable must still abort Phase 1
    /// (markers stay, `data_dir` stays at iCloud) instead of finishing
    /// with books only in iCloud and the app resolving against local.
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

        // `read_dir` order is filesystem-dependent; this test only
        // requires that the placeholder stub is never copied under
        // either name before the operation aborts.
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
    fn copy_dir_contents_waits_for_icloud_placeholder_materialization() {
        let tmp = TempDir::new().unwrap();
        let src = tmp.path().join("icloud");
        let dst = tmp.path().join("local");
        fs::create_dir_all(&src).unwrap();
        fs::write(src.join(".evicted.epub.icloud"), b"stub").unwrap();

        let real = src.join("evicted.epub");
        let real_for_thread = real.clone();
        std::thread::spawn(move || {
            std::thread::sleep(DISABLE_COPY_PLACEHOLDER_POLL + DISABLE_COPY_PLACEHOLDER_POLL);
            fs::write(real_for_thread, b"downloaded").unwrap();
        });

        copy_dir_contents(&src, &dst).unwrap();
        assert_eq!(fs::read(dst.join("evicted.epub")).unwrap(), b"downloaded");
        assert!(real.exists(), "copy-back must keep the iCloud source file");
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

    // -----------------------------------------------------------------------
    // Rebuild from iCloud (#300)
    // -----------------------------------------------------------------------

    use crate::sync::events::{
        BookImportPayload, Event, EventBody, HighlightPayload, EVENT_SCHEMA_VERSION,
    };
    use rusqlite::Connection;

    /// Same harness shape as `replay.rs`'s `Env`: temp shared dir +
    /// in-memory Db + own EventLog + engine.
    struct RebuildEnv {
        _dir: TempDir,
        shared: PathBuf,
        db: Db,
        engine: ReplayEngine,
    }

    impl RebuildEnv {
        fn conn(&self) -> std::sync::MutexGuard<'_, Connection> {
            self.db.conn.lock().unwrap()
        }

        fn count(&self, table: &str) -> i64 {
            self.conn()
                .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0))
                .unwrap()
        }
    }

    fn rebuild_setup(self_device: &str) -> RebuildEnv {
        let dir = TempDir::new().unwrap();
        let shared = dir.path().join("shared");
        fs::create_dir_all(shared.join("logs")).unwrap();

        let conn = Connection::open_in_memory().unwrap();
        Db::run_migrations_on(&conn).unwrap();
        let conn = Arc::new(Mutex::new(conn));
        let db = Db {
            read_conn: conn.clone(),
            conn,
            data_dir: Arc::new(Mutex::new(dir.path().to_path_buf())),
        };

        let own_log_path = shared.join("logs").join(format!("{self_device}.jsonl"));
        let own_log = Arc::new(EventLog::open(&own_log_path, self_device, false).unwrap());
        let engine = ReplayEngine::new(shared.clone(), self_device.to_string(), own_log);
        RebuildEnv { _dir: dir, shared, db, engine }
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

    fn write_peer_log(shared: &Path, peer: &str, events: &[Event]) {
        let p = shared.join("logs").join(format!("{peer}.jsonl"));
        let mut bytes = Vec::new();
        for e in events {
            bytes.extend_from_slice(&serde_json::to_vec(e).unwrap());
            bytes.push(b'\n');
        }
        fs::write(p, bytes).unwrap();
    }

    fn insert_book(conn: &Connection, id: &str, title: &str, ts: i64) {
        conn.execute(
            "INSERT INTO books
             (id, title, author, file_path, format, status, progress,
              created_at, updated_at, updated_by_device)
             VALUES (?1, ?2, 'Author', ?3, 'epub', 'unread', 0, ?4, ?4, 'self')",
            params![id, title, format!("books/{id}.epub"), ts],
        )
        .unwrap();
    }

    fn queue_event(conn: &Connection, ts: i64, body: &EventBody) {
        conn.execute(
            "INSERT INTO _pending_publish (id, ts, body_json, created_at)
             VALUES (?1, ?2, ?3, ?2)",
            params![
                uuid::Uuid::new_v4().to_string(),
                ts,
                serde_json::to_string(body).unwrap(),
            ],
        )
        .unwrap();
    }

    /// Spec test 1: the outbox drain and bootstrap snapshot land in the
    /// shared folder before the wipe, so both a queued-but-unflushed
    /// row and a row that was never queued at all survive the rebuild.
    #[test]
    fn rebuild_publishes_local_state_before_wiping() {
        let env = rebuild_setup("self");
        {
            let conn = env.conn();
            insert_book(&conn, "b-queued", "Queued", 1000);
            queue_event(&conn, 1000, &import("b-queued"));
            insert_book(&conn, "b-direct", "Never Queued", 1100);
        }

        run_rebuild(&env.db, &env.engine, None).unwrap();

        // The queued event reached the device's own log...
        let log_events = env.engine.own_log.read_all().unwrap();
        assert_eq!(log_events.len(), 1, "outbox must drain into the own log");
        // ...and the outbox is empty.
        assert_eq!(env.count("_pending_publish"), 0);
        // The bootstrap snapshot exists in the shared folder.
        assert!(env.shared.join("logs/self.snapshot.json").exists());

        // Both rows came back through the shared folder.
        let titles: Vec<String> = {
            let conn = env.conn();
            let mut stmt = conn
                .prepare("SELECT title FROM books ORDER BY id")
                .unwrap();
            let rows = stmt
                .query_map([], |r| r.get(0))
                .unwrap()
                .collect::<Result<_, _>>()
                .unwrap();
            rows
        };
        assert_eq!(titles, vec!["Never Queued".to_string(), "Queued".to_string()]);
        assert!(!rebuild_marker_set(&env.db), "marker clears after a complete rebuild");
    }

    /// Spec test 2: `settings`, `book_settings`, and `_tombstones`
    /// survive the rebuild, and a locally-deleted book stays deleted
    /// even though a peer log still carries its `book.import`.
    #[test]
    fn rebuild_preserves_local_tables_and_locally_deleted_books_stay_deleted() {
        let env = rebuild_setup("self");
        write_peer_log(
            &env.shared,
            "peer-A",
            &[
                ev(1000, "peer-A", import("b-keep")),
                ev(1100, "peer-A", import("b-del")),
            ],
        );
        env.engine.tick(&env.db).unwrap();
        assert_eq!(env.count("books"), 2);

        {
            let conn = env.conn();
            conn.execute(
                "INSERT INTO settings (key, value) VALUES ('reader_theme', 'dark')",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO book_settings (book_id, key, value)
                 VALUES ('b-keep', 'font_size', '24')",
                [],
            )
            .unwrap();
            // Local delete, the `do_delete_book` way: SQL delete plus a
            // queued `book.delete` event.
            conn.execute("DELETE FROM books WHERE id = 'b-del'", []).unwrap();
            queue_event(&conn, 2000, &EventBody::BookDelete { id: "b-del".into() });
        }
        // Tick lands the tombstone: the flush appends the delete to the
        // own log and the replay applies it back.
        env.engine.tick(&env.db).unwrap();
        let tombstoned: i64 = env
            .conn()
            .query_row(
                "SELECT COUNT(*) FROM _tombstones WHERE entity = 'book' AND id = 'b-del'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(tombstoned, 1, "own delete event must land a tombstone");

        run_rebuild(&env.db, &env.engine, None).unwrap();

        let conn = env.conn();
        let theme: String = conn
            .query_row(
                "SELECT value FROM settings WHERE key = 'reader_theme'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(theme, "dark", "settings must survive the rebuild");
        let font: String = conn
            .query_row(
                "SELECT value FROM book_settings WHERE book_id = 'b-keep' AND key = 'font_size'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(font, "24", "book_settings must survive the rebuild");
        let n_books: i64 = conn
            .query_row("SELECT COUNT(*) FROM books", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n_books, 1, "only b-keep should exist");
        let survivor: String = conn
            .query_row("SELECT id FROM books", [], |r| r.get(0))
            .unwrap();
        assert_eq!(survivor, "b-keep");
        let tombstoned: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM _tombstones WHERE entity = 'book' AND id = 'b-del'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(tombstoned, 1, "tombstone must survive the wipe");
    }

    /// Spec test 3: the wipe clears the nine synced tables and every
    /// `_replay_state` watermark, and nothing else.
    #[test]
    fn wipe_clears_synced_tables_and_watermarks_only() {
        let env = rebuild_setup("self");
        {
            let conn = env.conn();
            insert_book(&conn, "b1", "B1", 1000);
            conn.execute(
                "INSERT INTO highlights
                 (id, book_id, cfi_range, color, created_at, updated_at, updated_by_device)
                 VALUES ('h1', 'b1', 'cfi', 'yellow', 1000, 1000, 'self')",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO bookmarks (id, book_id, cfi, created_at, updated_at)
                 VALUES ('bm1', 'b1', 'cfi', 1000, 1000)",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO vocab_words
                 (id, book_id, word, definition, created_at, updated_at, updated_by_device)
                 VALUES ('v1', 'b1', 'word', 'def', 1000, 1000, 'self')",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO translations
                 (id, book_id, source_text, translated_text, target_language, created_at, updated_at)
                 VALUES ('t1', 'b1', 'src', 'dst', 'zh', 1000, 1000)",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO collections (id, name, created_at, updated_at, updated_by_device)
                 VALUES ('c1', 'Shelf', 1000, 1000, 'self')",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO collection_books (collection_id, book_id, created_at, updated_at, updated_by_device)
                 VALUES ('c1', 'b1', 1000, 1000, 'self')",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO chats (id, book_id, title, created_at, updated_at, updated_by_device)
                 VALUES ('ch1', 'b1', 'Chat', 1000, 1000, 'self')",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO chat_messages (id, chat_id, role, content, created_at, updated_at)
                 VALUES ('m1', 'ch1', 'user', 'hi', 1000, 1000)",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO _replay_state (peer_device, last_event_id, updated_at)
                 VALUES ('peer-A', 'e99', 1000), ('peer-B', 'e42', 1000)",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO _tombstones (entity, id, ts) VALUES ('book', 'gone', 500)",
                [],
            )
            .unwrap();
            queue_event(&conn, 1000, &import("b-pending"));
            conn.execute(
                "INSERT INTO settings (key, value) VALUES ('language', 'zh')",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO book_settings (book_id, key, value) VALUES ('b1', 'font', 'inter')",
                [],
            )
            .unwrap();
        }

        wipe_synced_tables(&env.db).unwrap();

        for table in WIPE_TABLES {
            assert_eq!(env.count(table), 0, "{table} must be wiped");
        }
        assert_eq!(env.count("_replay_state"), 0, "all watermarks must be cleared");
        assert_eq!(env.count("_tombstones"), 1, "_tombstones must survive");
        assert_eq!(env.count("_pending_publish"), 1, "_pending_publish must survive");
        assert_eq!(env.count("settings"), 1, "settings must survive");
        assert_eq!(env.count("book_settings"), 1, "book_settings must survive");
        // Legacy table with no replay source — wiping it would be
        // unrecoverable deletion, so it is preserved. Also naturally
        // absent on dev DBs stamped by the deleted migration 14; the
        // smoke-test failure ("no such table: translations") is why it
        // left WIPE_TABLES.
        assert_eq!(env.count("translations"), 1, "legacy translations must survive");
    }

    /// Spec test 4: a rebuild over an already-healthy library converges
    /// to the same end state — same row counts, same content, cover
    /// blob re-ingested.
    #[test]
    fn rebuild_over_healthy_library_converges_to_same_state() {
        let env = rebuild_setup("self");
        write_peer_log(
            &env.shared,
            "peer-A",
            &[
                ev(1000, "peer-A", import("b-peer")),
                ev(
                    1100,
                    "peer-A",
                    EventBody::HighlightAdd(HighlightPayload {
                        id: "h1".into(),
                        book_id: "b-peer".into(),
                        cfi_range: "cfi".into(),
                        color: "yellow".into(),
                        note: Some("note".into()),
                        text_content: None,
                    }),
                ),
            ],
        );
        let covers = env.shared.join("covers");
        fs::create_dir_all(&covers).unwrap();
        fs::write(covers.join("b-peer.img"), b"cover bytes").unwrap();
        {
            let conn = env.conn();
            insert_book(&conn, "b-own", "Own Book", 900);
        }
        env.engine.tick(&env.db).unwrap();

        let state_before: Vec<(String, String, Option<Vec<u8>>)> = {
            let conn = env.conn();
            let mut stmt = conn
                .prepare("SELECT id, title, cover_data FROM books ORDER BY id")
                .unwrap();
            let rows = stmt
                .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
                .unwrap()
                .collect::<Result<_, _>>()
                .unwrap();
            rows
        };
        assert_eq!(state_before.len(), 2);
        assert_eq!(
            state_before[1].2.as_deref(),
            Some(b"cover bytes".as_slice()),
            "healthy library has the peer cover ingested"
        );
        let highlights_before = env.count("highlights");

        run_rebuild(&env.db, &env.engine, None).unwrap();

        let state_after: Vec<(String, String, Option<Vec<u8>>)> = {
            let conn = env.conn();
            let mut stmt = conn
                .prepare("SELECT id, title, cover_data FROM books ORDER BY id")
                .unwrap();
            let rows = stmt
                .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
                .unwrap()
                .collect::<Result<_, _>>()
                .unwrap();
            rows
        };
        assert_eq!(state_after, state_before, "rebuild must converge to the same library");
        assert_eq!(env.count("highlights"), highlights_before);
        assert!(!rebuild_marker_set(&env.db));
    }

    /// Spec test 5: a rebuild interrupted after the wipe resumes on the
    /// next launch and converges; the marker clears exactly once.
    #[test]
    fn interrupted_rebuild_resumes_on_next_launch() {
        let env = rebuild_setup("self");
        write_peer_log(&env.shared, "peer-A", &[ev(1000, "peer-A", import("b1"))]);
        env.engine.tick(&env.db).unwrap();
        assert_eq!(env.count("books"), 1);

        // Crash simulation: fold tick + publish + marker + wipe ran,
        // the replay never did.
        env.engine.tick(&env.db).unwrap();
        publish_bootstrap_snapshot(&env.db, &env.shared, "self").unwrap();
        set_rebuild_marker(&env.db).unwrap();
        wipe_synced_tables(&env.db).unwrap();
        assert_eq!(env.count("books"), 0, "half-finished rebuild: library is wiped");
        assert!(rebuild_marker_set(&env.db), "marker survives the wipe");

        // "Next launch": the boot path sees the marker and resumes the
        // wipe + replay half.
        run_rebuild_replay(&env.db, &env.engine, None).unwrap();
        assert_eq!(env.count("books"), 1, "resume must converge");
        assert!(
            !rebuild_marker_set(&env.db),
            "marker clears after the resumed replay completes"
        );

        // A second launch finds no marker — the plain tick path runs
        // and the library stays converged.
        env.engine.tick(&env.db).unwrap();
        assert_eq!(env.count("books"), 1);
        assert!(!rebuild_marker_set(&env.db));
    }

    /// Review finding 1: retrying an interrupted rebuild must not
    /// re-publish a bootstrap snapshot from the wiped/partial DB —
    /// that would overwrite the only complete recovery snapshot and
    /// permanently lose local-only rows. With the marker set,
    /// `run_rebuild` skips straight to the wipe + replay half.
    #[test]
    fn rebuild_retry_after_interruption_does_not_republish_partial_state() {
        let env = rebuild_setup("self");
        write_peer_log(&env.shared, "peer-A", &[ev(1000, "peer-A", import("b-peer"))]);
        env.engine.tick(&env.db).unwrap();
        {
            // Local-only row: never queued, never logged — its only
            // durable copy is the pre-wipe bootstrap snapshot.
            let conn = env.conn();
            insert_book(&conn, "b-local", "Local Only", 1100);
        }

        // First rebuild, interrupted right after the wipe.
        env.engine.tick(&env.db).unwrap();
        publish_bootstrap_snapshot(&env.db, &env.shared, "self").unwrap();
        set_rebuild_marker(&env.db).unwrap();
        wipe_synced_tables(&env.db).unwrap();
        assert_eq!(env.count("books"), 0);

        // Retry through the real entry point.
        run_rebuild(&env.db, &env.engine, None).unwrap();

        let titles: Vec<String> = {
            let conn = env.conn();
            let mut stmt = conn.prepare("SELECT title FROM books ORDER BY id").unwrap();
            let rows = stmt
                .query_map([], |r| r.get(0))
                .unwrap()
                .collect::<Result<_, _>>()
                .unwrap();
            rows
        };
        assert_eq!(
            titles,
            vec!["Local Only".to_string(), "Book b-peer".to_string()],
            "retry must restore from the pre-wipe snapshot, not a re-published partial one",
        );
        assert!(!rebuild_marker_set(&env.db));
    }

    /// Review finding 1, sync_enable variant: enabling sync while a
    /// rebuild is pending (cancel → disable → re-enable) must keep the
    /// pre-wipe bootstrap snapshot instead of snapshotting the
    /// wiped/partial DB over it.
    #[test]
    fn enable_publish_is_skipped_while_rebuild_pending() {
        use crate::sync::snapshot::Snapshot;

        let env = rebuild_setup("self");
        {
            let conn = env.conn();
            insert_book(&conn, "b-local", "Local Only", 1000);
        }
        publish_bootstrap_snapshot(&env.db, &env.shared, "self").unwrap();
        let snap_path = env.shared.join("logs/self.snapshot.json");
        let good_id = Snapshot::read_from(&snap_path).unwrap().id;

        set_rebuild_marker(&env.db).unwrap();
        wipe_synced_tables(&env.db).unwrap();

        // What sync_enable now calls in its Phase 2.
        publish_bootstrap_snapshot_unless_rebuild_pending(&env.db, &env.shared, "self").unwrap();
        assert_eq!(
            Snapshot::read_from(&snap_path).unwrap().id,
            good_id,
            "the pre-wipe snapshot must not be overwritten while the marker is set",
        );

        // The enable-tick thread's resume then completes the rebuild.
        run_rebuild_replay(&env.db, &env.engine, None).unwrap();
        assert_eq!(env.count("books"), 1, "local-only book restored from the kept snapshot");
        assert!(!rebuild_marker_set(&env.db));
    }

    /// Review finding 2: a local delete whose event has NOT been
    /// applied locally yet — still queued in the outbox, or already
    /// flushed to the own log by the background worker — must stay
    /// deleted through a rebuild. The pre-wipe fold tick materializes
    /// the tombstones before the bootstrap snapshot is generated.
    #[test]
    fn rebuild_right_after_delete_keeps_books_deleted_without_prior_tick() {
        let env = rebuild_setup("self");
        write_peer_log(
            &env.shared,
            "peer-A",
            &[
                ev(1000, "peer-A", import("b-del-queued")),
                ev(1100, "peer-A", import("b-del-logged")),
            ],
        );
        env.engine.tick(&env.db).unwrap();
        assert_eq!(env.count("books"), 2);

        {
            let conn = env.conn();
            // Delete #1: event still sitting in the outbox.
            conn.execute("DELETE FROM books WHERE id = 'b-del-queued'", []).unwrap();
            queue_event(&conn, 2000, &EventBody::BookDelete { id: "b-del-queued".into() });
            // Delete #2: event already flushed to the own log (the
            // background flush worker ran) but never replayed locally.
            conn.execute("DELETE FROM books WHERE id = 'b-del-logged'", []).unwrap();
        }
        env.engine
            .own_log
            .append_batch_varied(vec![(EventBody::BookDelete { id: "b-del-logged".into() }, 2100)])
            .unwrap();
        // No tick here — neither delete has a tombstone yet.

        run_rebuild(&env.db, &env.engine, None).unwrap();

        assert_eq!(
            env.count("books"),
            0,
            "peer imports must not resurrect locally-deleted books",
        );
        let tombstones: i64 = env
            .conn()
            .query_row(
                "SELECT COUNT(*) FROM _tombstones WHERE entity = 'book'
                 AND id IN ('b-del-queued', 'b-del-logged')",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(tombstones, 2, "the fold tick must land both tombstones pre-snapshot");
    }

    /// Re-review finding 2: `run_rebuild` is single-flight. Two
    /// concurrent callers must serialize through the whole marker
    /// check → publish → wipe + replay state machine — otherwise the
    /// slower one can publish the already-wiped DB over the only
    /// complete recovery snapshot. (The mid-tick cancel-capture test
    /// lives in `replay.rs`, next to the tick internals it needs.)
    #[test]
    fn concurrent_rebuilds_serialize_and_keep_the_recovery_snapshot() {
        use crate::sync::snapshot::Snapshot;

        let env = rebuild_setup("self");
        write_peer_log(&env.shared, "peer-A", &[ev(1000, "peer-A", import("b-peer"))]);
        env.engine.tick(&env.db).unwrap();
        {
            let conn = env.conn();
            insert_book(&conn, "b-local", "Local Only", 1100);
        }

        std::thread::scope(|s| {
            let a = s.spawn(|| run_rebuild(&env.db, &env.engine, None));
            let b = s.spawn(|| run_rebuild(&env.db, &env.engine, None));
            a.join().unwrap().unwrap();
            b.join().unwrap().unwrap();
        });

        assert_eq!(env.count("books"), 2, "both books survive two overlapping rebuilds");
        assert!(!rebuild_marker_set(&env.db));
        let snap = Snapshot::read_from(&env.shared.join("logs/self.snapshot.json"))
            .unwrap();
        assert!(
            snap.state.books.contains_key("b-local"),
            "the published snapshot must never be a wiped/partial DB",
        );
    }

    /// Round-4 finding 1: the pre-rebuild tick skips a failing own
    /// event while a later success still max-bumps the self watermark
    /// past it (a hole). The sealed publish must not trust the
    /// watermark — it re-applies the full own log and fails closed, so
    /// the hole aborts the rebuild before any snapshot, marker, or
    /// wipe.
    #[test]
    fn rebuild_aborts_when_the_own_log_has_an_unapplied_hole() {
        let env = rebuild_setup("self");
        env.engine
            .own_log
            .append_batch_varied(vec![
                (
                    // Wrong value type — fails to apply, in the pre-tick
                    // and in the seal alike.
                    EventBody::BookMetadataSet {
                        book: "bX".into(),
                        field: "title".into(),
                        value: serde_json::json!(42),
                    },
                    2000,
                ),
                (import("b-later"), 2100),
            ])
            .unwrap();

        let result = run_rebuild(&env.db, &env.engine, None);

        assert!(result.is_err(), "the own-log hole must abort the rebuild");
        assert!(!rebuild_marker_set(&env.db), "no marker set");
        assert_eq!(
            env.count("books"),
            1,
            "the pre-tick applied the good event and nothing was wiped",
        );
        assert!(
            !env.shared.join("logs/self.snapshot.json").exists(),
            "no bootstrap snapshot may be published over the hole",
        );
    }

    /// Round-3 finding 2: cancels from before the rebuild entered the
    /// serialized state machine are stale — the generation captured at
    /// entry already includes them, so the rebuild proceeds. (This is
    /// what lets a fresh rebuild request supersede an old cancel with
    /// no clearable state for a second request to race on.)
    #[test]
    fn stale_cancel_before_rebuild_is_ignored() {
        let env = rebuild_setup("self");
        write_peer_log(&env.shared, "peer-A", &[ev(1000, "peer-A", import("b1"))]);
        env.engine.tick(&env.db).unwrap();

        env.engine.cancel();
        env.engine.bump_cancel_generation();

        let report = run_rebuild(&env.db, &env.engine, None).unwrap();
        assert!(!report.cancelled, "a cancel from before the request is stale");
        assert_eq!(env.count("books"), 1);
        assert!(!rebuild_marker_set(&env.db));
    }

    /// Round-3 finding 2, post-marker window: a cancel landing after
    /// the last pre-marker gate — where the replay tick's flag reset
    /// would launder the tick-scoped signal — must still force the
    /// cancelled verdict via the generation compare, retaining the
    /// marker so the next launch resumes.
    #[test]
    fn cancel_after_the_final_gate_retains_the_marker() {
        let env = rebuild_setup("self");
        write_peer_log(&env.shared, "peer-A", &[ev(1000, "peer-A", import("b1"))]);
        env.engine.tick(&env.db).unwrap();
        publish_bootstrap_snapshot(&env.db, &env.shared, "self").unwrap();
        set_rebuild_marker(&env.db).unwrap();

        // The operation captured this generation at entry; the cancel
        // bumps it before the destructive replay runs.
        let cancel_gen = env.engine.cancel_generation();
        env.engine.bump_cancel_generation();

        let report = run_rebuild_replay_locked(&env.db, &env.engine, None, cancel_gen).unwrap();
        assert!(report.cancelled, "generation change must force the cancelled verdict");
        assert!(rebuild_marker_set(&env.db), "marker retained — resume on next launch");
        assert_eq!(env.count("books"), 1, "the replay itself converged");

        // Next launch resumes with a fresh capture and clears the marker.
        let resumed = run_rebuild_replay(&env.db, &env.engine, None).unwrap();
        assert!(!resumed.cancelled);
        assert!(!rebuild_marker_set(&env.db));
    }

    /// Review finding 3, decision half: the marker outcome is decided
    /// by the replay tick's own report — cancelled keeps the marker
    /// for resume, completed clears it.
    #[test]
    fn settle_rebuild_marker_follows_the_tick_report() {
        let env = rebuild_setup("self");

        set_rebuild_marker(&env.db).unwrap();
        let cancelled = ReplayReport { cancelled: true, ..Default::default() };
        settle_rebuild_marker(&env.db, &cancelled).unwrap();
        assert!(rebuild_marker_set(&env.db), "cancelled replay must keep the marker");

        let completed = ReplayReport::default();
        settle_rebuild_marker(&env.db, &completed).unwrap();
        assert!(!rebuild_marker_set(&env.db), "completed replay must clear the marker");
    }
}
