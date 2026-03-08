use futures::StreamExt;
use tauri::{AppHandle, Emitter};

use crate::commands::ai::{AiStreamChunk, ChatMessage};
use crate::error::{AppError, AppResult};

pub async fn stream_chat(
    app: &AppHandle,
    base_url: &str,
    api_key: &str,
    model: &str,
    temperature: f64,
    messages: &[ChatMessage],
    keep_alive: Option<&str>,
    event_name: &str,
    max_tokens_override: Option<u32>,
) -> AppResult<()> {
    let client = reqwest::Client::new();
    let url = format!("{}/v1/chat/completions", base_url.trim_end_matches('/'));

    let mut body = serde_json::json!({
        "model": model,
        "messages": messages.iter().map(|m| serde_json::json!({
            "role": m.role,
            "content": m.content,
        })).collect::<Vec<_>>(),
        "temperature": temperature,
        "stream": true,
    });
    if let Some(ka) = keep_alive {
        body["keep_alive"] = serde_json::json!(ka);
    }
    if let Some(mt) = max_tokens_override {
        body["max_tokens"] = serde_json::json!(mt);
    }

    let mut request = client.post(&url).json(&body);
    if !api_key.is_empty() {
        request = request.bearer_auth(api_key);
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

        // Process complete SSE lines
        while let Some(line_end) = buffer.find('\n') {
            let line = buffer[..line_end].trim().to_string();
            buffer = buffer[line_end + 1..].to_string();

            if line.starts_with("data: ") {
                let data = &line[6..];
                if data == "[DONE]" {
                    let _ = app.emit(event_name, AiStreamChunk {
                        delta: String::new(),
                        done: true,
                    });
                    return Ok(());
                }

                if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(data) {
                    if let Some(delta) = parsed["choices"][0]["delta"]["content"].as_str() {
                        let _ = app.emit(event_name, AiStreamChunk {
                            delta: delta.to_string(),
                            done: false,
                        });
                    }
                }
            }
        }
    }

    let _ = app.emit(event_name, AiStreamChunk {
        delta: String::new(),
        done: true,
    });

    Ok(())
}
