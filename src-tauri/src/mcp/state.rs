use std::path::PathBuf;
use std::sync::Arc;

use crate::db::Db;
use crate::sync::writer::SyncWriter;

/// Shared state handed to every MCP request handler.
///
/// `Db` is already cheaply `Clone` (its inner `Connection` and
/// `data_dir` live behind `Arc<Mutex<…>>`), so we do NOT wrap it in
/// another `Arc`. See `db.rs:31-43`.
///
/// `sync` is `Some` when write tools are enabled (`mcp_write_enabled`
/// setting). Write tool handlers check this and return a clear error
/// when `None`. `SyncWriter` is behind `Arc` so `McpState` stays
/// `Clone` (the writer is shared across all tool invocations).
#[derive(Clone)]
pub struct McpState {
    pub db: Db,
    pub sync: Option<Arc<SyncWriter>>,
    notify_path: Option<PathBuf>,
}

impl McpState {
    pub fn new(db: Db, sync: Option<SyncWriter>) -> Self {
        let notify_path = if sync.is_some() {
            db.data_dir
                .lock()
                .ok()
                .map(|d| d.join(".mcp-notify"))
        } else {
            None
        };
        Self {
            db,
            sync: sync.map(Arc::new),
            notify_path,
        }
    }

    /// Write a sentinel file so the running Tauri app can detect MCP
    /// writes and refresh its UI. Overwrites (never appends) — the file
    /// stays ~80 bytes regardless of how many writes occur.
    pub fn notify(&self, domain: &str, action: &str, id: &str) {
        let Some(path) = &self.notify_path else {
            return;
        };
        let ts = chrono::Utc::now().timestamp_millis();
        let payload = format!(
            r#"{{"domain":"{domain}","action":"{action}","id":"{id}","ts":{ts}}}"#
        );
        if let Err(e) = std::fs::write(path, payload.as_bytes()) {
            eprintln!("mcp: failed to write notify sentinel: {e}");
        }
    }
}
