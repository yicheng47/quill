# OpenAI OAuth Login Implementation Plan

## Context

Quill currently requires users to manually copy-paste OpenAI API keys. This feature adds OAuth 2.0 Authorization Code + PKCE login so users can authenticate with their existing OpenAI account via browser — no API key needed. The OAuth flow follows the same pattern used by OpenAI's Codex CLI (reference: pi-mono repo).

---

## Files to Create

### 1. `src-tauri/src/ai/oauth.rs` — OAuth Core Logic

All OAuth functions in one module:

- **Constants**: `CLIENT_ID`, `AUTH_URL`, `TOKEN_URL`, `REDIRECT_URI`, `SCOPES`, `CALLBACK_PORT` (1455), `CALLBACK_TIMEOUT_SECS` (60)
- **Structs**: `OAuthTokens { access_token, refresh_token, expires_at, account_id }`, `OAuthStatus { connected, account_id }`, `TokenResponse` (deserialized from OpenAI)
- **`generate_pkce() -> (String, String)`**: 32 random bytes → base64url verifier, SHA-256(verifier) → base64url challenge. Uses `rand::RngCore`, `sha2::Sha256`, `base64::engine::general_purpose::URL_SAFE_NO_PAD`.
- **`generate_state() -> String`**: 16 random bytes → hex string (manual format, no hex crate)
- **`build_auth_url(challenge, state) -> String`**: Constructs authorization URL with all params. Uses `url::form_urlencoded::Serializer` (transitive dep from reqwest) for proper encoding. Includes `id_token_add_organizations=true`, `codex_cli_simplified_flow=true`, `originator=quill`.
- **`async wait_for_callback(expected_state) -> AppResult<String>`**: `tokio::net::TcpListener` on 127.0.0.1:1455. Reads raw HTTP, parses path + query with `url::form_urlencoded::parse`. Validates state, extracts code. Returns success HTML. 60s timeout via `tokio::time::timeout`.
- **`async exchange_code(code, verifier) -> AppResult<TokenResponse>`**: POST form-encoded to TOKEN_URL with `grant_type=authorization_code`, `client_id`, `code`, `code_verifier`, `redirect_uri`.
- **`async refresh_access_token(refresh_token) -> AppResult<TokenResponse>`**: POST with `grant_type=refresh_token`, `refresh_token`, `client_id`.
- **`decode_jwt_account_id(access_token) -> Option<String>`**: Split on `.`, base64url-decode payload, parse JSON, extract `["https://api.openai.com/auth"]["chatgpt_account_id"]`.
- **`save_tokens(conn, tokens)` / `load_tokens(conn)` / `clear_tokens(conn)`**: CRUD on settings table using existing UPSERT pattern from `commands/settings.rs`.
- **`async get_valid_token(db: &Db) -> AppResult<String>`**: Load tokens, check expiry (with 60s buffer), auto-refresh if needed, save new tokens, return access_token. This is the key function called by AI commands.

### 2. `src-tauri/src/commands/oauth.rs` — Tauri Commands

Three `#[tauri::command]` functions:

- **`openai_oauth_login(app: AppHandle, db: State<Db>) -> AppResult<OAuthStatus>`**: Generate PKCE + state → build auth URL → open browser via `tauri_plugin_opener::OpenerExt` (`app.opener().open_url()`) → wait for callback → exchange code → decode JWT → save tokens → return status.
- **`openai_oauth_status(db: State<Db>) -> AppResult<OAuthStatus>`**: Load tokens from DB, return connected/account_id.
- **`openai_oauth_logout(db: State<Db>) -> AppResult<()>`**: Clear all OAuth tokens from DB.

---

## Files to Modify

### 3. `src-tauri/Cargo.toml` — Add Dependencies

```toml
sha2 = "0.10"
base64 = "0.22"
rand = "0.8"
```

Update tokio features to include `net` and `io-util` (needed for TcpListener + AsyncWriteExt):
```toml
tokio = { version = "1", features = ["sync", "macros", "rt-multi-thread", "net", "io-util"] }
```

### 4. `src-tauri/src/ai/mod.rs` — Add Module

Add `pub mod oauth;` after existing modules.

### 5. `src-tauri/src/commands/mod.rs` — Add Module

Add `pub mod oauth;` after existing modules.

### 6. `src-tauri/src/lib.rs` — Register Commands

Add to `generate_handler![]` (after the AI section):
```rust
// OAuth
commands::oauth::openai_oauth_login,
commands::oauth::openai_oauth_status,
commands::oauth::openai_oauth_logout,
```

### 7. `src-tauri/src/commands/ai.rs` — Use OAuth Token for API Calls

In both `ai_chat()` and `ai_quick_explain()`:
1. After reading existing settings, also read `ai_auth_mode` from settings
2. If `auth_mode == "oauth"` and `provider == "openai"`: call `oauth::get_valid_token(&db).await` to get a valid access token (auto-refreshes if expired)
3. Otherwise: use `api_key` as before
4. Pass the resolved token into the spawned task (must resolve before `spawn` since `State<Db>` can't move into the closure)

Key pattern — must drop the Mutex lock before the async `get_valid_token` call:
```rust
let effective_api_key = {
    let conn = db.conn.lock()...;
    let auth_mode = conn.query_row("SELECT value FROM settings WHERE key = ?1",
        params!["ai_auth_mode"], |row| row.get::<_, String>(0))
        .ok().unwrap_or_else(|| "api_key".to_string());
    if auth_mode == "oauth" && provider == "openai" {
        drop(conn);
        crate::ai::oauth::get_valid_token(&db).await?
    } else {
        api_key
    }
};
```

### 8. `src/pages/SettingsPage.tsx` — Frontend UI

**New state:**
- `authMode: "api_key" | "oauth"` (default `"api_key"`)
- `oauthStatus: { connected: boolean, account_id: string | null }`
- `oauthLoading: boolean`, `oauthError: string | null`

**New effects:**
- Load `ai_auth_mode` from settings in existing useEffect
- Fetch `openai_oauth_status` when provider is "openai"

**New handlers:**
- `handleOAuthLogin()`: invoke `openai_oauth_login`, update status
- `handleOAuthLogout()`: invoke `openai_oauth_logout`, clear status

**UI changes (inside AI section, after Provider select, when `provider === "openai"`):**
- Auth mode toggle buttons: "API Key" / "OAuth Login"
- When OAuth selected: status panel showing connected state + account_id + logout button, OR login button
- Hide API Key field when `authMode === "oauth"` (change condition on line 174)
- Include `ai_auth_mode: authMode` in `handleSave`

---

## Implementation Order

1. `Cargo.toml` — deps
2. `ai/oauth.rs` — core logic (create)
3. `commands/oauth.rs` — Tauri commands (create)
4. `ai/mod.rs`, `commands/mod.rs`, `lib.rs` — wiring
5. `commands/ai.rs` — integrate OAuth token resolution
6. `SettingsPage.tsx` — frontend UI
7. Compile and test

## Verification

1. `cargo build` in `src-tauri/` — must compile without errors
2. `npm run dev` — app launches
3. Settings page: select OpenAI provider → auth mode toggle appears
4. Click "OAuth Login" → browser opens OpenAI login page
5. After login → callback received → status shows "Connected" with account_id
6. Send an AI chat message → uses OAuth token (check no API key error)
7. Logout → status clears → falls back to API key mode
8. Token refresh: wait for token expiry (or manually set expires_at to past) → next AI call auto-refreshes
