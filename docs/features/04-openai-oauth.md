# OpenAI OAuth Login

**Version:** 0.1
**Date:** March 9, 2026
**Status:** Design

---

## 1. Motivation

Quill currently requires users to manually obtain and paste an OpenAI API key in settings. This is friction-heavy — users must navigate to platform.openai.com, create an API key, copy it, and paste it into Quill.

**OpenAI OAuth** (ChatGPT OAuth / Codex Subscription) lets users authenticate with their existing OpenAI account via a browser-based login flow. After a one-click login, Quill automatically obtains and manages access tokens — no API key needed.

This is the same OAuth flow used by OpenAI's Codex CLI and third-party tools like OpenClaw. It is explicitly supported for external tool use.

---

## 2. UX Design

### 2.1. Settings Page — Auth Mode

When the AI provider is set to **OpenAI**, an **Authentication Method** selector appears below the provider dropdown:

```
┌─────────────────────────────────────────────┐
│ AI Provider:        [OpenAI          ▾]     │
│                                             │
│ Authentication:     [API Key] [OAuth Login]  │
│                                             │
│ ┌─── OAuth Login ────────────────────────┐  │
│ │  ● Connected as user@example.com       │  │
│ │  [Logout]                              │  │
│ └────────────────────────────────────────┘  │
│                                             │
│ Model:              [gpt-4o            ]    │
│ ...                                         │
```

**API Key mode** (default): Shows the existing API Key input field. No behavior change.

**OAuth Login mode**:
- **Not connected**: Shows a "Login with OpenAI" button.
- **Connected**: Shows green status with email/account info and a "Logout" button.
- The API Key input is hidden (not needed with OAuth).

### 2.2. Login Flow (User Perspective)

1. User selects "OAuth Login" and clicks **Login with OpenAI**.
2. System browser opens to OpenAI's login page.
3. User authenticates (or is already logged in) and authorizes the app.
4. Browser redirects to `http://localhost:1455/auth/callback` — shows "Authentication successful."
5. Settings page updates to show "Connected."
6. User can immediately use the AI assistant.

### 2.3. Error States

- **Port busy**: "OAuth callback server could not start. Please close any application using port 1455 and try again."
- **Timeout**: "Authentication timed out. Please try again." (60-second timeout)
- **User cancels / closes browser**: No callback received → timeout.
- **Token exchange fails**: "Authentication failed. Please try again."
- **Network error**: Standard error message.

In all error cases, the user can retry or fall back to API Key mode.

---

## 3. OAuth Protocol Details

### 3.1. Configuration

| Parameter | Value |
|-----------|-------|
| Flow | OAuth 2.0 Authorization Code + PKCE (public client) |
| Client ID | `app_EMoamEEZ73f0CkXaXp7hrann` |
| Authorization URL | `https://auth.openai.com/oauth/authorize` |
| Token URL | `https://auth.openai.com/oauth/token` |
| Redirect URI | `http://localhost:1455/auth/callback` |
| Scopes | `openid profile email offline_access` |
| PKCE Method | S256 |

Source: `@mariozechner/pi-ai` (pi-mono monorepo).

### 3.2. Authorization Request

```
GET https://auth.openai.com/oauth/authorize?
  response_type=code&
  client_id=app_EMoamEEZ73f0CkXaXp7hrann&
  redirect_uri=http://localhost:1455/auth/callback&
  scope=openid+profile+email+offline_access&
  code_challenge=<base64url(sha256(verifier))>&
  code_challenge_method=S256&
  state=<random_hex>&
  id_token_add_organizations=true&
  codex_cli_simplified_flow=true&
  originator=quill
```

### 3.3. Token Exchange

```
POST https://auth.openai.com/oauth/token
Content-Type: application/x-www-form-urlencoded

grant_type=authorization_code&
client_id=app_EMoamEEZ73f0CkXaXp7hrann&
code=<authorization_code>&
code_verifier=<pkce_verifier>&
redirect_uri=http://localhost:1455/auth/callback
```

Response:
```json
{
  "access_token": "eyJ...",
  "refresh_token": "v1.MjU...",
  "expires_in": 1800
}
```

### 3.4. Token Refresh

```
POST https://auth.openai.com/oauth/token
Content-Type: application/x-www-form-urlencoded

grant_type=refresh_token&
refresh_token=<refresh_token>&
client_id=app_EMoamEEZ73f0CkXaXp7hrann
```

### 3.5. PKCE Generation

1. Generate 32 random bytes.
2. `verifier` = base64url-encode the bytes (no padding).
3. `challenge` = base64url-encode(SHA-256(verifier)) (no padding).

### 3.6. Account ID Extraction

The `access_token` is a JWT. Decode the payload (base64) and extract:
```
payload["https://api.openai.com/auth"]["chatgpt_account_id"]
```

### 3.7. API Usage

The OAuth `access_token` is used as a Bearer token — identical to how an API key is used:
```
Authorization: Bearer <access_token>
```

---

## 4. Technical Architecture

### 4.1. Data Model

**Settings keys** (stored in existing SQLite key-value `settings` table — no schema migration):

| Key | Value |
|-----|-------|
| `ai_auth_mode` | `"api_key"` or `"oauth"` |
| `ai_oauth_access_token` | The access token string |
| `ai_oauth_refresh_token` | The refresh token string |
| `ai_oauth_token_expires` | Expiry timestamp (ms since epoch) |
| `ai_oauth_account_id` | ChatGPT account ID from JWT |

**OAuthTokens struct (Rust):**
```rust
pub struct OAuthTokens {
    pub access_token: String,
    pub refresh_token: String,
    pub expires_at: i64,       // ms since epoch
    pub account_id: Option<String>,
}
```

**OAuthStatus struct (returned to frontend):**
```rust
pub struct OAuthStatus {
    pub connected: bool,
    pub account_id: Option<String>,
}
```

### 4.2. Backend Flow

```
User clicks "Login with OpenAI"
  │
  invoke("openai_oauth_login")
  │
  ├── generate PKCE (verifier + challenge)
  ├── generate random state
  ├── start TCP listener on 127.0.0.1:1455
  ├── open browser to authorization URL (tauri-plugin-opener)
  │
  ├── wait for callback (GET /auth/callback?code=...&state=...)
  │     ├── validate state matches
  │     ├── extract authorization code
  │     └── respond with success HTML → close server
  │
  ├── POST token exchange → get access_token, refresh_token, expires_in
  ├── decode JWT → extract account_id
  └── store all in SQLite settings table
      └── return OAuthStatus { connected: true, account_id }
```

**Auto-refresh on API calls:**
```
ai_chat() / ai_quick_explain()
  │
  ├── read ai_auth_mode from settings
  ├── if "oauth" and provider == "openai":
  │     ├── read stored access_token + expires_at
  │     ├── if expired:
  │     │     ├── POST refresh_token → get new tokens
  │     │     └── update SQLite
  │     └── use access_token as Bearer token
  └── else: use api_key as before
```

### 4.3. Local Callback Server

- Uses `tokio::net::TcpListener` (already a dependency) — no new HTTP framework needed.
- Binds to `127.0.0.1:1455`.
- Manually parses the HTTP request line to extract the URL path and query parameters.
- Only handles one request: `GET /auth/callback?code=...&state=...`.
- Responds with minimal HTML: "Authentication successful. You can close this tab."
- Shuts down immediately after receiving the callback.
- Times out after 60 seconds if no callback is received.

---

## 5. Files to Create

| File | Purpose |
|------|---------|
| `src-tauri/src/ai/oauth.rs` | OAuth core: PKCE, callback server, token exchange, token refresh, JWT decode, `get_valid_token()` |
| `src-tauri/src/commands/oauth.rs` | Tauri commands: `openai_oauth_login`, `openai_oauth_status`, `openai_oauth_logout` |

## 6. Files to Modify

| File | Change |
|------|--------|
| `src-tauri/Cargo.toml` | Add `sha2 = "0.10"`, `base64 = "0.22"`, `rand = "0.8"` |
| `src-tauri/src/ai/mod.rs` | Add `pub mod oauth;` |
| `src-tauri/src/commands/mod.rs` | Add `pub mod oauth;` |
| `src-tauri/src/lib.rs` | Register `openai_oauth_login`, `openai_oauth_status`, `openai_oauth_logout` commands |
| `src-tauri/src/commands/ai.rs` | In `ai_chat()` and `ai_quick_explain()`: read `ai_auth_mode`, if `"oauth"` + OpenAI provider, call `oauth::get_valid_token()` (auto-refreshes) and use the access token as Bearer token |
| `src/pages/SettingsPage.tsx` | Add auth mode selector (API Key / OAuth Login) when provider is OpenAI. Show login/logout buttons and connection status. New state: `authMode`, `oauthStatus`. Save `ai_auth_mode` in `handleSave`. |

---

## 7. Implementation Plan

### Phase 1: Backend OAuth Module

1. Add `sha2`, `base64`, `rand` dependencies to `Cargo.toml`.
2. Create `src-tauri/src/ai/oauth.rs` with PKCE generation, callback server, token exchange, token refresh, and JWT decode.
3. Create `src-tauri/src/commands/oauth.rs` with three Tauri commands.
4. Register modules in `ai/mod.rs`, `commands/mod.rs`, and `lib.rs`.

### Phase 2: Integrate with AI Commands

1. Modify `ai.rs` to check `ai_auth_mode` and use OAuth tokens when applicable.
2. Implement `get_valid_token()` in `oauth.rs` that reads from SQLite, checks expiry, auto-refreshes, and returns the current access token.

### Phase 3: Frontend UI

1. Add auth mode toggle to `SettingsPage.tsx` for OpenAI provider.
2. Add login button, status display, and logout button.
3. Wire up `invoke("openai_oauth_login")`, `invoke("openai_oauth_status")`, `invoke("openai_oauth_logout")`.
4. Save/load `ai_auth_mode` with other settings.

---

## 8. Edge Cases & Considerations

- **Port 1455 in use**: Fail gracefully with a clear error message. User retries or uses API key mode.
- **Token expiry during streaming**: If a token expires mid-stream, the current request uses the old token (OpenAI tokens typically expire in 30 minutes). Refresh happens on the next request.
- **Refresh token invalidation**: If the refresh token is invalidated (e.g., user revoked access), the refresh fails → status becomes disconnected → user must re-login.
- **Multiple logins**: Each new login replaces the stored tokens. Only one OAuth session at a time.
- **Offline usage**: OAuth tokens work offline until they expire. Refresh requires network.
- **Security**: Tokens stored in local SQLite (same security model as API keys). PKCE prevents authorization code interception. State parameter prevents CSRF.
- **No client_secret**: This is a public OAuth client (desktop app). Security relies on PKCE, not a client secret.
