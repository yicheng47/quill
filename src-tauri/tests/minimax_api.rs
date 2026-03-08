use futures::StreamExt;

/// Integration test for MiniMax API via Anthropic-compatible endpoint.
/// Requires MINIMAX_API_KEY environment variable to be set.
///
/// Run with:
///   MINIMAX_API_KEY=your_key cargo test --test minimax_api -- --nocapture
#[tokio::test]
async fn test_minimax_streaming_chat() {
    let api_key = std::env::var("MINIMAX_API_KEY").expect("MINIMAX_API_KEY must be set");
    let base_url = "https://api.minimax.io/anthropic";
    let model = "MiniMax-M2.5";

    let client = reqwest::Client::new();

    let body = serde_json::json!({
        "model": model,
        "max_tokens": 256,
        "system": "You are a helpful assistant. Reply in one short sentence.",
        "messages": [
            { "role": "user", "content": "What is 2 + 2?" }
        ],
        "temperature": 0.0,
        "stream": true,
    });

    let response = client
        .post(format!("{}/v1/messages", base_url))
        .bearer_auth(&api_key)
        .header("anthropic-version", "2023-06-01")
        .header("content-type", "application/json")
        .json(&body)
        .send()
        .await
        .expect("Failed to send request");

    assert!(
        response.status().is_success(),
        "API returned error status {}: {}",
        response.status(),
        response.text().await.unwrap_or_default()
    );

    let mut stream = response.bytes_stream();
    let mut buffer = String::new();
    let mut full_response = String::new();
    let mut got_message_stop = false;

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.expect("Stream error");
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
                                full_response.push_str(text);
                            }
                        }
                        "message_stop" => {
                            got_message_stop = true;
                        }
                        _ => {}
                    }
                }
            }
        }
    }

    println!("MiniMax response: {}", full_response);
    assert!(!full_response.is_empty(), "Response should not be empty");
    assert!(got_message_stop, "Should receive message_stop event");
    // The response should mention "4" somewhere
    assert!(
        full_response.contains('4'),
        "Response should contain '4', got: {}",
        full_response
    );
}

/// Test that non-streaming request also works (sanity check).
#[tokio::test]
async fn test_minimax_non_streaming() {
    let api_key = std::env::var("MINIMAX_API_KEY").expect("MINIMAX_API_KEY must be set");
    let base_url = "https://api.minimax.io/anthropic";
    let model = "MiniMax-M2.5";

    let client = reqwest::Client::new();

    let body = serde_json::json!({
        "model": model,
        "max_tokens": 10240,
        "system": "Reply with just the number, nothing else.",
        "messages": [
            { "role": "user", "content": "What is 3 + 5?" }
        ],
        "temperature": 0.0,
        "stream": false,
    });

    let response = client
        .post(format!("{}/v1/messages", base_url))
        .bearer_auth(&api_key)
        .header("anthropic-version", "2023-06-01")
        .header("content-type", "application/json")
        .json(&body)
        .send()
        .await
        .expect("Failed to send request");

    assert!(
        response.status().is_success(),
        "API returned error status {}",
        response.status()
    );

    let json: serde_json::Value = response.json().await.expect("Failed to parse JSON");
    println!("MiniMax non-streaming raw response: {}", serde_json::to_string_pretty(&json).unwrap());

    // MiniMax returns content blocks with types (e.g. "thinking", "text")
    // Find the "text" type block
    let content = json["content"].as_array().expect("Missing content array");
    let text_block = content
        .iter()
        .find(|b| b["type"].as_str() == Some("text"))
        .expect("No text block in content");
    let text = text_block["text"].as_str().expect("Missing text field");

    println!("MiniMax non-streaming response: {}", text);
    assert!(text.contains('8'), "Response should contain '8', got: {}", text);
}
