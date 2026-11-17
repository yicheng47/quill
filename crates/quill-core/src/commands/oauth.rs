use std::time::{SystemTime, UNIX_EPOCH};

use crate::ai::oauth::{
    self, build_auth_url, clear_tokens, decode_jwt_account_id, exchange_code, generate_pkce,
    generate_state, load_tokens, save_tokens, OAuthStatus, OAuthTokens,
};
use crate::error::AppResult;
use crate::host::Core;

pub async fn openai_oauth_login(core: &Core) -> AppResult<OAuthStatus> {
    let (verifier, challenge) = generate_pkce();
    let state = generate_state();
    let auth_url = build_auth_url(&challenge, &state);

    core.host.open_url(&auth_url)?;

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

    save_tokens(&core.secrets, &tokens)?;

    Ok(OAuthStatus {
        connected: true,
        account_id,
    })
}

pub async fn openai_oauth_status(core: &Core) -> AppResult<OAuthStatus> {
    match load_tokens(&core.secrets) {
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

pub async fn openai_oauth_logout(core: &Core) -> AppResult<()> {
    clear_tokens(&core.secrets)?;
    Ok(())
}
