//! Model Context Protocol server for Quill.
//!
//! Driven over **stdio**: AI clients (Claude Code, Codex) spawn
//! `quill mcp` as a subprocess and exchange MCP messages on
//! stdin/stdout. The Tauri app does NOT host an MCP server in-process.
//! Both the app and the stdio subprocess open the same SQLite file
//! concurrently — safe because the DB runs in WAL mode and the stdio
//! side opens read-only. See `docs/impls/30-mcp-server.md`.

pub mod server;
pub mod state;
pub mod tools;

pub use state::McpState;
