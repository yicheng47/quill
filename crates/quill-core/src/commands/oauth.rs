use std::time::{SystemTime, UNIX_EPOCH};

use crate::ai::oauth::{
    self, build_auth_url, clear_tokens, decode_jwt_account_id, decode_jwt_email, exchange_code,
    generate_pkce, generate_state, load_tokens, save_tokens, OAuthStatus, OAuthTokens,
    OAUTH_CANCELLED,
};
use crate::error::{AppError, AppResult};
use crate::host::Core;

pub async fn openai_oauth_login(core: &Core) -> AppResult<OAuthStatus> {
    let (_guard, mut cancel_rx) = core.oauth_pending.begin().await;
    let listener = oauth::bind_callback_listener().await?;

    let (verifier, challenge) = generate_pkce();
    let state = generate_state();
    let auth_url = build_auth_url(&challenge, &state);

    core.host.open_url(&auth_url)?;

    let code = oauth::handle_callback_cancellable(listener, &state, &mut cancel_rx).await?;
    let response = tokio::select! {
        biased;
        _ = &mut cancel_rx => return Err(AppError::Other(OAUTH_CANCELLED.to_string())),
        res = exchange_code(&code, &verifier) => res?,
    };

    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs();
    let account_id = decode_jwt_account_id(&response.access_token);
    let email = response
        .id_token
        .as_deref()
        .and_then(decode_jwt_email)
        .or_else(|| decode_jwt_email(&response.access_token));

    let tokens = OAuthTokens {
        access_token: response.access_token,
        refresh_token: response.refresh_token.unwrap_or_default(),
        expires_at: now + response.expires_in.unwrap_or(3600),
        account_id: account_id.clone(),
        email: email.clone(),
    };

    save_tokens(&core.secrets, &tokens)?;
    core.host.emit_to_json(
        "main",
        "openai-oauth-changed",
        &serde_json::json!({ "connected": true }),
    );

    Ok(OAuthStatus {
        connected: true,
        account_id,
        email,
    })
}

pub async fn openai_oauth_status(core: &Core) -> AppResult<OAuthStatus> {
    match load_tokens(&core.secrets) {
        Some(tokens) => Ok(OAuthStatus {
            connected: true,
            account_id: tokens.account_id,
            email: tokens.email,
        }),
        None => Ok(OAuthStatus {
            connected: false,
            account_id: None,
            email: None,
        }),
    }
}

pub async fn openai_oauth_cancel(core: &Core) -> AppResult<()> {
    core.oauth_pending.cancel_and_wait().await;
    Ok(())
}

pub async fn openai_oauth_logout(core: &Core) -> AppResult<()> {
    clear_tokens(&core.secrets)?;
    core.host.emit_to_json(
        "main",
        "openai-oauth-changed",
        &serde_json::json!({ "connected": false }),
    );
    Ok(())
}
