use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use crate::ai::codex::TurnSpec;
use crate::commands::ai::{
    configured_ai_provider, emit_stream_error, non_empty_setting, resolve_api_key, setting_choice,
    AiFeature, ChatMessage,
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
    temperature: f64,
}

struct AgentConnection {
    codex_path: Option<String>,
    model: Option<String>,
    legacy_model: Option<String>,
    default_family: &'static str,
    effort: Option<String>,
    legacy_effort: Option<String>,
    default_effort: &'static str,
}

enum Connection {
    Agent(AgentConnection),
    Api(ApiConnection),
}

fn load_connection(core: &Core, call: &str) -> AppResult<Connection> {
    let map: HashMap<String, String> = {
        let conn = core.db.reader();
        let mut stmt = conn.prepare("SELECT key, value FROM settings WHERE key LIKE 'ai_%'")?;
        let rows = stmt
            .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))?
            .collect::<Result<HashMap<_, _>, _>>()?;
        rows
    };
    let get = |key: &str| -> Option<String> { map.get(key).cloned() };
    let auth_mode = get("ai_auth_mode").unwrap_or_else(|| "api_key".to_string());
    if auth_mode == "codex" {
        let feature = AiFeature::from_call(call);
        let legacy_effort = setting_choice(get(feature.legacy_effort_key())).or_else(|| {
            feature
                .legacy_effort_fallback_key()
                .and_then(|key| setting_choice(get(key)))
        });
        return Ok(Connection::Agent(AgentConnection {
            codex_path: non_empty_setting(get("ai_codex_path")),
            model: setting_choice(get(feature.model_key())),
            legacy_model: setting_choice(get("ai_model")),
            default_family: feature.default_family(),
            effort: setting_choice(get(feature.effort_key())),
            legacy_effort,
            default_effort: feature.default_effort(),
        }));
    }
    Ok(Connection::Api(ApiConnection {
        provider: configured_ai_provider(get("ai_provider"))?,
        model: get("ai_model").unwrap_or_else(|| "llama3.2".to_string()),
        base_url: non_empty_setting(get("ai_base_url")),
        keep_alive: get("ai_keep_alive").unwrap_or_else(|| "30m".to_string()),
        temperature: get("ai_temperature")
            .and_then(|v| v.parse::<f64>().ok())
            .unwrap_or(0.3),
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
                legacy_model_setting: agent.legacy_model,
                default_family: Some(agent.default_family),
                effort_setting: agent.effort,
                legacy_effort_setting: agent.legacy_effort,
                default_effort: Some(agent.default_effort),
                event_name: request.event_name,
            },
        )
        .await
}

async fn start_api(core: &Arc<Core>, connection: ApiConnection, request: AiRequest) -> AppResult<()> {
    let url = crate::ai::api::base_url(&connection.provider, connection.base_url.clone())?;
    let api_key = resolve_api_key(core, &connection.provider, &url)?;

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
            keep_alive,
            temperature: saved_temperature,
            ..
        } = connection;
        let temperature = temperature.unwrap_or(saved_temperature);
        let host = core.host.as_ref();
        let result = match provider.as_str() {
            "anthropic" => {
                crate::ai::anthropic::stream_chat(host, &url, &api_key, &model, temperature, &messages, false, &event_name, max_tokens).await
            }
            _ => {
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::host::{boot, BootConfig, ShellHost};
    use std::path::Path;
    use tempfile::TempDir;

    struct NoopHost;
    impl ShellHost for NoopHost {
        fn emit(&self, _event: &str, _payload: serde_json::Value) {}
        fn emit_to(&self, _window: &str, _event: &str, _payload: serde_json::Value) {}
        fn open_url(&self, _url: &str) -> AppResult<()> {
            Ok(())
        }
        fn reveal_path(&self, _path: &Path) -> AppResult<()> {
            Ok(())
        }
    }

    fn test_core(settings: &[(&str, &str)]) -> (TempDir, Arc<Core>) {
        let dir = TempDir::new().unwrap();
        let config = BootConfig {
            app_data_base_dir: dir.path().join("appdata"),
            log_dir: dir.path().join("logs"),
            is_dev: true,
            mcp_binary_path: dir.path().join("quill-mcp"),
            pdfium_path: None,
            dict_path: None,
        };
        let core = boot(config, Arc::new(NoopHost)).unwrap();
        {
            let conn = core.db.conn.lock().unwrap();
            for (k, v) in settings {
                conn.execute(
                    "INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = ?2",
                    rusqlite::params![k, v],
                )
                .unwrap();
            }
        }
        (dir, core)
    }

    #[test]
    fn load_connection_reads_per_feature_and_legacy_codex_settings_per_call() {
        let (_dir, core) = test_core(&[
            ("ai_auth_mode", "codex"),
            ("ai_model", "gpt-5.6-sol"),
            ("ai_effort_quick", "medium"),
            ("ai_effort_deep", "xhigh"),
            ("ai_codex_model_lookup", "gpt-6-luna"),
            ("ai_codex_effort_lookup", "low"),
            ("ai_codex_model_explain", "default"),
            ("ai_codex_effort_explain", ""),
            ("ai_codex_model_chat", "gpt-6.2-sol"),
            ("ai_codex_effort_chat", "high"),
            ("ai_codex_model_translate", "gpt-6.1-terra"),
            ("ai_codex_effort_translate", "default"),
        ]);

        let expect_agent = |call: &str| match load_connection(&core, call).unwrap() {
            Connection::Agent(a) => a,
            Connection::Api(_) => panic!("expected Agent for {call}"),
        };

        let lookup = expect_agent("lookup");
        assert_eq!(lookup.model.as_deref(), Some("gpt-6-luna"));
        assert_eq!(lookup.legacy_model.as_deref(), Some("gpt-5.6-sol"));
        assert_eq!(lookup.default_family, "luna");
        assert_eq!(lookup.effort.as_deref(), Some("low"));
        assert_eq!(lookup.legacy_effort.as_deref(), Some("medium"));
        assert_eq!(lookup.default_effort, "low");

        // generate_title shares Look up's keys, legacy tier and defaults.
        let title = expect_agent("generate_title");
        assert_eq!(title.model, lookup.model);
        assert_eq!(title.legacy_model, lookup.legacy_model);
        assert_eq!(title.default_family, "luna");
        assert_eq!(title.effort, lookup.effort);
        assert_eq!(title.legacy_effort.as_deref(), Some("medium"));
        assert_eq!(title.default_effort, "low");

        // Empty / "default" per-feature settings yield None while legacy keys stay available.
        let explain = expect_agent("explain");
        assert_eq!(explain.model, None);
        assert_eq!(explain.legacy_model.as_deref(), Some("gpt-5.6-sol"));
        assert_eq!(explain.default_family, "terra");
        assert_eq!(explain.effort, None);
        assert_eq!(explain.legacy_effort.as_deref(), Some("xhigh"));
        assert_eq!(explain.default_effort, "high");

        let chat = expect_agent("chat");
        assert_eq!(chat.model.as_deref(), Some("gpt-6.2-sol"));
        assert_eq!(chat.default_family, "sol");
        assert_eq!(chat.effort.as_deref(), Some("high"));
        assert_eq!(chat.legacy_effort.as_deref(), Some("xhigh"));
        assert_eq!(chat.default_effort, "high");

        let translate = expect_agent("translate");
        assert_eq!(translate.model.as_deref(), Some("gpt-6.1-terra"));
        assert_eq!(translate.default_family, "terra");
        assert_eq!(translate.effort, None);
        assert_eq!(translate.legacy_effort.as_deref(), Some("xhigh"));
        assert_eq!(translate.default_effort, "medium");
    }

    #[test]
    fn sibling_default_reset_preserves_legacy_effort_fallback_for_unsupported_saved_effort() {
        use crate::ai::codex::{resolve_model_and_effort, CodexModel, ModelResolutionInput};
        use crate::commands::settings::set_setting;

        let catalog = vec![
            CodexModel {
                slug: "gpt-6-luna".into(),
                display_name: "GPT-6 Luna".into(),
                description: String::new(),
                supported_reasoning_levels: vec!["medium".into(), "high".into()],
                default_reasoning_level: "medium".into(),
                is_default: false,
            },
            CodexModel {
                slug: "gpt-6.1-terra".into(),
                display_name: "GPT-6.1 Terra".into(),
                description: String::new(),
                supported_reasoning_levels: vec![
                    "low".into(),
                    "medium".into(),
                    "high".into(),
                    "xhigh".into(),
                ],
                default_reasoning_level: "medium".into(),
                is_default: false,
            },
            CodexModel {
                slug: "gpt-6.2-sol".into(),
                display_name: "GPT-6.2 Sol".into(),
                description: String::new(),
                supported_reasoning_levels: vec!["low".into(), "medium".into(), "high".into()],
                default_reasoning_level: "high".into(),
                is_default: true,
            },
        ];

        let resolve_call = |core: &Core, call: &str| match load_connection(core, call).unwrap() {
            Connection::Agent(a) => resolve_model_and_effort(
                &catalog,
                &ModelResolutionInput {
                    feature_model: a.model.as_deref(),
                    legacy_model: a.legacy_model.as_deref(),
                    default_family: Some(a.default_family),
                    feature_effort: a.effort.as_deref(),
                    legacy_effort: a.legacy_effort.as_deref(),
                    default_effort: Some(a.default_effort),
                },
            ),
            Connection::Api(_) => panic!("expected Agent for {call}"),
        };

        // Scenario (b): Chat saved on Luna with xhigh (unsupported by Luna) while legacy deep=medium.
        let (_dir, core) = test_core(&[
            ("ai_auth_mode", "codex"),
            ("ai_codex_model_chat", "gpt-6-luna"),
            ("ai_codex_effort_chat", "xhigh"),
            ("ai_effort_deep", "medium"),
        ]);

        assert_eq!(resolve_call(&core, "chat"), ("gpt-6-luna".into(), "medium".into()));
        assert_eq!(resolve_call(&core, "explain"), ("gpt-6.1-terra".into(), "medium".into()));
        assert_eq!(resolve_call(&core, "translate"), ("gpt-6.1-terra".into(), "medium".into()));

        // Reset Explain reasoning to Default.
        set_setting(&core, "ai_codex_effort_explain".into(), "".into()).unwrap();

        // Explain resets to its feature default (high), while untouched Translate AND untouched Chat
        // both keep effective effort medium.
        assert_eq!(resolve_call(&core, "explain"), ("gpt-6.1-terra".into(), "high".into()));
        assert_eq!(resolve_call(&core, "translate"), ("gpt-6.1-terra".into(), "medium".into()));
        assert_eq!(resolve_call(&core, "chat"), ("gpt-6-luna".into(), "medium".into()));

        // If Chat's model changes back to Terra (which supports xhigh), its saved xhigh still works
        // unless it was overwritten; then explicit Default reasoning on Chat resets Chat to high.
        set_setting(&core, "ai_codex_model_chat".into(), "gpt-6.1-terra".into()).unwrap();
        assert_eq!(resolve_call(&core, "chat"), ("gpt-6.1-terra".into(), "xhigh".into()));

        set_setting(&core, "ai_codex_model_chat".into(), "gpt-6-luna".into()).unwrap();
        assert_eq!(resolve_call(&core, "chat"), ("gpt-6-luna".into(), "medium".into()));

        set_setting(&core, "ai_codex_effort_chat".into(), "".into()).unwrap();
        assert_eq!(resolve_call(&core, "chat"), ("gpt-6-luna".into(), "high".into()));
        assert_eq!(resolve_call(&core, "translate"), ("gpt-6.1-terra".into(), "medium".into()));

        // Scenario (a): Chat on Terra/xhigh with legacy deep=medium; model-only switch to Luna
        // writes only ai_codex_model_chat, preserves supported legacy medium on Luna, restores xhigh
        // on Terra -> Luna -> Terra, and never retires deep for siblings.
        let (_dir2, core2) = test_core(&[
            ("ai_auth_mode", "codex"),
            ("ai_codex_model_chat", "gpt-6.1-terra"),
            ("ai_codex_effort_chat", "xhigh"),
            ("ai_effort_deep", "medium"),
        ]);
        set_setting(&core2, "ai_codex_model_chat".into(), "gpt-6-luna".into()).unwrap();
        assert_eq!(resolve_call(&core2, "chat"), ("gpt-6-luna".into(), "medium".into()));
        assert_eq!(resolve_call(&core2, "explain"), ("gpt-6.1-terra".into(), "medium".into()));
        assert_eq!(resolve_call(&core2, "translate"), ("gpt-6.1-terra".into(), "medium".into()));

        // Switching straight back to Terra restores the saved xhigh choice.
        set_setting(&core2, "ai_codex_model_chat".into(), "gpt-6.1-terra".into()).unwrap();
        assert_eq!(resolve_call(&core2, "chat"), ("gpt-6.1-terra".into(), "xhigh".into()));

        // Back on Luna, explicit Default reasoning on Chat resets Chat to high while siblings keep medium.
        set_setting(&core2, "ai_codex_model_chat".into(), "gpt-6-luna".into()).unwrap();
        set_setting(&core2, "ai_codex_effort_chat".into(), "".into()).unwrap();
        assert_eq!(resolve_call(&core2, "chat"), ("gpt-6-luna".into(), "high".into()));
        assert_eq!(resolve_call(&core2, "explain"), ("gpt-6.1-terra".into(), "medium".into()));
        assert_eq!(resolve_call(&core2, "translate"), ("gpt-6.1-terra".into(), "medium".into()));
    }
}
