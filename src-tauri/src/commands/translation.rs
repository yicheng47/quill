use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};

use crate::commands::ai::{AiStreamChunk, ChatMessage};
use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::secrets::Secrets;
use crate::sync::events::{EventBody, TranslationPayload};
use crate::sync::writer::SyncWriter;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Translation {
    pub id: String,
    pub book_id: String,
    pub source_text: String,
    pub translated_text: String,
    pub target_language: String,
    pub cfi: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    pub book_title: Option<String>,
}

fn lang_display_name(code: &str) -> &str {
    match code {
        "en" => "English",
        "zh" => "Chinese (Simplified)",
        "ja" => "Japanese",
        "ko" => "Korean",
        "es" => "Spanish",
        "fr" => "French",
        "de" => "German",
        "pt" => "Portuguese",
        "ru" => "Russian",
        "ar" => "Arabic",
        "it" => "Italian",
        _ => code,
    }
}

/// Stream a translation from the AI provider. Does NOT persist — the frontend
/// calls `save_translation` explicitly when the user clicks Save.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn ai_translate_passage(
    text: String,
    context: Option<String>,
    #[allow(unused_variables)]
    book_id: String,
    target_language: Option<String>,
    request_id: String,
    app: AppHandle,
    db: State<'_, Db>,
    secrets: State<'_, Secrets>,
) -> AppResult<()> {
    // Read target language setting
    let (target_lang, provider, model, base_url, keep_alive, auth_mode) = {
        let conn = db.conn.lock().map_err(|e| AppError::Other(e.to_string()))?;
        let get = |key: &str| -> Option<String> {
            conn.query_row(
                "SELECT value FROM settings WHERE key = ?1",
                rusqlite::params![key],
                |row| row.get(0),
            )
            .ok()
        };
        let tl = target_language.unwrap_or_else(|| {
            get("native_language").unwrap_or_else(|| "en".to_string())
        });
        (
            tl,
            get("ai_provider").unwrap_or_else(|| "ollama".to_string()),
            get("ai_model").unwrap_or_else(|| "llama3.2".to_string()),
            get("ai_base_url"),
            get("ai_keep_alive").unwrap_or_else(|| "30m".to_string()),
            get("ai_auth_mode").unwrap_or_else(|| "api_key".to_string()),
        )
    };

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

    let target_name = lang_display_name(&target_lang);

    // Context-aware prompt: if selection is shorter than surrounding paragraph,
    // provide the paragraph as context but only translate the selection
    let has_context = context.as_ref().is_some_and(|c| c != &text && c.len() > text.len());
    let system_prompt = if has_context {
        format!(
            "You are a translator embedded in an ebook reader. The user selected a portion of text they want translated into {}.\n\n\
            Full paragraph for context:\n\"{}\"\n\n\
            Translate ONLY the selected portion below — not the full paragraph. Use the surrounding context to ensure accuracy of meaning, tone, and any pronouns or references.\n\n\
            Produce only the translation. No commentary, no labels, no original text.",
            target_name,
            context.as_deref().unwrap_or("")
        )
    } else {
        format!(
            "You are a translator embedded in an ebook reader. Translate the following passage into {}.\n\n\
            Produce only the translation. No commentary, no labels, no original text. Preserve paragraph structure and tone.",
            target_name
        )
    };

    let messages = vec![
        ChatMessage {
            role: "system".to_string(),
            content: system_prompt,
        },
        ChatMessage {
            role: "user".to_string(),
            content: text.clone(),
        },
    ];

    let event_name = format!("ai-translate-chunk-{}", request_id);
    let use_responses_api = auth_mode == "oauth" && provider == "openai";
    let app_clone = app.clone();

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

/// Persist a translation the user explicitly chose to save.
#[tauri::command]
pub fn save_translation(
    book_id: String,
    source_text: String,
    translated_text: String,
    target_language: String,
    cfi: Option<String>,
    db: State<'_, Db>,
    sync: State<'_, SyncWriter>,
) -> AppResult<String> {
    let id = uuid::Uuid::new_v4().to_string();
    let now = chrono::Utc::now().timestamp_millis();
    let id_for_return = id.clone();
    sync.with_tx(&db, |tx, events| {
        tx.execute(
            "INSERT INTO translations (id, book_id, source_text, translated_text, target_language, cfi, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)",
            rusqlite::params![id, book_id, source_text, translated_text, target_language, cfi, now],
        )?;
        events.push(EventBody::TranslationAdd(TranslationPayload {
            id: id.clone(),
            book_id: book_id.clone(),
            source_text: source_text.clone(),
            translated_text: translated_text.clone(),
            target_language: target_language.clone(),
            cfi: cfi.clone(),
        }));
        Ok(())
    })?;
    Ok(id_for_return)
}

#[tauri::command]
pub fn remove_saved_translation(
    id: String,
    db: State<'_, Db>,
    sync: State<'_, SyncWriter>,
) -> AppResult<()> {
    sync.with_tx(&db, |tx, events| {
        tx.execute(
            "DELETE FROM translations WHERE id = ?1",
            rusqlite::params![id],
        )?;
        events.push(EventBody::TranslationDelete { id: id.clone() });
        Ok(())
    })
}

#[tauri::command]
pub fn list_translations(
    book_id: Option<String>,
    db: State<'_, Db>,
) -> AppResult<Vec<Translation>> {
    let conn = db.conn.lock().map_err(|e| AppError::Other(e.to_string()))?;

    let mut sql = "SELECT t.id, t.book_id, t.source_text, t.translated_text, t.target_language, t.cfi, t.created_at, t.updated_at, b.title FROM translations t LEFT JOIN books b ON t.book_id = b.id".to_string();
    let mut params: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();

    if let Some(ref bid) = book_id {
        sql.push_str(" WHERE t.book_id = ?1");
        params.push(Box::new(bid.clone()));
    }
    sql.push_str(" ORDER BY t.created_at DESC");

    let mut stmt = conn.prepare(&sql)?;
    let param_refs: Vec<&dyn rusqlite::types::ToSql> = params.iter().map(|p| p.as_ref()).collect();

    let rows = stmt.query_map(param_refs.as_slice(), |row| {
        Ok(Translation {
            id: row.get(0)?,
            book_id: row.get(1)?,
            source_text: row.get(2)?,
            translated_text: row.get(3)?,
            target_language: row.get(4)?,
            cfi: row.get(5)?,
            created_at: row.get(6)?,
            updated_at: row.get(7)?,
            book_title: row.get(8)?,
        })
    })?;

    let translations: Vec<Translation> = rows.filter_map(|r| r.ok()).collect();
    Ok(translations)
}
