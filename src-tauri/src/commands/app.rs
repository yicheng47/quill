use tauri::{AppHandle, Manager};

#[cfg(target_os = "macos")]
use tauri::Emitter;

use crate::error::{AppError, AppResult};
use crate::LocalDir;

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
                    eprintln!(
                        "iCloud: daemon unreachable; running against the cached path. Sync will resume on next launch."
                    );
                }
                let _ = handle.emit("icloud-sync-done", ());
            });
        }
    }

    Ok(())
}
