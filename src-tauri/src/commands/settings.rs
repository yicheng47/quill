use rusqlite::params;
use std::collections::HashMap;
use tauri::State;

use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::secrets::Secrets;

#[tauri::command]
pub fn get_all_settings(db: State<'_, Db>, secrets: State<'_, Secrets>) -> AppResult<HashMap<String, String>> {
    let conn = db.conn.lock().map_err(|e| AppError::Other(e.to_string()))?;
    let mut stmt = conn.prepare("SELECT key, value FROM settings")?;
    let mut settings = stmt
        .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))?
        .collect::<Result<HashMap<_, _>, _>>()?;

    // Merge sensitive keys from secrets store
    if let Some(value) = secrets.get("ai_api_key") {
        settings.insert("ai_api_key".to_string(), value);
    }

    Ok(settings)
}

#[tauri::command]
pub fn get_setting(key: String, db: State<'_, Db>, secrets: State<'_, Secrets>) -> AppResult<Option<String>> {
    if Secrets::is_sensitive_key(&key) {
        return Ok(secrets.get(&key));
    }

    let conn = db.conn.lock().map_err(|e| AppError::Other(e.to_string()))?;
    let result = conn.query_row(
        "SELECT value FROM settings WHERE key = ?1",
        params![key],
        |row| row.get(0),
    );
    match result {
        Ok(value) => Ok(Some(value)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(e.into()),
    }
}

#[tauri::command]
pub fn set_setting(key: String, value: String, db: State<'_, Db>, secrets: State<'_, Secrets>) -> AppResult<()> {
    if Secrets::is_sensitive_key(&key) {
        return secrets.set(&key, &value);
    }

    let conn = db.conn.lock().map_err(|e| AppError::Other(e.to_string()))?;
    conn.execute(
        "INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = ?2",
        params![key, value],
    )?;
    Ok(())
}

#[tauri::command]
pub fn set_settings_bulk(settings: HashMap<String, String>, db: State<'_, Db>, secrets: State<'_, Secrets>) -> AppResult<()> {
    let conn = db.conn.lock().map_err(|e| AppError::Other(e.to_string()))?;
    for (key, value) in settings {
        if Secrets::is_sensitive_key(&key) {
            secrets.set(&key, &value)?;
        } else {
            conn.execute(
                "INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = ?2",
                params![key, value],
            )?;
        }
    }
    Ok(())
}
