//! Watches the `.mcp-notify` sentinel file and emits shell events so
//! the frontend can refresh when the MCP subprocess mutates the library.

use std::path::PathBuf;
use std::sync::Arc;

use notify::{recommended_watcher, RecursiveMode, Watcher};

use crate::host::ShellHost;

/// Spawn a background thread that watches `sentinel_path` for writes.
/// On each write, reads the JSON payload and emits the appropriate
/// event (`mcp:books-changed` or `mcp:collections-changed`).
///
/// The watcher thread lives for the entire app lifetime. If the
/// sentinel file doesn't exist yet, the watcher still activates — it
/// watches the parent directory and fires when the file is created.
pub fn spawn_watcher(sentinel_path: PathBuf, host: Arc<dyn ShellHost>) {
    let watch_dir = sentinel_path
        .parent()
        .unwrap_or_else(|| std::path::Path::new("."))
        .to_path_buf();
    let sentinel_name = sentinel_path
        .file_name()
        .unwrap_or_default()
        .to_os_string();

    let mut watcher = match recommended_watcher(move |res: notify::Result<notify::Event>| {
        let Ok(event) = res else { return };
        let dominated = event.paths.iter().any(|p| {
            p.file_name()
                .map(|n| n == sentinel_name)
                .unwrap_or(false)
        });
        if !dominated {
            return;
        }
        if let Ok(payload) = std::fs::read_to_string(&sentinel_path) {
            emit_from_payload(host.as_ref(), &payload);
        }
    }) {
        Ok(w) => w,
        Err(e) => {
            log::warn!("mcp notify: failed to create watcher: {e}");
            return;
        }
    };

    if let Err(e) = watcher.watch(&watch_dir, RecursiveMode::NonRecursive) {
        log::warn!("mcp notify: failed to watch {}: {e}", watch_dir.display());
        return;
    }

    // Leak the watcher so it stays alive for the app's lifetime.
    // The OS hooks are cleaned up on process exit.
    std::mem::forget(watcher);
}

fn emit_from_payload(host: &dyn ShellHost, payload: &str) {
    let Ok(json) = serde_json::from_str::<serde_json::Value>(payload) else {
        return;
    };
    let domain = json["domain"].as_str().unwrap_or("");
    let event_name = match domain {
        "books" => "mcp:books-changed",
        "collections" => "mcp:collections-changed",
        _ => return,
    };
    host.emit_json(event_name, &payload);
}
