# 30 — MCP Server

**Issue:** [#184](https://github.com/yicheng47/quill/issues/184)
**Spec:** [30 — MCP Server](../features/30-mcp-server.md)

## Context

Expose Quill's library to MCP-compatible AI clients (Claude Code, Codex) via a stdio MCP server. The MCP code lives inside the same `quill` binary; clients spawn `quill mcp` as a subprocess and exchange MCP messages over stdin/stdout. The subprocess opens the local SQLite materialized view (`quill.db`) **read-only** as a second SQLite connection, which works because the DB now runs in WAL mode (concurrent readers + one writer).

This plan ships in four phases. **Phase 1** stands up the stdio binary and the MCP handshake. **Phase 2** wires the library-management read tools. **Phase 3** ships the settings UI (per-client integration toggles + Copy MCP config). **Phase 4** adds write tools for book and collection management — the MCP subprocess opens the DB read-write, creates its own `SyncWriter`, and gates every write tool behind an opt-in "Allow write access" toggle (default off).

---

## Architect decisions (locked)

These are the inputs to this plan. Do not relitigate while implementing — open a follow-up if a constraint conflicts with reality.

1. **MCP scope = library management, not active reading.** Tools expose collections of saved data the user might want an AI client to help organize, search, or annotate (books, collections, highlights, bookmarks, vocab list, translations, chat history). Active-reading-session state (current position, SRS due queue) stays in-app and is intentionally NOT exposed — the in-app reader is the right surface for that.
2. **stdio transport, not HTTP.** AI clients spawn `quill mcp` as a subprocess and the MCP session lives as long as the client uses it. No port to manage, no auth surface, no in-process server inside the Tauri app. This is the standard MCP shape and works whether or not the Quill desktop app is currently running.
3. **Single binary, `mcp` subcommand.** `main.rs` dispatches on `argv[1] == "mcp"` to `quill_lib::mcp_stdio_main()`, otherwise launches the normal Tauri app. Avoids a second binary in the macOS app bundle and the packaging complexity that brings.
4. **WAL journal mode** for `quill.db`. The stdio subprocess opens its own SQLite connection; WAL is what lets that coexist with the Tauri app's writer without serializing on the file lock. Was already safe to switch — DELETE mode was a hangover from the pre-Chunk-6 era when `quill.db` lived in iCloud.
5. **Read-only by default.** Write tools (Phase 4) are gated behind a single "Allow write access" toggle in the MCP settings panel, default off. When off, the subprocess opens the DB read-only; when on, it opens read-write and creates its own `SyncWriter` so writes flow through the sync pipeline.
6. **`search_highlights` / FTS — deferred to v1.1.** No FTS infra exists in `quill.db` today; AI clients can call `get_highlights(book_id)` and filter client-side for v1.
7. **`get_vocab_stats` — included.** `commands/vocab.rs::get_vocab_stats` already exposes the aggregate; wiring it into MCP is a free win for library-overview queries.
8. **Client integrations (v1): Claude Code + Codex CLI.** Settings UI auto-registers Quill in those two clients' config files. Custom integrations get a "Copy MCP config" escape hatch.

---

## Hard constraints (security & integrity)

- **`Db` is already `Arc`-cloneable** (db.rs:31-43). When the stdio subprocess opens the DB, it constructs a separate `Db` instance via `Db::open_readonly`; the cheap-clone shape isn't relevant on that side because there's only one process-local consumer (the MCP handler).
- **stdio subprocess opens read-only.** `Db::open_readonly` uses `SQLITE_OPEN_READ_ONLY`. v1 has no write tools, so the read-only flag enforces "MCP can't mutate the library" at the SQLite layer regardless of what tool code does.
- **MCP MUST NOT expose `settings` or `oauth` data.** `commands::settings::get_all_settings` merges `ai_api_key` from secrets into its return map — wrapping it as an MCP tool would leak the API key. The `Secrets` store is a separate `Mutex<Connection>` and the stdio entry point intentionally does NOT open it.
- **Internal sync tables are off-limits.** `_replay_state`, `_tombstones`, `_pending_publish` (migrations 010/011) are sync infra, not user data. No MCP tool may read or write them.
- **Diagnostics on stderr only.** stdout is the MCP wire; any `eprintln!` / log line that lands on stdout corrupts the JSON-RPC stream. `mcp_stdio_main` uses `eprintln!` for startup errors before handing the streams to rmcp.

---

## Architecture

### Module layout

```
src-tauri/src/mcp/
  mod.rs              # public facade: re-exports McpState
  server.rs           # QuillMcpHandler + tool_router aggregator
                      # + ServerHandler impl + serve_stdio entry helper
  state.rs            # McpState — Db clone (v1.1 adds SyncWriter + write-tool toggles)
  tools/
    mod.rs            # forbidden-surface audit comment, submodule declarations
    library.rs        # list_books, get_book, get_collections
    highlights.rs     # get_highlights
    bookmarks.rs      # get_bookmarks
    vocab.rs          # get_vocab_words, get_vocab_stats
    translations.rs   # get_translations
    chats.rs          # get_chat_history
    collections.rs    # Phase 4: create/rename/delete collection, add/remove book
```

`src/lib.rs::mcp_stdio_main()` is the binary-mode entry point. `src/main.rs` dispatches to it on `argv[1] == "mcp"`.

### Subprocess lifecycle

There's no in-process server. The lifecycle is whatever the AI client decides:

1. Client launches; reads its MCP config; sees an entry pointing at `/path/to/quill mcp`.
2. Client spawns the binary as a subprocess with piped stdin/stdout.
3. The subprocess calls `resolve_app_data_dir()` → opens `local_dir/quill.db` read-only → constructs `McpState` → runs `mcp::server::serve_stdio(state)` on a current-thread tokio runtime.
4. rmcp handles the MCP handshake + tool calls until the client closes stdin (or sends `notifications/cancelled`).
5. `serve_stdio` returns; `mcp_stdio_main` exits.

Crash recovery is the client's problem. Quill's only invariant: open the DB read-only, don't pollute stdout.

### Write-tool architecture (Phase 4)

The MCP subprocess opens the DB read-write when the "Allow write access" setting is enabled. It constructs its own `SyncWriter` using the same `node_id` as the host Tauri app (read from the `settings` table at startup). This means MCP writes look identical to app writes from the sync engine's perspective — same device, same timeline, same `_pending_publish` pipeline.

**Why same device ID:** Using a separate device ID (e.g. `mcp-<uuid>`) would cause the sync engine to treat MCP writes as remote changes, triggering unnecessary conflict resolution. The MCP subprocess is the user writing from the same machine; it should share the device identity.

**SyncWriter mode:** `should_queue = true`, `log = None`. Events accumulate in `_pending_publish`; the Tauri app's `ReplayEngine::tick` drains them on its next cycle.

**Write toggle:** A single `mcp_write_enabled` key in the `settings` table (default `"false"`). The MCP settings UI adds a toggle row. `mcp_stdio_main` reads this setting at startup: `"true"` → `Db::open_readwrite` + `SyncWriter`; anything else → `Db::open_readonly` + write tools return "write access disabled" errors.

**Real-time UI refresh via sentinel file:** After each write transaction, the MCP subprocess overwrites `$APP_DATA/.mcp-notify` with a single-line JSON payload: `{"domain":"books","action":"created","id":"abc-123","ts":1716550000}`. The file never grows — each write replaces the previous content (~80 bytes). The Tauri app watches this file with the `notify` crate (native FSEvents on macOS). On change, it reads the payload and emits a domain-specific Tauri event (`mcp:books-changed` or `mcp:collections-changed`). `Home.tsx` listens for these events and calls the existing `refresh()` / `refreshCollectionBooks()` functions — no changes to hooks needed.

---

## Phase 1 — Stdio binary infrastructure

### Step 1.1: Dependencies

**File: `src-tauri/Cargo.toml`**

```toml
rmcp = { version = "1.7", features = ["server", "transport-io"] }
schemars = "1"
```

`transport-io` pulls `tokio/io-std` transitively (for `tokio::io::stdin/stdout`). No `axum`, no HTTP server stack.

### Step 1.2: Switch SQLite to WAL

**File: `src-tauri/src/db.rs`** — change every `PRAGMA journal_mode=DELETE` to `PRAGMA journal_mode=WAL` (production path in `init_split`, plus the two migration-test seed paths so tests run on the same mode as production).

WAL is safe because `quill.db` is local-only post Chunk-6. Pre-Chunk-6 it lived in iCloud, where the `-wal`/`-shm` companion files don't sync atomically; that was the original reason DELETE was pinned.

### Step 1.3: Read-only Db constructor

**File: `src-tauri/src/db.rs`** — add `Db::open_readonly(db_path: &Path) -> AppResult<Self>` that uses `Connection::open_with_flags(.., SQLITE_OPEN_READ_ONLY | SQLITE_OPEN_NO_MUTEX | SQLITE_OPEN_URI)` and does NOT run migrations. The Tauri app is the sole owner of schema changes; the stdio subprocess sees whatever schema is on disk.

`data_dir` is set to `db_path.parent()` as a placeholder — the v1 read tools don't touch it.

### Step 1.4: stdio module + serve helper

**File: `src-tauri/src/mcp/server.rs`** (rewritten from the HTTP-server version):

```rust
#[derive(Clone)]
pub(crate) struct QuillMcpHandler { pub(crate) state: McpState }

impl QuillMcpHandler {
    pub(crate) fn new(state: McpState) -> Self { Self { state } }

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
    fn get_info(&self) -> ServerInfo { /* enable_tools(), instructions, etc. */ }
}

pub(crate) async fn serve_stdio(state: McpState) -> Result<(), Box<dyn std::error::Error>> {
    let handler = QuillMcpHandler::new(state);
    let server = handler.serve(rmcp::transport::io::stdio()).await?;
    let _quit = server.waiting().await?;
    Ok(())
}
```

`#[tool_handler]` generates `call_tool` / `list_tools` against `Self::tool_router()`. The hand-written `get_info` stays as-is.

### Step 1.5: Binary entry point

**File: `src-tauri/src/main.rs`** — dispatch on `argv[1]`:

```rust
fn main() {
    let mut args = std::env::args();
    let _exe = args.next();
    if args.next().as_deref() == Some("mcp") {
        quill_lib::mcp_stdio_main();
        return;
    }
    quill_lib::run()
}
```

**File: `src-tauri/src/lib.rs`** — add `pub fn mcp_stdio_main()` that:
1. Calls `resolve_app_data_dir()` (new helper, mirrors `resolve_log_dir`'s platform handling but returns Application Support / APPDATA / XDG_DATA_HOME).
2. Asserts `quill.db` exists; eprintln + exit(1) with a "launch the app first" hint if not.
3. Opens the DB via `Db::open_readonly`.
4. Constructs `McpState`.
5. Builds a current-thread tokio runtime and `block_on(mcp::server::serve_stdio(state))`.

Also rip out the previous in-process MCP server boot (`mcp_enabled` gating + `app.manage(mcp_server)` + `RunEvent::ExitRequested` teardown). The Tauri app no longer hosts MCP.

### Step 1.6: Verification (Phase 1)

- `cargo build` produces a single `target/debug/quill` binary.
- Smoke: pipe `initialize` + `notifications/initialized` + `tools/list` JSON-RPC lines into `target/debug/quill mcp`; expect a populated `tools` array + correct `serverInfo`.
- `quill mcp` exits cleanly when stdin closes.

---

## Phase 2 — Read tools

All read tools are pure SQLite queries that reuse the existing column shapes. Each Tauri command exposes a `pub(crate) fn query_*(db: &Db, ...) -> AppResult<...>` helper; the Tauri command becomes a thin wrapper and the MCP tool calls the same helper. No new SQL invented.

### Tool surface

| Tool | Args | Returns | Source |
|------|------|---------|--------|
| `list_books` | `filter?`, `search?` | `Vec<Book>` (relative paths) | books.rs `query_books` |
| `get_book` | `book_id` | `Book` + progress (relative paths) | books.rs `query_book` |
| `get_highlights` | `book_id` | `Vec<Highlight>` (incl. `text_content`) | bookmarks.rs `query_highlights` |
| `get_bookmarks` | `book_id` | `Vec<Bookmark>` | bookmarks.rs `query_bookmarks` |
| `get_vocab_words` | `book_id` | `Vec<VocabWord>` (incl. mastery, SRS) | vocab.rs `query_vocab_words` |
| `get_vocab_stats` | — | aggregate counts by mastery | vocab.rs `query_vocab_stats` |
| `get_translations` | `book_id?` | `Vec<Translation>` | translation.rs `query_translations` |
| `get_collections` | — | `Vec<Collection>` + book counts | collections.rs `query_collections` |
| `get_chat_history` | `book_id`, `chat_id?` | chats + messages | chats.rs `query_chats` + `query_chat_messages` |

### Step 2.1: Extract shared query helpers

For each command listed above, factor the SELECT logic into a `pub(crate) fn query_*(db: &Db, ...) -> AppResult<...>` in the same module. The Tauri command becomes a thin wrapper. The MCP tool calls the same helper.

For `query_books` / `query_book`: return the **relative** file path (`books/<slug>.epub`) — the Tauri wrapper resolves to absolute via `resolve_book_paths`, but MCP responses keep paths relative so they don't leak the user's home directory layout.

### Step 2.2: Implement tools

rmcp 1.7's pattern is `#[tool_router]` impl blocks + `Parameters<T>` argument structs (NOT the older `#[tool(tool_box)]` / `#[tool(param)]` shape). Each `mcp/tools/<file>.rs` adds an `impl QuillMcpHandler` block decorated with `#[tool_router(router = …, vis = "pub(crate)")]`; the proc-macro emits a `pub(crate) fn <name>_router() -> ToolRouter<Self>`. The aggregator in `mcp/server.rs::tool_router` merges them.

Example (highlights.rs):

```rust
use rmcp::ErrorData;
use rmcp::handler::server::wrapper::Parameters;
use rmcp::model::{CallToolResult, Content};
use rmcp::{tool, tool_router};
use schemars::JsonSchema;
use serde::Deserialize;

#[derive(Debug, Deserialize, JsonSchema)]
pub struct GetHighlightsArgs {
    /// Book ID to fetch highlights for.
    pub book_id: String,
}

#[tool_router(router = highlights_router, vis = "pub(crate)")]
impl QuillMcpHandler {
    #[tool(description = "List all highlights for a book, including the highlighted text content.")]
    pub async fn get_highlights(
        &self,
        Parameters(GetHighlightsArgs { book_id }): Parameters<GetHighlightsArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let highlights = bookmarks::query_highlights(&self.state.db, &book_id)
            .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;
        Ok(CallToolResult::success(vec![Content::json(&highlights)?]))
    }
}
```

**Important:** `vis` is parsed by darling and requires a string literal (`vis = "pub(crate)"`), not a bare visibility (`vis = pub(crate)` fails to parse).

### Step 2.3: Forbidden surfaces — enforce via review, not code

There is no SQL-level enforcement; the `Db` connection sees everything. Instead, `mcp/tools/mod.rs` carries a comment block listing the forbidden surfaces (settings, oauth, secrets store, sync infra tables, device identity, sync logs). PR review verifies the tool registry contains only the tools listed in the table above.

### Step 2.4: Verification (Phase 2)

- Smoke via `printf … | target/debug/quill mcp` (or `npx @modelcontextprotocol/inspector --command /path/to/quill --args mcp`):
  - `tools/list` returns all 9 tools.
  - `get_highlights(book_id)` returns rows with `text_content` populated.
  - `get_vocab_stats()` returns the same shape as the existing Tauri command.
  - `list_books` paths are **relative** (`books/<slug>.epub`).
- Tool registry diff against the table above is empty — no extra tools snuck in.

---

## Phase 3 — Settings UI

Lives under the **AI Assistant** section of the existing Settings modal (NOT a standalone top-level tab). The MCP UI is a section among AI provider/model controls.

Pattern follows tools that "auto-register Quill with each AI client": for each supported client (Claude Code, Codex), a toggle writes/removes the Quill entry in that client's MCP config file. A "Copy MCP config" escape hatch produces a JSON snippet for clients we don't natively support.

### Step 3.1: Settings rows (within AI Assistant section)

**File: `src/components/settings/AiAssistantSettings.tsx`** (existing or new) — append a section titled "MCP Integrations" with:

1. **Section header** "MCP Integrations" + short subtitle: "Let AI clients read your library — books, highlights, bookmarks, vocab, translations, and chat history. Read-only."
2. **Per-client toggle rows**, identical row shape to the General settings rows:
   - **Claude Code CLI** — toggle. On = write entry to `~/.claude.json` (user-scoped) or project-scoped `.mcp.json` (decide per-platform). Subtext: "Auto-register Quill with Claude Code."
   - **Codex CLI** — toggle. Subtext: "Auto-register Quill with Codex."
3. **Custom MCP Server Configuration** subsection (collapsed-by-default):
   - Description: "For any MCP client we don't ship a direct integration for. Paste this JSON snippet into the client's MCP config."
   - "Copy MCP config" button — copies the JSON snippet (see §3.3).
4. **Localhost-trust caveat** — full-width muted text block at the bottom of the section:
   > Quill's MCP server runs as a local subprocess on this Mac. Any AI client running under your account can launch it and read your library. Don't enable MCP integrations on a shared machine without trusting every signed-in user.

### Step 3.2: Backend Tauri commands

**File: `src-tauri/src/commands/mcp.rs`** (new)

```rust
#[tauri::command]
pub fn mcp_integration_status() -> AppResult<McpIntegrationStatus>;
//   McpIntegrationStatus { claude_code: bool, codex: bool, binary_path: String }

#[tauri::command]
pub fn mcp_set_integration(client: String, enabled: bool) -> AppResult<()>;
//   client ∈ {"claude_code", "codex"}; writes/removes the Quill entry

#[tauri::command]
pub fn mcp_config_snippet() -> AppResult<String>;
//   Returns the JSON snippet for manual config (used by Copy button)
```

`binary_path` resolves via `std::env::current_exe()` so the registered command always points to *this build* of the Quill binary. On macOS that resolves to `<Quill.app>/Contents/MacOS/Quill` in a packaged install or `target/debug/quill` in dev.

Config-file paths per client (resolved at write-time, created if absent, never destructive merge):
- **Claude Code:** `~/.claude.json` — read existing JSON, set `mcpServers.quill = {"command": <binary_path>, "args": ["mcp"]}`, write back. Removing reverses (delete the key if present).
- **Codex:** `~/.codex/config.toml` (TOML format; needs the `toml` crate) — set `[mcp_servers.quill] command = …, args = ["mcp"]`.

### Step 3.3: MCP config snippet

```json
{
  "mcpServers": {
    "quill": {
      "command": "/path/to/Quill.app/Contents/MacOS/Quill",
      "args": ["mcp"]
    }
  }
}
```

The exact path is `current_exe()` at runtime. The snippet is what `mcp_config_snippet()` returns.

### Step 3.4: i18n keys

**Files:** `src/i18n/en.json`, `src/i18n/zh.json`

Add `settings.ai.mcp.*` keys for: header, subtitle, claudeCodeLabel, claudeCodeSubtext, codexLabel, codexSubtext, customHeader, customSubtitle, copyConfig, copied, localhostCaveat.

### Step 3.5: Verification (Phase 3)

- Toggle Claude Code on → `~/.claude.json` gains `mcpServers.quill` entry pointing at the current binary; toggle off → entry removed; other clients in that file are untouched.
- Toggle Codex on → `~/.codex/config.toml` gains `[mcp_servers.quill]`; toggle off removes it.
- Copy MCP config button copies a valid snippet to the clipboard.
- Launch Claude Code after enabling the integration → `claude mcp list` shows `quill`; `claude mcp` session can invoke `list_books`.
- Disable each client → its config no longer has the entry; the file isn't corrupted.

---

## Phase 4 — Write tools (book & collection management)

Adds 8 write tools for library management. All gated behind a single "Allow write access" toggle (default off). The MCP subprocess opens the DB read-write and creates its own `SyncWriter` when the toggle is on.

### Tool surface

| Tool | Args | Returns | Source helper |
|------|------|---------|---------------|
| `add_book` | `file_path` | `McpBook` | books.rs — new `import_book_from_path` |
| `update_book` | `book_id`, `title?`, `author?`, `genre?`, `status?` | `McpBook` | books.rs `update_book_metadata` + `update_book_status` |
| `delete_book` | `book_id` | confirmation | books.rs — new `delete_book_with_sync` |
| `create_collection` | `name` | `Collection` | collections.rs `create_collection` logic |
| `rename_collection` | `id`, `name` | confirmation | collections.rs `rename_collection` logic |
| `delete_collection` | `id` | confirmation | collections.rs `delete_collection` logic |
| `add_book_to_collection` | `collection_id`, `book_id` | confirmation | collections.rs `add_book_to_collection` logic |
| `remove_book_from_collection` | `collection_id`, `book_id` | confirmation | collections.rs `remove_book_from_collection` logic |

### Step 4.1: DB open mode switch

**File: `src-tauri/src/db.rs`** — add `Db::open_readwrite(db_path: &Path) -> AppResult<Self>` that uses `SQLITE_OPEN_READ_WRITE | SQLITE_OPEN_NO_MUTEX | SQLITE_OPEN_URI`. Like `open_readonly`, it does NOT run migrations — the Tauri app owns schema evolution.

**File: `src-tauri/src/lib.rs`** — `mcp_stdio_main` reads `mcp_write_enabled` from the settings table after opening the DB read-only. If `"true"`, re-opens read-write and constructs a `SyncWriter` using the `node_id` from settings. If false (or missing), stays read-only.

### Step 4.2: McpState expansion

**File: `src-tauri/src/mcp/state.rs`** — add optional `SyncWriter`:

```rust
pub struct McpState {
    pub db: Db,
    pub sync: Option<SyncWriter>,
}
```

Write tools check `self.state.sync.as_ref()` and return a clear error ("write access is disabled — enable it in Quill settings") when `None`.

### Step 4.3: Extract write helpers

Factor the write logic out of the existing Tauri commands into `pub(crate)` helpers, same pattern as Phase 2's read helpers. Each helper takes `&Db` + `&SyncWriter` instead of Tauri `State<>` wrappers.

**`books.rs`:**
- `pub(crate) fn import_book_from_path(db: &Db, sync: &SyncWriter, file_path: &str) -> AppResult<Book>` — detects format by extension (`.epub` / `.pdf`), extracts metadata, copies file to app data, inserts DB row via `sync.with_tx`. For PDF, uses a Rust-side page counter (or defaults to 0 if unavailable — the frontend's pdf.js-based count is authoritative and will overwrite on first open).
- `pub(crate) fn update_book_fields(db: &Db, sync: &SyncWriter, id: &str, title: Option<&str>, author: Option<&str>, genre: Option<&str>, status: Option<&str>) -> AppResult<Book>` — partial update, only touches fields that are `Some`.
- `pub(crate) fn delete_book_with_files(db: &Db, sync: &SyncWriter, id: &str) -> AppResult<()>` — cascade deletes (chats, chat_messages, highlights, bookmarks, etc.) + removes book/cover files from disk.

**`collections.rs`:**
- Extract the bodies of `create_collection`, `rename_collection`, `delete_collection`, `add_book_to_collection`, `remove_book_from_collection` into `pub(crate)` helpers taking `&Db` + `&SyncWriter`.

### Step 4.4: Implement write tool handlers

**File: `src-tauri/src/mcp/tools/library.rs`** — add `add_book`, `update_book`, `delete_book` to the existing `library_router` impl block.

**File: `src-tauri/src/mcp/tools/collections.rs`** (new) — `create_collection`, `rename_collection`, `delete_collection`, `add_book_to_collection`, `remove_book_from_collection` behind a `#[tool_router(router = collections_write_router, vis = "pub(crate)")]`.

Each handler:
1. Checks `self.state.sync.as_ref()` — returns error if `None`.
2. Calls the extracted `pub(crate)` helper.
3. Writes the sentinel notification (see §4.6).
4. Returns the result as `CallToolResult::success(vec![Content::json(&result)?])`.

### Step 4.5: Sentinel file notification

**MCP subprocess side:** After each successful write transaction, overwrite `$APP_DATA/.mcp-notify` with a single-line JSON payload:

```json
{"domain":"books","action":"created","id":"abc-123","ts":1716550000}
```

The file is always overwritten (not appended) — stays ~80 bytes. Helper: `McpState::notify(domain, action, id)`.

**Tauri app side (`src-tauri/src/lib.rs`):** On setup, spawn a background task that watches `$APP_DATA/.mcp-notify` using the `notify` crate (native FSEvents on macOS, inotify on Linux). On file change:
1. Read the JSON payload.
2. Map `domain` to a Tauri event name: `"books"` → `mcp:books-changed`, `"collections"` → `mcp:collections-changed`.
3. Emit the event via `app_handle.emit(event_name, payload)`.

**Frontend (`src/pages/Home.tsx`):** Add two `listen()` calls in a `useEffect`:
- `mcp:books-changed` → call `refresh()` + `allBooks.refresh()`.
- `mcp:collections-changed` → call `refreshCollectionBooks()`.

No changes to hooks — the existing imperative `refresh()` pattern handles it.

### Step 4.6: Settings UI — write access toggle

**File: `src/components/settings/McpSettings.tsx`** — add a toggle row for "Allow write access" between the client integration toggles and the Custom MCP Server section. Subtext: "Let MCP clients add, update, and delete books and collections." Warning color or icon to signal this is a privilege escalation.

**Backend:** `mcp_integration_status` grows a `write_enabled: bool` field. `mcp_set_write_access(enabled: bool)` writes `mcp_write_enabled` to the settings table.

**i18n:** Add `settings.mcp.writeAccess`, `settings.mcp.writeAccessSub` keys.

### Step 4.7: Register new tools conditionally

The write tools are always registered in the tool router (they always appear in `tools/list`). The gate is at call time: if `McpState.sync` is `None`, the handler returns an error with a human-readable message. This way AI clients can discover the tools exist and tell the user how to enable them, rather than the tools silently disappearing.

### Step 4.8: Verification (Phase 4)

1. **Write toggle off (default):**
   - `tools/list` shows all 16 tools (9 read + 7 write; `update_book` covers both metadata and status).
   - Calling any write tool returns an error: "write access is disabled."
   - DB is opened read-only — even a bug in tool code can't mutate.
2. **Write toggle on:**
   - `add_book("/path/to/book.epub")` → book appears in library, file copied to app data, cover extracted.
   - `update_book(id, title="New Title")` → title changed, other fields untouched.
   - `delete_book(id)` → book + cover files removed, cascaded deletes (chats, highlights, etc.).
   - `create_collection("Sci-Fi")` → collection created with next sort_order.
   - `add_book_to_collection(collection_id, book_id)` → association created.
   - `remove_book_from_collection` + `delete_collection` → clean removal.
   - `rename_collection(id, "Science Fiction")` → name updated.
3. **Sync integration:**
   - Write tool → `_pending_publish` row created → Tauri app's `ReplayEngine::tick` picks it up → syncs to other devices.
   - `updated_by_device` matches the host app's `node_id`.
4. **Real-time notification:**
   - MCP `add_book` → `.mcp-notify` written → Tauri app's watcher fires → `mcp:books-changed` emitted → `Home.tsx` refetches books.
   - MCP `create_collection` → `mcp:collections-changed` emitted → sidebar collections refresh.
   - Sentinel file stays ~80 bytes after any number of writes.
5. **Concurrency:**
   - MCP subprocess writing while Tauri app is running: both succeed (WAL).
   - Tauri app's next read sees MCP's writes immediately.
6. **Security:**
   - Write tools still cannot touch settings, oauth, secrets, or sync infra tables.
   - `delete_book` cascade matches the Tauri app's `cascade_delete_book` exactly.

---

## Figma design prompt

> **AI Assistant settings tab** — extend the existing AI Assistant settings panel with an "MCP Integrations" section at the bottom. Same shell, same 73px-tall row pattern, same 1px `black/10` dividers as the General tab.
>
> **MCP Integrations section structure (top to bottom):**
> 1. **Section header** — "MCP Integrations" title + a `Plug` icon on the left in the gutter. Small "Beta" pill on the right.
> 2. **Subtitle** — "Let AI clients read your library — books, highlights, bookmarks, vocab, translations, and chat history. Read-only."
> 3. **Claude Code CLI row** — label "Claude Code CLI", subtext "Auto-register Quill with Claude Code.", `Toggle` on the right.
> 4. **Codex CLI row** — label "Codex CLI", subtext "Auto-register Quill with Codex.", `Toggle` on the right.
> 5. **Custom MCP Server subsection** — collapsible. Header "Custom MCP Server Configuration" + "Copy MCP config" button on the right. Expanded body has a short paragraph + a syntax-highlighted JSON snippet preview.
> 6. **Localhost-trust caveat** — full-width muted text block (`text-text-muted text-[12px] leading-5`), `ShieldAlert` icon in the gutter on the left.
>
> **States:**
> - Each integration toggle independently on/off; visual state matches.
> - Config-write error (rare): toggle reverts + inline red error message ("Couldn't update ~/.claude.json — check file permissions.").
> - Custom section collapsed by default; expand shows the JSON.
>
> **Theme:** follows app theme variables. `bg-bg-surface`, `text-text-primary`, `text-text-muted`. Caveat block uses `bg-bg-muted/40` to softly differentiate.

---

## Files to add / modify

| File | Change |
|------|--------|
| `src-tauri/Cargo.toml` | Add `rmcp = "1.7"` (server + transport-io), `schemars = "1"`, `notify = "7"` (Phase 4: fs watcher for sentinel). |
| `src-tauri/src/db.rs` | Switch `journal_mode=DELETE` → `WAL` (3 sites). Add `Db::open_readonly(db_path)` for the stdio subprocess. |
| `src-tauri/src/mcp/mod.rs` | New: module facade — re-exports `McpState`. |
| `src-tauri/src/mcp/state.rs` | New: `McpState` (Db clone). |
| `src-tauri/src/mcp/server.rs` | New: `QuillMcpHandler` + `tool_router` aggregator + `#[tool_handler]` ServerHandler impl + `serve_stdio` helper. |
| `src-tauri/src/mcp/tools/mod.rs` | New: forbidden-surface audit comment + submodule declarations. |
| `src-tauri/src/mcp/tools/library.rs` | New: list_books, get_book, get_collections. |
| `src-tauri/src/mcp/tools/highlights.rs` | New: get_highlights. |
| `src-tauri/src/mcp/tools/bookmarks.rs` | New: get_bookmarks. |
| `src-tauri/src/mcp/tools/vocab.rs` | New: get_vocab_words, get_vocab_stats. |
| `src-tauri/src/mcp/tools/translations.rs` | New: get_translations. |
| `src-tauri/src/mcp/tools/chats.rs` | New: get_chat_history. |
| `src-tauri/src/commands/mcp.rs` | New: mcp_integration_status / mcp_set_integration / mcp_config_snippet. |
| `src-tauri/src/commands/mod.rs` | Register `mcp` module. |
| `src-tauri/src/commands/bookmarks.rs` | Extract `query_highlights`, `query_bookmarks` helpers. |
| `src-tauri/src/commands/books.rs` | Extract `query_books`, `query_book` helpers (relative paths). |
| `src-tauri/src/commands/vocab.rs` | Extract `query_vocab_words`, `query_vocab_stats` helpers. |
| `src-tauri/src/commands/translation.rs` | Extract `query_translations` helper. |
| `src-tauri/src/commands/chats.rs` | Extract `query_chats`, `query_chat_messages` helpers. |
| `src-tauri/src/commands/collections.rs` | Extract `query_collections` helper. |
| `src-tauri/src/main.rs` | Dispatch `argv[1] == "mcp"` → `quill_lib::mcp_stdio_main()`. |
| `src-tauri/src/lib.rs` | Add `resolve_app_data_dir` + `mcp_stdio_main`. Remove the old in-process MCP server boot + `ExitRequested` teardown. Register the new MCP Tauri commands. |
| `src/components/settings/McpSettings.tsx` | MCP settings panel — client toggles, write access toggle, copy config. |
| `src/i18n/en.json` | Add `settings.mcp.*` keys. |
| `src/i18n/zh.json` | Add `settings.mcp.*` keys (Chinese). |
| `src-tauri/src/mcp/tools/collections.rs` | Phase 4: collection write tools (create/rename/delete, add/remove book). |
| `src-tauri/src/mcp/state.rs` | Phase 4: add `Option<SyncWriter>` to McpState. |

---

## Verification (full)

1. `cargo check` and `cargo clippy --all-targets -- -D warnings` — clean.
2. `cargo test --workspace` — passes; schema-version assertions stay at 12 (no migration added in v1).
3. `target/debug/quill mcp` smoke test:
   - `initialize` returns serverInfo + `capabilities.tools`.
   - `tools/list` returns all 9 tools with populated schemas.
   - `tools/call` for `get_collections` (no args) returns the library's collections.
   - `tools/call` for `list_books` returns books with **relative** paths.
   - Exits cleanly when stdin closes.
4. Settings UI:
   - Toggling Claude Code writes `~/.claude.json::mcpServers.quill` with `command = current_exe()`, `args = ["mcp"]`. Other entries in the file are preserved.
   - Toggling Codex writes/removes `~/.codex/config.toml::[mcp_servers.quill]`.
   - Copy MCP config produces a valid JSON snippet matching the same shape.
5. End-to-end with Claude Code:
   - Enable in Quill settings → `claude mcp list` shows `quill` → invoke `list_books` from a Claude session → receives the library.
6. Concurrency:
   - Tauri app running + `quill mcp` subprocess running simultaneously: subprocess reads succeed, app writes succeed (WAL allows both).
   - Forcibly killing the subprocess does NOT corrupt the WAL or block the Tauri app.
7. Security:
   - With write toggle off: subprocess opens DB read-only — mutations impossible at the SQLite layer.
   - With write toggle on: writes go through `SyncWriter::with_tx` — same sync guarantees as the Tauri app.
   - `get_all_settings` style endpoints are NOT exposed; `Secrets` clone is NOT in `McpState`.
   - Write tools cannot touch settings, oauth, secrets, or sync infra tables.
   - Tool registry diff against the Phase 2 + Phase 4 tables is empty (no extra surfaces snuck in).
8. Write tools (Phase 4):
   - `add_book` with an epub → book in library, cover extracted, file copied.
   - `update_book` with partial fields → only specified fields change.
   - `delete_book` → cascade deletes + file cleanup.
   - Collection CRUD round-trip: create → rename → add book → remove book → delete.
   - All writes produce `_pending_publish` rows that the Tauri app's sync engine drains.
