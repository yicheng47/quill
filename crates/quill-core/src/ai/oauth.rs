use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use crate::ai::{AI_NOT_CONFIGURED, AI_REAUTH_REQUIRED};
use crate::error::{AppError, AppResult};
use crate::secrets::Secrets;

// OpenAI OAuth constants (public PKCE client, matches Codex CLI / pi-mono)
const CLIENT_ID: &str = "app_EMoamEEZ73f0CkXaXp7hrann";
const AUTH_URL: &str = "https://auth.openai.com/oauth/authorize";
const TOKEN_URL: &str = "https://auth.openai.com/oauth/token";
const SCOPES: &str = "openid profile email offline_access";
const CALLBACK_PORT: u16 = 1455;
const REDIRECT_URI: &str = "http://localhost:1455/auth/callback";
const CALLBACK_TIMEOUT_SECS: u64 = 60;
pub const OAUTH_CANCELLED: &str = "OAUTH_CANCELLED";

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct OAuthTokens {
    pub access_token: String,
    pub refresh_token: String,
    pub expires_at: u64,
    pub account_id: Option<String>,
    #[serde(default)]
    pub email: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct OAuthStatus {
    pub connected: bool,
    pub account_id: Option<String>,
    #[serde(default)]
    pub email: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct TokenResponse {
    pub access_token: String,
    pub refresh_token: Option<String>,
    pub expires_in: Option<u64>,
    #[serde(default)]
    pub id_token: Option<String>,
}

struct PendingLoginEntry {
    id: u64,
    cancel_tx: Option<tokio::sync::oneshot::Sender<()>>,
    released_rx: tokio::sync::watch::Receiver<bool>,
}

#[derive(Default)]
pub struct OAuthPendingLogin {
    inner: Mutex<Option<PendingLoginEntry>>,
    next_id: AtomicU64,
}

pub struct PendingLoginGuard<'a> {
    state: &'a OAuthPendingLogin,
    id: u64,
    released_tx: Option<tokio::sync::watch::Sender<bool>>,
}

impl Drop for PendingLoginGuard<'_> {
    fn drop(&mut self) {
        if let Some(tx) = self.released_tx.take() {
            let _ = tx.send(true);
        }
        if let Ok(mut guard) = self.state.inner.lock() {
            if guard.as_ref().is_some_and(|entry| entry.id == self.id) {
                *guard = None;
            }
        }
    }
}

impl OAuthPendingLogin {
    pub async fn begin(&self) -> (PendingLoginGuard<'_>, tokio::sync::oneshot::Receiver<()>) {
        self.cancel_and_wait().await;
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (cancel_tx, cancel_rx) = tokio::sync::oneshot::channel();
        let (released_tx, released_rx) = tokio::sync::watch::channel(false);
        if let Ok(mut guard) = self.inner.lock() {
            *guard = Some(PendingLoginEntry {
                id,
                cancel_tx: Some(cancel_tx),
                released_rx,
            });
        }
        (
            PendingLoginGuard {
                state: self,
                id,
                released_tx: Some(released_tx),
            },
            cancel_rx,
        )
    }

    pub async fn cancel_and_wait(&self) {
        let (cancel_tx, released_rx) = {
            let Ok(mut guard) = self.inner.lock() else {
                return;
            };
            let Some(entry) = guard.as_mut() else {
                return;
            };
            (entry.cancel_tx.take(), entry.released_rx.clone())
        };

        if let Some(tx) = cancel_tx {
            let _ = tx.send(());
        }

        if !*released_rx.borrow() {
            let mut rx = released_rx;
            let _ = tokio::time::timeout(
                Duration::from_secs(2),
                rx.wait_for(|&released| released),
            )
            .await;
        }
    }
}

fn now_epoch() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs()
}

/// Generate PKCE verifier and challenge pair.
pub fn generate_pkce() -> (String, String) {
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    let verifier = URL_SAFE_NO_PAD.encode(bytes);
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    (verifier, challenge)
}

/// Generate random hex state parameter.
pub fn generate_state() -> String {
    let mut bytes = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut bytes);
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

/// Build the OpenAI authorization URL with PKCE challenge and state.
pub fn build_auth_url(challenge: &str, state: &str) -> String {
    let mut url = reqwest::Url::parse(AUTH_URL).unwrap();
    url.query_pairs_mut()
        .append_pair("response_type", "code")
        .append_pair("client_id", CLIENT_ID)
        .append_pair("redirect_uri", REDIRECT_URI)
        .append_pair("scope", SCOPES)
        .append_pair("state", state)
        .append_pair("code_challenge", challenge)
        .append_pair("code_challenge_method", "S256")
        .append_pair("id_token_add_organizations", "true")
        .append_pair("codex_cli_simplified_flow", "true")
        .append_pair("originator", "quill");
    url.to_string()
}

/// Bind the local HTTP callback listener for OpenAI OAuth.
pub async fn bind_callback_listener() -> AppResult<tokio::net::TcpListener> {
    tokio::net::TcpListener::bind(format!("127.0.0.1:{}", CALLBACK_PORT))
        .await
        .map_err(|e| {
            AppError::Other(format!(
                "Failed to bind callback port {}: {}",
                CALLBACK_PORT, e
            ))
        })
}

/// Start a local HTTP server and wait for the OAuth callback.
/// Returns the authorization code on success.
pub async fn wait_for_callback(expected_state: &str) -> AppResult<String> {
    let listener = bind_callback_listener().await?;
    let (_tx, mut rx) = tokio::sync::oneshot::channel();
    handle_callback_cancellable(listener, expected_state, &mut rx).await
}

/// Accept a single connection on the listener, parse the OAuth callback, and return the code.
/// Dropping or firing `cancel_rx` immediately closes the listener and aborts the wait.
pub async fn handle_callback_cancellable(
    listener: tokio::net::TcpListener,
    expected_state: &str,
    cancel_rx: &mut tokio::sync::oneshot::Receiver<()>,
) -> AppResult<String> {
    let accept_res = tokio::select! {
        biased;
        _ = &mut *cancel_rx => {
            drop(listener);
            return Err(AppError::Other(OAUTH_CANCELLED.to_string()));
        }
        res = tokio::time::timeout(
            Duration::from_secs(CALLBACK_TIMEOUT_SECS),
            listener.accept(),
        ) => res,
    };

    let (mut stream, _) = accept_res
        .map_err(|_| AppError::Other("OAuth callback timed out after 60s".to_string()))?
        .map_err(|e| AppError::Other(format!("Failed to accept connection: {}", e)))?;
    drop(listener);

    let mut buf = [0u8; 4096];
    let n = tokio::select! {
        biased;
        _ = &mut *cancel_rx => return Err(AppError::Other(OAUTH_CANCELLED.to_string())),
        res = stream.read(&mut buf) => res?,
    };
    let request = String::from_utf8_lossy(&buf[..n]);

    // Parse first line: "GET /callback?code=xxx&state=yyy HTTP/1.1"
    let first_line = request.lines().next().unwrap_or("");
    let path = first_line.split_whitespace().nth(1).unwrap_or("");

    let full_url = format!("http://127.0.0.1{}", path);
    let parsed = reqwest::Url::parse(&full_url)
        .map_err(|e| AppError::Other(format!("Failed to parse callback URL: {}", e)))?;

    let mut code = None;
    let mut state = None;
    for (key, value) in parsed.query_pairs() {
        match key.as_ref() {
            "code" => code = Some(value.to_string()),
            "state" => state = Some(value.to_string()),
            _ => {}
        }
    }

    let state = state.ok_or_else(|| AppError::Other("Missing state in callback".to_string()))?;
    if state != expected_state {
        let resp = "HTTP/1.1 400 Bad Request\r\nContent-Type: text/html\r\nConnection: close\r\n\r\n\
            <html><body><h1>Authentication Failed</h1><p>State mismatch. Please try again.</p></body></html>";
        let _ = stream.write_all(resp.as_bytes()).await;
        return Err(AppError::Other("OAuth state mismatch".to_string()));
    }

    let code =
        code.ok_or_else(|| AppError::Other("Missing authorization code in callback".to_string()))?;

    let resp = "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nConnection: close\r\n\r\n\
        <html><body><h1>Authentication Successful</h1><p>You can close this window and return to Quill.</p></body></html>";
    let _ = stream.write_all(resp.as_bytes()).await;

    Ok(code)
}

/// Exchange an authorization code for tokens.
pub async fn exchange_code(code: &str, verifier: &str) -> AppResult<TokenResponse> {
    let client = reqwest::Client::new();
    let resp = client
        .post(TOKEN_URL)
        .form(&[
            ("grant_type", "authorization_code"),
            ("client_id", CLIENT_ID),
            ("code", code),
            ("code_verifier", verifier),
            ("redirect_uri", REDIRECT_URI),
        ])
        .send()
        .await
        .map_err(|e| AppError::Other(format!("Token exchange request failed: {}", e)))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(AppError::Other(format!(
            "Token exchange error {}: {}",
            status, body
        )));
    }

    resp.json::<TokenResponse>()
        .await
        .map_err(|e| AppError::Other(format!("Failed to parse token response: {}", e)))
}

enum RefreshError {
    Http {
        status: reqwest::StatusCode,
        body: String,
    },
    Transport(String),
}

impl RefreshError {
    fn into_app_error(self) -> AppError {
        match self {
            Self::Http { status, body } => {
                AppError::Other(format!("Token refresh error {}: {}", status, body))
            }
            Self::Transport(msg) => AppError::Other(msg),
        }
    }
}

async fn refresh_access_token_at(
    token_url: &str,
    refresh_token: &str,
) -> Result<TokenResponse, RefreshError> {
    let client = reqwest::Client::new();
    let resp = client
        .post(token_url)
        .form(&[
            ("grant_type", "refresh_token"),
            ("client_id", CLIENT_ID),
            ("refresh_token", refresh_token),
        ])
        .send()
        .await
        .map_err(|e| RefreshError::Transport(format!("Token refresh request failed: {}", e)))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(RefreshError::Http { status, body });
    }

    resp.json::<TokenResponse>()
        .await
        .map_err(|e| RefreshError::Transport(format!("Failed to parse refresh response: {}", e)))
}

/// Refresh an expired access token using the refresh token.
pub async fn refresh_access_token(refresh_token: &str) -> AppResult<TokenResponse> {
    refresh_access_token_at(TOKEN_URL, refresh_token)
        .await
        .map_err(RefreshError::into_app_error)
}

fn decode_jwt_payload(token: &str) -> Option<serde_json::Value> {
    let parts: Vec<&str> = token.split('.').collect();
    if parts.len() != 3 {
        return None;
    }
    let payload = URL_SAFE_NO_PAD.decode(parts[1]).ok()?;
    serde_json::from_slice(&payload).ok()
}

/// Decode the chatgpt_account_id from an OpenAI JWT access token.
pub fn decode_jwt_account_id(access_token: &str) -> Option<String> {
    let json = decode_jwt_payload(access_token)?;
    json.get("https://api.openai.com/auth")?
        .get("chatgpt_account_id")?
        .as_str()
        .map(String::from)
}

/// Decode an email address from an OpenAI OIDC id_token or access_token JWT,
/// without requiring any extra scopes beyond `openid profile email`.
pub fn decode_jwt_email(token: &str) -> Option<String> {
    let json = decode_jwt_payload(token)?;
    let raw = json
        .get("email")
        .and_then(|v| v.as_str())
        .or_else(|| {
            json.get("https://api.openai.com/profile")
                .and_then(|p| p.get("email"))
                .and_then(|v| v.as_str())
        })?;
    let trimmed = raw.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

pub fn save_tokens(secrets: &Secrets, tokens: &OAuthTokens) -> AppResult<()> {
    secrets.set("oauth_access_token", &tokens.access_token)?;
    secrets.set("oauth_refresh_token", &tokens.refresh_token)?;
    secrets.set("oauth_expires_at", &tokens.expires_at.to_string())?;
    if let Some(ref id) = tokens.account_id {
        secrets.set("oauth_account_id", id)?;
    }
    if let Some(ref email) = tokens.email {
        secrets.set("oauth_email", email)?;
    }
    Ok(())
}

pub fn load_tokens(secrets: &Secrets) -> Option<OAuthTokens> {
    let access_token = secrets.get("oauth_access_token")?;
    let email = secrets
        .get("oauth_email")
        .filter(|e| !e.trim().is_empty())
        .or_else(|| decode_jwt_email(&access_token));
    Some(OAuthTokens {
        access_token,
        refresh_token: secrets.get("oauth_refresh_token")?,
        expires_at: secrets.get("oauth_expires_at")?.parse().ok()?,
        account_id: secrets.get("oauth_account_id"),
        email,
    })
}

pub fn clear_tokens(secrets: &Secrets) -> AppResult<()> {
    secrets.delete_prefix("oauth_")?;
    Ok(())
}

/// Get a valid access token and account ID, auto-refreshing if expired.
/// This is the main entry point called by AI commands.
/// Returns (access_token, account_id).
pub async fn get_valid_token(secrets: &Secrets) -> AppResult<(String, Option<String>)> {
    get_valid_token_with_url(secrets, TOKEN_URL).await
}

async fn get_valid_token_with_url(
    secrets: &Secrets,
    token_url: &str,
) -> AppResult<(String, Option<String>)> {
    let tokens = load_tokens(secrets)
        .ok_or_else(|| AppError::Other(AI_NOT_CONFIGURED.to_string()))?;

    if tokens.refresh_token.trim().is_empty() {
        if let Err(err) = clear_tokens(secrets) {
            log::warn!("oauth: failed to clear tokens for empty refresh token: {err}");
        }
        return Err(AppError::Other(AI_REAUTH_REQUIRED.to_string()));
    }

    if tokens.expires_at > now_epoch() + 60 {
        return Ok((tokens.access_token, tokens.account_id));
    }

    // Token expired — refresh it
    let response = match refresh_access_token_at(token_url, &tokens.refresh_token).await {
        Ok(resp) => resp,
        Err(RefreshError::Http { status, .. })
            if status == reqwest::StatusCode::BAD_REQUEST
                || status == reqwest::StatusCode::UNAUTHORIZED =>
        {
            log::warn!("oauth: token refresh rejected with status {status}; clearing stored session");
            if let Err(err) = clear_tokens(secrets) {
                log::warn!("oauth: failed to clear tokens after refresh {status}: {err}");
            }
            return Err(AppError::Other(AI_REAUTH_REQUIRED.to_string()));
        }
        Err(err) => return Err(err.into_app_error()),
    };

    let now = now_epoch();
    let email = response
        .id_token
        .as_deref()
        .and_then(decode_jwt_email)
        .or_else(|| decode_jwt_email(&response.access_token))
        .or(tokens.email);
    let new_tokens = OAuthTokens {
        access_token: response.access_token.clone(),
        refresh_token: response
            .refresh_token
            .filter(|rt| !rt.trim().is_empty())
            .unwrap_or(tokens.refresh_token),
        expires_at: now + response.expires_in.unwrap_or(3600),
        account_id: decode_jwt_account_id(&response.access_token).or(tokens.account_id),
        email,
    };

    save_tokens(secrets, &new_tokens)?;

    Ok((new_tokens.access_token, new_tokens.account_id))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    fn make_jwt(payload: serde_json::Value) -> String {
        let header = URL_SAFE_NO_PAD.encode(b"{}");
        let payload_b64 = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&payload).unwrap());
        let signature = URL_SAFE_NO_PAD.encode(b"fake_sig");
        format!("{}.{}.{}", header, payload_b64, signature)
    }

    async fn spawn_mock_token_server(status_line: &str, body: &str) -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let status_line = status_line.to_string();
        let body = body.to_string();
        tokio::spawn(async move {
            if let Ok((mut stream, _)) = listener.accept().await {
                let mut buf = [0u8; 4096];
                let _ = stream.read(&mut buf).await;
                let resp = format!(
                    "HTTP/1.1 {status_line}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = stream.write_all(resp.as_bytes()).await;
            }
        });
        format!("http://{}/oauth/token", addr)
    }

    #[test]
    fn test_generate_pkce_format() {
        let (verifier, challenge) = generate_pkce();
        // 32 bytes → 43 base64url chars (no padding)
        assert_eq!(verifier.len(), 43);
        // SHA-256 → 32 bytes → 43 base64url chars
        assert_eq!(challenge.len(), 43);
        assert_ne!(verifier, challenge);
        // Must be valid base64url (no +, /, =)
        assert!(!verifier.contains('+') && !verifier.contains('/') && !verifier.contains('='));
        assert!(!challenge.contains('+') && !challenge.contains('/') && !challenge.contains('='));
    }

    #[test]
    fn test_generate_pkce_deterministic_challenge() {
        // Given the same verifier, challenge should be SHA256(verifier)
        let verifier = "test_verifier_string";
        let expected = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
        // Verify our PKCE logic matches
        let digest = Sha256::digest(verifier.as_bytes());
        let challenge = URL_SAFE_NO_PAD.encode(digest);
        assert_eq!(challenge, expected);
    }

    #[test]
    fn test_generate_pkce_uniqueness() {
        let (v1, c1) = generate_pkce();
        let (v2, c2) = generate_pkce();
        assert_ne!(v1, v2);
        assert_ne!(c1, c2);
    }

    #[test]
    fn test_generate_state_format() {
        let state = generate_state();
        // 16 bytes → 32 hex chars
        assert_eq!(state.len(), 32);
        assert!(state.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn test_generate_state_uniqueness() {
        let s1 = generate_state();
        let s2 = generate_state();
        assert_ne!(s1, s2);
    }

    #[test]
    fn test_build_auth_url_contains_required_params() {
        let url = build_auth_url("test_challenge", "test_state");
        let parsed = reqwest::Url::parse(&url).unwrap();

        assert_eq!(parsed.scheme(), "https");
        assert_eq!(parsed.host_str(), Some("auth.openai.com"));
        assert_eq!(parsed.path(), "/oauth/authorize");

        let params: std::collections::HashMap<_, _> = parsed.query_pairs().collect();
        assert_eq!(params.get("response_type").unwrap(), "code");
        assert_eq!(params.get("client_id").unwrap(), CLIENT_ID);
        assert_eq!(params.get("redirect_uri").unwrap(), REDIRECT_URI);
        assert_eq!(params.get("scope").unwrap(), SCOPES);
        assert_eq!(params.get("state").unwrap(), "test_state");
        assert_eq!(params.get("code_challenge").unwrap(), "test_challenge");
        assert_eq!(params.get("code_challenge_method").unwrap(), "S256");
        assert_eq!(params.get("originator").unwrap(), "quill");
    }

    #[test]
    fn test_decode_jwt_account_id_valid() {
        let token = make_jwt(serde_json::json!({
            "https://api.openai.com/auth": {
                "chatgpt_account_id": "acct_abc123"
            }
        }));

        assert_eq!(
            decode_jwt_account_id(&token),
            Some("acct_abc123".to_string())
        );
    }

    #[test]
    fn test_decode_jwt_account_id_missing_field() {
        let token = make_jwt(serde_json::json!({"sub": "user123"}));
        assert_eq!(decode_jwt_account_id(&token), None);
    }

    #[test]
    fn test_decode_jwt_account_id_malformed() {
        assert_eq!(decode_jwt_account_id("not.a.jwt"), None);
        assert_eq!(decode_jwt_account_id("only_one_part"), None);
        assert_eq!(decode_jwt_account_id("two.parts"), None);
    }

    #[test]
    fn test_decode_jwt_email() {
        let oidc = make_jwt(serde_json::json!({ "email": "reader@example.com" }));
        assert_eq!(decode_jwt_email(&oidc), Some("reader@example.com".to_string()));

        let profile = make_jwt(serde_json::json!({
            "https://api.openai.com/profile": { "email": "profile@example.com" }
        }));
        assert_eq!(
            decode_jwt_email(&profile),
            Some("profile@example.com".to_string())
        );

        let empty = make_jwt(serde_json::json!({ "email": "   " }));
        assert_eq!(decode_jwt_email(&empty), None);
        assert_eq!(decode_jwt_email("bad"), None);
    }

    #[test]
    fn test_save_load_clear_tokens() {
        let secrets = Secrets::init_in_memory().unwrap();

        // Initially empty
        assert!(load_tokens(&secrets).is_none());

        // Save and load
        let tokens = OAuthTokens {
            access_token: "access_123".to_string(),
            refresh_token: "refresh_456".to_string(),
            expires_at: 1700000000,
            account_id: Some("acct_789".to_string()),
            email: Some("reader@example.com".to_string()),
        };
        save_tokens(&secrets, &tokens).unwrap();

        let loaded = load_tokens(&secrets).unwrap();
        assert_eq!(loaded.access_token, "access_123");
        assert_eq!(loaded.refresh_token, "refresh_456");
        assert_eq!(loaded.expires_at, 1700000000);
        assert_eq!(loaded.account_id, Some("acct_789".to_string()));
        assert_eq!(loaded.email, Some("reader@example.com".to_string()));

        // Overwrite (upsert)
        let tokens2 = OAuthTokens {
            access_token: "new_access".to_string(),
            refresh_token: "new_refresh".to_string(),
            expires_at: 1800000000,
            account_id: None,
            email: None,
        };
        save_tokens(&secrets, &tokens2).unwrap();

        let loaded2 = load_tokens(&secrets).unwrap();
        assert_eq!(loaded2.access_token, "new_access");
        assert_eq!(loaded2.expires_at, 1800000000);
        // account_id still has old value since save_tokens only writes Some
        assert_eq!(loaded2.account_id, Some("acct_789".to_string()));

        // Clear
        clear_tokens(&secrets).unwrap();
        assert!(load_tokens(&secrets).is_none());
        assert!(secrets.get("oauth_email").is_none());
    }

    #[test]
    fn test_save_tokens_without_account_id() {
        let secrets = Secrets::init_in_memory().unwrap();

        let tokens = OAuthTokens {
            access_token: "at".to_string(),
            refresh_token: "rt".to_string(),
            expires_at: 999,
            account_id: None,
            email: None,
        };
        save_tokens(&secrets, &tokens).unwrap();

        let loaded = load_tokens(&secrets).unwrap();
        assert_eq!(loaded.access_token, "at");
        assert_eq!(loaded.account_id, None);
        assert_eq!(loaded.email, None);
    }

    #[tokio::test]
    async fn test_get_valid_token_empty_refresh_token_clears_and_returns_sentinel() {
        let cases = [
            ("expired empty", 0, ""),
            ("in-window empty", now_epoch() + 3600, ""),
            ("in-window whitespace", now_epoch() + 3600, " \n\t "),
        ];

        for (label, expires_at, refresh_token) in cases {
            let secrets = Secrets::init_in_memory().unwrap();
            save_tokens(
                &secrets,
                &OAuthTokens {
                    access_token: "access_at".to_string(),
                    refresh_token: refresh_token.to_string(),
                    expires_at,
                    account_id: Some("acct".to_string()),
                    email: Some("reader@example.com".to_string()),
                },
            )
            .unwrap();

            let err = get_valid_token_with_url(&secrets, "http://127.0.0.1:1")
                .await
                .unwrap_err();
            assert_eq!(err.to_string(), AI_REAUTH_REQUIRED, "case {label}");
            assert!(load_tokens(&secrets).is_none(), "case {label} must clear tokens");
        }
    }

    #[tokio::test]
    async fn test_get_valid_token_refresh_400_clears_tokens_and_returns_sentinel() {
        let secrets = Secrets::init_in_memory().unwrap();
        save_tokens(
            &secrets,
            &OAuthTokens {
                access_token: "stale_at".to_string(),
                refresh_token: "dead_rt".to_string(),
                expires_at: 0,
                account_id: Some("acct".to_string()),
                email: Some("reader@example.com".to_string()),
            },
        )
        .unwrap();
        let url = spawn_mock_token_server(
            "400 Bad Request",
            r#"{"error":"invalid_grant","error_description":"refresh token revoked"}"#,
        )
        .await;

        let err = get_valid_token_with_url(&secrets, &url).await.unwrap_err();
        assert_eq!(err.to_string(), AI_REAUTH_REQUIRED);
        assert!(!err.to_string().contains("invalid_grant"));
        assert!(load_tokens(&secrets).is_none());
    }

    #[tokio::test]
    async fn test_get_valid_token_refresh_401_clears_tokens_and_returns_sentinel() {
        let secrets = Secrets::init_in_memory().unwrap();
        save_tokens(
            &secrets,
            &OAuthTokens {
                access_token: "stale_at".to_string(),
                refresh_token: "revoked_rt".to_string(),
                expires_at: 0,
                account_id: Some("acct".to_string()),
                email: None,
            },
        )
        .unwrap();
        let url = spawn_mock_token_server("401 Unauthorized", r#"{"error":"unauthorized"}"#).await;

        let err = get_valid_token_with_url(&secrets, &url).await.unwrap_err();
        assert_eq!(err.to_string(), AI_REAUTH_REQUIRED);
        assert!(!err.to_string().contains("unauthorized"));
        assert!(load_tokens(&secrets).is_none());
    }

    #[tokio::test]
    async fn test_get_valid_token_refresh_5xx_and_403_and_network_keep_tokens() {
        for (status_line, body) in [
            ("503 Service Unavailable", "upstream busy"),
            ("403 Forbidden", "forbidden"),
        ] {
            let secrets = Secrets::init_in_memory().unwrap();
            save_tokens(
                &secrets,
                &OAuthTokens {
                    access_token: "stale_at".to_string(),
                    refresh_token: "valid_rt".to_string(),
                    expires_at: 0,
                    account_id: Some("acct".to_string()),
                    email: None,
                },
            )
            .unwrap();
            let url = spawn_mock_token_server(status_line, body).await;

            let err = get_valid_token_with_url(&secrets, &url).await.unwrap_err();
            assert_ne!(err.to_string(), AI_REAUTH_REQUIRED);
            assert!(load_tokens(&secrets).is_some(), "tokens must survive {status_line}");
        }

        // Network failure must not log the user out
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);

        let secrets = Secrets::init_in_memory().unwrap();
        save_tokens(
            &secrets,
            &OAuthTokens {
                access_token: "stale_at".to_string(),
                refresh_token: "valid_rt".to_string(),
                expires_at: 0,
                account_id: Some("acct".to_string()),
                email: None,
            },
        )
        .unwrap();

        let err = get_valid_token_with_url(&secrets, &format!("http://127.0.0.1:{port}/oauth/token"))
            .await
            .unwrap_err();
        assert_ne!(err.to_string(), AI_REAUTH_REQUIRED);
        assert!(load_tokens(&secrets).is_some());
    }

    #[tokio::test]
    async fn test_get_valid_token_refresh_success_updates_tokens_and_email() {
        let secrets = Secrets::init_in_memory().unwrap();
        save_tokens(
            &secrets,
            &OAuthTokens {
                access_token: "stale_at".to_string(),
                refresh_token: "old_rt".to_string(),
                expires_at: 0,
                account_id: None,
                email: None,
            },
        )
        .unwrap();
        let new_at = make_jwt(serde_json::json!({
            "https://api.openai.com/auth": { "chatgpt_account_id": "acct_new" }
        }));
        let id_tok = make_jwt(serde_json::json!({ "email": "fresh@example.com" }));
        let body = serde_json::json!({
            "access_token": new_at,
            "refresh_token": "new_rt",
            "expires_in": 3600,
            "id_token": id_tok,
        })
        .to_string();
        let url = spawn_mock_token_server("200 OK", &body).await;

        let (token, account_id) = get_valid_token_with_url(&secrets, &url).await.unwrap();
        assert_eq!(token, new_at);
        assert_eq!(account_id.as_deref(), Some("acct_new"));
        let saved = load_tokens(&secrets).unwrap();
        assert_eq!(saved.refresh_token, "new_rt");
        assert_eq!(saved.email.as_deref(), Some("fresh@example.com"));
    }

    #[tokio::test]
    async fn test_handle_callback_success() {
        // Bind to port 0 so the OS assigns a free port
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let state = "expected_state_123";

        let handle = tokio::spawn(async move {
            let (_tx, mut rx) = tokio::sync::oneshot::channel();
            handle_callback_cancellable(listener, state, &mut rx).await
        });

        let mut stream = tokio::net::TcpStream::connect(format!("127.0.0.1:{}", port))
            .await
            .unwrap();
        let request = format!(
            "GET /auth/callback?code=auth_code_xyz&state={} HTTP/1.1\r\nHost: localhost\r\n\r\n",
            state
        );
        stream.write_all(request.as_bytes()).await.unwrap();

        let result = handle.await.unwrap().unwrap();
        assert_eq!(result, "auth_code_xyz");
    }

    #[tokio::test]
    async fn test_handle_callback_state_mismatch() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();

        let handle = tokio::spawn(async move {
            let (_tx, mut rx) = tokio::sync::oneshot::channel();
            handle_callback_cancellable(listener, "correct_state", &mut rx).await
        });

        let mut stream = tokio::net::TcpStream::connect(format!("127.0.0.1:{}", port))
            .await
            .unwrap();
        let request = "GET /auth/callback?code=code&state=wrong_state HTTP/1.1\r\nHost: localhost\r\n\r\n";
        stream.write_all(request.as_bytes()).await.unwrap();

        let result = handle.await.unwrap();
        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("state mismatch"));
    }

    #[tokio::test]
    async fn test_cancel_pending_login_aborts_wait_and_frees_port() {
        let pending = Arc::new(OAuthPendingLogin::default());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();

        let (tx_started, rx_started) = tokio::sync::oneshot::channel();
        let pending_login = Arc::clone(&pending);
        let login_task = tokio::spawn(async move {
            let (_guard, mut cancel_rx) = pending_login.begin().await;
            let _ = tx_started.send(());
            handle_callback_cancellable(listener, "state_abc", &mut cancel_rx).await
        });

        rx_started.await.unwrap();
        pending.cancel_and_wait().await;

        // Listener must already be dropped and port immediately re-bindable.
        let rebound = tokio::net::TcpListener::bind(format!("127.0.0.1:{}", port)).await;
        assert!(rebound.is_ok(), "callback port should be freed immediately on cancel");

        let login_res = login_task.await.unwrap();
        assert_eq!(login_res.unwrap_err().to_string(), OAUTH_CANCELLED);
    }
}
