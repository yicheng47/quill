use std::time::{SystemTime, UNIX_EPOCH};

use tauri::{AppHandle, State};
use tauri_plugin_opener::OpenerExt;

use crate::ai::oauth::{
    self, build_auth_url, clear_tokens, decode_jwt_account_id, exchange_code, generate_pkce,
    generate_state, load_tokens, save_tokens, OAuthStatus, OAuthTokens,
};
use crate::error::{AppError, AppResult};
use crate::secrets::Secrets;

#[tauri::command]
pub async fn openai_oauth_login(app: AppHandle, secrets: State<'_, Secrets>) -> AppResult<OAuthStatus> {
    let (verifier, challenge) = generate_pkce();
    let state = generate_state();
    let auth_url = build_auth_url(&challenge, &state);

    app.opener()
        .open_url(&auth_url, None::<&str>)
        .map_err(|e| AppError::Other(format!("Failed to open browser: {}", e)))?;

    let code = oauth::wait_for_callback(&state).await?;
    let response = exchange_code(&code, &verifier).await?;

    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs();
    let account_id = decode_jwt_account_id(&response.access_token);

    let tokens = OAuthTokens {
        access_token: response.access_token,
        refresh_token: response.refresh_token.unwrap_or_default(),
        expires_at: now + response.expires_in.unwrap_or(3600),
        account_id: account_id.clone(),
    };

    save_tokens(&secrets, &tokens)?;

    Ok(OAuthStatus {
        connected: true,
        account_id,
    })
}

#[tauri::command]
pub async fn openai_oauth_status(secrets: State<'_, Secrets>) -> AppResult<OAuthStatus> {
    match load_tokens(&secrets) {
        Some(tokens) => Ok(OAuthStatus {
            connected: true,
            account_id: tokens.account_id,
        }),
        None => Ok(OAuthStatus {
            connected: false,
            account_id: None,
        }),
    }
}

#[tauri::command]
pub async fn openai_oauth_logout(secrets: State<'_, Secrets>) -> AppResult<()> {
    clear_tokens(&secrets)?;
    Ok(())
}
