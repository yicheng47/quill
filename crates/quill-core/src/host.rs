use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::Serialize;

use crate::commands::sync::{rebuild_marker_set, run_rebuild_replay, SyncState};
use crate::db::Db;
use crate::error::AppResult;
use crate::sync::device::DeviceIdentity;
use crate::sync::log::EventLog;
use crate::sync::replay::ReplayEngine;
use crate::sync::writer::SyncWriter;
use crate::{icloud, logging, mcp, panic_hook, paths, pdfium, secrets::Secrets, sync};

/// Host-shell capabilities required by `quill-core`.
pub trait ShellHost: Send + Sync + 'static {
    fn emit(&self, event: &str, payload: serde_json::Value);
    fn emit_to(&self, window: &str, event: &str, payload: serde_json::Value);
    fn open_url(&self, url: &str) -> AppResult<()>;
    fn reveal_path(&self, path: &Path) -> AppResult<()>;
}

impl dyn ShellHost {
    pub fn emit_json<T: Serialize>(&self, event: &str, payload: &T) {
        if let Ok(value) = serde_json::to_value(payload) {
            self.emit(event, value);
        }
    }

    pub fn emit_to_json<T: Serialize>(&self, window: &str, event: &str, payload: &T) {
        if let Ok(value) = serde_json::to_value(payload) {
            self.emit_to(window, event, value);
        }
    }
}

#[derive(Debug, Clone)]
pub struct BootConfig {
    pub app_data_base_dir: PathBuf,
    pub log_dir: PathBuf,
    pub is_dev: bool,
    pub mcp_binary_path: PathBuf,
    pub pdfium_path: Option<PathBuf>,
}

pub struct Core {
    pub local_dir: PathBuf,
    pub log_dir: PathBuf,
    pub mcp_binary_path: PathBuf,
    pub db: Db,
    pub secrets: Secrets,
    pub device: DeviceIdentity,
    pub sync_writer: SyncWriter,
    pub sync_state: SyncState,
    pub oauth_pending: crate::ai::oauth::OAuthPendingLogin,
    pub host: Arc<dyn ShellHost>,
}

pub fn boot(config: BootConfig, host: Arc<dyn ShellHost>) -> AppResult<Arc<Core>> {
    // Install the panic hook before anything else so any panic during setup
    // still lands in the log file once logging is active.
    panic_hook::install();
    logging::init_logging(&config.log_dir, config.is_dev)?;

    #[cfg(debug_assertions)]
    if config.is_dev && std::env::var("QUILL_PANIC_TEST").is_ok() {
        std::thread::spawn(|| {
            std::thread::sleep(std::time::Duration::from_secs(5));
            panic!("QUILL_PANIC_TEST: intentional panic for smoke testing the panic hook");
        });
    }

    if let Some(pdfium_path) = config.pdfium_path {
        pdfium::set_configured_path(pdfium_path);
    }

    let local_dir = paths::resolve_data_dir_from_base(&config.app_data_base_dir, config.is_dev);
    std::fs::create_dir_all(&local_dir)?;

    // Self-heal: if .icloud_setting survived but quill.db was deleted
    // (e.g. user cleared app data via Finder, which skips hidden dot-files),
    // remove the stale marker so the app starts fresh.
    if !local_dir.join("quill.db").exists() && sync::migration::is_sync_enabled(&local_dir) {
        log::warn!(
            "sync: quill.db missing but .icloud_setting survived — \
             clearing stale marker to start fresh"
        );
        let _ = std::fs::remove_file(local_dir.join(".icloud_setting"));
    }

    let ubiquity_dir = if sync::migration::is_sync_enabled(&local_dir) {
        sync::migration::recorded_data_dir(&local_dir).or_else(icloud::icloud_data_dir)
    } else {
        None
    };

    let device = DeviceIdentity::load_or_create(&local_dir)?;

    // When sync is on, blobs (books/, covers/) live in iCloud;
    // otherwise they're local.
    let data_dir = ubiquity_dir.clone().unwrap_or_else(|| local_dir.clone());
    let (db, needs_cover_backfill) = Db::init_split(&local_dir, &data_dir)?;

    // DB cover backfill for non-sync users. When sync boots, the
    // initial-tick thread handles both DB and .img backfill sequentially.
    let sync_will_boot = sync::migration::is_sync_enabled(&local_dir)
        && ubiquity_dir.as_ref().is_some_and(|p| p.exists());
    if needs_cover_backfill && !sync_will_boot {
        let backfill_db = db.clone();
        std::thread::Builder::new()
            .name("cover-backfill".into())
            .spawn(move || {
                backfill_db.backfill_cover_data();
            })
            .ok();
    }

    log::info!(
        "quill start v{version} os={os} arch={arch} data_dir={data_dir} schema_v={schema}",
        version = env!("CARGO_PKG_VERSION"),
        os = std::env::consts::OS,
        arch = std::env::consts::ARCH,
        data_dir = data_dir.display(),
        schema = db.schema_version(),
    );

    let secrets = Secrets::init(&local_dir)?;
    secrets.migrate_from_settings(&db)?;

    let sync_writer = SyncWriter::new(device.device_uuid.clone());
    if sync::migration::is_sync_enabled(&local_dir) {
        sync_writer.set_should_queue(true);
    }

    let mcp_notify_path = local_dir.join(".mcp-notify");
    mcp::notify::spawn_watcher(mcp_notify_path, Arc::clone(&host));

    crate::commands::mcp::repair_legacy_mcp_configs(config.is_dev, &config.mcp_binary_path);

    let core = Arc::new(Core {
        local_dir: local_dir.clone(),
        log_dir: config.log_dir,
        mcp_binary_path: config.mcp_binary_path,
        db,
        secrets,
        device,
        sync_writer,
        sync_state: SyncState::new(None, None),
        oauth_pending: Default::default(),
        host,
    });

    // Boot the sync engine on a background thread so boot() returns fast and
    // iCloud I/O never stalls window startup.
    let should_boot = sync::migration::is_sync_enabled(&local_dir)
        .then(|| ubiquity_dir.clone().filter(|p| p.exists()))
        .flatten();
    if let Some(ub) = should_boot {
        let bg_core = Arc::clone(&core);
        std::thread::Builder::new()
            .name("sync-boot".into())
            .spawn(move || {
                match boot_sync_engine(ub, &bg_core, needs_cover_backfill) {
                    Ok(()) => {
                        log::info!("sync: engine booted (replay + watcher active)");
                        bg_core.host.emit("sync-status-changed", serde_json::Value::Null);
                    }
                    Err(e) => {
                        log::error!("sync: failed to boot sync engine: {e}");
                    }
                }
            })
            .ok();
    } else if sync::migration::is_sync_enabled(&local_dir) {
        log::warn!(
            "sync: skipping engine boot — iCloud container not reachable \
             this launch; outbox preserved for the next launch"
        );
    }

    Ok(core)
}

fn boot_sync_engine(
    shared_dir: PathBuf,
    core: &Arc<Core>,
    needs_cover_backfill: bool,
) -> AppResult<()> {
    let device_uuid = &core.device.device_uuid;
    let log_path = shared_dir.join("logs").join(format!("{device_uuid}.jsonl"));
    let log = Arc::new(EventLog::open(&log_path, device_uuid, true)?);

    let engine = Arc::new(
        ReplayEngine::new(
            shared_dir.clone(),
            device_uuid.to_string(),
            Arc::clone(&log),
        )
        .with_host(Arc::clone(&core.host)),
    );

    let watcher = sync::watcher::spawn(shared_dir, core.db.clone(), Arc::clone(&engine))?;

    // Atomic check-and-install: hold the engine mutex across both the
    // marker recheck and the state writes. sync_disable also locks
    // engine before clearing, so this prevents the race where disable
    // slips in between the check and the install.
    {
        let mut engine_guard = core
            .sync_state
            .engine
            .lock()
            .map_err(|e| crate::error::AppError::Other(format!("engine mutex: {e}")))?;
        if !sync::migration::is_sync_enabled(&core.local_dir) {
            log::warn!("sync: boot finished but sync was disabled during boot — discarding engine");
            drop(watcher);
            return Ok(());
        }
        let mut watcher_guard = core
            .sync_state
            .watcher
            .lock()
            .map_err(|e| crate::error::AppError::Other(format!("watcher mutex: {e}")))?;
        *engine_guard = Some(Arc::clone(&engine));
        *watcher_guard = Some(watcher);
        core.sync_writer.set_log(Some(Arc::clone(&log)));
        core.sync_writer.spawn_cover_writer();
        core.sync_writer.spawn_flush_worker(core.db.clone(), log);
    }

    let bg_engine = Arc::clone(&engine);
    let bg_core = Arc::clone(core);
    std::thread::Builder::new()
        .name("sync-initial-tick".into())
        .spawn(move || {
            let result = if rebuild_marker_set(&bg_core.db) {
                log::info!("sync: rebuild marker set — resuming rebuild from iCloud");
                run_rebuild_replay(&bg_core.db, &bg_engine, Some(bg_core.host.as_ref()))
            } else {
                bg_engine.tick_with_progress(&bg_core.db, Some(bg_core.host.as_ref()))
            };
            if let Err(e) = result {
                log::warn!("sync: initial replay tick failed: {e}");
            }
            if needs_cover_backfill {
                bg_core.db.backfill_cover_data();
            }
            bg_core.sync_writer.backfill_cover_files(&bg_core.db);
            bg_core
                .host
                .emit("sync-initial-tick-done", serde_json::Value::Null);
        })
        .ok();

    Ok(())
}
