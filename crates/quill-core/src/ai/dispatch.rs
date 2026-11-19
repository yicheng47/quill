use std::sync::Arc;

use crate::commands::ai::{
    configured_ai_provider, effort_from_setting, effort_tier_key, emit_stream_error,
    non_empty_setting, resolve_ai_auth, ChatMessage,
};
use crate::error::AppResult;
use crate::host::Core;

/// One AI call from a Quill entry point (lookup, explain, title, chat,
/// translate), independent of which connection serves it.
pub struct AiRequest {
    /// Entry point name; selects the effort tier and labels the logs.
    pub call: &'static str,
    pub messages: Vec<ChatMessage>,
    pub event_name: String,
    pub max_tokens: Option<u32>,
    /// `None` uses the saved `ai_temperature`.
    pub temperature: Option<f64>,
}

struct Connection {
    provider: String,
    model: String,
    base_url: Option<String>,
    keep_alive: String,
    auth_mode: String,
    temperature: f64,
    effort: Option<String>,
}

fn load_connection(core: &Core, call: &str) -> AppResult<Connection> {
    let conn = core.db.reader();
    let get = |key: &str| -> Option<String> {
        conn.query_row(
            "SELECT value FROM settings WHERE key = ?1",
            rusqlite::params![key],
            |row| row.get(0),
        )
        .ok()
    };
    Ok(Connection {
        provider: configured_ai_provider(get("ai_provider"))?,
        model: get("ai_model").unwrap_or_else(|| "llama3.2".to_string()),
        base_url: non_empty_setting(get("ai_base_url")),
        keep_alive: get("ai_keep_alive").unwrap_or_else(|| "30m".to_string()),
        auth_mode: get("ai_auth_mode").unwrap_or_else(|| "api_key".to_string()),
        temperature: get("ai_temperature")
            .and_then(|v| v.parse::<f64>().ok())
            .unwrap_or(0.3),
        effort: effort_from_setting(get(effort_tier_key(call))),
    })
}

/// Read the saved connection, check it can be used, then stream the reply
/// into `request.event_name` from a background task. Configuration and
/// auth failures return before anything is spawned.
pub async fn start(core: &Arc<Core>, request: AiRequest) -> AppResult<()> {
    let connection = load_connection(core, request.call)?;
    let (api_key, oauth_account_id) =
        resolve_ai_auth(core, &connection.provider, &connection.auth_mode).await?;

    log::info!(
        "ai_{}: spawn provider={} model={}",
        request.call,
        connection.provider,
        connection.model
    );

    let core = Arc::clone(core);
    tokio::spawn(async move {
        let AiRequest {
            call,
            messages,
            event_name,
            max_tokens,
            temperature,
        } = request;
        let Connection {
            provider,
            model,
            base_url,
            keep_alive,
            auth_mode,
            temperature: saved_temperature,
            effort,
        } = connection;
        let temperature = temperature.unwrap_or(saved_temperature);
        let host = core.host.as_ref();
        let result = match provider.as_str() {
            "anthropic" => {
                let url = base_url.unwrap_or_else(|| "https://api.anthropic.com".to_string());
                crate::ai::anthropic::stream_chat(host, &url, &api_key, &model, temperature, &messages, false, &event_name, max_tokens).await
            }
            "openai" if auth_mode == "oauth" => {
                let url = "https://chatgpt.com/backend-api/codex".to_string();
                crate::ai::openai_responses::stream_chat(host, &core.secrets, &url, &api_key, &model, &messages, oauth_account_id.as_deref(), effort.as_deref(), &event_name).await
            }
            _ => {
                let default_url = if provider == "ollama" { "http://localhost:11434" } else { "https://api.openai.com" };
                let url = base_url.unwrap_or_else(|| default_url.to_string());
                let ka = if provider == "ollama" { Some(keep_alive.as_str()) } else { None };
                crate::ai::openai_compat::stream_chat(host, &url, &api_key, &model, temperature, &messages, ka, &event_name, max_tokens).await
            }
        };
        if let Err(e) = result {
            log::error!("ai_{call}: provider={provider} streaming failed: {e}");
            emit_stream_error(host, &event_name, &e);
        }
    });

    Ok(())
}
