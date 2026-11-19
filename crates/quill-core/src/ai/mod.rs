pub mod anthropic;
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
    matches!(err, AppError::Other(msg) if msg == AI_REAUTH_REQUIRED || msg == AI_NOT_CONFIGURED)
}
