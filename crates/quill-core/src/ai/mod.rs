pub mod anthropic;
pub mod api;
pub mod codex;
pub mod dispatch;
pub mod ollama;
pub mod openai_compat;

use rusqlite::params;

use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::secrets::Secrets;

pub const AI_NOT_CONFIGURED: &str = "AI_NOT_CONFIGURED";
/// Set when a pre-2.0 `ai_auth_mode = oauth` profile is migrated to `codex` so
/// the first-launch AI setup helper shows once with the migration note.
pub const CODEX_MIGRATION_PENDING_KEY: &str = "ai_codex_migration_pending";

pub fn is_ai_sentinel(err: &AppError) -> bool {
    matches!(err, AppError::Other(msg) if [
        AI_NOT_CONFIGURED,
        codex::CODEX_NOT_INSTALLED,
        codex::CODEX_NOT_SIGNED_IN,
        codex::CODEX_TOO_OLD,
        codex::CODEX_FAILED,
    ]
    .contains(&msg.as_str()))
}

/// Migrate a pre-2.0 `ai_auth_mode = oauth` profile onto Codex (when OpenAI
/// was the effective provider) or back to `api_key` (when an Ollama/Anthropic
/// user had a stale `ai_auth_mode = oauth`), and remove obsolete ChatGPT OAuth
/// tokens from `secrets.db`. Idempotent: a second launch is a no-op.
pub fn migrate_oauth_to_codex(db: &Db, secrets: &Secrets) -> AppResult<()> {
    secrets.delete_prefix("oauth_")?;

    let mut conn = db
        .conn
        .lock()
        .map_err(|e| AppError::Other(e.to_string()))?;
    let tx = conn.transaction()?;
    tx.execute("DELETE FROM settings WHERE key LIKE 'oauth_%'", [])?;

    let auth_mode: Option<String> = tx
        .query_row(
            "SELECT value FROM settings WHERE key = 'ai_auth_mode'",
            [],
            |row| row.get(0),
        )
        .ok();
    if auth_mode.as_deref() == Some("oauth") {
        let provider: Option<String> = tx
            .query_row(
                "SELECT value FROM settings WHERE key = 'ai_provider'",
                [],
                |row| row.get(0),
            )
            .ok();
        let effective_provider = provider
            .as_deref()
            .map(str::trim)
            .filter(|p| !p.is_empty());
        // Pre-2.0 ChatGPT OAuth only routed when `ai_provider` was `openai` (or unset
        // in a seeded migration test); switching to Ollama/Anthropic updated `ai_provider`
        // without clearing `ai_auth_mode = oauth`.
        if matches!(effective_provider, None | Some("openai")) {
            tx.execute(
                "INSERT INTO settings (key, value) VALUES ('ai_auth_mode', 'codex') ON CONFLICT(key) DO UPDATE SET value = 'codex'",
                [],
            )?;
            tx.execute(
                "INSERT INTO settings (key, value) VALUES (?1, 'true') ON CONFLICT(key) DO UPDATE SET value = 'true'",
                params![CODEX_MIGRATION_PENDING_KEY],
            )?;
            log::info!("ai: migrated ai_auth_mode from oauth to codex");
        } else {
            tx.execute(
                "INSERT INTO settings (key, value) VALUES ('ai_auth_mode', 'api_key') ON CONFLICT(key) DO UPDATE SET value = 'api_key'",
                [],
            )?;
            log::info!(
                "ai: normalized stale oauth auth_mode to api_key for provider={}",
                effective_provider.unwrap_or("")
            );
        }
    }
    tx.commit()?;

    Ok(())
}

/// Run all 2.0 AI settings & secrets migrations on boot.
pub fn migrate_startup(db: &Db, secrets: &Secrets) -> AppResult<()> {
    api::migrate_saved_base_url(db)?;
    migrate_oauth_to_codex(db, secrets)?;
    secrets.migrate_legacy_api_key_binding(db)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migrate_oauth_moves_mode_keeps_model_and_tiers_deletes_tokens_and_is_idempotent() {
        let dir = tempfile::TempDir::new().unwrap();
        let db = Db::init(dir.path()).unwrap();
        let secrets = Secrets::init(&dir.path().to_path_buf()).unwrap();
        {
            let conn = db.conn.lock().unwrap();
            for (k, v) in [
                ("ai_provider", "openai"),
                ("ai_auth_mode", "oauth"),
                ("ai_model", "gpt-5.6-sol"),
                ("ai_effort_quick", "low"),
                ("ai_effort_deep", "high"),
                ("ai_setup_seen", "true"),
            ] {
                conn.execute("INSERT INTO settings (key, value) VALUES (?1, ?2)", params![k, v])
                    .unwrap();
            }
        }
        secrets.set("oauth_access_token", "tok").unwrap();
        secrets.set("oauth_refresh_token", "ref").unwrap();
        secrets.set("oauth_expires_at", "123").unwrap();
        secrets.set("oauth_account_id", "acct").unwrap();
        secrets.set("oauth_email", "reader@example.com").unwrap();
        secrets.set("ai_api_key", "sk-keep-me").unwrap();

        migrate_oauth_to_codex(&db, &secrets).unwrap();

        let get = |key: &str| -> Option<String> {
            db.reader()
                .query_row("SELECT value FROM settings WHERE key = ?1", params![key], |r| r.get(0))
                .ok()
        };
        assert_eq!(get("ai_auth_mode").as_deref(), Some("codex"));
        assert_eq!(get("ai_model").as_deref(), Some("gpt-5.6-sol"));
        assert_eq!(get("ai_effort_quick").as_deref(), Some("low"));
        assert_eq!(get("ai_effort_deep").as_deref(), Some("high"));
        assert_eq!(get(CODEX_MIGRATION_PENDING_KEY).as_deref(), Some("true"));
        assert!(secrets.get("oauth_access_token").is_none());
        assert!(secrets.get("oauth_refresh_token").is_none());
        assert!(secrets.get("oauth_expires_at").is_none());
        assert!(secrets.get("oauth_account_id").is_none());
        assert!(secrets.get("oauth_email").is_none());
        assert_eq!(secrets.get("ai_api_key").as_deref(), Some("sk-keep-me"));

        // Dismiss the one-time notice; a second launch must be a complete no-op.
        {
            let conn = db.conn.lock().unwrap();
            conn.execute(
                "UPDATE settings SET value = 'false' WHERE key = ?1",
                params![CODEX_MIGRATION_PENDING_KEY],
            )
            .unwrap();
        }
        migrate_oauth_to_codex(&db, &secrets).unwrap();
        assert_eq!(get("ai_auth_mode").as_deref(), Some("codex"));
        assert_eq!(get(CODEX_MIGRATION_PENDING_KEY).as_deref(), Some("false"));
    }

    #[test]
    fn migrate_oauth_clears_stale_tokens_without_touching_api_key_mode() {
        let dir = tempfile::TempDir::new().unwrap();
        let db = Db::init(dir.path()).unwrap();
        let secrets = Secrets::init(&dir.path().to_path_buf()).unwrap();
        {
            let conn = db.conn.lock().unwrap();
            conn.execute("INSERT INTO settings (key, value) VALUES ('ai_provider', 'anthropic')", [])
                .unwrap();
            conn.execute("INSERT INTO settings (key, value) VALUES ('ai_auth_mode', 'api_key')", [])
                .unwrap();
        }
        secrets.set("oauth_access_token", "stale").unwrap();
        secrets.set("ai_api_key", "sk-ant").unwrap();

        migrate_oauth_to_codex(&db, &secrets).unwrap();

        let get = |key: &str| -> Option<String> {
            db.reader()
                .query_row("SELECT value FROM settings WHERE key = ?1", params![key], |r| r.get(0))
                .ok()
        };
        assert_eq!(get("ai_auth_mode").as_deref(), Some("api_key"));
        assert_eq!(get(CODEX_MIGRATION_PENDING_KEY), None);
        assert!(secrets.get("oauth_access_token").is_none());
        assert_eq!(secrets.get("ai_api_key").as_deref(), Some("sk-ant"));
    }

    #[test]
    fn migrate_oauth_preserves_ollama_and_anthropic_with_stale_oauth_mode() {
        for (provider, model, base_url, api_key) in [
            ("ollama", "qwen3.5", "http://localhost:11434/v1", None),
            ("anthropic", "claude-sonnet-4-20250514", "https://api.anthropic.com", Some("sk-ant-live")),
        ] {
            let dir = tempfile::TempDir::new().unwrap();
            let db = Db::init(dir.path()).unwrap();
            let secrets = Secrets::init(&dir.path().to_path_buf()).unwrap();
            {
                let conn = db.conn.lock().unwrap();
                for (k, v) in [
                    ("ai_provider", provider),
                    ("ai_auth_mode", "oauth"),
                    ("ai_model", model),
                    ("ai_base_url", base_url),
                ] {
                    conn.execute("INSERT INTO settings (key, value) VALUES (?1, ?2)", params![k, v])
                        .unwrap();
                }
            }
            secrets.set("oauth_access_token", "stale-tok").unwrap();
            if let Some(key) = api_key {
                secrets.set("ai_api_key", key).unwrap();
            }

            migrate_oauth_to_codex(&db, &secrets).unwrap();

            let get = |key: &str| -> Option<String> {
                db.reader()
                    .query_row("SELECT value FROM settings WHERE key = ?1", params![key], |r| r.get(0))
                    .ok()
            };
            assert_eq!(get("ai_auth_mode").as_deref(), Some("api_key"), "provider={provider}");
            assert_eq!(get("ai_provider").as_deref(), Some(provider));
            assert_eq!(get("ai_model").as_deref(), Some(model));
            assert_eq!(get("ai_base_url").as_deref(), Some(base_url));
            assert_eq!(
                get(CODEX_MIGRATION_PENDING_KEY),
                None,
                "stale oauth on {provider} must not show Codex migration note"
            );
            assert!(secrets.get("oauth_access_token").is_none());
            assert_eq!(secrets.get("ai_api_key").as_deref(), api_key);
        }
    }

    #[test]
    fn migrate_startup_binds_legacy_api_key_once_and_blocks_other_origins() {
        let dir = tempfile::TempDir::new().unwrap();
        let db = Db::init(dir.path()).unwrap();
        let secrets = Secrets::init(&dir.path().to_path_buf()).unwrap();
        {
            let conn = db.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO settings (key, value) VALUES ('ai_provider', 'anthropic')",
                [],
            )
            .unwrap();
        }
        // Pre-2.0 profile: plain `ai_api_key` in secrets.db with no binding row.
        secrets.set("ai_api_key", "sk-ant-legacy").unwrap();

        migrate_startup(&db, &secrets).unwrap();

        assert_eq!(
            secrets
                .get_api_key_for_endpoint("anthropic", "https://api.anthropic.com")
                .as_deref(),
            Some("sk-ant-legacy")
        );
        assert_eq!(
            secrets.get_api_key_for_endpoint("anthropic", "https://evil.example"),
            None
        );
        assert_eq!(
            secrets.get_api_key_for_endpoint("openai", "https://api.anthropic.com"),
            None
        );

        // Even if `settings` is later repointed externally before another boot,
        // the one-time binding migration must not re-bind the legacy key.
        {
            let conn = db.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO settings (key, value) VALUES ('ai_base_url', 'https://evil.example') ON CONFLICT(key) DO UPDATE SET value = 'https://evil.example'",
                [],
            )
            .unwrap();
        }
        migrate_startup(&db, &secrets).unwrap();
        assert_eq!(
            secrets.get_api_key_for_endpoint("anthropic", "https://evil.example"),
            None
        );
    }

    #[test]
    fn migrate_startup_preserves_legacy_key_unbound_when_saved_url_is_invalid() {
        let dir = tempfile::TempDir::new().unwrap();
        let db = Db::init(dir.path()).unwrap();
        let secrets = Secrets::init(&dir.path().to_path_buf()).unwrap();
        {
            let conn = db.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO settings (key, value) VALUES ('ai_provider', 'openai')",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO settings (key, value) VALUES ('ai_base_url', 'https://')",
                [],
            )
            .unwrap();
        }
        secrets.set("ai_api_key", "sk-unfinished-url").unwrap();

        // First boot: cannot bind to an invalid URL, so the pre-existing secret
        // is preserved on disk while remaining unavailable to dispatch.
        migrate_startup(&db, &secrets).unwrap();
        assert_eq!(secrets.get("ai_api_key").as_deref(), Some("sk-unfinished-url"));
        assert_eq!(secrets.get("ai_api_key_binding"), None);
        assert_eq!(
            secrets.get_api_key_for_endpoint("openai", "https://api.openai.com/v1"),
            None
        );

        // Second boot after URL changes: one-time marker prevents automatic
        // rebinding while still preserving the stored row.
        {
            let conn = db.conn.lock().unwrap();
            conn.execute(
                "UPDATE settings SET value = 'https://other.example/v1' WHERE key = 'ai_base_url'",
                [],
            )
            .unwrap();
        }
        migrate_startup(&db, &secrets).unwrap();
        assert_eq!(secrets.get("ai_api_key").as_deref(), Some("sk-unfinished-url"));
        assert_eq!(secrets.get("ai_api_key_binding"), None);
        assert_eq!(
            secrets.get_api_key_for_endpoint("openai", "https://other.example/v1"),
            None
        );
    }
}
