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
    let (provider, model, base_url, keep_alive, auth_mode, language, native_language, show_translation) = {
        let conn = db.conn.lock().map_err(|e| AppError::Other(e.to_string()))?;
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
            get("native_language").unwrap_or_else(|| "en".to_string()),
            get("show_translation").unwrap_or_else(|| "false".to_string()),
        )
    };

    // Read API key from secrets store
    let api_key = secrets.get("ai_api_key").unwrap_or_default();

    let (api_key, oauth_account_id) = if auth_mode == "oauth" && provider == "openai" {
        let (token, acct_id) = crate::ai::oauth::get_valid_token(&secrets).await?;
        (token, acct_id)
    } else {
        // Providers other than ollama require an API key
        if api_key.is_empty() && provider != "ollama" {
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

    // Language-aware lookup:
    // 1. When system language is non-English, respond entirely in that language
    // 2. When system language is English but translation is enabled, prepend a native translation
    let language_prefix = if language != "en" {
        let lang_name = match language.as_str() {
            "zh" => "Chinese (Simplified)",
            _ => &language,
        };
        format!("Respond entirely in {}.\n\n", lang_name)
    } else if show_translation == "true" && native_language != "en" {
        let lang_name = match native_language.as_str() {
            "zh" => "Chinese (Simplified)",
            _ => "the user's language",
        };
        format!(
            "Before the definition, provide a brief translation of the word/phrase in {}. Keep the translation to a few words — no explanation, just the meaning. Then proceed with the definition as usual.\n\n",
            lang_name
        )
    } else {
        String::new()
    };

    // Only apply translation prefix to definition, not context
    let def_prefix = &language_prefix;
    let ctx_prefix = if language != "en" { &language_prefix } else { "" };

    let system_prompt = match kind.as_str() {
        "definition" => format!("{}You are a reading assistant embedded in an ebook reader. The user selected a word or phrase and wants a dictionary-style definition.\n\nGive: pronunciation in IPA (if English), part of speech, and a concise definition in 1–2 sentences.\n\nIf the selection is a proper noun (person, place, historical event), give a brief factual identification instead.\n\nBe concise. No headers or labels.", def_prefix),
        "context" => format!("{}You are a reading assistant embedded in an ebook reader. The user selected a word or phrase and wants to understand how it's used in the surrounding passage.\n\nExplain how the word is used in context. Consider the author's intent, tone, or any literary/idiomatic significance. Keep it to 2–3 sentences.\n\nBe concise. No headers or labels.", ctx_prefix),
        _ => format!("{}You are a reading assistant embedded in an ebook reader. The user selected a word or phrase and wants to understand it.\n\nRespond in two parts:\n\n1. **Definition** — Give a dictionary-style entry: the word, pronunciation in IPA (if it's an English word), part of speech, and a concise definition in one sentence.\n\n2. **In context** — Explain how the word is used in the given passage. Consider the author's intent, tone, or any literary/idiomatic significance. Keep it to 2–3 sentences.\n\nIf the selection is a proper noun (person, place, historical event), replace the dictionary definition with a brief factual identification, then explain its relevance in context.\n\nDo not use headers or labels like \"Definition:\" or \"In context:\". Separate the two parts with a line break. Be concise.", def_prefix),
    };

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

    let use_responses_api = auth_mode == "oauth" && provider == "openai";
    let app_clone = app.clone();
    tauri::async_runtime::spawn(async move {
        let result = match provider.as_str() {
            "anthropic" => {
                let url = base_url.unwrap_or_else(|| "https://api.anthropic.com".to_string());
                crate::ai::anthropic::stream_chat(&app_clone, &url, &api_key, &model, 0.3, &messages, false, &event_name, max_tokens).await
            }
            "minimax" => {
                let url = base_url.unwrap_or_else(|| "https://api.minimax.io/anthropic".to_string());
                crate::ai::anthropic::stream_chat(&app_clone, &url, &api_key, &model, 0.3, &messages, true, &event_name, max_tokens).await
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
        let conn = db.conn.lock().map_err(|e| AppError::Other(e.to_string()))?;
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
            "minimax" => {
                let url = base_url.unwrap_or_else(|| "https://api.minimax.io/anthropic".to_string());
                crate::ai::anthropic::stream_chat(&app_clone, &url, &api_key, &model, 0.3, &messages, true, &event_name, Some(32)).await
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
        let conn = db.conn.lock().map_err(|e| AppError::Other(e.to_string()))?;
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

    // Spawn streaming in a background task so events emit immediately
    let use_responses_api = auth_mode == "oauth" && provider == "openai";
    let app_clone = app.clone();
    tauri::async_runtime::spawn(async move {
        let result = match provider.as_str() {
            "anthropic" => {
                let url = base_url.unwrap_or_else(|| "https://api.anthropic.com".to_string());
                crate::ai::anthropic::stream_chat(&app_clone, &url, &api_key, &model, temperature, &api_messages, false, "ai-stream-chunk", None).await
            }
            "minimax" => {
                let url = base_url.unwrap_or_else(|| "https://api.minimax.io/anthropic".to_string());
                crate::ai::anthropic::stream_chat(&app_clone, &url, &api_key, &model, temperature, &api_messages, true, "ai-stream-chunk", None).await
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
