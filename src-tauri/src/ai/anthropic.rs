use futures::StreamExt;
use tauri::{AppHandle, Emitter};

use crate::commands::ai::{AiStreamChunk, ChatMessage};
use crate::error::{AppError, AppResult};

pub async fn stream_chat(
    app: &AppHandle,
    api_key: &str,
    model: &str,
    temperature: f64,
    messages: &[ChatMessage],
) -> AppResult<()> {
    let client = reqwest::Client::new();

    // Anthropic uses a separate system parameter
    let system_msg = messages
        .iter()
        .filter(|m| m.role == "system")
        .map(|m| m.content.clone())
        .collect::<Vec<_>>()
        .join("\n\n");

    let api_messages: Vec<serde_json::Value> = messages
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
        "max_tokens": 4096,
        "system": system_msg,
        "messages": api_messages,
        "temperature": temperature,
        "stream": true,
    });

    let response = client
        .post("https://api.anthropic.com/v1/messages")
        .header("x-api-key", api_key)
        .header("anthropic-version", "2023-06-01")
        .header("content-type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| AppError::Ai(e.to_string()))?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(AppError::Ai(format!("Anthropic API error {}: {}", status, body)));
    }

    let mut stream = response.bytes_stream();
    let mut buffer = String::new();

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| AppError::Ai(e.to_string()))?;
        buffer.push_str(&String::from_utf8_lossy(&chunk));

        while let Some(line_end) = buffer.find('\n') {
            let line = buffer[..line_end].trim().to_string();
            buffer = buffer[line_end + 1..].to_string();

            if line.starts_with("data: ") {
                let data = &line[6..];
                if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(data) {
                    let event_type = parsed["type"].as_str().unwrap_or("");
                    match event_type {
                        "content_block_delta" => {
                            if let Some(text) = parsed["delta"]["text"].as_str() {
                                let _ = app.emit("ai-stream-chunk", AiStreamChunk {
                                    delta: text.to_string(),
                                    done: false,
                                });
                            }
                        }
                        "message_stop" => {
                            let _ = app.emit("ai-stream-chunk", AiStreamChunk {
                                delta: String::new(),
                                done: true,
                            });
                            return Ok(());
                        }
                        _ => {}
                    }
                }
            }
        }
    }

    let _ = app.emit("ai-stream-chunk", AiStreamChunk {
        delta: String::new(),
        done: true,
    });

    Ok(())
}
