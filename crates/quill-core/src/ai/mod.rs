pub mod anthropic;
pub mod api;
pub mod codex;
pub mod codex_models;
pub mod dispatch;
pub mod oauth;
pub mod ollama;
pub mod openai_compat;
pub mod openai_responses;

use crate::error::AppError;

pub const AI_NOT_CONFIGURED: &str = "AI_NOT_CONFIGURED";
pub const AI_REAUTH_REQUIRED: &str = "AI_REAUTH_REQUIRED";

pub fn is_reauth_required(err: &AppError) -> bool {
    matches!(err, AppError::Other(msg) if msg == AI_REAUTH_REQUIRED)
}

pub fn is_ai_sentinel(err: &AppError) -> bool {
    matches!(err, AppError::Other(msg) if [
        AI_REAUTH_REQUIRED,
        AI_NOT_CONFIGURED,
        codex::CODEX_NOT_INSTALLED,
        codex::CODEX_NOT_SIGNED_IN,
        codex::CODEX_TOO_OLD,
        codex::CODEX_FAILED,
    ]
    .contains(&msg.as_str()))
}
