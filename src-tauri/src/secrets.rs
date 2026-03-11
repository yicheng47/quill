use rusqlite::{params, Connection};
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

use crate::db::Db;
use crate::error::{AppError, AppResult};

/// Local-only secrets store. Lives at the local app_data_dir and never syncs to iCloud.
/// Stores OAuth tokens, API keys, and other sensitive data.
pub struct Secrets {
    pub conn: Mutex<Connection>,
}

const SENSITIVE_KEYS: &[&str] = &[
    "ai_api_key",
    "oauth_access_token",
    "oauth_refresh_token",
    "oauth_expires_at",
    "oauth_account_id",
];

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
