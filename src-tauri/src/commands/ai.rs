use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};

use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::secrets::Secrets;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AiStreamChunk {
    pub delta: String,
    pub done: bool,
}

const LOOKUP_TRANSLATION_MARKER: &str = "[[QUILL_TRANSLATION]]";

fn language_name(code: &str) -> String {
    match code {
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
    let definition_language_prefix = if language != "en" {
        if should_show_translation {
            format!("After that first line, respond entirely in {}.\n\n", language_name(language))
        } else {
            format!("Respond entirely in {}.\n\n", language_name(language))
        }
    } else {
        String::new()
    };
    let context_language_prefix = if language != "en" {
        format!("Respond entirely in {}.\n\n", language_name(language))
    } else {
        String::new()
    };

    let def_prefix = format!("{translation_prefix}{definition_language_prefix}");
    let ctx_prefix = if language != "en" { &context_language_prefix } else { "" };

    match kind {
        "definition" => format!("{}You are a reading assistant embedded in an ebook reader. The user selected a word or phrase and wants a dictionary-style definition.\n\nGive: pronunciation in IPA (if English), part of speech, and a concise definition in 1–2 sentences.\n\nIf the selection is a proper noun (person, place, historical event), give a brief factual identification instead.\n\nBe concise. No headers or labels.", def_prefix),
        "context" => format!("{}You are a reading assistant embedded in an ebook reader. The user selected a word or phrase and wants to understand how it's used in the surrounding passage.\n\nExplain how the word is used in context. Consider the author's intent, tone, or any literary/idiomatic significance. Keep it to 2–3 sentences.\n\nBe concise. No headers or labels.", ctx_prefix),
        _ => format!("{}You are a reading assistant embedded in an ebook reader. The user selected a word or phrase and wants to understand it.\n\nRespond in two parts:\n\n1. **Definition** — Give a dictionary-style entry: the word, pronunciation in IPA (if it's an English word), part of speech, and a concise definition in one sentence.\n\n2. **In context** — Explain how the word is used in the given passage. Consider the author's intent, tone, or any literary/idiomatic significance. Keep it to 2–3 sentences.\n\nIf the selection is a proper noun (person, place, historical event), replace the dictionary definition with a brief factual identification, then explain its relevance in context.\n\nDo not use headers or labels like \"Definition:\" or \"In context:\". Separate the two parts with a line break. Be concise.", def_prefix),
    }
}

#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn ai_lookup(
    word: String,
    sentence: String,
    book_title: Option<String>,
    chapter: Option<String>,
    request_id: String,
    kind: Option<String>,
    app: AppHandle,
    db: State<'_, Db>,
    secrets: State<'_, Secrets>,
) -> AppResult<()> {
    // Read provider settings
    let (provider, model, base_url, keep_alive, auth_mode, language, lookup_translation_language, show_translation) = {
        let conn = db.reader();
        let get = |key: &str| -> Option<String> {
            conn.query_row(
                "SELECT value FROM settings WHERE key = ?1",
                rusqlite::params![key],
                |row| row.get(0),
            )
            .ok()
        };
        let sys_language = get("language").unwrap_or_else(|| "en".to_string());
        // lookup_language overrides system language for lookup prompts
        let lookup_language = get("lookup_language").unwrap_or(sys_language.clone());
        (
            get("ai_provider").unwrap_or_else(|| "ollama".to_string()),
            get("ai_model").unwrap_or_else(|| "llama3.2".to_string()),
            get("ai_base_url"),
            get("ai_keep_alive").unwrap_or_else(|| "30m".to_string()),
            get("ai_auth_mode").unwrap_or_else(|| "api_key".to_string()),
            lookup_language,
            get("lookup_translation_language").unwrap_or_default(),
            get("show_translation").unwrap_or_else(|| "false".to_string()),
        )
    };

    if show_translation == "true" && lookup_translation_language.trim().is_empty() {
        return Err(AppError::Other(
            "LOOKUP_TRANSLATION_LANGUAGE_NOT_CONFIGURED".to_string(),
        ));
    }

    // Read API key from secrets store
    let api_key = secrets.get("ai_api_key").unwrap_or_default();

    let (api_key, oauth_account_id) = if auth_mode == "oauth" && provider == "openai" {
        let (token, acct_id) = crate::ai::oauth::get_valid_token(&secrets).await?;
        (token, acct_id)
    } else {
        // Providers other than ollama require an API key
        if api_key.is_empty() && provider != "ollama" {
            log::warn!("ai_lookup: AI_NOT_CONFIGURED provider={provider}");
            return Err(AppError::Other("AI_NOT_CONFIGURED".to_string()));
        }
        (api_key, None)
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

    let event_name = format!("ai-lookup-chunk-{}", request_id);

    log::info!("ai_lookup: spawn provider={provider} model={model} kind={kind}");

    let use_responses_api = auth_mode == "oauth" && provider == "openai";
    let app_clone = app.clone();
    let log_provider = provider.clone();
    tauri::async_runtime::spawn(async move {
        let result = match provider.as_str() {
            "anthropic" => {
                let url = base_url.unwrap_or_else(|| "https://api.anthropic.com".to_string());
                crate::ai::anthropic::stream_chat(&app_clone, &url, &api_key, &model, 0.3, &messages, false, &event_name, max_tokens).await
            }
            _ if use_responses_api => {
                let url = "https://chatgpt.com/backend-api/codex".to_string();
                crate::ai::openai_responses::stream_chat(&app_clone, &url, &api_key, &model, &messages, oauth_account_id.as_deref(), &event_name).await
            }
            _ => {
                let url = base_url.unwrap_or_else(|| "http://localhost:11434".to_string());
                let ka = if provider == "ollama" { Some(keep_alive.clone()) } else { None };
                crate::ai::openai_compat::stream_chat(&app_clone, &url, &api_key, &model, 0.3, &messages, ka.as_deref(), &event_name, max_tokens).await
            }
        };
        if let Err(e) = result {
            log::error!("ai_lookup: provider={log_provider} streaming failed: {e}");
            let _ = app_clone.emit(&event_name, AiStreamChunk {
                delta: format!("Error: {}", e),
                done: false,
            });
            let _ = app_clone.emit(&event_name, AiStreamChunk {
                delta: String::new(),
                done: true,
            });
        }
    });

    Ok(())
}

/// Build the system prompt for sentence/passage explanation.
///
/// Brevity is enforced by the prompt itself (2–3 sentences, no preamble) —
/// deliberately no `max_tokens` cap, which would truncate mid-sentence.
/// Unlike `ai_lookup`, there is no translation-gloss branch: that is a
/// word-level concept and makes no sense for a whole passage. The only
/// language handling is the response-language directive.
fn explain_system_prompt(language: &str) -> String {
    let language_prefix = if language != "en" {
        let lang_name = match language {
            "zh" => "Chinese (Simplified)",
            other => other,
        };
        format!("Respond entirely in {}.\n\n", lang_name)
    } else {
        String::new()
    };

    format!(
        "{}You are a reading assistant embedded in an ebook reader. The user selected a sentence or passage and wants to understand it in context.\n\nIn 2–3 sentences, explain what it means and why it matters here — clarify any difficult phrasing, allusion, or tone. Be direct and concise. Do not restate the passage, add headers or labels, or pad with preamble. Plain prose only.",
        language_prefix
    )
}

#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn ai_explain(
    passage: String,
    surrounding: Option<String>,
    book_title: Option<String>,
    chapter: Option<String>,
    request_id: String,
    app: AppHandle,
    db: State<'_, Db>,
    secrets: State<'_, Secrets>,
) -> AppResult<()> {
    // Read provider settings
    let (provider, model, base_url, keep_alive, auth_mode, language) = {
        let conn = db.reader();
        let get = |key: &str| -> Option<String> {
            conn.query_row(
                "SELECT value FROM settings WHERE key = ?1",
                rusqlite::params![key],
                |row| row.get(0),
            )
            .ok()
        };
        let sys_language = get("language").unwrap_or_else(|| "en".to_string());
        // lookup_language overrides system language for reading-assistant prompts
        let lookup_language = get("lookup_language").unwrap_or(sys_language);
        (
            get("ai_provider").unwrap_or_else(|| "ollama".to_string()),
            get("ai_model").unwrap_or_else(|| "llama3.2".to_string()),
            get("ai_base_url"),
            get("ai_keep_alive").unwrap_or_else(|| "30m".to_string()),
            get("ai_auth_mode").unwrap_or_else(|| "api_key".to_string()),
            lookup_language,
        )
    };

    // Read API key from secrets store
    let api_key = secrets.get("ai_api_key").unwrap_or_default();

    let (api_key, oauth_account_id) = if auth_mode == "oauth" && provider == "openai" {
        let (token, acct_id) = crate::ai::oauth::get_valid_token(&secrets).await?;
        (token, acct_id)
    } else {
        if api_key.is_empty() && provider != "ollama" {
            log::warn!("ai_explain: AI_NOT_CONFIGURED provider={provider}");
            return Err(AppError::Other("AI_NOT_CONFIGURED".to_string()));
        }
        (api_key, None)
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

    let event_name = format!("ai-lookup-chunk-{}", request_id);

    log::info!("ai_explain: spawn provider={provider} model={model}");

    let use_responses_api = auth_mode == "oauth" && provider == "openai";
    let app_clone = app.clone();
    let log_provider = provider.clone();
    tauri::async_runtime::spawn(async move {
        let result = match provider.as_str() {
            "anthropic" => {
                let url = base_url.unwrap_or_else(|| "https://api.anthropic.com".to_string());
                crate::ai::anthropic::stream_chat(&app_clone, &url, &api_key, &model, 0.3, &messages, false, &event_name, None).await
            }
            _ if use_responses_api => {
                let url = "https://chatgpt.com/backend-api/codex".to_string();
                crate::ai::openai_responses::stream_chat(&app_clone, &url, &api_key, &model, &messages, oauth_account_id.as_deref(), &event_name).await
            }
            _ => {
                let url = base_url.unwrap_or_else(|| "http://localhost:11434".to_string());
                let ka = if provider == "ollama" { Some(keep_alive.clone()) } else { None };
                crate::ai::openai_compat::stream_chat(&app_clone, &url, &api_key, &model, 0.3, &messages, ka.as_deref(), &event_name, None).await
            }
        };
        if let Err(e) = result {
            log::error!("ai_explain: provider={log_provider} streaming failed: {e}");
            let _ = app_clone.emit(&event_name, AiStreamChunk {
                delta: format!("Error: {}", e),
                done: false,
            });
            let _ = app_clone.emit(&event_name, AiStreamChunk {
                delta: String::new(),
                done: true,
            });
        }
    });

    Ok(())
}

#[tauri::command]
pub async fn ai_generate_title(
    user_message: String,
    assistant_message: String,
    request_id: String,
    app: AppHandle,
    db: State<'_, Db>,
    secrets: State<'_, Secrets>,
) -> AppResult<()> {
    let (provider, model, base_url, keep_alive, auth_mode, language) = {
        let conn = db.reader();
        let get = |key: &str| -> Option<String> {
            conn.query_row(
                "SELECT value FROM settings WHERE key = ?1",
                rusqlite::params![key],
                |row| row.get(0),
            )
            .ok()
        };
        (
            get("ai_provider").unwrap_or_else(|| "ollama".to_string()),
            get("ai_model").unwrap_or_else(|| "llama3.2".to_string()),
            get("ai_base_url"),
            get("ai_keep_alive").unwrap_or_else(|| "30m".to_string()),
            get("ai_auth_mode").unwrap_or_else(|| "api_key".to_string()),
            get("language").unwrap_or_else(|| "en".to_string()),
        )
    };

    let api_key = secrets.get("ai_api_key").unwrap_or_default();
    let (api_key, oauth_account_id) = if auth_mode == "oauth" && provider == "openai" {
        let (token, acct_id) = crate::ai::oauth::get_valid_token(&secrets).await?;
        (token, acct_id)
    } else {
        (api_key, None)
    };

    let user_snippet = if user_message.len() > 200 { &user_message[..200] } else { &user_message };
    let ai_snippet = if assistant_message.len() > 200 { &assistant_message[..200] } else { &assistant_message };

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

    let event_name = format!("ai-title-chunk-{}", request_id);
    let use_responses_api = auth_mode == "oauth" && provider == "openai";
    let app_clone = app.clone();
    tauri::async_runtime::spawn(async move {
        let result = match provider.as_str() {
            "anthropic" => {
                let url = base_url.unwrap_or_else(|| "https://api.anthropic.com".to_string());
                crate::ai::anthropic::stream_chat(&app_clone, &url, &api_key, &model, 0.3, &messages, false, &event_name, Some(32)).await
            }
            _ if use_responses_api => {
                let url = "https://chatgpt.com/backend-api/codex".to_string();
                crate::ai::openai_responses::stream_chat(&app_clone, &url, &api_key, &model, &messages, oauth_account_id.as_deref(), &event_name).await
            }
            _ => {
                let url = base_url.unwrap_or_else(|| "http://localhost:11434".to_string());
                let ka = if provider == "ollama" { Some(keep_alive.clone()) } else { None };
                crate::ai::openai_compat::stream_chat(&app_clone, &url, &api_key, &model, 0.3, &messages, ka.as_deref(), &event_name, Some(32)).await
            }
        };
        if let Err(e) = result {
            let _ = app_clone.emit(&event_name, AiStreamChunk {
                delta: format!("Error: {}", e),
                done: false,
            });
            let _ = app_clone.emit(&event_name, AiStreamChunk {
                delta: String::new(),
                done: true,
            });
        }
    });

    Ok(())
}

#[tauri::command]
pub async fn ai_chat(
    messages: Vec<ChatMessage>,
    book_title: Option<String>,
    book_author: Option<String>,
    current_chapter: Option<String>,
    app: AppHandle,
    db: State<'_, Db>,
    secrets: State<'_, Secrets>,
) -> AppResult<()> {
    // Read provider settings
    let (provider, model, base_url, temperature, keep_alive, auth_mode, language) = {
        let conn = db.reader();
        let get = |key: &str| -> Option<String> {
            conn.query_row(
                "SELECT value FROM settings WHERE key = ?1",
                rusqlite::params![key],
                |row| row.get(0),
            )
            .ok()
        };
        (
            get("ai_provider").unwrap_or_else(|| "ollama".to_string()),
            get("ai_model").unwrap_or_else(|| "llama3.2".to_string()),
            get("ai_base_url"),
            get("ai_temperature")
                .and_then(|v| v.parse::<f64>().ok())
                .unwrap_or(0.3),
            get("ai_keep_alive").unwrap_or_else(|| "30m".to_string()),
            get("ai_auth_mode").unwrap_or_else(|| "api_key".to_string()),
            get("language").unwrap_or_else(|| "en".to_string()),
        )
    };

    // Read API key from secrets store
    let api_key = secrets.get("ai_api_key").unwrap_or_default();

    let (api_key, oauth_account_id) = if auth_mode == "oauth" && provider == "openai" {
        let (token, acct_id) = crate::ai::oauth::get_valid_token(&secrets).await?;
        (token, acct_id)
    } else {
        if api_key.is_empty() && provider != "ollama" {
            log::warn!("ai_chat: AI_NOT_CONFIGURED provider={provider}");
            return Err(AppError::Other("AI_NOT_CONFIGURED".to_string()));
        }
        (api_key, None)
    };

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

    log::info!("ai_chat: spawn provider={provider} model={model} kind=chat");

    // Spawn streaming in a background task so events emit immediately
    let use_responses_api = auth_mode == "oauth" && provider == "openai";
    let app_clone = app.clone();
    let log_provider = provider.clone();
    tauri::async_runtime::spawn(async move {
        let result = match provider.as_str() {
            "anthropic" => {
                let url = base_url.unwrap_or_else(|| "https://api.anthropic.com".to_string());
                crate::ai::anthropic::stream_chat(&app_clone, &url, &api_key, &model, temperature, &api_messages, false, "ai-stream-chunk", None).await
            }
            _ if use_responses_api => {
                let url = "https://chatgpt.com/backend-api/codex".to_string();
                crate::ai::openai_responses::stream_chat(&app_clone, &url, &api_key, &model, &api_messages, oauth_account_id.as_deref(), "ai-stream-chunk").await
            }
            _ => {
                let url = base_url.unwrap_or_else(|| "http://localhost:11434".to_string());
                let ka = if provider == "ollama" { Some(keep_alive.clone()) } else { None };
                crate::ai::openai_compat::stream_chat(&app_clone, &url, &api_key, &model, temperature, &api_messages, ka.as_deref(), "ai-stream-chunk", None).await
            }
        };
        if let Err(e) = result {
            log::error!("ai_chat: provider={log_provider} streaming failed: {e}");
            let _ = app_clone.emit("ai-stream-chunk", AiStreamChunk {
                delta: format!("Error: {}", e),
                done: false,
            });
            let _ = app_clone.emit("ai-stream-chunk", AiStreamChunk {
                delta: String::new(),
                done: true,
            });
        }
    });

    Ok(())
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
    fn explain_prompt_english_has_no_language_directive() {
        let p = explain_system_prompt("en");
        assert!(!p.contains("Respond entirely in"));
    }

    #[test]
    fn explain_prompt_non_english_prepends_response_language() {
        let zh = explain_system_prompt("zh");
        assert!(zh.starts_with("Respond entirely in Chinese (Simplified)."));

        let fr = explain_system_prompt("fr");
        assert!(fr.starts_with("Respond entirely in fr."));
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
        assert!(non_english_lookup.contains("English"));
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
}
