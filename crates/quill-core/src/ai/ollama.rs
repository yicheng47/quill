use std::time::Duration;

use serde::Serialize;

const NOT_RUNNING: OllamaStatus = OllamaStatus { running: false, models: None };
const OLLAMA_CHECK_TIMEOUT: Duration = Duration::from_millis(1200);

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct OllamaStatus {
    pub running: bool,
    /// Installed models, when the server answered.
    pub models: Option<usize>,
}

/// Probe a local Ollama server at `base_url` with a short timeout so the UI
/// never stalls when Ollama is stopped or unreachable.
pub async fn check_ollama_status(base_url: &str) -> OllamaStatus {
    check_ollama_status_with_timeout(base_url, OLLAMA_CHECK_TIMEOUT).await
}

async fn check_ollama_status_with_timeout(base_url: &str, timeout: Duration) -> OllamaStatus {
    let trimmed = base_url.trim().trim_end_matches('/');
    // The connection's base URL ends in the OpenAI-compatible `/v1`; the
    // native status endpoint sits beside it.
    let trimmed = trimmed.strip_suffix("/v1").unwrap_or(trimmed);
    let Ok(parsed) = reqwest::Url::parse(trimmed) else {
        return NOT_RUNNING;
    };
    if !matches!(parsed.scheme(), "http" | "https") {
        return NOT_RUNNING;
    }

    let Ok(client) = reqwest::Client::builder().timeout(timeout).build() else {
        return NOT_RUNNING;
    };

    let url = format!("{trimmed}/api/tags");
    match client.get(&url).send().await {
        Ok(resp) if resp.status().is_success() => {
            let models = resp
                .json::<serde_json::Value>()
                .await
                .ok()
                .and_then(|body| body["models"].as_array().map(Vec::len));
            OllamaStatus { running: true, models }
        }
        _ => NOT_RUNNING,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    async fn spawn_one_shot_server(status_line: &str, body: &str, delay: Duration) -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let status_line = status_line.to_string();
        let body = body.to_string();
        tokio::spawn(async move {
            if let Ok((mut stream, _)) = listener.accept().await {
                let mut buf = [0u8; 1024];
                let _ = stream.read(&mut buf).await;
                if !delay.is_zero() {
                    tokio::time::sleep(delay).await;
                }
                let resp = format!(
                    "HTTP/1.1 {status_line}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = stream.write_all(resp.as_bytes()).await;
            }
        });
        format!("http://{}", addr)
    }

    #[tokio::test]
    async fn reports_running_when_ollama_returns_200() {
        let base_url = spawn_one_shot_server("200 OK", r#"{"models":[{"name":"a"},{"name":"b"}]}"#, Duration::ZERO).await;
        let status = check_ollama_status(&format!("{base_url}/")).await;
        assert_eq!(status, OllamaStatus { running: true, models: Some(2) });
    }

    #[tokio::test]
    async fn probes_beside_the_openai_compatible_v1_path() {
        let base_url = spawn_one_shot_server("200 OK", r#"{"models":[]}"#, Duration::ZERO).await;
        let status = check_ollama_status(&format!("{base_url}/v1")).await;
        assert_eq!(status, OllamaStatus { running: true, models: Some(0) });
    }

    #[tokio::test]
    async fn reports_not_running_on_non_2xx() {
        let base_url = spawn_one_shot_server("500 Internal Server Error", "err", Duration::ZERO).await;
        let status = check_ollama_status(&base_url).await;
        assert_eq!(status, NOT_RUNNING);
    }

    #[tokio::test]
    async fn reports_not_running_on_connection_refused() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);

        let status = check_ollama_status(&format!("http://127.0.0.1:{port}")).await;
        assert_eq!(status, NOT_RUNNING);
    }

    #[tokio::test]
    async fn reports_not_running_when_probe_times_out() {
        let base_url =
            spawn_one_shot_server("200 OK", r#"{"models":[]}"#, Duration::from_millis(350)).await;
        let status = check_ollama_status_with_timeout(&base_url, Duration::from_millis(60)).await;
        assert_eq!(status, NOT_RUNNING);
    }

    #[tokio::test]
    async fn reports_not_running_for_invalid_or_non_http_urls() {
        assert_eq!(check_ollama_status("").await, NOT_RUNNING);
        assert_eq!(
            check_ollama_status("not a url").await,
            NOT_RUNNING
        );
        assert_eq!(
            check_ollama_status("ftp://localhost:11434").await,
            NOT_RUNNING
        );
    }
}
