use std::path::{Path, PathBuf};

use crate::db::Db;

/// Shared state handed to every MCP request handler.
///
/// `Db` is already cheaply `Clone` (its inner `Connection` handles live
/// behind `Arc<Mutex<…>>`), so we do NOT wrap it in another `Arc`.
///
/// `write_enabled` reflects whether write tools were enabled when this
/// MCP session started (`mcp_write_enabled` setting). Write tool handlers
/// also re-check SQLite on every call so revoking write access takes
/// effect immediately.
#[derive(Clone)]
pub struct McpState {
    pub db: Db,
    pub write_enabled: bool,
    notify_path: Option<PathBuf>,
}

impl McpState {
    /// `notify_dir` is the local app-data directory containing `.mcp-notify`,
    /// watched by the desktop app to refresh its UI after MCP writes.
    pub fn new(db: Db, write_enabled: bool, notify_dir: Option<&Path>) -> Self {
        let notify_path = write_enabled
            .then(|| notify_dir.map(|d| d.join(".mcp-notify")))
            .flatten();
        Self {
            db,
            write_enabled,
            notify_path,
        }
    }

    /// Write a sentinel file so the running desktop app can detect MCP
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
