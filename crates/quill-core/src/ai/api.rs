//! The API connection's service presets. A preset only fills the base URL
//! and says whether a key is needed; the base URL includes the API version
//! path and stays editable.

use std::time::Duration;

use rusqlite::params;
use serde::Serialize;

use crate::db::Db;
use crate::error::{AppError, AppResult};

const MODELS_TIMEOUT: Duration = Duration::from_secs(10);
const ANTHROPIC_VERSION: &str = "2023-06-01";
pub const BASE_URL_MIGRATED_KEY: &str = "ai_base_url_v2_migrated";

/// The default base URL of each `ai_provider` service; `custom` has none.
pub fn default_base_url(provider: &str) -> Option<&'static str> {
    match provider {
        "openai" => Some("https://api.openai.com/v1"),
        "anthropic" => Some("https://api.anthropic.com"),
        "gemini" => Some("https://generativelanguage.googleapis.com/v1beta/openai"),
        "deepseek" => Some("https://api.deepseek.com/v1"),
        "openrouter" => Some("https://openrouter.ai/api/v1"),
        "ollama" => Some("http://localhost:11434/v1"),
        _ => None,
    }
}

/// Ollama and custom endpoints (often a local server) work without a key.
pub fn requires_key(provider: &str) -> bool {
    !matches!(provider, "ollama" | "custom")
}

/// The base URL a call uses: the saved one, else the preset's.
pub fn base_url(provider: &str, saved: Option<String>) -> AppResult<String> {
    saved
        .or_else(|| default_base_url(provider).map(str::to_string))
        .ok_or_else(|| AppError::Other(crate::ai::AI_NOT_CONFIGURED.to_string()))
}

/// OpenAI-compatible services take the versioned base URL and append only
/// the endpoint.
pub fn chat_completions_url(base_url: &str) -> String {
    format!("{}/chat/completions", base_url.trim_end_matches('/'))
}

/// Anthropic's native client keeps its unversioned base URL, while tolerating
/// a trailing `/v1` if a user included one on a custom proxy.
pub fn anthropic_messages_url(base_url: &str) -> String {
    let base = base_url.trim_end_matches('/');
    let root = base.strip_suffix("/v1").unwrap_or(base);
    format!("{root}/v1/messages")
}

pub fn models_url(provider: &str, base_url: &str) -> String {
    let base = base_url.trim_end_matches('/');
    if provider == "anthropic" {
        let root = base.strip_suffix("/v1").unwrap_or(base);
        format!("{root}/v1/models")
    } else {
        format!("{base}/models")
    }
}

fn has_version_segment(url: &str) -> bool {
    let last = if let Ok(parsed) = reqwest::Url::parse(url) {
        parsed
            .path_segments()
            .and_then(|mut segs| segs.rfind(|s| !s.is_empty()))
            .unwrap_or("")
            .to_string()
    } else {
        url.trim_end_matches('/').rsplit('/').next().unwrap_or("").to_string()
    };
    let rest = last.strip_prefix('v').unwrap_or("");
    !rest.is_empty()
        && rest.starts_with(|c: char| c.is_ascii_digit())
        && rest.chars().all(|c| c.is_ascii_alphanumeric())
}

/// A saved OpenAI or Ollama base URL from before the version-in-base-URL
/// convention, which always appended `/v1`, gets `/v1` once. `None` when it
/// needs no change.
pub fn versioned_base_url(provider: &str, saved: &str) -> Option<String> {
    if !matches!(provider, "openai" | "ollama") {
        return None;
    }
    let trimmed = saved.trim();
    if trimmed.is_empty() || has_version_segment(trimmed) {
        return None;
    }
    Some(format!("{}/v1", trimmed.trim_end_matches('/')))
}

/// One-time startup migration for the version-in-base-URL convention: appends
/// `/v1` once to a saved OpenAI or Ollama `ai_base_url` lacking a version path.
pub fn migrate_saved_base_url(db: &Db) -> AppResult<()> {
    let conn = db
        .conn
        .lock()
        .map_err(|e| AppError::Other(e.to_string()))?;
    let already_migrated: bool = conn
        .query_row(
            "SELECT COUNT(*) > 0 FROM settings WHERE key = ?1",
            params![BASE_URL_MIGRATED_KEY],
            |row| row.get(0),
        )
        .unwrap_or(false);
    if already_migrated {
        return Ok(());
    }

    let get = |key: &str| -> Option<String> {
        conn.query_row(
            "SELECT value FROM settings WHERE key = ?1",
            params![key],
            |row| row.get(0),
        )
        .ok()
    };
    if let (Some(provider), Some(saved_url)) = (get("ai_provider"), get("ai_base_url")) {
        if let Some(updated) = versioned_base_url(provider.trim(), &saved_url) {
            conn.execute(
                "INSERT INTO settings (key, value) VALUES ('ai_base_url', ?1) ON CONFLICT(key) DO UPDATE SET value = ?1",
                params![updated],
            )?;
            log::info!("ai: migrated saved {} base URL to versioned path", provider.trim());
        }
    }
    conn.execute(
        "INSERT INTO settings (key, value) VALUES (?1, 'true') ON CONFLICT(key) DO UPDATE SET value = 'true'",
        params![BASE_URL_MIGRATED_KEY],
    )?;
    Ok(())
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct ApiModelList {
    pub models: Vec<String>,
}

pub fn parse_model_ids(body: &serde_json::Value) -> Vec<String> {
    let mut ids: Vec<String> = body["data"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|m| m["id"].as_str())
        .map(|id| id.strip_prefix("models/").unwrap_or(id).to_string())
        .collect();
    ids.sort();
    ids.dedup();
    ids
}

/// List the service's models from `GET {base}/models`.
pub async fn list_models(provider: &str, base_url: &str, api_key: &str) -> AppResult<ApiModelList> {
    let client = reqwest::Client::builder()
        .timeout(MODELS_TIMEOUT)
        .build()
        .map_err(|e| AppError::Ai(e.to_string()))?;
    let mut request = client.get(models_url(provider, base_url));
    if provider == "anthropic" {
        request = request.header("x-api-key", api_key).header("anthropic-version", ANTHROPIC_VERSION);
    } else if !api_key.is_empty() {
        request = request.bearer_auth(api_key);
    }
    let response = request.send().await.map_err(|e| AppError::Ai(e.to_string()))?;
    if !response.status().is_success() {
        return Err(AppError::Ai(format!("model list failed: {}", response.status())));
    }
    let body: serde_json::Value = response.json().await.map_err(|e| AppError::Ai(e.to_string()))?;
    Ok(ApiModelList { models: parse_model_ids(&body) })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::ai::ChatMessage;
    use std::sync::{Arc, Mutex};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    #[test]
    fn presets_fill_versioned_base_urls() {
        assert_eq!(default_base_url("openai"), Some("https://api.openai.com/v1"));
        assert_eq!(default_base_url("anthropic"), Some("https://api.anthropic.com"));
        assert_eq!(
            default_base_url("gemini"),
            Some("https://generativelanguage.googleapis.com/v1beta/openai")
        );
        assert_eq!(default_base_url("deepseek"), Some("https://api.deepseek.com/v1"));
        assert_eq!(default_base_url("openrouter"), Some("https://openrouter.ai/api/v1"));
        assert_eq!(default_base_url("ollama"), Some("http://localhost:11434/v1"));
        assert_eq!(default_base_url("custom"), None);
        assert_eq!(
            base_url("custom", None).unwrap_err().to_string(),
            crate::ai::AI_NOT_CONFIGURED
        );
        assert_eq!(base_url("openai", Some("https://proxy/v1".into())).unwrap(), "https://proxy/v1");

        assert!(requires_key("openai") && requires_key("anthropic") && requires_key("gemini"));
        assert!(requires_key("deepseek") && requires_key("openrouter"));
        assert!(!requires_key("ollama") && !requires_key("custom"));
    }

    #[test]
    fn request_urls_append_only_the_endpoint() {
        for provider in ["openai", "gemini", "deepseek", "openrouter", "ollama"] {
            let base = default_base_url(provider).unwrap();
            assert_eq!(chat_completions_url(base), format!("{base}/chat/completions"));
            assert_eq!(models_url(provider, &format!("{base}/")), format!("{base}/models"));
        }
        assert_eq!(
            chat_completions_url("https://generativelanguage.googleapis.com/v1beta/openai/"),
            "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions"
        );
        assert_eq!(anthropic_messages_url("https://api.anthropic.com"), "https://api.anthropic.com/v1/messages");
        assert_eq!(anthropic_messages_url("https://api.anthropic.com/v1"), "https://api.anthropic.com/v1/messages");
        assert_eq!(models_url("anthropic", "https://api.anthropic.com/"), "https://api.anthropic.com/v1/models");
        assert_eq!(models_url("anthropic", "https://api.anthropic.com/v1/"), "https://api.anthropic.com/v1/models");
    }

    #[test]
    fn saved_base_urls_gain_v1_once() {
        assert_eq!(versioned_base_url("openai", "https://api.openai.com"), Some("https://api.openai.com/v1".into()));
        assert_eq!(versioned_base_url("openai", "https://api.openai.com/"), Some("https://api.openai.com/v1".into()));
        assert_eq!(versioned_base_url("ollama", "http://localhost:11434"), Some("http://localhost:11434/v1".into()));
        assert_eq!(versioned_base_url("ollama", "http://v1"), Some("http://v1/v1".into()));
        assert_eq!(versioned_base_url("openai", "https://proxy.example/openai"), Some("https://proxy.example/openai/v1".into()));
        assert_eq!(versioned_base_url("openai", "https://api.openai.com/v1"), None);
        assert_eq!(versioned_base_url("openai", "https://x/v1beta"), None);
        assert_eq!(versioned_base_url("openai", "https://x/v2/"), None);
        assert_eq!(versioned_base_url("openai", ""), None);
        assert_eq!(versioned_base_url("anthropic", "https://api.anthropic.com"), None);
        let once = versioned_base_url("openai", "https://api.openai.com").unwrap();
        assert_eq!(versioned_base_url("openai", &once), None, "a second run changes nothing");
    }

    #[test]
    fn migrate_saved_base_url_runs_once_and_preserves_later_user_edits() {
        let dir = tempfile::TempDir::new().unwrap();
        let db = Db::init(dir.path()).unwrap();
        {
            let conn = db.conn.lock().unwrap();
            conn.execute("INSERT INTO settings (key, value) VALUES ('ai_provider', 'openai')", []).unwrap();
            conn.execute("INSERT INTO settings (key, value) VALUES ('ai_base_url', 'https://api.openai.com')", []).unwrap();
        }
        migrate_saved_base_url(&db).unwrap();
        let migrated: String = db
            .reader()
            .query_row("SELECT value FROM settings WHERE key = 'ai_base_url'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(migrated, "https://api.openai.com/v1");

        // User later edits the URL to a custom path without /v1; a second
        // launch must leave it untouched.
        {
            let conn = db.conn.lock().unwrap();
            conn.execute("UPDATE settings SET value = 'https://proxy.internal/openai' WHERE key = 'ai_base_url'", []).unwrap();
        }
        migrate_saved_base_url(&db).unwrap();
        let after_second: String = db
            .reader()
            .query_row("SELECT value FROM settings WHERE key = 'ai_base_url'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(after_second, "https://proxy.internal/openai");
    }

    #[test]
    fn parses_model_listings() {
        let openai = serde_json::json!({"object": "list", "data": [{"id": "gpt-4o"}, {"id": "gpt-4o-mini"}, {"id": "gpt-4o"}]});
        assert_eq!(parse_model_ids(&openai), ["gpt-4o", "gpt-4o-mini"]);
        let gemini = serde_json::json!({"data": [{"id": "models/gemini-2.5-flash", "object": "model"}]});
        assert_eq!(parse_model_ids(&gemini), ["gemini-2.5-flash"]);
        let anthropic = serde_json::json!({"data": [{"id": "claude-sonnet-4-20250514", "display_name": "Claude Sonnet 4"}], "has_more": false});
        assert_eq!(parse_model_ids(&anthropic), ["claude-sonnet-4-20250514"]);
        assert!(parse_model_ids(&serde_json::json!({"error": "nope"})).is_empty());
    }

    /// A one-request HTTP server that records the request head and answers
    /// with `body` as an event stream or JSON.
    async fn mock(body: &'static str, content_type: &'static str) -> (String, Arc<Mutex<String>>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let seen = Arc::new(Mutex::new(String::new()));
        let record = Arc::clone(&seen);
        tokio::spawn(async move {
            if let Ok((mut stream, _)) = listener.accept().await {
                let mut buf = vec![0u8; 16384];
                let n = stream.read(&mut buf).await.unwrap_or(0);
                *record.lock().unwrap() = String::from_utf8_lossy(&buf[..n]).to_string();
                let resp = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = stream.write_all(resp.as_bytes()).await;
            }
        });
        (format!("http://{addr}"), seen)
    }

    struct NoHost;
    impl crate::host::ShellHost for NoHost {
        fn emit(&self, _e: &str, _p: serde_json::Value) {}
        fn emit_to(&self, _w: &str, _e: &str, _p: serde_json::Value) {}
        fn open_url(&self, _u: &str) -> AppResult<()> {
            Ok(())
        }
        fn reveal_path(&self, _p: &std::path::Path) -> AppResult<()> {
            Ok(())
        }
    }

    #[tokio::test]
    async fn each_preset_sends_its_url_and_auth_header() {
        const SSE: &str = "data: {\"choices\":[{\"delta\":{\"content\":\"ok\"}}]}\n\ndata: [DONE]\n\n";
        let messages = vec![ChatMessage { role: "user".into(), content: "hi".into() }];
        let host: &dyn crate::host::ShellHost = &NoHost;
        for (provider, path, key) in [
            ("openai", "/v1", "sk-openai"),
            ("gemini", "/v1beta/openai", "gm-key"),
            ("deepseek", "/v1", "ds-key"),
            ("openrouter", "/api/v1", "sk-or-key"),
            ("ollama", "/v1", ""),
            ("custom", "/serve/v1", ""),
        ] {
            let (origin, seen) = mock(SSE, "text/event-stream").await;
            let ka = (provider == "ollama").then_some("30m");
            crate::ai::openai_compat::stream_chat(host, &format!("{origin}{path}"), key, "m", 0.3, &messages, ka, "e", None)
                .await
                .unwrap();
            let head = seen.lock().unwrap().clone();
            assert!(head.starts_with(&format!("POST {path}/chat/completions HTTP/1.1")), "{provider}: {head}");
            let lower = head.to_lowercase();
            if key.is_empty() {
                assert!(!lower.contains("authorization:"), "{provider}: {head}");
            } else {
                assert!(lower.contains(&format!("authorization: bearer {key}")), "{provider}: {head}");
            }
            assert_eq!(head.contains("\"keep_alive\":\"30m\""), provider == "ollama", "{provider}");
        }

        let (origin, seen) = mock("data: {\"type\":\"message_stop\"}\n\n", "text/event-stream").await;
        crate::ai::anthropic::stream_chat(host, &origin, "sk-ant", "claude", 0.3, &messages, false, "e", None)
            .await
            .unwrap();
        let head = seen.lock().unwrap().to_lowercase();
        assert!(head.starts_with("post /v1/messages http/1.1"), "{head}");
        assert!(head.contains("x-api-key: sk-ant") && head.contains("anthropic-version: 2023-06-01"), "{head}");
    }

    #[tokio::test]
    async fn lists_models_with_each_auth_style() {
        let (origin, seen) = mock(r#"{"data":[{"id":"b"},{"id":"a"}]}"#, "application/json").await;
        let list = list_models("openrouter", &format!("{origin}/api/v1"), "sk-or").await.unwrap();
        assert_eq!(list.models, ["a", "b"]);
        let head = seen.lock().unwrap().to_lowercase();
        assert!(head.starts_with("get /api/v1/models http/1.1") && head.contains("authorization: bearer sk-or"), "{head}");

        let (origin, seen) = mock(r#"{"data":[{"id":"claude-x"}]}"#, "application/json").await;
        assert_eq!(list_models("anthropic", &origin, "sk-ant").await.unwrap().models, ["claude-x"]);
        let head = seen.lock().unwrap().to_lowercase();
        assert!(head.starts_with("get /v1/models http/1.1") && head.contains("x-api-key: sk-ant"), "{head}");

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        assert!(list_models("ollama", &format!("http://127.0.0.1:{port}/v1"), "").await.is_err());
    }
}
