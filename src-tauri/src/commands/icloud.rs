use serde::Serialize;
use tauri::State;

use crate::db::Db;
use crate::error::AppResult;
use crate::icloud;
use crate::LocalDir;

#[derive(Serialize)]
pub struct ICloudStatus {
    available: bool,
    enabled: bool,
    /// Whether the iCloud container already has a quill.db (another device set it up).
    has_existing_data: bool,
}

#[tauri::command]
pub fn icloud_status(local: State<'_, LocalDir>) -> AppResult<ICloudStatus> {
    let has_existing_data = icloud::icloud_data_dir()
        .map(|dir| dir.join("quill.db").exists())
        .unwrap_or(false);
    Ok(ICloudStatus {
        available: icloud::icloud_data_dir().is_some(),
        enabled: icloud::is_icloud_enabled(&local.0),
        has_existing_data,
    })
}

#[tauri::command]
pub fn icloud_enable(local: State<'_, LocalDir>, db: State<'_, Db>) -> AppResult<()> {
    let icloud_dir = icloud::icloud_data_dir()
        .ok_or_else(|| crate::error::AppError::Other("iCloud is not available".to_string()))?;

    icloud::ensure_downloaded(&icloud_dir)?;
    icloud::migrate_to_icloud(&db, &local.0, &icloud_dir)
}

#[tauri::command]
pub fn icloud_disable(local: State<'_, LocalDir>, db: State<'_, Db>) -> AppResult<()> {
    let icloud_dir = icloud::icloud_data_dir()
        .ok_or_else(|| crate::error::AppError::Other("iCloud is not available".to_string()))?;

    icloud::migrate_from_icloud(&db, &local.0, &icloud_dir)
}
