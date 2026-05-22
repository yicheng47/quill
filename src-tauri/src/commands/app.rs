use tauri::{AppHandle, Manager};
use tauri_plugin_opener::OpenerExt;

#[cfg(target_os = "macos")]
use tauri::Emitter;

use crate::error::{AppError, AppResult};
use crate::{resolve_log_dir, LocalDir};

/// Called by the frontend after React has mounted and painted its first frame.
/// Shows the main window — the window starts hidden so the user sees the dock
/// bounce → fully-rendered window instead of a beach ball over a blank webview.
///
/// Also kicks off background iCloud daemon registration + evicted-file downloads.
/// We do this here (not in setup) so the frontend event listeners are already
/// registered and can show the sync indicator.
#[tauri::command]
pub fn app_ready(app: AppHandle, _local_dir: tauri::State<'_, LocalDir>) -> AppResult<()> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| AppError::Other("main window not found".into()))?;
    window
        .show()
        .map_err(|e| AppError::Other(e.to_string()))?;
    window
        .set_focus()
        .map_err(|e| AppError::Other(e.to_string()))?;

    // Trigger iCloud downloads for the binaries directory whenever
    // sync is on — either via the new event-log sync (marker present)
    // or the legacy file-sync (`is_icloud_enabled`). Without this,
    // evicted books / covers stay as `.icloud` placeholders until the
    // user opens them individually. The browser-style sync indicator
    // in the sidebar is driven off this same emit pair.
    #[cfg(target_os = "macos")]
    {
        let new_sync = crate::sync::migration::is_migration_complete(&_local_dir.0);
        let legacy = crate::icloud::is_icloud_enabled(&_local_dir.0);
        if new_sync || legacy {
            let handle = app.clone();
            tauri::async_runtime::spawn_blocking(move || {
                let _ = handle.emit("icloud-sync-start", ());
                if let Some(icloud_dir) = crate::icloud::icloud_data_dir() {
                    let _ = crate::icloud::ensure_downloaded(&icloud_dir);
                } else {
                    log::warn!(
                        "iCloud: daemon unreachable; running against the cached path. Sync will resume on next launch."
                    );
                }
                let _ = handle.emit("icloud-sync-done", ());
            });
        }
    }

    Ok(())
}

/// Reveal the per-user app log directory in the OS file manager. Both the
/// Help menu item ("Reveal Logs in Finder" / "Show Logs in Explorer") and
/// the Settings → General → Diagnostics row route here.
///
/// Uses the same `resolve_log_dir()` helper as the plugin registration so
/// the two surfaces can never drift — in debug builds, both point at
/// `<base>/com.wycstudios.quill-dev/...` so dev runs don't pollute the
/// release log path. The directory exists by the time this command can be
/// invoked because the tauri-plugin-log file target creates it on the
/// first `log::` call.
#[tauri::command]
pub fn reveal_logs(app: AppHandle) -> AppResult<()> {
    let log_dir = resolve_log_dir();
    app.opener()
        .open_path(log_dir.to_string_lossy(), None::<&str>)
        .map_err(|e| AppError::Other(format!("open log dir: {e}")))?;
    Ok(())
}
