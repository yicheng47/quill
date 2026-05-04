use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::Arc;

use rmcp::handler::server::ServerHandler;
use rmcp::model::{Implementation, ProtocolVersion, ServerCapabilities, ServerInfo};
use rmcp::transport::streamable_http_server::session::local::LocalSessionManager;
use rmcp::transport::streamable_http_server::{StreamableHttpServerConfig, StreamableHttpService};
use tauri::async_runtime::JoinHandle;
use tokio::net::TcpListener;
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;

use super::state::McpState;

/// Errors raised by the MCP server lifecycle.
#[derive(Debug, thiserror::Error)]
pub enum McpServerError {
    #[error("MCP server bind failed on {addr}: {source}")]
    Bind {
        addr: SocketAddr,
        #[source]
        source: std::io::Error,
    },
    #[error("MCP server already running on port {0}")]
    AlreadyRunning(u16),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
}

/// Default port for the local MCP server. Documented in
/// `docs/features/30-mcp-server.md` so AI clients can hardcode it.
pub const DEFAULT_PORT: u16 = 51983;

/// Lifecycle handle for the in-process MCP HTTP server.
///
/// Owns nothing while idle. While running, holds:
///   - a `CancellationToken` whose cancellation triggers graceful
///     shutdown of every active session;
///   - the `JoinHandle` for the axum task, so `stop()` can await
///     teardown rather than abandoning it;
///   - the actual bound port (the listener may pick a different one
///     when port `0` is requested or when port-reuse is in flight).
pub struct McpServer {
    inner: Mutex<Option<RunningServer>>,
}

struct RunningServer {
    cancel: CancellationToken,
    join: JoinHandle<()>,
    port: u16,
}

impl McpServer {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(None),
        }
    }

    /// True if the server is currently running. Used by the Phase 4
    /// settings bridge to render the toggle's current state.
    #[allow(dead_code)]
    pub async fn is_running(&self) -> bool {
        self.inner.lock().await.is_some()
    }

    /// Bound port if running, else `None`. Surfaced to the settings UI
    /// in Phase 4 so users can copy the MCP endpoint URL.
    #[allow(dead_code)]
    pub async fn bound_port(&self) -> Option<u16> {
        self.inner.lock().await.as_ref().map(|r| r.port)
    }

    /// Start the MCP server bound to `127.0.0.1:port`, exposing the
    /// MCP endpoint at `/mcp` over Streamable HTTP. Returns the
    /// actual bound port on success.
    ///
    /// Binds explicitly to loopback — never `0.0.0.0` — per the
    /// security constraints in `docs/impls/30-mcp-server.md`.
    pub async fn start(
        &self,
        state: McpState,
        port: u16,
    ) -> Result<u16, McpServerError> {
        let mut guard = self.inner.lock().await;
        if let Some(running) = guard.as_ref() {
            return Err(McpServerError::AlreadyRunning(running.port));
        }

        let addr = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), port);
        let listener = TcpListener::bind(addr)
            .await
            .map_err(|source| McpServerError::Bind { addr, source })?;
        let bound_port = listener.local_addr()?.port();

        let cancel = CancellationToken::new();
        let cancel_for_service = cancel.child_token();
        let cancel_for_axum = cancel.clone();

        // Per-session handler factory. Each session gets a fresh
        // `QuillMcpHandler` carrying a clone of the shared `McpState`
        // (which is itself cheap-clone). Keeps Phase 2's per-tool
        // `Arc<AtomicBool>` flags observable without restart.
        let state_for_factory = state.clone();
        // `StreamableHttpServerConfig` is `#[non_exhaustive]`, so we
        // can't construct it with struct-literal syntax from outside
        // the crate. Mutate a `Default` instance instead.
        let mut http_config = StreamableHttpServerConfig::default();
        http_config.cancellation_token = cancel_for_service;
        let service = StreamableHttpService::new(
            move || Ok(QuillMcpHandler::new(state_for_factory.clone())),
            Arc::new(LocalSessionManager::default()),
            http_config,
        );

        let router = axum::Router::new().nest_service("/mcp", service);

        let join = tauri::async_runtime::spawn(async move {
            if let Err(err) = axum::serve(listener, router)
                .with_graceful_shutdown(async move {
                    cancel_for_axum.cancelled().await;
                })
                .await
            {
                eprintln!("mcp: server task exited with error: {err}");
            }
        });

        *guard = Some(RunningServer {
            cancel,
            join,
            port: bound_port,
        });
        Ok(bound_port)
    }

    /// Cancel the server task and await its termination. No-op if not
    /// running. Safe to call from `RunEvent::ExitRequested`.
    pub async fn stop(&self) {
        let running = self.inner.lock().await.take();
        if let Some(RunningServer { cancel, join, .. }) = running {
            cancel.cancel();
            // Best-effort: if the join fails (panicked task) we log and
            // move on so app shutdown isn't held hostage.
            if let Err(err) = join.await {
                eprintln!("mcp: server task join failed during stop: {err}");
            }
        }
    }
}

impl Default for McpServer {
    fn default() -> Self {
        Self::new()
    }
}

/// Phase 1 MCP server handler: completes the handshake, advertises the
/// `tools` capability so clients know future tool calls are coming, and
/// returns an empty list for `tools/list` and every other request.
///
/// The actual tool wiring lands in Phase 2 (`mcp/tools/*`).
#[derive(Clone)]
#[allow(dead_code)]
struct QuillMcpHandler {
    state: McpState,
}

impl QuillMcpHandler {
    fn new(state: McpState) -> Self {
        Self { state }
    }
}

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
                "Quill MCP server. Phase 1: handshake only — no tools yet.",
            )
    }
}
