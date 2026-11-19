use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use crate::ai::codex::TurnSpec;
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
    /// The chat this call continues, so an agent can keep its thread.
    pub chat_id: Option<String>,
}

/// Streams running over a direct API connection, by event channel, so a
/// cancelled stream stops its request.
#[derive(Default)]
pub struct ApiStreams(Mutex<HashMap<String, tokio::task::AbortHandle>>);

struct ApiConnection {
    provider: String,
    model: String,
    base_url: Option<String>,
    keep_alive: String,
    auth_mode: String,
    temperature: f64,
    effort: Option<String>,
}

struct AgentConnection {
    codex_path: Option<String>,
    model: Option<String>,
    effort: Option<String>,
}

enum Connection {
    Agent(AgentConnection),
    Api(ApiConnection),
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
    let auth_mode = get("ai_auth_mode").unwrap_or_else(|| "api_key".to_string());
    if auth_mode == "codex" {
        return Ok(Connection::Agent(AgentConnection {
            codex_path: non_empty_setting(get("ai_codex_path")),
            model: non_empty_setting(get("ai_model")),
            effort: effort_from_setting(get(effort_tier_key(call))),
        }));
    }
    Ok(Connection::Api(ApiConnection {
        provider: configured_ai_provider(get("ai_provider"))?,
        model: get("ai_model").unwrap_or_else(|| "llama3.2".to_string()),
        base_url: non_empty_setting(get("ai_base_url")),
        keep_alive: get("ai_keep_alive").unwrap_or_else(|| "30m".to_string()),
        auth_mode,
        temperature: get("ai_temperature")
            .and_then(|v| v.parse::<f64>().ok())
            .unwrap_or(0.3),
        effort: effort_from_setting(get(effort_tier_key(call))),
    }))
}

/// Read the saved connection, check it can be used, then stream the reply
/// into `request.event_name` from a background task. Configuration and
/// auth failures return before anything is spawned.
pub async fn start(core: &Arc<Core>, request: AiRequest) -> AppResult<()> {
    match load_connection(core, request.call)? {
        Connection::Agent(agent) => start_agent(core, agent, request).await,
        Connection::Api(api) => {
            if let Some(chat_id) = &request.chat_id {
                core.codex.forget_chat(chat_id);
            }
            start_api(core, api, request).await
        }
    }
}

/// Stop the stream on `event_name`, whichever connection serves it.
pub async fn cancel(core: &Core, event_name: &str) {
    if let Some(handle) = core.api_streams.0.lock().unwrap().remove(event_name) {
        handle.abort();
    }
    core.codex.interrupt(event_name).await;
}

async fn start_agent(core: &Arc<Core>, agent: AgentConnection, request: AiRequest) -> AppResult<()> {
    let (system, messages): (Vec<ChatMessage>, Vec<ChatMessage>) =
        request.messages.into_iter().partition(|m| m.role == "system");
    let system = system.into_iter().map(|m| m.content).collect::<Vec<_>>().join("\n\n");
    log::info!("ai_{}: spawn connection=codex", request.call);
    core.codex
        .start_turn(
            Arc::clone(&core.host),
            agent.codex_path,
            TurnSpec {
                system,
                messages,
                chat_id: request.chat_id,
                model_setting: agent.model,
                effort_setting: agent.effort,
                event_name: request.event_name,
            },
        )
        .await
}

async fn start_api(core: &Arc<Core>, connection: ApiConnection, request: AiRequest) -> AppResult<()> {
    let (api_key, oauth_account_id) =
        resolve_ai_auth(core, &connection.provider, &connection.auth_mode).await?;

    log::info!(
        "ai_{}: spawn provider={} model={}",
        request.call,
        connection.provider,
        connection.model
    );

    let event_name = request.event_name.clone();
    let task_core = Arc::clone(core);
    // Hold the map while spawning so a task that finishes at once cannot
    // remove its entry before it is inserted.
    let mut streams = core.api_streams.0.lock().unwrap();
    let task = tokio::spawn(async move {
        let core = task_core;
        let AiRequest {
            call,
            messages,
            event_name,
            max_tokens,
            temperature,
            ..
        } = request;
        let ApiConnection {
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
        core.api_streams.0.lock().unwrap().remove(&event_name);
    });
    streams.insert(event_name, task.abort_handle());

    Ok(())
}
