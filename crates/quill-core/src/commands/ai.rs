use std::sync::Arc;

use serde::{Deserialize, Serialize};

use crate::ai::dispatch::AiRequest;
use crate::ai::AI_NOT_CONFIGURED;
use crate::error::{AppError, AppResult};
use crate::host::{Core, ShellHost};

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AiStreamChunk {
    pub delta: String,
    pub done: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl AiStreamChunk {
    pub fn delta(delta: impl Into<String>) -> Self {
        Self {
            delta: delta.into(),
            done: false,
            error: None,
        }
    }

    pub fn done() -> Self {
        Self {
            delta: String::new(),
            done: true,
            error: None,
        }
    }

    pub fn error(error: impl Into<String>) -> Self {
        Self {
            delta: String::new(),
            done: true,
            error: Some(error.into()),
        }
    }
}

const LOOKUP_TRANSLATION_MARKER: &str = "[[QUILL_TRANSLATION]]";

/// Effort-tier setting key governing each AI entry point (spec 294):
/// quick = lookup + title generation, deep = chat + explain + translate.
pub(crate) fn effort_tier_key(call: &str) -> &'static str {
    match call {
        "lookup" | "generate_title" => "ai_effort_quick",
        _ => "ai_effort_deep",
    }
}

/// Map a stored effort setting to a request value. Missing key, empty
/// string, or "default" is the inherit-server-default sentinel → `None`,
/// which keeps the `reasoning` key out of the request body entirely.
pub(crate) fn effort_from_setting(value: Option<String>) -> Option<String> {
    value.filter(|v| !v.is_empty() && v != "default")
}

fn codex_path_override(core: &Core) -> Option<String> {
    non_empty_setting(
        core.db
            .reader()
            .query_row("SELECT value FROM settings WHERE key = 'ai_codex_path'", [], |row| row.get(0))
            .ok(),
    )
}

pub async fn codex_status(core: &Core) -> AppResult<crate::ai::codex::CodexStatus> {
    Ok(core.codex.status(codex_path_override(core)).await)
}

pub async fn list_codex_models(core: &Core) -> AppResult<crate::ai::codex::CodexModelList> {
    core.codex.models(codex_path_override(core)).await
}

pub async fn codex_login(core: &Core) -> AppResult<crate::ai::codex::LoginOutcome> {
    core.codex.login(core.host.as_ref(), codex_path_override(core)).await
}

pub async fn codex_login_cancel(core: &Core) -> AppResult<()> {
    core.codex.cancel_login().await
}

pub async fn ai_cancel(core: &Core, channel: String) -> AppResult<()> {
    crate::ai::dispatch::cancel(core, &channel).await;
    Ok(())
}

pub async fn check_ollama_status(
    core: &Core,
    base_url: Option<String>,
) -> AppResult<crate::ai::ollama::OllamaStatus> {
    let configured_url = match base_url {
        Some(draft) => non_empty_setting(Some(draft)),
        None => {
            let conn = core.db.reader();
            let saved_provider: Option<String> = conn
                .query_row("SELECT value FROM settings WHERE key = 'ai_provider'", [], |row| row.get(0))
                .ok();
            if saved_provider.as_deref() == Some("ollama") {
                non_empty_setting(
                    conn.query_row("SELECT value FROM settings WHERE key = 'ai_base_url'", [], |row| row.get(0))
                        .ok(),
                )
            } else {
                None
            }
        }
    }
    .unwrap_or_else(|| crate::ai::api::default_base_url("ollama").unwrap_or_default().to_string());
    Ok(crate::ai::ollama::check_ollama_status(&configured_url).await)
}

/// Only reuse the stored API key when the caller omitted a draft key AND the
/// listing targets the exact saved provider and origin; an explicit draft key
/// authorizes whatever provider/URL the caller passed.
fn resolve_list_models_api_key(
    core: &Core,
    provider: &str,
    target_url: &str,
    draft_key: Option<String>,
    saved_provider: Option<&str>,
    saved_base_url: Option<String>,
) -> String {
    if provider == "ollama" {
        return String::new();
    }
    if let Some(draft) = draft_key {
        return draft;
    }
    let Some(saved_prov) = saved_provider else {
        return String::new();
    };
    if saved_prov != provider {
        return String::new();
    }
    let Ok(saved_effective_url) = crate::ai::api::base_url(saved_prov, saved_base_url) else {
        return String::new();
    };
    if !crate::ai::api::same_origin(target_url, &saved_effective_url) {
        return String::new();
    }
    core.secrets
        .get_api_key_for_endpoint(provider, target_url)
        .unwrap_or_default()
}

/// List a service's models for the model picker. Unsaved drafts from the
/// settings screen take precedence over the saved values.
pub async fn list_api_models(
    core: &Core,
    provider: String,
    base_url: Option<String>,
    api_key: Option<String>,
) -> AppResult<crate::ai::api::ApiModelList> {
    let (saved_provider, saved_base_url) = {
        let conn = core.db.reader();
        let mut stmt = conn.prepare(
            "SELECT key, value FROM settings WHERE key IN ('ai_provider', 'ai_base_url')",
        )?;
        let mut saved_provider: Option<String> = None;
        let mut saved_base_url: Option<String> = None;
        let rows = stmt.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?;
        for row in rows {
            let (k, v) = row?;
            match k.as_str() {
                "ai_provider" => saved_provider = Some(v),
                "ai_base_url" => saved_base_url = Some(v),
                _ => {}
            }
        }
        (non_empty_setting(saved_provider), non_empty_setting(saved_base_url))
    };
    let url_override = match base_url {
        Some(draft) => non_empty_setting(Some(draft)),
        None if saved_provider.as_deref() == Some(provider.as_str()) => saved_base_url.clone(),
        None => None,
    };
    let url = crate::ai::api::base_url(&provider, url_override)?;
    let key = resolve_list_models_api_key(
        core,
        &provider,
        &url,
        api_key,
        saved_provider.as_deref(),
        saved_base_url,
    );
    crate::ai::api::list_models(&provider, &url, key.trim()).await
}

fn truncate_at_char_boundary(text: &str, max_bytes: usize) -> &str {
    if text.len() <= max_bytes {
        return text;
    }
    let mut end = max_bytes;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    &text[..end]
}

fn ui_language(core: &Core) -> String {
    core.db
        .reader()
        .query_row("SELECT value FROM settings WHERE key = 'language'", [], |row| row.get(0))
        .unwrap_or_else(|_| "en".to_string())
}

pub(crate) fn non_empty_setting(value: Option<String>) -> Option<String> {
    value
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

pub(crate) fn configured_ai_provider(value: Option<String>) -> AppResult<String> {
    non_empty_setting(value).ok_or_else(|| AppError::Other(AI_NOT_CONFIGURED.to_string()))
}

pub(crate) fn resolve_api_key(core: &Core, provider: &str, url: &str) -> AppResult<String> {
    let api_key = if provider == "ollama" {
        String::new()
    } else {
        core.secrets
            .get_api_key_for_endpoint(provider, url)
            .unwrap_or_default()
    };
    if api_key.is_empty() && crate::ai::api::requires_key(provider) {
        log::warn!("ai_auth: AI_NOT_CONFIGURED provider={provider}");
        return Err(AppError::Other(AI_NOT_CONFIGURED.to_string()));
    }
    Ok(api_key)
}

pub(crate) fn stream_error_delta(err: &AppError) -> String {
    if crate::ai::is_ai_sentinel(err) {
        err.to_string()
    } else {
        format!("Error: {}", err)
    }
}

pub(crate) fn emit_stream_error(host: &dyn ShellHost, event_name: &str, err: &AppError) {
    host.emit_json(event_name, &AiStreamChunk::error(stream_error_delta(err)));
}

/// Sentinel `lookup_language` value: respond in whatever language the
/// selection is in, rather than a pinned target language.
const LOOKUP_LANGUAGE_SELECTION: &str = "selection";

fn language_name(code: &str) -> String {
    match code {
        "en" => "English",
        "zh" => "Chinese (Simplified)",
        "ja" => "Japanese",
        "ko" => "Korean",
        "es" => "Spanish",
        "fr" => "French",
        "de" => "German",
        _ => code,
    }
    .to_string()
}

/// The "respond in X" clause for the main definition/context output. For the
/// `selection` sentinel this instructs the model to mirror the selection's
/// language; otherwise it resolves to a concrete language name.
fn main_language_clause(language: &str) -> String {
    if language == LOOKUP_LANGUAGE_SELECTION {
        "the same language as the selected word/phrase".to_string()
    } else {
        language_name(language)
    }
}

fn lookup_system_prompt(
    kind: &str,
    language: &str,
    lookup_translation_language: &str,
    show_translation: bool,
) -> String {
    let should_show_translation = show_translation
        && !lookup_translation_language.is_empty()
        && lookup_translation_language != language;
    let translation_prefix = if should_show_translation {
        format!(
            "Before the definition, provide a brief translation of the word/phrase in {}. The first line MUST be exactly `{}` followed immediately by the brief translation, then a newline. This marker is required machine-readable metadata, not a header. Keep the translation to a few words — no explanation, just the meaning. After that first line, proceed with the definition as usual. Do not put the marker anywhere except the first line.\n\n",
            language_name(lookup_translation_language),
            LOOKUP_TRANSLATION_MARKER,
        )
    } else {
        String::new()
    };
    let clause = main_language_clause(language);
    let definition_language_prefix = if should_show_translation {
        format!("After that first line, respond entirely in {}.\n\n", clause)
    } else {
        format!("Respond entirely in {}.\n\n", clause)
    };
    let context_language_prefix = format!("Respond entirely in {}.\n\n", clause);

    let def_prefix = format!("{translation_prefix}{definition_language_prefix}");
    let ctx_prefix = &context_language_prefix;

    match kind {
        "definition" => format!("{}You are a reading assistant embedded in an ebook reader. The user selected a word or phrase and wants a dictionary-style definition.\n\nGive: pronunciation in IPA (if English), part of speech, and a concise definition in 1–2 sentences.\n\nIf the selection is a proper noun (person, place, historical event), give a brief factual identification instead.\n\nBe concise. No headers or labels.", def_prefix),
        "context" => format!("{}You are a reading assistant embedded in an ebook reader. The user selected a word or phrase and wants to understand how it's used in the surrounding passage.\n\nExplain how the word is used in context. Consider the author's intent, tone, or any literary/idiomatic significance. Keep it to 2–3 sentences.\n\nBe concise. No headers or labels.", ctx_prefix),
        _ => format!("{}You are a reading assistant embedded in an ebook reader. The user selected a word or phrase and wants to understand it.\n\nRespond in two parts:\n\n1. **Definition** — Give a dictionary-style entry: the word, pronunciation in IPA (if it's an English word), part of speech, and a concise definition in one sentence.\n\n2. **In context** — Explain how the word is used in the given passage. Consider the author's intent, tone, or any literary/idiomatic significance. Keep it to 2–3 sentences.\n\nIf the selection is a proper noun (person, place, historical event), replace the dictionary definition with a brief factual identification, then explain its relevance in context.\n\nDo not use headers or labels like \"Definition:\" or \"In context:\". Separate the two parts with a line break. Be concise.", def_prefix),
    }
}

#[allow(clippy::too_many_arguments)]
pub async fn ai_lookup(
    core: Arc<Core>,
    word: String,
    sentence: String,
    book_title: Option<String>,
    chapter: Option<String>,
    request_id: String,
    kind: Option<String>,
) -> AppResult<()> {
    let (language, lookup_translation_language, show_translation) = {
        let conn = core.db.reader();
        let get = |key: &str| -> Option<String> {
            conn.query_row(
                "SELECT value FROM settings WHERE key = ?1",
                rusqlite::params![key],
                |row| row.get(0),
            )
            .ok()
        };
        let sys_language = get("language").unwrap_or_else(|| "en".to_string());
        // lookup_language drives the main definition/context language; unset
        // falls back to the selection's own language.
        let lookup_language =
            get("lookup_language").unwrap_or_else(|| LOOKUP_LANGUAGE_SELECTION.to_string());
        let lookup_translation_language = get("lookup_translation_language")
            .map(|lang| lang.trim().to_string())
            .filter(|lang| !lang.is_empty())
            .unwrap_or_else(|| sys_language.clone());
        (
            lookup_language,
            lookup_translation_language,
            get("show_translation").unwrap_or_else(|| "false".to_string()),
        )
    };

    let mut user_content = format!("Word/phrase: \"{}\"\nSurrounding text: \"{}\"", word, sentence);
    if let Some(ref title) = book_title {
        user_content.push_str(&format!("\nBook: \"{}\"", title));
    }
    if let Some(ref ch) = chapter {
        user_content.push_str(&format!("\nChapter: \"{}\"", ch));
    }

    let kind = kind.unwrap_or_else(|| "full".to_string());

    let system_prompt = lookup_system_prompt(
        kind.as_str(),
        &language,
        lookup_translation_language.trim(),
        show_translation == "true",
    );

    let max_tokens = match kind.as_str() {
        "definition" => Some(128),
        "context" => Some(192),
        _ => Some(256),
    };

    let messages = vec![
        ChatMessage {
            role: "system".to_string(),
            content: system_prompt,
        },
        ChatMessage {
            role: "user".to_string(),
            content: user_content,
        },
    ];

    crate::ai::dispatch::start(
        &core,
        AiRequest {
            call: "lookup",
            messages,
            event_name: format!("ai-lookup-chunk-{}", request_id),
            max_tokens,
            temperature: Some(0.3),
            chat_id: None,
        },
    )
    .await
}

/// Build the system prompt for sentence/passage explanation.
///
/// Brevity is enforced by the prompt itself (2–3 sentences, no preamble) —
/// deliberately no `max_tokens` cap, which would truncate mid-sentence.
/// Unlike `ai_lookup`, there is no translation-gloss branch: that is a
/// word-level concept and makes no sense for a whole passage. The only
/// language handling is the response-language directive.
fn explain_system_prompt(language: &str) -> String {
    let target = if language == LOOKUP_LANGUAGE_SELECTION {
        "the same language as the selected passage".to_string()
    } else {
        language_name(language)
    };
    let language_prefix = format!("Respond entirely in {}.\n\n", target);

    format!(
        "{}You are a reading assistant embedded in an ebook reader. The user selected a sentence or passage and wants to understand it in context.\n\nIn 2–3 sentences, explain what it means and why it matters here — clarify any difficult phrasing, allusion, or tone. Be direct and concise. Do not restate the passage, add headers or labels, or pad with preamble. Plain prose only.",
        language_prefix
    )
}

pub async fn ai_explain(
    core: Arc<Core>,
    passage: String,
    surrounding: Option<String>,
    book_title: Option<String>,
    chapter: Option<String>,
    request_id: String,
) -> AppResult<()> {
    let language = {
        let conn = core.db.reader();
        let get = |key: &str| -> Option<String> {
            conn.query_row(
                "SELECT value FROM settings WHERE key = ?1",
                rusqlite::params![key],
                |row| row.get(0),
            )
            .ok()
        };
        let lookup_language =
            get("lookup_language").unwrap_or_else(|| LOOKUP_LANGUAGE_SELECTION.to_string());
        let explain_language = get("explain_language")
            .map(|lang| lang.trim().to_string())
            .filter(|lang| !lang.is_empty());
        match explain_language.as_deref() {
            Some("lookup") | None => lookup_language,
            Some(lang) => lang.to_string(),
        }
    };

    let mut user_content = format!("Passage: \"{}\"", passage);
    if let Some(ref ctx) = surrounding {
        if !ctx.is_empty() && ctx != &passage {
            user_content.push_str(&format!("\nSurrounding text: \"{}\"", ctx));
        }
    }
    if let Some(ref title) = book_title {
        user_content.push_str(&format!("\nBook: \"{}\"", title));
    }
    if let Some(ref ch) = chapter {
        user_content.push_str(&format!("\nChapter: \"{}\"", ch));
    }

    let messages = vec![
        ChatMessage {
            role: "system".to_string(),
            content: explain_system_prompt(&language),
        },
        ChatMessage {
            role: "user".to_string(),
            content: user_content,
        },
    ];

    crate::ai::dispatch::start(
        &core,
        AiRequest {
            call: "explain",
            messages,
            event_name: format!("ai-lookup-chunk-{}", request_id),
            max_tokens: None,
            temperature: Some(0.3),
            chat_id: None,
        },
    )
    .await
}

pub async fn ai_generate_title(
    core: Arc<Core>,
    user_message: String,
    assistant_message: String,
    request_id: String,
) -> AppResult<()> {
    let language = ui_language(&core);

    let user_snippet = truncate_at_char_boundary(&user_message, 200);
    let ai_snippet = truncate_at_char_boundary(&assistant_message, 200);

    let title_lang_hint = if language == "zh" { " Generate the title in Chinese." } else { "" };

    let messages = vec![
        ChatMessage {
            role: "system".to_string(),
            content: format!("Generate a very short title (3-6 words) for the following chat exchange.{} Respond with ONLY the title, no quotes, no punctuation at the end.", title_lang_hint),
        },
        ChatMessage {
            role: "user".to_string(),
            content: format!("User: {}\nAssistant: {}", user_snippet, ai_snippet),
        },
    ];

    crate::ai::dispatch::start(
        &core,
        AiRequest {
            call: "generate_title",
            messages,
            event_name: format!("ai-title-chunk-{}", request_id),
            max_tokens: Some(32),
            temperature: Some(0.3),
            chat_id: None,
        },
    )
    .await
}

pub async fn ai_chat(
    core: Arc<Core>,
    chat_id: Option<String>,
    messages: Vec<ChatMessage>,
    book_title: Option<String>,
    book_author: Option<String>,
    current_chapter: Option<String>,
    request_id: Option<String>,
) -> AppResult<()> {
    let language = ui_language(&core);

    // Build messages: system prompt + conversation history (context is inlined by frontend)
    let mut system_content = "You are a helpful reading assistant. Help the user understand and discuss the book they are reading.".to_string();
    if let Some(ref title) = book_title {
        system_content.push_str(&format!("\n\nThe user is currently reading \"{}\"", title));
        if let Some(ref author) = book_author {
            system_content.push_str(&format!(" by {}", author));
        }
        system_content.push('.');
        if let Some(ref chapter) = current_chapter {
            system_content.push_str(&format!(" They are on: {}.", chapter));
        }
    }
    if language == "zh" {
        system_content.push_str(" Always respond in Chinese (Simplified).");
    }

    let mut api_messages = Vec::new();
    api_messages.push(ChatMessage {
        role: "system".to_string(),
        content: system_content,
    });
    api_messages.extend(messages);

    let event_name = match request_id.as_deref().map(str::trim).filter(|id| !id.is_empty()) {
        Some(id) => format!("ai-stream-chunk-{id}"),
        None => "ai-stream-chunk".to_string(),
    };

    crate::ai::dispatch::start(
        &core,
        AiRequest {
            call: "chat",
            messages: api_messages,
            event_name,
            max_tokens: None,
            temperature: None,
            chat_id,
        },
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn explain_prompt_asks_for_brevity_and_no_headers() {
        let p = explain_system_prompt("en");
        assert!(p.contains("2–3 sentences"), "must request a short answer");
        assert!(p.contains("headers or labels"), "must forbid headers/labels");
        assert!(p.contains("in context"), "must be context-aware");
    }

    #[test]
    fn explain_prompt_english_emits_english_directive() {
        let p = explain_system_prompt("en");
        assert!(p.contains("Respond entirely in English."));
    }

    #[test]
    fn explain_prompt_non_english_prepends_response_language() {
        let zh = explain_system_prompt("zh");
        assert!(zh.starts_with("Respond entirely in Chinese (Simplified)."));

        let fr = explain_system_prompt("fr");
        assert!(fr.starts_with("Respond entirely in French."));
    }

    #[test]
    fn explain_selection_uses_source_language() {
        let p = explain_system_prompt("selection");
        assert!(p.contains("the same language as the selected passage"));
    }

    #[test]
    fn explain_prompt_never_has_translation_gloss() {
        // The word-level "brief translation of the word/phrase" preamble from
        // ai_lookup must not leak into the passage-level explain prompt.
        for lang in ["en", "zh", "fr"] {
            let p = explain_system_prompt(lang);
            assert!(
                !p.to_lowercase().contains("translation of the"),
                "explain must not carry ai_lookup's word-gloss logic (lang={lang})"
            );
        }
    }

    #[test]
    fn lookup_definition_prompt_marks_translation_when_target_differs() {
        let p = lookup_system_prompt("definition", "en", "zh", true);
        assert!(p.contains(LOOKUP_TRANSLATION_MARKER));
        assert!(p.contains("Chinese (Simplified)"));

        let non_english_lookup = lookup_system_prompt("definition", "zh", "en", true);
        assert!(non_english_lookup.contains(LOOKUP_TRANSLATION_MARKER));
        assert!(non_english_lookup
            .contains("brief translation of the word/phrase in English"));
        assert!(non_english_lookup
            .contains("After that first line, respond entirely in Chinese (Simplified)."));

        let same_language = lookup_system_prompt("definition", "en", "en", true);
        assert!(!same_language.contains(LOOKUP_TRANSLATION_MARKER));

        let disabled = lookup_system_prompt("definition", "en", "zh", false);
        assert!(!disabled.contains(LOOKUP_TRANSLATION_MARKER));
    }

    #[test]
    fn lookup_context_prompt_never_marks_english_translation() {
        let p = lookup_system_prompt("context", "en", "zh", true);
        assert!(!p.contains(LOOKUP_TRANSLATION_MARKER));
        assert!(!p.to_lowercase().contains("brief translation"));
    }

    #[test]
    fn lookup_prompt_uses_lookup_language_names() {
        let zh = lookup_system_prompt("definition", "zh", "en", true);
        assert!(zh.contains("respond entirely in Chinese (Simplified)."));
    }

    #[test]
    fn lookup_english_emits_explicit_english_directive() {
        let p = lookup_system_prompt("definition", "en", "", false);
        assert!(p.contains("Respond entirely in English."));
    }

    #[test]
    fn lookup_selection_uses_source_language() {
        let p = lookup_system_prompt("definition", "selection", "", false);
        assert!(p.contains("the same language as the selected word/phrase"));
        assert!(!p.contains("Respond entirely in selection."));
    }

    #[test]
    fn lookup_selection_allows_gloss() {
        let p = lookup_system_prompt("definition", "selection", "en", true);
        assert!(p.contains(LOOKUP_TRANSLATION_MARKER));
        assert!(p.contains(
            "After that first line, respond entirely in the same language as the selected word/phrase."
        ));
    }

    #[test]
    fn effort_tier_mapping_matches_spec() {
        // Quick tier: lookup + title generation
        assert_eq!(effort_tier_key("lookup"), "ai_effort_quick");
        assert_eq!(effort_tier_key("generate_title"), "ai_effort_quick");
        // Deep tier: chat + explain + translate
        assert_eq!(effort_tier_key("chat"), "ai_effort_deep");
        assert_eq!(effort_tier_key("explain"), "ai_effort_deep");
        assert_eq!(effort_tier_key("translate"), "ai_effort_deep");
    }

    #[test]
    fn effort_setting_sentinel_yields_none() {
        assert_eq!(effort_from_setting(None), None);
        assert_eq!(effort_from_setting(Some(String::new())), None);
        assert_eq!(effort_from_setting(Some("default".to_string())), None);
        assert_eq!(
            effort_from_setting(Some("xhigh".to_string())),
            Some("xhigh".to_string())
        );
    }

    #[test]
    fn stream_error_delta_emits_bare_sentinels_and_prefixes_generic_errors() {
        assert_eq!(
            stream_error_delta(&AppError::Other(crate::ai::codex::CODEX_NOT_SIGNED_IN.to_string())),
            "CODEX_NOT_SIGNED_IN"
        );
        assert_eq!(
            stream_error_delta(&AppError::Other(crate::ai::AI_NOT_CONFIGURED.to_string())),
            "AI_NOT_CONFIGURED"
        );
        assert_eq!(
            stream_error_delta(&AppError::Ai("API error 403 Forbidden: denied".to_string())),
            "Error: AI error: API error 403 Forbidden: denied"
        );
    }

    #[test]
    fn emit_stream_error_sends_terminal_error_chunk_separate_from_deltas() {
        use std::sync::Mutex;
        struct RecordingHost(Mutex<Vec<(String, serde_json::Value)>>);
        impl ShellHost for RecordingHost {
            fn emit(&self, event: &str, payload: serde_json::Value) {
                self.0.lock().unwrap().push((event.to_string(), payload));
            }
            fn emit_to(&self, _w: &str, _e: &str, _p: serde_json::Value) {}
            fn open_url(&self, _u: &str) -> AppResult<()> {
                Ok(())
            }
            fn reveal_path(&self, _p: &std::path::Path) -> AppResult<()> {
                Ok(())
            }
        }

        let host = RecordingHost(Mutex::new(Vec::new()));
        emit_stream_error(
            &host,
            "ai-lookup-chunk-1",
            &AppError::Other(crate::ai::codex::CODEX_NOT_SIGNED_IN.to_string()),
        );
        let events = host.0.lock().unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(
            events[0],
            (
                "ai-lookup-chunk-1".to_string(),
                serde_json::json!({"delta": "", "done": true, "error": "CODEX_NOT_SIGNED_IN"})
            )
        );
    }

    #[test]
    fn truncate_at_char_boundary_never_splits_a_character() {
        assert_eq!(truncate_at_char_boundary("hello", 200), "hello");
        let chinese = "读".repeat(67);
        assert_eq!(chinese.len(), 201);
        assert_eq!(truncate_at_char_boundary(&chinese, 200), "读".repeat(66));
        assert_eq!(truncate_at_char_boundary(&"a".repeat(201), 200), "a".repeat(200));
    }

    #[test]
    fn non_empty_setting_ignores_blank_strings() {
        assert_eq!(non_empty_setting(None), None);
        assert_eq!(non_empty_setting(Some("".to_string())), None);
        assert_eq!(non_empty_setting(Some("   ".to_string())), None);
        assert_eq!(
            non_empty_setting(Some("  https://proxy.example  ".to_string())),
            Some("https://proxy.example".to_string())
        );
    }

    #[test]
    fn configured_ai_provider_requires_non_empty_setting() {
        assert_eq!(
            configured_ai_provider(None).unwrap_err().to_string(),
            AI_NOT_CONFIGURED
        );
        assert_eq!(
            configured_ai_provider(Some("  ".to_string())).unwrap_err().to_string(),
            AI_NOT_CONFIGURED
        );
        assert_eq!(
            configured_ai_provider(Some(" ollama ".to_string())).unwrap(),
            "ollama"
        );
    }
}
