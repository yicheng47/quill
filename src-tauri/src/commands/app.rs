use tauri::AppHandle;
use tauri_plugin_opener::OpenerExt;

use crate::error::{AppError, AppResult};
use crate::resolve_log_dir;

/// Called by the frontend after React has mounted and painted its first frame.
/// Shows the calling window after its UI and cached zoom have been restored.
#[tauri::command]
pub fn app_ready(window: tauri::WebviewWindow) -> AppResult<()> {
    window.show().map_err(|e| AppError::Other(e.to_string()))?;
    if window.label() == "main" {
        window
            .set_focus()
            .map_err(|e| AppError::Other(e.to_string()))?;
    }
    Ok(())
}

/// Reveal the per-user app log directory in the OS file manager.
#[tauri::command]
pub fn reveal_logs(app: AppHandle) -> AppResult<()> {
    let log_dir = resolve_log_dir();
    app.opener()
        .open_path(log_dir.to_string_lossy(), None::<&str>)
        .map_err(|e| AppError::Other(format!("open log dir: {e}")))?;
    Ok(())
}
