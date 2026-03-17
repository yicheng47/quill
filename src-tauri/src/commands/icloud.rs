use serde::Serialize;
use tauri::{AppHandle, Manager, State};

use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::icloud;

#[derive(Serialize)]
pub struct ICloudStatus {
    available: bool,
    enabled: bool,
}

#[tauri::command]
pub fn icloud_status(app: AppHandle) -> AppResult<ICloudStatus> {
    let local_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::Other(e.to_string()))?;
    Ok(ICloudStatus {
        available: icloud::icloud_data_dir().is_some(),
        enabled: icloud::is_icloud_enabled(&local_dir),
    })
}

#[tauri::command]
pub fn icloud_enable(app: AppHandle, db: State<'_, Db>) -> AppResult<()> {
    let local_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::Other(e.to_string()))?;
    let icloud_dir = icloud::icloud_data_dir()
        .ok_or_else(|| AppError::Other("iCloud is not available".to_string()))?;

    icloud::ensure_downloaded(&icloud_dir)?;
    icloud::migrate_to_icloud(&db, &local_dir, &icloud_dir)
}

#[tauri::command]
pub fn icloud_disable(app: AppHandle, db: State<'_, Db>) -> AppResult<()> {
    let local_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::Other(e.to_string()))?;
    let icloud_dir = icloud::icloud_data_dir()
        .ok_or_else(|| AppError::Other("iCloud is not available".to_string()))?;

    icloud::migrate_from_icloud(&db, &local_dir, &icloud_dir)
}
