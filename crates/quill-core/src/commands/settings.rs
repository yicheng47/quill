use rusqlite::params;
use std::collections::HashMap;

use crate::error::{AppError, AppResult};
use crate::host::Core;
use crate::secrets::{ApiKeyBinding, Secrets, AI_API_KEY};

fn non_empty(value: Option<String>) -> Option<String> {
    value.map(|v| v.trim().to_string()).filter(|v| !v.is_empty())
}

fn read_endpoint_from_conn(conn: &rusqlite::Connection) -> AppResult<(String, Option<String>)> {
    let mut stmt = conn.prepare(
        "SELECT key, value FROM settings WHERE key IN ('ai_provider', 'ai_base_url')",
    )?;
    let mut provider: Option<String> = None;
    let mut base_url: Option<String> = None;
    let rows = stmt.query_map([], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })?;
    for row in rows {
        let (k, v) = row?;
        match k.as_str() {
            "ai_provider" => provider = Some(v),
            "ai_base_url" => base_url = Some(v),
            _ => {}
        }
    }
    let effective_provider = non_empty(provider).unwrap_or_else(|| "openai".to_string());
    Ok((effective_provider, non_empty(base_url)))
}

pub fn get_all_settings(core: &Core) -> AppResult<HashMap<String, String>> {
    let mut settings = {
        let conn = core.db.reader();
        let mut stmt = conn.prepare("SELECT key, value FROM settings")?;
        let rows = stmt
            .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))?
            .collect::<Result<HashMap<_, _>, _>>()?;
        rows
    };

    // Only expose `ai_api_key` when its persisted binding matches the current
    // provider and effective origin in `settings`.
    let provider =
        non_empty(settings.get("ai_provider").cloned()).unwrap_or_else(|| "openai".to_string());
    let base_url = non_empty(settings.get("ai_base_url").cloned());
    if let Ok(url) = crate::ai::api::base_url(&provider, base_url) {
        if let Some(value) = core.secrets.get_api_key_for_endpoint(&provider, &url) {
            settings.insert(AI_API_KEY.to_string(), value);
        }
    }

    Ok(settings)
}

pub fn get_setting(core: &Core, key: String) -> AppResult<Option<String>> {
    if key == AI_API_KEY {
        let (provider, base_url) = {
            let conn = core.db.reader();
            read_endpoint_from_conn(&conn)?
        };
        let Ok(url) = crate::ai::api::base_url(&provider, base_url) else {
            return Ok(None);
        };
        return Ok(core.secrets.get_api_key_for_endpoint(&provider, &url));
    }
    if Secrets::is_sensitive_key(&key) {
        return Ok(core.secrets.get(&key));
    }

    let conn = core.db.reader();
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

pub fn set_setting(core: &Core, key: String, value: String) -> AppResult<()> {
    let mut conn = core.db.conn.lock().map_err(|e| AppError::Other(e.to_string()))?;
    if key == AI_API_KEY {
        let (provider, base_url) = read_endpoint_from_conn(&conn)?;
        if provider == "ollama" {
            return core.secrets.clear_api_key();
        }
        let binding = ApiKeyBinding::for_endpoint(&provider, base_url.as_deref());
        return core.secrets.set_bound_api_key(&value, binding.as_ref());
    }
    if Secrets::is_sensitive_key(&key) {
        return core.secrets.set(&key, &value);
    }

    let endpoint_change = matches!(key.as_str(), "ai_provider" | "ai_base_url");
    let tx = conn.transaction()?;
    let old_binding = if endpoint_change {
        let (old_provider, old_base_url) = read_endpoint_from_conn(&tx)?;
        ApiKeyBinding::for_endpoint(&old_provider, old_base_url.as_deref())
    } else {
        None
    };

    tx.execute(
        "INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = ?2",
        params![key, value],
    )?;

    if endpoint_change {
        let (new_provider, new_base_url) = read_endpoint_from_conn(&tx)?;
        let new_binding = ApiKeyBinding::for_endpoint(&new_provider, new_base_url.as_deref());
        if new_binding != old_binding {
            // Clear the stored secret before committing `quill.db` so a failed
            // secret write rolls back the endpoint change; even if a mismatch
            // ever existed on disk, reads also verify the binding.
            core.secrets.clear_api_key()?;
        }
    }
    tx.commit()?;
    Ok(())
}

pub fn set_settings_bulk(core: &Core, mut settings: HashMap<String, String>) -> AppResult<()> {
    let mut conn = core.db.conn.lock().map_err(|e| AppError::Other(e.to_string()))?;
    let endpoint_change =
        settings.contains_key("ai_provider") || settings.contains_key("ai_base_url");
    let explicit_api_key = settings.remove(AI_API_KEY);
    let mut other_secrets: Vec<(String, String)> = Vec::new();
    let mut regular_settings: Vec<(String, String)> = Vec::with_capacity(settings.len());
    for (key, value) in settings {
        if Secrets::is_sensitive_key(&key) {
            other_secrets.push((key, value));
        } else {
            regular_settings.push((key, value));
        }
    }

    let tx = conn.transaction()?;
    let old_binding = if endpoint_change {
        let (old_provider, old_base_url) = read_endpoint_from_conn(&tx)?;
        ApiKeyBinding::for_endpoint(&old_provider, old_base_url.as_deref())
    } else {
        None
    };

    for (key, value) in regular_settings {
        tx.execute(
            "INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = ?2",
            params![key, value],
        )?;
    }

    let (new_provider, new_base_url) = read_endpoint_from_conn(&tx)?;
    let new_binding = ApiKeyBinding::for_endpoint(&new_provider, new_base_url.as_deref());

    for (key, value) in other_secrets {
        core.secrets.set(&key, &value)?;
    }
    if let Some(api_key) = explicit_api_key {
        if new_provider == "ollama" {
            core.secrets.clear_api_key()?;
        } else {
            core.secrets
                .set_bound_api_key(&api_key, new_binding.as_ref())?;
        }
    } else if endpoint_change && new_binding != old_binding {
        core.secrets.clear_api_key()?;
    }

    tx.commit()?;
    Ok(())
}

pub fn get_book_settings(core: &Core, book_id: String) -> AppResult<HashMap<String, String>> {
    let conn = core.db.reader();
    let mut stmt = conn.prepare("SELECT key, value FROM book_settings WHERE book_id = ?1")?;
    let settings = stmt
        .query_map(params![book_id], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))?
        .collect::<Result<HashMap<_, _>, _>>()?;
    Ok(settings)
}

pub fn set_book_settings_bulk(
    core: &Core,
    book_id: String,
    settings: HashMap<String, String>,
) -> AppResult<()> {
    let conn = core.db.conn.lock().map_err(|e| AppError::Other(e.to_string()))?;
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
        let db = Db::init(dir.path()).unwrap();
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
    fn test_book_settings_cleaned_on_book_delete() {
        let (_dir, db) = setup();

        let mut settings = HashMap::new();
        settings.insert("font_size".to_string(), "28".to_string());
        set_book_settings_bulk(&db, "book1", settings);

        assert_eq!(get_book_settings(&db, "book1").len(), 1);

        let conn = db.conn.lock().unwrap();
        conn.execute("DELETE FROM book_settings WHERE book_id = 'book1'", []).unwrap();
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
pub fn open_settings_on_main(core: &Core, section: String) -> AppResult<()> {
    core.host.emit_to_json("main", "open-settings", &section);
    Ok(())
}
