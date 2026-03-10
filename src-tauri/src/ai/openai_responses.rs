use futures::StreamExt;
use tauri::{AppHandle, Emitter};

use crate::commands::ai::{AiStreamChunk, ChatMessage};
use crate::error::{AppError, AppResult};

/// Stream chat using OpenAI's Responses API (`/responses`).
/// When using OAuth tokens, requests go to `chatgpt.com/backend-api/codex`
/// with the `chatgpt-account-id` header (same as Codex CLI).
///
/// Request format matches `ResponsesApiRequest` from the Codex CLI source:
///   model, instructions, input, tools, tool_choice, parallel_tool_calls,
///   store, stream — no temperature, no max_output_tokens.
pub async fn stream_chat(
    app: &AppHandle,
    base_url: &str,
    api_key: &str,
    model: &str,
    messages: &[ChatMessage],
    account_id: Option<&str>,
    event_name: &str,
) -> AppResult<()> {
    let client = reqwest::Client::new();
    let url = format!("{}/responses", base_url.trim_end_matches('/'));

    // Responses API uses top-level "instructions" for system messages,
    // and "input" for user/assistant messages only.
    let instructions: String = messages
        .iter()
        .filter(|m| m.role == "system")
        .map(|m| m.content.as_str())
        .collect::<Vec<_>>()
        .join("\n\n");

    let input: Vec<serde_json::Value> = messages
        .iter()
        .filter(|m| m.role != "system")
        .map(|m| {
            serde_json::json!({
                "role": m.role,
                "content": m.content,
            })
        })
        .collect();

    let body = serde_json::json!({
        "model": model,
        "instructions": instructions,
        "input": input,
        "stream": true,
        "store": false,
    });

    let mut request = client.post(&url).bearer_auth(api_key).json(&body);
    if let Some(acct) = account_id {
        request = request.header("chatgpt-account-id", acct);
    }

    let response = request
        .send()
        .await
        .map_err(|e| AppError::Ai(e.to_string()))?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(AppError::Ai(format!("API error {}: {}", status, body)));
    }

    let mut stream = response.bytes_stream();
    let mut buffer = String::new();

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| AppError::Ai(e.to_string()))?;
        buffer.push_str(&String::from_utf8_lossy(&chunk));

        while let Some(line_end) = buffer.find('\n') {
            let line = buffer[..line_end].trim().to_string();
            buffer = buffer[line_end + 1..].to_string();

            if let Some(data) = line.strip_prefix("data: ") {
                if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(data) {
                    let event_type = parsed["type"].as_str().unwrap_or("");
                    match event_type {
                        "response.output_text.delta" => {
                            if let Some(delta) = parsed["delta"].as_str() {
                                let _ = app.emit(
                                    event_name,
                                    AiStreamChunk {
                                        delta: delta.to_string(),
                                        done: false,
                                    },
                                );
                            }
                        }
                        "response.completed" => {
                            let _ = app.emit(
                                event_name,
                                AiStreamChunk {
                                    delta: String::new(),
                                    done: true,
                                },
                            );
                            return Ok(());
                        }
                        _ => {}
                    }
                }
            }
        }
    }

    let _ = app.emit(
        event_name,
        AiStreamChunk {
            delta: String::new(),
            done: true,
        },
    );

    Ok(())
}
