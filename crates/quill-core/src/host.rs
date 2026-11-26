use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::Serialize;

use crate::db::Db;
use crate::error::AppResult;
use crate::sync::device::DeviceIdentity;
use crate::{logging, mcp, panic_hook, paths, pdfium, secrets::Secrets};

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
    pub dict_path: Option<PathBuf>,
}

pub struct Core {
    pub local_dir: PathBuf,
    pub log_dir: PathBuf,
    pub mcp_binary_path: PathBuf,
    pub db: Db,
    pub secrets: Secrets,
    pub device: DeviceIdentity,
    pub codex: Arc<crate::ai::codex::Codex>,
    pub api_streams: crate::ai::dispatch::ApiStreams,
    pub dictionary: crate::dictionary::DictionaryManager,
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

    let device = DeviceIdentity::load_or_create(&local_dir)?;

    let (db, needs_cover_backfill) = Db::init_with_backfill(&local_dir)?;

    if needs_cover_backfill {
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
        data_dir = local_dir.display(),
        schema = db.schema_version(),
    );

    let secrets = Secrets::init(&local_dir)?;
    secrets.migrate_from_settings(&db)?;
    crate::ai::migrate_startup(&db, &secrets)?;

    let mcp_notify_path = local_dir.join(".mcp-notify");
    mcp::notify::spawn_watcher(mcp_notify_path, Arc::clone(&host));

    crate::commands::mcp::repair_legacy_mcp_configs(config.is_dev, &config.mcp_binary_path);

    let codex = Arc::new(crate::ai::codex::Codex::new(local_dir.join("codex-workspace")));
    codex.set_host(Arc::clone(&host));

    let dictionary =
        crate::dictionary::DictionaryManager::new(config.dict_path, local_dir.join("dictionaries"));

    Ok(Arc::new(Core {
        local_dir,
        log_dir: config.log_dir,
        mcp_binary_path: config.mcp_binary_path,
        db,
        secrets,
        device,
        codex,
        api_streams: Default::default(),
        dictionary,
        host,
    }))
}
