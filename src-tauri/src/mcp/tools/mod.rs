//! MCP tool registry. Each submodule adds one or more
//! `#[tool_router]`-decorated `impl QuillMcpHandler` blocks; the macro
//! generates per-file `<name>_router()` associated functions that
//! `QuillMcpHandler::tool_router()` (in `mcp/server.rs`) merges into a
//! single `ToolRouter`.
//!
//! ## Forbidden surfaces — DO NOT ADD TOOLS THAT TOUCH:
//!
//! - `settings` table — `commands::settings::get_all_settings` merges
//!   `ai_api_key` from secrets into its return map
//!   (`commands/settings.rs:18-20`). Wrapping it as an MCP tool would
//!   leak the API key. Future partial settings exposure must filter
//!   against `Secrets::SENSITIVE_KEYS` (`secrets.rs:15-21`).
//! - `oauth` / OAuth tokens — `commands::oauth::*`.
//! - Secrets store — separate `Mutex<Connection>`; never add a
//!   `Secrets` clone to `McpState`.
//! - Sync infra tables — `_replay_state`, `_tombstones`,
//!   `_pending_publish` (migrations 010/011).
//! - Device identity, sync logs.
//!
//! Every new tool MUST be added to `QuillMcpHandler::tool_router()`'s
//! merge list AND its router method named in this audit comment when
//! Phase 3 / future phases extend the surface.

pub mod bookmarks;
pub mod chats;
pub mod collections;
pub mod highlights;
pub mod library;
pub mod translations;
pub mod vocab;
