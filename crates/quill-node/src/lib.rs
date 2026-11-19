use std::path::{Path, PathBuf};
use std::sync::Arc;

use napi::bindgen_prelude::*;
use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi_derive::napi;
use quill_core::error::{AppError, AppResult};
use quill_core::{boot, icloud, paths, BootConfig, Core, ShellHost};

#[napi(object)]
pub struct JsBootConfig {
    pub app_data_base_dir: String,
    pub log_dir: String,
    pub is_dev: bool,
    pub mcp_binary_path: String,
    pub pdfium_path: Option<String>,
}

#[napi(object)]
#[derive(Clone)]
pub struct JsHostEvent {
    pub kind: String,
    pub window: Option<String>,
    pub event: Option<String>,
    pub payload_json: Option<String>,
    pub target: Option<String>,
}

type HostCallback = ThreadsafeFunction<JsHostEvent, (), JsHostEvent, Status, false, true>;

struct NodeHost {
    callback: HostCallback,
}

impl NodeHost {
    fn send(&self, event: JsHostEvent) {
        let status = self.callback.call(event, ThreadsafeFunctionCallMode::NonBlocking);
        if status != Status::Ok && status != Status::Closing {
            log::warn!("quill-node: host callback failed with status {status:?}");
        }
    }
}

impl ShellHost for NodeHost {
    fn emit(&self, event: &str, payload: serde_json::Value) {
        self.send(JsHostEvent {
            kind: "emit".to_string(),
            window: None,
            event: Some(event.to_string()),
            payload_json: Some(payload.to_string()),
            target: None,
        });
    }

    fn emit_to(&self, window: &str, event: &str, payload: serde_json::Value) {
        self.send(JsHostEvent {
            kind: "emit_to".to_string(),
            window: Some(window.to_string()),
            event: Some(event.to_string()),
            payload_json: Some(payload.to_string()),
            target: None,
        });
    }

    fn open_url(&self, url: &str) -> AppResult<()> {
        if !(url.starts_with("https://") || url.starts_with("http://")) {
            return Err(AppError::Other(format!("Unsupported URL scheme: {url}")));
        }
        self.send(JsHostEvent {
            kind: "open_url".to_string(),
            window: None,
            event: None,
            payload_json: None,
            target: Some(url.to_string()),
        });
        Ok(())
    }

    fn reveal_path(&self, path: &Path) -> AppResult<()> {
        if !path.exists() {
            return Err(AppError::Other(format!(
                "Path does not exist: {}",
                path.display()
            )));
        }
        self.send(JsHostEvent {
            kind: "reveal_path".to_string(),
            window: None,
            event: None,
            payload_json: None,
            target: Some(path.to_string_lossy().into_owned()),
        });
        Ok(())
    }
}

async fn boot_blocking(config: BootConfig, host: Arc<dyn ShellHost>) -> Result<Arc<Core>> {
    tokio::task::spawn_blocking(move || boot(config, host))
        .await
        .map_err(|e| Error::from_reason(format!("Core boot task failed: {e}")))?
        .map_err(|e| Error::from_reason(e.to_string()))
}

fn collect_media_roots(core: &Core) -> AppResult<Vec<String>> {
    let mut roots = Vec::new();
    let mut push_root = |path: PathBuf| {
        for candidate in [std::fs::canonicalize(&path).ok(), Some(path)]
            .into_iter()
            .flatten()
        {
            let s = candidate.to_string_lossy().into_owned();
            if !roots.contains(&s) {
                roots.push(s);
            }
        }
    };

    push_root(core.local_dir.clone());
    let data_dir = core
        .db
        .data_dir
        .lock()
        .map_err(|e| AppError::Other(format!("data_dir mutex: {e}")))?
        .clone();
    push_root(data_dir);
    if let Some(icloud_dir) = icloud::icloud_data_dir() {
        push_root(icloud_dir);
    }
    Ok(roots)
}

#[napi]
pub struct QuillCore {
    inner: Arc<Core>,
}

#[napi]
impl QuillCore {
    #[napi]
    pub fn boot<'env>(
        env: &'env Env,
        config: JsBootConfig,
        on_host_event: Function<'env, JsHostEvent, ()>,
    ) -> Result<PromiseRaw<'env, QuillCore>> {
        let tsfn: HostCallback = on_host_event
            .build_threadsafe_function::<JsHostEvent>()
            .weak::<true>()
            .build()?;
        let host = Arc::new(NodeHost { callback: tsfn });
        let boot_config = BootConfig {
            app_data_base_dir: PathBuf::from(config.app_data_base_dir),
            log_dir: PathBuf::from(config.log_dir),
            is_dev: config.is_dev,
            mcp_binary_path: PathBuf::from(config.mcp_binary_path),
            pdfium_path: config.pdfium_path.map(PathBuf::from),
        };
        env.spawn_future(async move {
            let core = boot_blocking(boot_config, host).await?;
            Ok(QuillCore { inner: core })
        })
    }

    #[napi]
    pub async fn dispatch(&self, command: String, args_json: String) -> Result<String> {
        let value = quill_core::dispatch(Arc::clone(&self.inner), &command, &args_json)
            .await
            .map_err(|e| Error::from_reason(e.to_string()))?;
        serde_json::to_string(&value)
            .map_err(|e| Error::from_reason(format!("Serialize dispatch result: {e}")))
    }

    #[napi]
    pub async fn allowed_media_roots(&self) -> Result<Vec<String>> {
        let core = Arc::clone(&self.inner);
        tokio::task::spawn_blocking(move || collect_media_roots(&core))
            .await
            .map_err(|e| Error::from_reason(format!("Media roots task failed: {e}")))?
            .map_err(|e| Error::from_reason(e.to_string()))
    }

    #[napi]
    pub fn local_dir(&self) -> String {
        self.inner.local_dir.to_string_lossy().into_owned()
    }

    #[napi]
    pub fn log_dir(&self) -> String {
        self.inner.log_dir.to_string_lossy().into_owned()
    }

    /// Stop the child processes Quill started, such as the Codex app server.
    #[napi]
    pub fn shutdown(&self) {
        self.inner.codex.shutdown();
    }
}

#[napi]
pub fn resolve_default_log_dir(is_dev: bool) -> String {
    paths::resolve_log_dir(is_dev)
        .to_string_lossy()
        .into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;
    use tempfile::TempDir;

    struct NoopHost;

    impl ShellHost for NoopHost {
        fn emit(&self, _event: &str, _payload: serde_json::Value) {}
        fn emit_to(&self, _window: &str, _event: &str, _payload: serde_json::Value) {}
        fn open_url(&self, _url: &str) -> AppResult<()> {
            Ok(())
        }
        fn reveal_path(&self, _path: &Path) -> AppResult<()> {
            Ok(())
        }
    }

    #[tokio::test]
    async fn boot_blocking_runs_off_runtime_and_rejects_unwritable_paths() {
        let dir = TempDir::new().unwrap();
        let file_blocking_dir = dir.path().join("not-a-dir");
        std::fs::write(&file_blocking_dir, b"occupied").unwrap();

        let bad_config = BootConfig {
            app_data_base_dir: file_blocking_dir,
            log_dir: dir.path().join("logs"),
            is_dev: true,
            mcp_binary_path: dir.path().join("quill-mcp"),
            pdfium_path: None,
        };
        let err = boot_blocking(bad_config, Arc::new(NoopHost))
            .await
            .err()
            .expect("boot against file path should fail cleanly");
        assert!(!err.reason.is_empty());
    }

    #[tokio::test]
    async fn collect_media_roots_waits_for_data_dir_lock_on_blocking_pool() {
        let dir = TempDir::new().unwrap();
        let config = BootConfig {
            app_data_base_dir: dir.path().join("appdata"),
            log_dir: dir.path().join("logs"),
            is_dev: true,
            mcp_binary_path: dir.path().join("quill-mcp"),
            pdfium_path: None,
        };
        let core = boot_blocking(config, Arc::new(NoopHost)).await.unwrap();

        let guard = core.db.data_dir.lock().unwrap();
        let core_clone = Arc::clone(&core);
        let handle = tokio::task::spawn_blocking(move || collect_media_roots(&core_clone));

        // Async tasks on the Tokio runtime keep progressing while the blocking worker waits on data_dir.
        tokio::time::sleep(Duration::from_millis(25)).await;
        assert!(!handle.is_finished());
        drop(guard);

        let roots = handle.await.unwrap().unwrap();
        assert!(roots.iter().any(|r| r.contains("com.wycstudios.quill-dev")));
    }
}
