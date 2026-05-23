# 30 — MCP Server

**Issue:** [#184](https://github.com/yicheng47/quill/issues/184)
**Spec:** [30 — MCP Server](../features/30-mcp-server.md)

## Context

Expose Quill's reading data to any MCP-compatible AI client (Claude Code, Claude Desktop, Codex, Cursor) via a local Streamable HTTP server using the official `rmcp` Rust SDK. The MCP server runs in-process with Tauri, shares the existing SQLite materialized view (`quill.db`), and pushes Tauri events on writes so open windows refresh.

This plan ships in three phases. **Phase 1** stands up the server lifecycle and MCP handshake. **Phase 2** wires the library-management read tools. **Phase 3** ships the settings UI (enable/disable + port + connection URL). Write tools and the frontend reading-state bridge are deferred to **v1.1** — the v1 surface is read-only by design (MCP is for library management, not for replacing the in-app reader).

---

## Architect decisions (locked)

These are the inputs to this plan. Do not relitigate while implementing — open a follow-up if a constraint conflicts with reality.

1. **MCP scope = library management, not active reading.** Tools expose collections of saved data the user might want an AI client to help organize, search, or annotate (books, collections, highlights, bookmarks, vocab list, translations, chat history). Active-reading-session state (current position, SRS due queue) stays in-app and is intentionally NOT exposed — the in-app reader is the right surface for that.
2. **Read-only by default.** Each of the four write tools (`add_highlight`, `add_bookmark`, `add_vocab_word`, `update_vocab_mastery`) gets its own opt-in toggle in settings. All four default to off. Read tools are always on whenever the server is on.
3. **`search_highlights` / FTS — deferred to v1.1.** No FTS infra exists in `quill.db` today; AI clients can call `get_highlights(book_id)` and filter client-side for v1. Spec's "Out of scope" should record this.
4. **`get_vocab_stats` — included.** `commands/vocab.rs:251` already exposes the aggregate; wiring it into MCP is a free win for library-overview queries.
5. **MCP writes propagate to peers.** Writes go through `SyncWriter::with_tx`, hit the LWW outbox, and replay on peer devices like any other write. This is intended behavior, not a leak; do not add a filter.

---

## Hard constraints (security & integrity)

These come out of the impl-validation audit (settings.rs:10-23, secrets.rs:15-21, lib.rs:309). Any deviation is a revision.

- **`Db` is already `Arc`-cloneable** (db.rs:31-43). The MCP server holds a `Db` clone, never an `Arc<Db>` wrapper. Take the clone before `app.manage(db)` at lib.rs:309.
- **`SyncWriter` is `Arc`-shaped too** — write tools need a clone. Writes flow through `sync.with_tx(&db, ...)` (bookmarks.rs:52, 130) so the LWW outbox keeps working.
- **Bind explicitly to `127.0.0.1`**, never `0.0.0.0`. MCP is localhost-only per spec; misconfigured binds expose the user's library to the LAN.
- **MCP MUST NOT expose `settings` or `oauth` data.** `commands::settings::get_all_settings` (settings.rs:10-23, lines 18-20) merges `ai_api_key` from secrets into its return map — wrapping it as an MCP tool would leak the API key. If a future release ever wants partial settings exposure, filter via `Secrets::SENSITIVE_KEYS` at secrets.rs:15-21 (the canonical list).
- **Internal sync tables are off-limits.** `_replay_state`, `_tombstones`, `_pending_publish` (migrations 010/011) are sync infra, not user data. No MCP tool may read or write them.
- (v1 is read-only — the write-tool / frontend-bridge constraints land with the v1.1 plan.)

---

## Architecture

### Module layout

```
src-tauri/src/mcp/
  mod.rs              # public facade: McpServer, McpState, McpServerError
  server.rs           # axum router + rmcp StreamableHttpService, CancellationToken shutdown,
                      # QuillMcpHandler + tool_router aggregator
  state.rs            # McpState — Db clone (v1.1 adds SyncWriter + write-tool toggles)
  tools/
    mod.rs            # forbidden-surface audit comment, submodule declarations
    library.rs        # list_books, get_book, get_collections
    highlights.rs     # get_highlights
    bookmarks.rs      # get_bookmarks
    vocab.rs          # get_vocab_words, get_vocab_stats
    translations.rs   # get_translations
    chats.rs          # get_chat_history
```

v1.1 adds `mcp/notify.rs` (write-side fan-out) and write-tool methods on the same `QuillMcpHandler` impl blocks.

### Server lifecycle

A single `McpServer` struct owns a `Mutex<Option<RunningServer>>`. While running, `RunningServer` carries:
- A `CancellationToken` (cloned into the `StreamableHttpService` config AND into `axum::serve(...).with_graceful_shutdown(...)`) so cancellation drains both per-session SSE channels and the axum accept loop.
- A `JoinHandle<()>` for the axum task — `stop()` awaits this so app shutdown doesn't abandon in-flight requests.
- The bound port (settings UI reads it back; `TcpListener` may pick a different port than requested when port `0` is passed).

State transitions, all driven from settings or app exit:
- `start(state, port)` — `TcpListener::bind("127.0.0.1:{port}")`, build the `StreamableHttpService` against a fresh `LocalSessionManager`, mount via `axum::Router::new().nest_service("/mcp", service)`, spawn `axum::serve(listener, router).with_graceful_shutdown(cancel.cancelled())` on `tauri::async_runtime::spawn`, return the actually-bound port. If `bind` fails, return `McpServerError::Bind` and (Phase 4) persist `mcp_last_error` to settings — do NOT auto-increment the port.
- `stop()` — `cancel.cancel()`, await the join handle, clear state. No-op if not running.
- `restart(port)` — `stop()` then `start(port)`. Phase 4 only — Phase 1 doesn't need it.

`McpServer` lives in Tauri app state (`app.manage(McpServer::new())`). Settings commands toggle/configure it.

### Write-tool toggles and notification channel

Deferred to v1.1 with the write tools themselves. See the v1.1 plan
(separate doc) for the `Arc<AtomicBool>` flag layout, the
`notify::emit_data_changed` fan-out helper, and the four per-write
opt-in settings.

---

## Phase 1 — Server infrastructure

### Step 1.1: Add dependencies

**File: `src-tauri/Cargo.toml`**

```toml
rmcp = { version = "1.7", features = ["server", "transport-streamable-http-server"] }
axum = "0.8"
tokio-util = "0.7"   # CancellationToken for graceful shutdown
```

Update existing `tokio` line to add `time`:
```toml
tokio = { version = "1", features = ["sync", "macros", "rt-multi-thread", "net", "io-util", "time"] }
```

`time` is required for axum interval/keepalive timers and rmcp's session manager heartbeat. The Streamable HTTP transport (`StreamableHttpService` + `LocalSessionManager`) is rmcp's current recommended transport — supersedes the older `transport-sse-server`. No `tokio-stream` needed: the service hosts its own SSE channel internally.

### Step 1.2: Create `mcp` module skeleton

**File: `src-tauri/src/mcp/mod.rs`** (new) — re-exports.
**File: `src-tauri/src/mcp/state.rs`** (new):

```rust
pub struct McpState {
    pub db: Db,                   // already cheaply Clone
    pub sync_writer: SyncWriter,  // ditto
    pub app: AppHandle,
    pub write_highlights: Arc<AtomicBool>,
    pub write_bookmarks: Arc<AtomicBool>,
    pub write_vocab_add: Arc<AtomicBool>,
    pub write_vocab_mastery: Arc<AtomicBool>,
}
```

**File: `src-tauri/src/mcp/server.rs`** (new):

```rust
pub struct McpServer {
    inner: Mutex<Option<RunningServer>>,
}

struct RunningServer {
    cancel: CancellationToken,
    join: JoinHandle<()>,
    port: u16,
}

impl McpServer {
    pub fn new() -> Self { /* ... */ }

    pub async fn start(&self, state: McpState, port: u16) -> Result<u16, McpServerError> {
        // Bind 127.0.0.1:{port}. NEVER 0.0.0.0.
        let addr = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), port);
        let listener = TcpListener::bind(addr).await
            .map_err(|source| McpServerError::Bind { addr, source })?;
        let bound_port = listener.local_addr()?.port();

        let cancel = CancellationToken::new();
        let cancel_for_service = cancel.child_token();

        // `StreamableHttpServerConfig` is `#[non_exhaustive]`, so build
        // a `Default` and mutate it rather than struct-literal.
        let mut http_config = StreamableHttpServerConfig::default();
        http_config.cancellation_token = cancel_for_service;
        let state_for_factory = state.clone();
        let service = StreamableHttpService::new(
            move || Ok(QuillMcpHandler::new(state_for_factory.clone())),
            Arc::new(LocalSessionManager::default()),
            http_config,
        );
        let router = axum::Router::new().nest_service("/mcp", service);

        let cancel_for_axum = cancel.clone();
        let join = tauri::async_runtime::spawn(async move {
            let _ = axum::serve(listener, router)
                .with_graceful_shutdown(async move { cancel_for_axum.cancelled().await })
                .await;
        });
        // ... store RunningServer { cancel, join, port: bound_port }
        Ok(bound_port)
    }

    pub async fn stop(&self) { /* cancel.cancel(); join.await */ }
}
```

The `QuillMcpHandler` implements `rmcp::handler::server::ServerHandler` and returns `ServerInfo::new(ServerCapabilities::builder().enable_tools().build())` from `get_info()`. Phase 1 leaves `tools/list` at the default (empty) impl; Phase 2 swaps in the registered tool list.

### Step 1.3: Wire setup() boot

**File: `src-tauri/src/lib.rs`**

Inside `.setup(|app| { ... })`, before `app.manage(db)`:

1. `let mcp_state = McpState::new(db.clone());` — grabs the `Db` clone for both the gating check and the per-session handler factory. **No `Arc<Db>` wrapper.**
2. Read `mcp_enabled` directly from the `settings` table via `mcp_state.db.conn.lock()` (default `false` when missing). Phase 4 will add `mcp_port` lookup too; Phase 1 hardcodes `mcp::server::DEFAULT_PORT = 51983`.
3. Construct `McpServer::new()`. `app.manage(server)` unconditionally so the `ExitRequested` teardown path is uniform and Phase 4 can call `start()` on the same instance without a restart.
4. If `mcp_enabled` is true, call `server.start(state, DEFAULT_PORT)` via `tauri::async_runtime::block_on`; log bind errors with `log::error!` but do not fail setup.
5. If `mcp_enabled` is false, `log::info!` a one-liner explaining the gate. No socket is bound.

App exit hook: in `app.run(|_, event|)` match `RunEvent::ExitRequested` and call `server.stop().await` (block via `tauri::async_runtime::block_on`). `stop()` is a no-op if the server was never started, so the gating path is naturally safe.

### Step 1.4: Verification (Phase 1)

- `cargo build` compiles with the new deps.
- `claude-code mcp add quill http://localhost:51983/mcp` connects, handshake OK.
- Server stops cleanly on app exit (no orphaned port).
- Bind failure surfaces a readable error (covered in Phase 4 UI).

---

## Phase 2 — Read tools

All read tools are pure SQLite queries that reuse the existing column shapes. Where a Tauri command already does the right SELECT, the MCP tool calls a shared helper extracted from that command. No new SQL invented; the MCP layer is a thin re-projection.

### Tool surface

| Tool | Args | Returns | Source |
|------|------|---------|--------|
| `list_books` | `filter?`, `search?` | `Vec<Book>` | books.rs:202 |
| `get_book` | `book_id` | `Book` + progress | books.rs `get_book` |
| `get_highlights` | `book_id` | `Vec<Highlight>` (incl. `text_content`) | bookmarks.rs:164 |
| `get_bookmarks` | `book_id` | `Vec<Bookmark>` | bookmarks.rs:84 |
| `get_vocab_words` | `book_id` | `Vec<VocabWord>` (incl. mastery, SRS) | vocab.rs `list_vocab_words` |
| `get_vocab_stats` | — | aggregate counts by mastery | vocab.rs `get_vocab_stats` |
| `get_translations` | `book_id?` | `Vec<Translation>` | translation.rs `list_translations` |
| `get_collections` | — | `Vec<Collection>` + book counts | collections.rs `list_collections` |
| `get_chat_history` | `book_id`, `chat_id?` | chats + messages | chats.rs |

### Step 2.1: Extract shared query helpers

For each existing Tauri command listed above, factor the SELECT logic into a `pub(crate) fn query_*(db: &Db, ...) -> AppResult<...>` in the same module. The Tauri command becomes a thin wrapper. The MCP tool calls the same helper.

This avoids duplicating SQL, keeps the column shape canonical, and ensures schema migrations only touch one place.

### Step 2.2: Implement tools

rmcp 1.7 replaces the old `#[tool(tool_box)]` / `#[tool(param)]` shape with `#[tool_router]` + `Parameters<T>` argument structs. Each tool file under `src-tauri/src/mcp/tools/` adds an `impl QuillMcpHandler` block decorated with `#[tool_router(router = …, vis = pub(crate))]`, which the proc-macro expands into a `pub(crate) fn <router>() -> ToolRouter<Self>`. The handler then merges them into one router in `mcp/server.rs` (or `mcp/tools/mod.rs`). Parameters are plain `serde` + `schemars::JsonSchema` structs wrapped in `Parameters<T>`.

Example sketch (highlights.rs):

```rust
use rmcp::tool_router;
use rmcp::handler::server::wrapper::Parameters;
use schemars::JsonSchema;
use serde::Deserialize;

#[derive(Debug, Deserialize, JsonSchema)]
pub struct GetHighlightsArgs {
    /// Book ID to fetch highlights for.
    pub book_id: String,
}

#[tool_router(router = highlights_router, vis = pub(crate))]
impl QuillMcpHandler {
    #[tool(description = "List all highlights for a book, including the highlighted text content.")]
    pub async fn get_highlights(
        &self,
        Parameters(GetHighlightsArgs { book_id }): Parameters<GetHighlightsArgs>,
    ) -> Result<CallToolResult, McpError> {
        let highlights = bookmarks::query_highlights(&self.state.db, &book_id)
            .map_err(|e| McpError::internal_error(e.to_string(), None))?;
        Ok(CallToolResult::success(vec![Content::json(&highlights)?]))
    }
}
```

Aggregation (in `mcp/tools/mod.rs` or alongside `QuillMcpHandler`):

```rust
impl QuillMcpHandler {
    pub fn tool_router() -> ToolRouter<Self> {
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
    fn get_info(&self) -> ServerInfo { /* existing — keep `enable_tools()` */ }
}
```

`#[tool_handler]` generates `call_tool` / `list_tools` against `Self::tool_router()`. The hand-written `get_info` stays as-is — only `tools_*` are derived.

### Step 2.3: Forbidden tables — enforce via review, not code

There is no SQL-level enforcement; the `Db` connection sees everything. Instead, the impl plan reviewer (and PR review) checks the tool registry contains **only** the tools listed above. Add a comment block at the top of `mcp/tools/mod.rs` listing the forbidden surfaces:

```rust
//! Forbidden surfaces — DO NOT ADD TOOLS THAT TOUCH:
//! - settings (commands::settings::get_all_settings leaks ai_api_key, see settings.rs:18-20)
//! - oauth   (commands::oauth::*)
//! - secrets store (separate Mutex<Connection>; not reachable via Db, but DO NOT add a Secrets clone to McpState)
//! - sync infra (_replay_state, _tombstones, _pending_publish — migrations 010/011)
//! - device identity, sync logs
//!
//! If a future tool needs partial settings exposure, filter via
//! Secrets::SENSITIVE_KEYS at secrets.rs:15-21.
```

### Step 2.4: Verification (Phase 2)

- Connect via Claude Code or `npx @modelcontextprotocol/inspector http://127.0.0.1:51983/mcp`: `list_books` returns the library.
- `get_highlights(book_id)` returns rows with `text_content` populated.
- `get_vocab_stats()` returns the same shape as the existing Tauri command.
- Tool registry diff against the table above is empty — no extra tools snuck in.

---

## Phase 3 — Settings UI

v1 ships the minimum surface needed for the user to opt in: an enable toggle, a port input, the connection URL with a copy button, and the localhost-trust caveat. No write-tool toggles (those land with the write tools themselves in v1.1).

### Step 3.1: Settings rows

**File: `src/components/settings/McpSettings.tsx`** (new)

Follow the 73px-tall row pattern from `GeneralSettings.tsx` (1px `black/10` dividers, `flex justify-between`).

Rows, in order:

1. **Enable MCP server** — `Toggle`. Saves to `mcp_enabled`. Toggling off calls `stop_mcp_server`; on calls `start_mcp_server` and reads back the bound port.
2. **Port** — `Input` (numeric, default `51983`). Saves to `mcp_port` on blur. Restart server on change.
3. **Connection URL** — readonly text + copy button. Renders `http://localhost:{actual_bound_port}/mcp`. Shows `mcp_last_error` if non-empty.
4. **Localhost-trust caveat** — copy block:
   > Quill's MCP server only listens on `localhost` (`127.0.0.1`). Any program running on this Mac under your account can connect to it without authentication. Quill is designed for single-user, single-machine use; do not enable MCP on a shared machine without trusting every signed-in user.
   Use `text-text-muted text-[12px] leading-5` and indent under the URL row.

### Step 3.2: Settings backend commands

**File: `src-tauri/src/commands/mcp.rs`** (new)

```rust
#[tauri::command]
pub async fn mcp_start(server: State<'_, McpServer>, ...) -> AppResult<u16>;

#[tauri::command]
pub async fn mcp_stop(server: State<'_, McpServer>) -> AppResult<()>;

#[tauri::command]
pub async fn mcp_status(server: State<'_, McpServer>) -> AppResult<McpStatus>;
//   McpStatus { running: bool, port: Option<u16>, last_error: Option<String> }
```

`mcp_start` reads the current `mcp_port` from settings (default 51983) and calls `server.start(state, port)`. On change of port via settings, the frontend issues `mcp_stop` + `mcp_start` rather than a dedicated `restart` — keeps the backend surface minimal.

The startup-gate in `lib.rs::setup()` already reads `mcp_enabled`; nothing changes there. The new commands just give the settings UI a runtime hook.

### Step 3.3: i18n keys

**Files:** `src/i18n/en.json`, `src/i18n/zh.json`

Add `settings.mcp.*` keys for: title, enable, port, url, copy, copied, localhostCaveat (multi-line), bindError, restartHint.

### Step 3.4: Wire into settings modal

**File: `src/components/settings/SettingsModal.tsx`** (or wherever tab list lives) — add an "MCP" tab in a natural slot in the existing list. Tab icon: `Plug` from lucide-react.

### Step 3.5: Verification (Phase 3)

- Toggle on/off → server starts/stops; `lsof -iTCP:51983 -sTCP:LISTEN` confirms.
- Change port → server restarts on the new port; URL row reflects the actual bound port.
- Bind to a port already in use → toggle stays off, error message appears below URL row, no crash.
- Copy button copies the URL.
- Localhost caveat is visible and reads cleanly in both EN and ZH.
- Setting persists across app restarts: enable, quit, relaunch, observe server bound to the same port automatically.

---

## Figma design prompt

> **MCP Settings tab** — a single settings tab inside the existing Quill settings modal. Same shell, same 73px-tall row pattern, same 1px `black/10` dividers as the General tab.
>
> **Structure (top to bottom):**
> 1. **Header row** — "MCP Server" title + a small "Beta" pill on the right.
> 2. **Enable row** — label "Enable MCP server", subtext "Lets MCP-compatible AI clients (Claude Code, Claude Desktop, Codex, Cursor) read your library — books, highlights, bookmarks, vocab, translations, and chat history.", `Toggle` on the right.
> 3. **Port row** — label "Port", numeric `Input` on the right (max width ~140px), default value `51983`. Subtext: "Local port for the MCP server. Default: 51983."
> 4. **Connection URL row** — label "Connection URL" + readonly text showing `http://localhost:51983/mcp` + small `Copy` button. When copied, button briefly shows `Check` + "Copied". On bind error, replace the URL line with red error text and a `RotateCw` retry button.
> 5. **Localhost-trust caveat** — full-width muted text block (`text-text-muted text-[12px] leading-5`), indented to align with the URL field. Reads: "Quill's MCP server only listens on `localhost` (`127.0.0.1`). Any program running on this Mac under your account can connect to it without authentication. Quill is designed for single-user, single-machine use; do not enable MCP on a shared machine without trusting every signed-in user." A small `ShieldAlert` icon in the gutter on the left.
>
> **States:**
> - Server off (rows 2–5 visible but the URL row is muted / shows "Server disabled").
> - Server on, healthy (URL row populated, copy button enabled).
> - Server on, bind error (URL row replaced with red error + retry).
> - Restart in flight (URL row shows a thin progress bar across its bottom edge for ~500ms).
>
> **Theme:** follows app theme variables. `bg-bg-surface`, `text-text-primary`, `text-text-muted`. Caveat block uses `bg-bg-muted/40` to softly differentiate from the toggle/input rows above.
>
> **Tab icon:** `Plug` from lucide-react.

---

## Files to add / modify

| File | Change |
|------|--------|
| `src-tauri/Cargo.toml` | Add `rmcp = "1.7"` (server + transport-streamable-http-server), `axum = "0.8"`, `tokio-util = "0.7"`, `schemars = "1"`; add `time` to `tokio` features |
| `src-tauri/src/mcp/mod.rs` | New: module facade |
| `src-tauri/src/mcp/state.rs` | New: `McpState` (Db clone) |
| `src-tauri/src/mcp/server.rs` | New: `McpServer` lifecycle + `QuillMcpHandler` + tool_router aggregator |
| `src-tauri/src/mcp/tools/mod.rs` | New: tool registry + forbidden-surface audit comment |
| `src-tauri/src/mcp/tools/library.rs` | New: list_books, get_book, get_collections |
| `src-tauri/src/mcp/tools/highlights.rs` | New: get_highlights |
| `src-tauri/src/mcp/tools/bookmarks.rs` | New: get_bookmarks |
| `src-tauri/src/mcp/tools/vocab.rs` | New: get_vocab_words, get_vocab_stats |
| `src-tauri/src/mcp/tools/translations.rs` | New: get_translations |
| `src-tauri/src/mcp/tools/chats.rs` | New: get_chat_history |
| `src-tauri/src/commands/mcp.rs` | New: mcp_start / mcp_stop / mcp_status |
| `src-tauri/src/commands/mod.rs` | Register `mcp` module |
| `src-tauri/src/commands/bookmarks.rs` | Extract `query_highlights`, `query_bookmarks` helpers |
| `src-tauri/src/commands/books.rs` | Extract `query_books`, `query_book` helpers (relative paths; Tauri wrapper resolves to absolute) |
| `src-tauri/src/commands/vocab.rs` | Extract `query_vocab_words`, `query_vocab_stats` helpers |
| `src-tauri/src/commands/translation.rs` | Extract `query_translations` helper |
| `src-tauri/src/commands/chats.rs` | Extract `query_chats`, `query_chat_messages` helpers |
| `src-tauri/src/commands/collections.rs` | Extract `query_collections` helper |
| `src-tauri/src/lib.rs` | Boot `McpServer` in `setup()` gated on `mcp_enabled`; register MCP commands; stop server on `RunEvent::ExitRequested` |
| `src/components/settings/McpSettings.tsx` | New: settings tab |
| `src/components/settings/SettingsModal.tsx` | Register MCP tab |
| `src/i18n/en.json` | Add `settings.mcp.*` keys |
| `src/i18n/zh.json` | Add `settings.mcp.*` keys (Chinese) |

---

## Verification (full)

1. `cargo check` and `cargo clippy --all-targets -- -D warnings` — clean with the new deps (rmcp 1.7, axum 0.8, tokio-util, schemars, tokio `time` feature).
2. `cargo test --workspace` — passes; the existing schema-version tests stay at 12 (no migration added in v1).
3. Integration via MCP inspector (`npx @modelcontextprotocol/inspector http://127.0.0.1:51983/mcp`) after enabling MCP in settings:
   - All 7 read tools listed (`list_books`, `get_book`, `get_collections`, `get_highlights`, `get_bookmarks`, `get_vocab_words`, `get_vocab_stats`, `get_translations`, `get_chat_history`).
   - Each returns the expected JSON shape against a seeded library.
   - File paths in `list_books` / `get_book` responses are **relative** (`books/<slug>.epub`), not absolute.
4. Lifecycle:
   - Toggle off → port no longer listening (`lsof -iTCP:51983 -sTCP:LISTEN`).
   - Toggle on → bound port matches the configured `mcp_port`.
   - Port change → old port released, new port bound (frontend issues stop+start).
   - Bind to port-in-use → settings UI surfaces error, server stays off, no crash.
   - App exit → port released cleanly (no orphan).
5. Persistence: enable → quit → relaunch → server bound automatically.
6. Security:
   - `netstat -an | grep 51983` shows the listening socket bound to `127.0.0.1` only, never `0.0.0.0`.
   - Tool registry diff against the Phase 2 table is empty (no settings/oauth/sync-infra surfaces snuck in — see `mcp/tools/mod.rs`).
   - `get_all_settings` style endpoints are NOT exposed; `Secrets` clone is NOT in `McpState`.
