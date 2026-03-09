use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};

use crate::db::Db;
use crate::error::{AppError, AppResult};

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

#[tauri::command]
pub async fn ai_quick_explain(
    word: String,
    sentence: String,
    book_title: Option<String>,
    chapter: Option<String>,
    app: AppHandle,
    db: State<'_, Db>,
) -> AppResult<()> {
    // Read provider settings
    let (provider, api_key, model, base_url, keep_alive, auth_mode) = {
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
            get("ai_api_key").unwrap_or_default(),
            get("ai_model").unwrap_or_else(|| "llama3.2".to_string()),
            get("ai_base_url"),
            get("ai_keep_alive").unwrap_or_else(|| "30m".to_string()),
            get("ai_auth_mode").unwrap_or_else(|| "api_key".to_string()),
        )
    };

    let (api_key, oauth_account_id) = if auth_mode == "oauth" && provider == "openai" {
        let (token, acct_id) = crate::ai::oauth::get_valid_token(&db).await?;
        (token, acct_id)
    } else {
        (api_key, None)
    };

    let mut user_content = format!("Word/phrase: \"{}\"\nSurrounding text: \"{}\"", word, sentence);
    if let Some(ref title) = book_title {
        user_content.push_str(&format!("\nBook: \"{}\"", title));
    }
    if let Some(ref ch) = chapter {
        user_content.push_str(&format!("\nChapter: \"{}\"", ch));
    }

    let messages = vec![
        ChatMessage {
            role: "system".to_string(),
            content: "You are a reading assistant. The user selected a word or phrase from a book and wants a brief explanation. Explain the meaning in 2-3 sentences, considering the context of the surrounding text and the book. If it's a literary device, idiom, or domain-specific term, note that. Be concise.".to_string(),
        },
        ChatMessage {
            role: "user".to_string(),
            content: user_content,
        },
    ];

    let event_name = "ai-quick-explain-chunk";

    let use_responses_api = auth_mode == "oauth" && provider == "openai";
    let app_clone = app.clone();
    tauri::async_runtime::spawn(async move {
        let result = match provider.as_str() {
            "anthropic" => {
                let url = base_url.unwrap_or_else(|| "https://api.anthropic.com".to_string());
                crate::ai::anthropic::stream_chat(&app_clone, &url, &api_key, &model, 0.3, &messages, false, event_name, Some(256)).await
            }
            "minimax" => {
                let url = base_url.unwrap_or_else(|| "https://api.minimax.io/anthropic".to_string());
                crate::ai::anthropic::stream_chat(&app_clone, &url, &api_key, &model, 0.3, &messages, true, event_name, Some(256)).await
            }
            _ if use_responses_api => {
                let url = "https://chatgpt.com/backend-api/codex".to_string();
                crate::ai::openai_responses::stream_chat(&app_clone, &url, &api_key, &model, &messages, oauth_account_id.as_deref(), event_name).await
            }
            _ => {
                let url = base_url.unwrap_or_else(|| "http://localhost:11434".to_string());
                let ka = if provider == "ollama" { Some(keep_alive.clone()) } else { None };
                crate::ai::openai_compat::stream_chat(&app_clone, &url, &api_key, &model, 0.3, &messages, ka.as_deref(), event_name, Some(256)).await
            }
        };
        if let Err(e) = result {
            let _ = app_clone.emit(event_name, AiStreamChunk {
                delta: format!("Error: {}", e),
                done: false,
            });
            let _ = app_clone.emit(event_name, AiStreamChunk {
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
    context: Option<String>,
    app: AppHandle,
    db: State<'_, Db>,
) -> AppResult<()> {
    // Read provider settings
    let (provider, api_key, model, base_url, temperature, keep_alive, auth_mode) = {
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
            get("ai_api_key").unwrap_or_default(),
            get("ai_model").unwrap_or_else(|| "llama3.2".to_string()),
            get("ai_base_url"),
            get("ai_temperature")
                .and_then(|v| v.parse::<f64>().ok())
                .unwrap_or(0.3),
            get("ai_keep_alive").unwrap_or_else(|| "30m".to_string()),
            get("ai_auth_mode").unwrap_or_else(|| "api_key".to_string()),
        )
    };

    let (api_key, oauth_account_id) = if auth_mode == "oauth" && provider == "openai" {
        let (token, acct_id) = crate::ai::oauth::get_valid_token(&db).await?;
        (token, acct_id)
    } else {
        (api_key, None)
    };

    // Build messages with optional context
    let mut api_messages = Vec::new();
    api_messages.push(ChatMessage {
        role: "system".to_string(),
        content: "You are a helpful reading assistant. Help the user understand and discuss the book they are reading.".to_string(),
    });
    if let Some(ctx) = context {
        api_messages.push(ChatMessage {
            role: "system".to_string(),
            content: format!("The user has selected the following text from the book:\n\n{}", ctx),
        });
    }
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
