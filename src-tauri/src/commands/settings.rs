use rusqlite::params;
use std::collections::HashMap;
use tauri::{AppHandle, Emitter, State};

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

#[tauri::command]
pub fn get_book_settings(book_id: String, db: State<'_, Db>) -> AppResult<HashMap<String, String>> {
    let conn = db.conn.lock().map_err(|e| AppError::Other(e.to_string()))?;
    let mut stmt = conn.prepare("SELECT key, value FROM book_settings WHERE book_id = ?1")?;
    let settings = stmt
        .query_map(params![book_id], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))?
        .collect::<Result<HashMap<_, _>, _>>()?;
    Ok(settings)
}

#[tauri::command]
pub fn set_book_settings_bulk(book_id: String, settings: HashMap<String, String>, db: State<'_, Db>) -> AppResult<()> {
    let conn = db.conn.lock().map_err(|e| AppError::Other(e.to_string()))?;
    for (key, value) in settings {
        conn.execute(
            "INSERT INTO book_settings (book_id, key, value) VALUES (?1, ?2, ?3) ON CONFLICT(book_id, key) DO UPDATE SET value = ?3",
            params![book_id, key, value],
        )?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use crate::db::Db;
    use rusqlite::params;
    use std::collections::HashMap;
    use tempfile::TempDir;

    fn setup() -> (TempDir, Db) {
        let dir = TempDir::new().unwrap();
        let db = Db::init(&dir.path().to_path_buf()).unwrap();
        let conn = db.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO books (id, title, author, file_path, status, progress, created_at, updated_at)
             VALUES ('book1', 'Test Book', 'Author', 'books/test.epub', 'reading', 0, '2024-01-01', '2024-01-01')",
            [],
        ).unwrap();
        conn.execute(
            "INSERT INTO books (id, title, author, file_path, status, progress, created_at, updated_at)
             VALUES ('book2', 'Second Book', 'Author 2', 'books/test2.epub', 'reading', 0, '2024-01-01', '2024-01-01')",
            [],
        ).unwrap();
        drop(conn);
        (dir, db)
    }

    fn get_book_settings(db: &Db, book_id: &str) -> HashMap<String, String> {
        let conn = db.conn.lock().unwrap();
        let mut stmt = conn.prepare("SELECT key, value FROM book_settings WHERE book_id = ?1").unwrap();
        stmt.query_map(params![book_id], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))
            .unwrap()
            .collect::<Result<HashMap<_, _>, _>>()
            .unwrap()
    }

    fn set_book_settings_bulk(db: &Db, book_id: &str, settings: HashMap<String, String>) {
        let conn = db.conn.lock().unwrap();
        for (key, value) in settings {
            conn.execute(
                "INSERT INTO book_settings (book_id, key, value) VALUES (?1, ?2, ?3) ON CONFLICT(book_id, key) DO UPDATE SET value = ?3",
                params![book_id, key, value],
            ).unwrap();
        }
    }

    #[test]
    fn test_book_settings_roundtrip() {
        let (_dir, db) = setup();
        let mut settings = HashMap::new();
        settings.insert("font_family".to_string(), "inter".to_string());
        settings.insert("font_size".to_string(), "32".to_string());

        set_book_settings_bulk(&db, "book1", settings);

        let result = get_book_settings(&db, "book1");
        assert_eq!(result.get("font_family").unwrap(), "inter");
        assert_eq!(result.get("font_size").unwrap(), "32");
    }

    #[test]
    fn test_book_settings_isolation() {
        let (_dir, db) = setup();

        let mut s1 = HashMap::new();
        s1.insert("font_family".to_string(), "inter".to_string());
        set_book_settings_bulk(&db, "book1", s1);

        let mut s2 = HashMap::new();
        s2.insert("font_family".to_string(), "georgia".to_string());
        set_book_settings_bulk(&db, "book2", s2);

        assert_eq!(get_book_settings(&db, "book1").get("font_family").unwrap(), "inter");
        assert_eq!(get_book_settings(&db, "book2").get("font_family").unwrap(), "georgia");
    }

    #[test]
    fn test_book_settings_cascade_delete() {
        let (_dir, db) = setup();

        let mut settings = HashMap::new();
        settings.insert("font_size".to_string(), "28".to_string());
        set_book_settings_bulk(&db, "book1", settings);

        assert_eq!(get_book_settings(&db, "book1").len(), 1);

        let conn = db.conn.lock().unwrap();
        conn.execute("DELETE FROM books WHERE id = 'book1'", []).unwrap();
        drop(conn);

        assert!(get_book_settings(&db, "book1").is_empty());
    }

    #[test]
    fn test_book_settings_upsert() {
        let (_dir, db) = setup();

        let mut s1 = HashMap::new();
        s1.insert("font_size".to_string(), "24".to_string());
        set_book_settings_bulk(&db, "book1", s1);

        let mut s2 = HashMap::new();
        s2.insert("font_size".to_string(), "30".to_string());
        set_book_settings_bulk(&db, "book1", s2);

        assert_eq!(get_book_settings(&db, "book1").get("font_size").unwrap(), "30");
    }
}

/// Emit an open-settings event to the main window from any window.
#[tauri::command]
pub fn open_settings_on_main(section: String, app: AppHandle) -> AppResult<()> {
    app.emit_to("main", "open-settings", &section)
        .map_err(|e| AppError::Other(e.to_string()))?;
    Ok(())
}
