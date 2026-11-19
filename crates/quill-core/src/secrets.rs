use rusqlite::{params, Connection};
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

use crate::db::Db;
use crate::error::{AppError, AppResult};

/// Local-only secrets store. Lives at the local app_data_dir and never syncs to iCloud.
/// Stores API keys and other sensitive data.
pub struct Secrets {
    pub conn: Mutex<Connection>,
}

pub const AI_API_KEY: &str = "ai_api_key";
pub const AI_API_KEY_BINDING: &str = "ai_api_key_binding";
const AI_API_KEY_BINDING_MIGRATED: &str = "ai_api_key_binding_migrated";

const SENSITIVE_KEYS: &[&str] = &[AI_API_KEY];

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct ApiKeyBinding {
    pub provider: String,
    pub origin: String,
}

impl ApiKeyBinding {
    /// Compute the `(provider, normalized_origin)` binding for a saved endpoint.
    /// Returns `None` for Ollama (no API key) or missing/invalid HTTP(S) URLs.
    pub fn for_endpoint(provider: &str, base_url: Option<&str>) -> Option<Self> {
        let provider = provider.trim();
        if provider.is_empty() || provider == "ollama" {
            return None;
        }
        let saved = base_url
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string);
        let url = crate::ai::api::base_url(provider, saved).ok()?;
        let origin = crate::ai::api::normalized_origin(&url)?;
        Some(Self {
            provider: provider.to_string(),
            origin,
        })
    }

    /// Compute the `(provider, normalized_origin)` binding for an already-resolved URL.
    pub fn for_url(provider: &str, url: &str) -> Option<Self> {
        let provider = provider.trim();
        if provider.is_empty() || provider == "ollama" {
            return None;
        }
        let origin = crate::ai::api::normalized_origin(url)?;
        Some(Self {
            provider: provider.to_string(),
            origin,
        })
    }
}

impl Secrets {
    pub fn init(local_dir: &PathBuf) -> AppResult<Self> {
        fs::create_dir_all(local_dir)?;

        let db_path = local_dir.join("secrets.db");
        let conn = Connection::open(&db_path)?;

        conn.execute_batch("PRAGMA journal_mode=WAL;")?;
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS secrets (key TEXT PRIMARY KEY, value TEXT NOT NULL);",
        )?;

        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    pub fn get(&self, key: &str) -> Option<String> {
        let conn = self.conn.lock().ok()?;
        conn.query_row(
            "SELECT value FROM secrets WHERE key = ?1",
            params![key],
            |row| row.get(0),
        )
        .ok()
    }

    pub fn set(&self, key: &str, value: &str) -> AppResult<()> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Other(e.to_string()))?;
        conn.execute(
            "INSERT INTO secrets (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = ?2",
            params![key, value],
        )?;
        Ok(())
    }

    pub fn delete_prefix(&self, prefix: &str) -> AppResult<()> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Other(e.to_string()))?;
        conn.execute(
            "DELETE FROM secrets WHERE key LIKE ?1",
            params![format!("{}%", prefix)],
        )?;
        Ok(())
    }

    /// Atomically persist `ai_api_key` together with its `(provider, origin)`
    /// binding inside `secrets.db`. Passing an empty key clears both rows;
    /// passing a non-empty key without a bindable endpoint returns a validation
    /// error and leaves existing storage untouched.
    pub fn set_bound_api_key(&self, key: &str, binding: Option<&ApiKeyBinding>) -> AppResult<()> {
        if key.trim().is_empty() {
            let mut conn = self
                .conn
                .lock()
                .map_err(|e| AppError::Other(e.to_string()))?;
            let tx = conn.transaction()?;
            tx.execute(
                "DELETE FROM secrets WHERE key IN (?1, ?2)",
                params![AI_API_KEY, AI_API_KEY_BINDING],
            )?;
            tx.commit()?;
            return Ok(());
        }
        let Some(binding) = binding else {
            return Err(AppError::Other(
                "Cannot save an API key without a valid HTTP(S) base URL".to_string(),
            ));
        };
        let serialized =
            serde_json::to_string(binding).map_err(|e| AppError::Other(e.to_string()))?;
        let mut conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Other(e.to_string()))?;
        let tx = conn.transaction()?;
        tx.execute(
            "INSERT INTO secrets (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = ?2",
            params![AI_API_KEY, key],
        )?;
        tx.execute(
            "INSERT INTO secrets (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = ?2",
            params![AI_API_KEY_BINDING, serialized],
        )?;
        tx.commit()?;
        Ok(())
    }

    /// Atomically remove `ai_api_key` and its binding from `secrets.db`.
    pub fn clear_api_key(&self) -> AppResult<()> {
        self.set_bound_api_key("", None)
    }

    /// Return the stored `ai_api_key` only if its persisted binding in
    /// `secrets.db` matches both `provider` and the normalized origin of `url`.
    /// Fails closed (`None`) on any missing, malformed, or mismatched binding.
    pub fn get_api_key_for_endpoint(&self, provider: &str, url: &str) -> Option<String> {
        let expected = ApiKeyBinding::for_url(provider, url)?;
        let conn = self.conn.lock().ok()?;
        let key: String = conn
            .query_row(
                "SELECT value FROM secrets WHERE key = ?1",
                params![AI_API_KEY],
                |row| row.get(0),
            )
            .ok()?;
        if key.trim().is_empty() {
            return None;
        }
        let binding_raw: String = conn
            .query_row(
                "SELECT value FROM secrets WHERE key = ?1",
                params![AI_API_KEY_BINDING],
                |row| row.get(0),
            )
            .ok()?;
        let stored: ApiKeyBinding = serde_json::from_str(&binding_raw).ok()?;
        if stored == expected {
            Some(key)
        } else {
            None
        }
    }

    /// One-time upgrade migration: bind an existing pre-2.0 `ai_api_key` in
    /// `secrets.db` to the profile's currently saved `(ai_provider, ai_base_url)`
    /// origin so existing API users keep working seamlessly while gaining
    /// cross-origin binding enforcement.
    pub fn migrate_legacy_api_key_binding(&self, db: &Db) -> AppResult<()> {
        if self.get(AI_API_KEY_BINDING_MIGRATED).as_deref() == Some("true") {
            return Ok(());
        }

        let (provider, base_url) = {
            let conn = db.reader();
            let mut stmt = conn.prepare(
                "SELECT key, value FROM settings WHERE key IN ('ai_provider', 'ai_base_url')",
            )?;
            let mut provider: Option<String> = None;
            let mut base_url: Option<String> = None;
            let rows = stmt.query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?;
            for row in rows.flatten() {
                match row.0.as_str() {
                    "ai_provider" => provider = Some(row.1),
                    "ai_base_url" => base_url = Some(row.1),
                    _ => {}
                }
            }
            let effective_provider = provider
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .unwrap_or("openai")
                .to_string();
            (effective_provider, base_url)
        };

        let mut conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Other(e.to_string()))?;
        let tx = conn.transaction()?;
        let already: Option<String> = tx
            .query_row(
                "SELECT value FROM secrets WHERE key = ?1",
                params![AI_API_KEY_BINDING_MIGRATED],
                |row| row.get(0),
            )
            .ok();
        if already.as_deref() == Some("true") {
            return Ok(());
        }

        let existing_key: Option<String> = tx
            .query_row(
                "SELECT value FROM secrets WHERE key = ?1",
                params![AI_API_KEY],
                |row| row.get(0),
            )
            .ok();
        let existing_binding: Option<String> = tx
            .query_row(
                "SELECT value FROM secrets WHERE key = ?1",
                params![AI_API_KEY_BINDING],
                |row| row.get(0),
            )
            .ok();

        if existing_key.is_some_and(|k| !k.trim().is_empty()) && existing_binding.is_none() {
            if let Some(binding) = ApiKeyBinding::for_endpoint(&provider, base_url.as_deref()) {
                let serialized = serde_json::to_string(&binding)
                    .map_err(|e| AppError::Other(e.to_string()))?;
                tx.execute(
                    "INSERT INTO secrets (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = ?2",
                    params![AI_API_KEY_BINDING, serialized],
                )?;
                log::info!(
                    "secrets: bound legacy ai_api_key to provider={} origin={}",
                    binding.provider,
                    binding.origin
                );
            }
            // If the saved URL is invalid or non-bindable (e.g., an unfinished
            // URL edit before upgrade), leave the pre-existing secret intact
            // without a binding: get_api_key_for_endpoint still returns None,
            // and the migrated marker prevents automatic rebinding later.
        }

        tx.execute(
            "INSERT INTO secrets (key, value) VALUES (?1, 'true') ON CONFLICT(key) DO UPDATE SET value = 'true'",
            params![AI_API_KEY_BINDING_MIGRATED],
        )?;
        tx.commit()?;
        Ok(())
    }

    /// Migrate sensitive keys from the main settings DB to secrets.
    /// Runs once — if the key already exists in secrets, skip it.
    pub fn migrate_from_settings(&self, db: &Db) -> AppResult<()> {
        let db_conn = db
            .conn
            .lock()
            .map_err(|e| AppError::Other(e.to_string()))?;
        let secrets_conn = self
            .conn
            .lock()
            .map_err(|e| AppError::Other(e.to_string()))?;

        for key in SENSITIVE_KEYS {
            let value: Result<String, _> = db_conn.query_row(
                "SELECT value FROM settings WHERE key = ?1",
                params![key],
                |row| row.get(0),
            );
            if let Ok(value) = value {
                // Only migrate if not already in secrets
                let exists: bool = secrets_conn
                    .query_row(
                        "SELECT COUNT(*) > 0 FROM secrets WHERE key = ?1",
                        params![key],
                        |row| row.get(0),
                    )
                    .unwrap_or(false);
                if !exists {
                    secrets_conn.execute(
                        "INSERT INTO secrets (key, value) VALUES (?1, ?2)",
                        params![key, value],
                    )?;
                }
                db_conn.execute("DELETE FROM settings WHERE key = ?1", params![key])?;
            }
        }

        Ok(())
    }

    pub fn is_sensitive_key(key: &str) -> bool {
        SENSITIVE_KEYS.contains(&key)
    }
}

#[cfg(test)]
impl Secrets {
    pub fn init_in_memory() -> AppResult<Self> {
        let conn = Connection::open_in_memory()?;
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS secrets (key TEXT PRIMARY KEY, value TEXT NOT NULL);",
        )?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }
}
