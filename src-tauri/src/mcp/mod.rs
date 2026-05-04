//! Model Context Protocol server for Quill.
//!
//! Phase 1 stands up the server lifecycle and the MCP handshake on a
//! Streamable HTTP transport bound to `127.0.0.1`. No tools are
//! registered yet — that arrives in Phase 2. See
//! `docs/impls/30-mcp-server.md`.

pub mod server;
pub mod state;

pub use server::McpServer;
// `McpServerError` is re-exported from `server::` for Phase 2 callers
// (settings UI bridge) but unused inside this crate today.
#[allow(unused_imports)]
pub use server::McpServerError;
pub use state::McpState;
