//! MCP server handler + stdio entry point.
//!
//! This file owns:
//!   - `QuillMcpHandler` — the per-process MCP service. Carries
//!     `McpState` so tool methods (defined across `mcp/tools/*.rs` via
//!     `#[tool_router]` impl blocks) can read the DB.
//!   - `tool_router()` — aggregator merging every per-file router.
//!   - `ServerHandler` impl (annotated `#[tool_handler]`) which
//!     auto-generates `call_tool` / `list_tools` against the merged
//!     router.
//!   - `serve_stdio()` — drives the handler over `(stdin, stdout)` for
//!     the `quill mcp` subcommand. The Tauri app does NOT run an MCP
//!     server in-process; AI clients (Claude Code, Codex) launch this
//!     subprocess themselves.

use rmcp::handler::server::ServerHandler;
use rmcp::handler::server::router::tool::ToolRouter;
use rmcp::model::{Implementation, ProtocolVersion, ServerCapabilities, ServerInfo};
use rmcp::transport::io::stdio;
use rmcp::{ServiceExt, tool_handler};

use super::state::McpState;

#[derive(Clone)]
pub(crate) struct QuillMcpHandler {
    pub(crate) state: McpState,
}

impl QuillMcpHandler {
    pub(crate) fn new(state: McpState) -> Self {
        Self { state }
    }

    /// Aggregator merging every per-file router into one. The
    /// `#[tool_handler]` macro on the `ServerHandler` impl below invokes
    /// this on every `call_tool` / `list_tools`, so keep it cheap —
    /// only fixed `with_route` inserts, no I/O.
    ///
    /// New tool files must add a `r.merge(Self::<name>_router());` line
    /// here AND register themselves in `tools/mod.rs`'s forbidden-
    /// surfaces audit comment.
    pub(crate) fn tool_router() -> ToolRouter<Self> {
        let mut r = ToolRouter::new();
        r.merge(Self::library_router());
        r.merge(Self::highlights_router());
        r.merge(Self::bookmarks_router());
        r.merge(Self::vocab_router());
        r.merge(Self::translations_router());
        r.merge(Self::chats_router());
        r
    }
}

#[tool_handler]
impl ServerHandler for QuillMcpHandler {
    fn get_info(&self) -> ServerInfo {
        // `ServerInfo` and `Implementation` are both `#[non_exhaustive]`.
        // Use the public constructors / builder methods rather than
        // struct literals.
        let implementation =
            Implementation::new("quill", env!("CARGO_PKG_VERSION"));
        let capabilities = ServerCapabilities::builder().enable_tools().build();
        ServerInfo::new(capabilities)
            .with_protocol_version(ProtocolVersion::LATEST)
            .with_server_info(implementation)
            .with_instructions(
                "Quill MCP server. Read-only access to the local library, \
                 highlights, bookmarks, vocabulary, translations, and chat \
                 history. Write tools land in v1.1 behind opt-in per-tool \
                 toggles.",
            )
    }
}

/// Drive the handler over `(stdin, stdout)` until the client closes the
/// pipe (or sends a shutdown notification). Returns when the session
/// ends; the binary's `main` should exit afterward.
///
/// Called from `mcp_stdio_main()` in `lib.rs`; not used by the Tauri
/// app side.
pub(crate) async fn serve_stdio(state: McpState) -> Result<(), Box<dyn std::error::Error>> {
    let handler = QuillMcpHandler::new(state);
    let server = handler.serve(stdio()).await?;
    // `waiting` resolves when the peer disconnects or sends shutdown.
    let _quit_reason = server.waiting().await?;
    Ok(())
}
