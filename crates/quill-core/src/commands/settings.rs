use rusqlite::{params, Transaction};
use std::collections::{HashMap, HashSet};

use crate::error::{AppError, AppResult};
use crate::host::Core;
use crate::secrets::{ApiKeyBinding, Secrets, AI_API_KEY};

const CODEX_MODEL_KEYS: [&str; 4] = [
    "ai_codex_model_lookup",
    "ai_codex_model_explain",
    "ai_codex_model_chat",
    "ai_codex_model_translate",
];

const CODEX_DEEP_EFFORT_FEATURES: [(&str, &str); 3] = [
    ("ai_codex_effort_explain", "ai_codex_effort_fallback_explain"),
    ("ai_codex_effort_chat", "ai_codex_effort_fallback_chat"),
    ("ai_codex_effort_translate", "ai_codex_effort_fallback_translate"),
];

fn non_empty(value: Option<String>) -> Option<String> {
    value.map(|v| v.trim().to_string()).filter(|v| !v.is_empty())
}

fn is_unset_codex_choice(value: Option<&str>) -> bool {
    value
        .map(str::trim)
        .is_none_or(|v| v.is_empty() || v == "default")
}

fn read_setting_tx(tx: &Transaction<'_>, key: &str) -> AppResult<Option<String>> {
    match tx.query_row("SELECT value FROM settings WHERE key = ?1", params![key], |row| row.get(0)) {
        Ok(value) => Ok(Some(value)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(e.into()),
    }
}

fn upsert_setting_tx(tx: &Transaction<'_>, key: &str, value: &str) -> AppResult<()> {
    tx.execute(
        "INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = ?2",
        params![key, value],
    )?;
    Ok(())
}

/// Atomically materialize carried-over 2.0 Codex keys (`ai_model`, `ai_effort_quick`,
/// `ai_effort_deep`) onto untouched per-feature rows inside the write transaction so:
/// 1. Switching from Codex to API never erases carried-over Codex choices when `ai_model`
///    is overwritten with the API model.
/// 2. Clearing one feature row to Default retires the legacy key without clobbering
///    concurrent per-feature writes from another window.
fn preserve_codex_legacy_in_tx(
    tx: &Transaction<'_>,
    incoming: &HashMap<String, String>,
) -> AppResult<Vec<String>> {
    let mut extra_keys = Vec::new();
    let old_auth_mode = read_setting_tx(tx, "ai_auth_mode")?;
    let new_auth_mode = incoming
        .get("ai_auth_mode")
        .map(String::as_str)
        .or(old_auth_mode.as_deref());

    let switching_from_codex =
        old_auth_mode.as_deref() == Some("codex") && new_auth_mode != Some("codex");
    let clearing_codex_model = new_auth_mode == Some("codex")
        && CODEX_MODEL_KEYS
            .iter()
            .any(|k| incoming.get(*k).is_some_and(|v| is_unset_codex_choice(Some(v))))
        && incoming
            .get("ai_model")
            .is_none_or(|v| is_unset_codex_choice(Some(v)));

    if switching_from_codex || clearing_codex_model {
        let old_model = read_setting_tx(tx, "ai_model")?;
        if let Some(legacy_model) = old_model
            .as_deref()
            .map(str::trim)
            .filter(|v| !v.is_empty() && *v != "default")
        {
            for key in CODEX_MODEL_KEYS {
                if incoming.contains_key(key) {
                    continue;
                }
                if is_unset_codex_choice(read_setting_tx(tx, key)?.as_deref()) {
                    upsert_setting_tx(tx, key, legacy_model)?;
                    extra_keys.push(key.to_string());
                }
            }
            if clearing_codex_model && !incoming.contains_key("ai_model") {
                upsert_setting_tx(tx, "ai_model", "")?;
                extra_keys.push("ai_model".to_string());
            }
        }
    }

    if incoming
        .get("ai_codex_effort_lookup")
        .is_some_and(|v| is_unset_codex_choice(Some(v)))
        && incoming
            .get("ai_effort_quick")
            .is_none_or(|v| is_unset_codex_choice(Some(v)))
    {
        let old_quick = read_setting_tx(tx, "ai_effort_quick")?;
        if !is_unset_codex_choice(old_quick.as_deref()) && !incoming.contains_key("ai_effort_quick") {
            upsert_setting_tx(tx, "ai_effort_quick", "")?;
            extra_keys.push("ai_effort_quick".to_string());
        }
    }

    let clearing_deep_effort = CODEX_DEEP_EFFORT_FEATURES
        .iter()
        .any(|(effort_key, _)| incoming.get(*effort_key).is_some_and(|v| is_unset_codex_choice(Some(v))))
        && incoming
            .get("ai_effort_deep")
            .is_none_or(|v| is_unset_codex_choice(Some(v)));
    if clearing_deep_effort {
        let old_deep = read_setting_tx(tx, "ai_effort_deep")?;
        if let Some(legacy_deep) = old_deep
            .as_deref()
            .map(str::trim)
            .filter(|v| !v.is_empty() && *v != "default")
        {
            for (effort_key, fallback_key) in CODEX_DEEP_EFFORT_FEATURES {
                if incoming.contains_key(effort_key) {
                    continue;
                }
                if is_unset_codex_choice(read_setting_tx(tx, effort_key)?.as_deref()) {
                    upsert_setting_tx(tx, effort_key, legacy_deep)?;
                    extra_keys.push(effort_key.to_string());
                } else if !incoming.contains_key(fallback_key)
                    && is_unset_codex_choice(read_setting_tx(tx, fallback_key)?.as_deref())
                {
                    // Preserve the shared legacy tier as a per-feature fallback for untouched
                    // siblings whose saved effort may be unsupported by their resolved catalog model.
                    upsert_setting_tx(tx, fallback_key, legacy_deep)?;
                    extra_keys.push(fallback_key.to_string());
                }
            }
            if !incoming.contains_key("ai_effort_deep") {
                upsert_setting_tx(tx, "ai_effort_deep", "")?;
                extra_keys.push("ai_effort_deep".to_string());
            }
        }
        for (effort_key, fallback_key) in CODEX_DEEP_EFFORT_FEATURES {
            if incoming
                .get(effort_key)
                .is_some_and(|v| is_unset_codex_choice(Some(v)))
                && !incoming.contains_key(fallback_key)
                && !is_unset_codex_choice(read_setting_tx(tx, fallback_key)?.as_deref())
            {
                upsert_setting_tx(tx, fallback_key, "")?;
                extra_keys.push(fallback_key.to_string());
            }
        }
    }

    Ok(extra_keys)
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

    let incoming = HashMap::from([(key.clone(), value.clone())]);
    let mut changed_keys = preserve_codex_legacy_in_tx(&tx, &incoming)?;

    upsert_setting_tx(&tx, &key, &value)?;
    if !changed_keys.iter().any(|k| k == &key) {
        changed_keys.push(key);
    }

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
    core.host
        .emit("settings-changed", serde_json::json!({ "keys": changed_keys }));
    Ok(())
}

pub fn set_settings_bulk(core: &Core, mut settings: HashMap<String, String>) -> AppResult<()> {
    let mut conn = core.db.conn.lock().map_err(|e| AppError::Other(e.to_string()))?;
    let endpoint_change =
        settings.contains_key("ai_provider") || settings.contains_key("ai_base_url");
    let explicit_api_key = settings.remove(AI_API_KEY);
    let mut other_secrets: Vec<(String, String)> = Vec::new();
    let mut regular_settings: HashMap<String, String> = HashMap::with_capacity(settings.len());
    for (key, value) in settings {
        if Secrets::is_sensitive_key(&key) {
            other_secrets.push((key, value));
        } else {
            regular_settings.insert(key, value);
        }
    }

    let tx = conn.transaction()?;
    let old_binding = if endpoint_change {
        let (old_provider, old_base_url) = read_endpoint_from_conn(&tx)?;
        ApiKeyBinding::for_endpoint(&old_provider, old_base_url.as_deref())
    } else {
        None
    };

    let extra_keys = preserve_codex_legacy_in_tx(&tx, &regular_settings)?;

    let mut changed_set: HashSet<String> = extra_keys.into_iter().collect();
    for (key, value) in &regular_settings {
        upsert_setting_tx(&tx, key, value)?;
        changed_set.insert(key.clone());
    }
    let changed_keys: Vec<String> = changed_set.into_iter().collect();

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
    if !changed_keys.is_empty() {
        core.host
            .emit("settings-changed", serde_json::json!({ "keys": changed_keys }));
    }
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

    #[test]
    fn codex_to_api_round_trip_preserves_legacy_model_on_untouched_features() {
        use crate::host::{boot, BootConfig, ShellHost};
        use std::path::Path;
        use std::sync::Arc;

        struct NoopHost;
        impl ShellHost for NoopHost {
            fn emit(&self, _event: &str, _payload: serde_json::Value) {}
            fn emit_to(&self, _w: &str, _e: &str, _p: serde_json::Value) {}
            fn open_url(&self, _u: &str) -> crate::error::AppResult<()> {
                Ok(())
            }
            fn reveal_path(&self, _p: &Path) -> crate::error::AppResult<()> {
                Ok(())
            }
        }

        let dir = TempDir::new().unwrap();
        let core = boot(
            BootConfig {
                app_data_base_dir: dir.path().join("appdata"),
                log_dir: dir.path().join("logs"),
                is_dev: true,
                mcp_binary_path: dir.path().join("quill-mcp"),
                pdfium_path: None,
            },
            Arc::new(NoopHost),
        )
        .unwrap();

        // 2.0 Codex profile with legacy ai_model = gpt-6-luna and no per-feature overrides.
        super::set_settings_bulk(
            &core,
            HashMap::from([
                ("ai_auth_mode".into(), "codex".into()),
                ("ai_model".into(), "gpt-6-luna".into()),
            ]),
        )
        .unwrap();

        // Switch Codex -> API (overwriting ai_model with gpt-4o).
        super::set_settings_bulk(
            &core,
            HashMap::from([
                ("ai_auth_mode".into(), "api_key".into()),
                ("ai_provider".into(), "openai".into()),
                ("ai_base_url".into(), "https://api.openai.com/v1".into()),
                ("ai_model".into(), "gpt-4o".into()),
            ]),
        )
        .unwrap();

        // Switch API -> Codex (clearing ai_model so gpt-4o never bleeds into Codex).
        super::set_settings_bulk(
            &core,
            HashMap::from([
                ("ai_auth_mode".into(), "codex".into()),
                ("ai_model".into(), "".into()),
            ]),
        )
        .unwrap();

        let all = super::get_all_settings(&core).unwrap();
        assert_eq!(all.get("ai_model").map(String::as_str), Some(""));
        for key in super::CODEX_MODEL_KEYS {
            assert_eq!(
                all.get(key).map(String::as_str),
                Some("gpt-6-luna"),
                "{key} must preserve the 2.0 carried-over Codex model across an API round-trip"
            );
        }
    }

    #[test]
    fn clearing_feature_to_default_preserves_concurrent_sibling_writes_in_tx() {
        use crate::host::{boot, BootConfig, ShellHost};
        use std::path::Path;
        use std::sync::Arc;

        struct NoopHost;
        impl ShellHost for NoopHost {
            fn emit(&self, _event: &str, _payload: serde_json::Value) {}
            fn emit_to(&self, _w: &str, _e: &str, _p: serde_json::Value) {}
            fn open_url(&self, _u: &str) -> crate::error::AppResult<()> {
                Ok(())
            }
            fn reveal_path(&self, _p: &Path) -> crate::error::AppResult<()> {
                Ok(())
            }
        }

        let dir = TempDir::new().unwrap();
        let core = boot(
            BootConfig {
                app_data_base_dir: dir.path().join("appdata"),
                log_dir: dir.path().join("logs"),
                is_dev: true,
                mcp_binary_path: dir.path().join("quill-mcp"),
                pdfium_path: None,
            },
            Arc::new(NoopHost),
        )
        .unwrap();

        // Both windows start from legacy Luna / deep=medium / quick=high.
        super::set_settings_bulk(
            &core,
            HashMap::from([
                ("ai_auth_mode".into(), "codex".into()),
                ("ai_model".into(), "gpt-6-luna".into()),
                ("ai_effort_deep".into(), "medium".into()),
                ("ai_effort_quick".into(), "high".into()),
            ]),
        )
        .unwrap();

        // Reader saves explicit Chat=Sol and Chat effort=low first.
        super::set_setting(&core, "ai_codex_model_chat".into(), "gpt-6.2-sol".into()).unwrap();
        super::set_setting(&core, "ai_codex_effort_chat".into(), "low".into()).unwrap();

        // Settings (from stale snapshot) clears Explain model and Explain effort to Default.
        super::set_setting(&core, "ai_codex_model_explain".into(), "".into()).unwrap();
        super::set_setting(&core, "ai_codex_effort_explain".into(), "".into()).unwrap();
        super::set_setting(&core, "ai_codex_effort_lookup".into(), "".into()).unwrap();

        let all = super::get_all_settings(&core).unwrap();
        // Chat's explicit choices must NEVER be overwritten by legacy Luna / medium.
        assert_eq!(all.get("ai_codex_model_chat").map(String::as_str), Some("gpt-6.2-sol"));
        assert_eq!(all.get("ai_codex_effort_chat").map(String::as_str), Some("low"));
        // Cleared feature rows are empty and legacy keys are retired.
        assert_eq!(all.get("ai_codex_model_explain").map(String::as_str), Some(""));
        assert_eq!(all.get("ai_codex_effort_explain").map(String::as_str), Some(""));
        assert_eq!(all.get("ai_codex_effort_lookup").map(String::as_str), Some(""));
        assert_eq!(all.get("ai_model").map(String::as_str), Some(""));
        assert_eq!(all.get("ai_effort_deep").map(String::as_str), Some(""));
        assert_eq!(all.get("ai_effort_quick").map(String::as_str), Some(""));
        // Untouched siblings preserve carried-over legacy values.
        assert_eq!(all.get("ai_codex_model_lookup").map(String::as_str), Some("gpt-6-luna"));
        assert_eq!(all.get("ai_codex_model_translate").map(String::as_str), Some("gpt-6-luna"));
        assert_eq!(all.get("ai_codex_effort_translate").map(String::as_str), Some("medium"));
        // Non-empty sibling Chat retains its legacy deep fallback until Chat itself resets to Default.
        assert_eq!(
            all.get("ai_codex_effort_fallback_chat").map(String::as_str),
            Some("medium")
        );

        // Explicitly resetting Chat to Default clears its saved effort and its fallback.
        super::set_setting(&core, "ai_codex_effort_chat".into(), "".into()).unwrap();
        let after_chat_reset = super::get_all_settings(&core).unwrap();
        assert_eq!(after_chat_reset.get("ai_codex_effort_chat").map(String::as_str), Some(""));
        assert_eq!(
            after_chat_reset.get("ai_codex_effort_fallback_chat").map(String::as_str),
            Some("")
        );
        assert_eq!(
            after_chat_reset.get("ai_codex_effort_translate").map(String::as_str),
            Some("medium")
        );
    }
}

/// Emit an open-settings event to the main window from any window.
pub fn open_settings_on_main(core: &Core, section: String) -> AppResult<()> {
    core.host.emit_to_json("main", "open-settings", &section);
    Ok(())
}
