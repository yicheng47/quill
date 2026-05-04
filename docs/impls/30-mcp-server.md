# 30 — MCP Server

**Issue:** [#184](https://github.com/yicheng47/quill/issues/184)
**Spec:** [30 — MCP Server](../features/30-mcp-server.md)

## Context

Expose Quill's reading data to any MCP-compatible AI client (Claude Code, Claude Desktop, Codex, Cursor) via a local HTTP/SSE server using the official `rmcp` Rust SDK. The MCP server runs in-process with Tauri, shares the existing SQLite materialized view (`quill.db`), and pushes Tauri events on writes so open windows refresh.

This plan implements all four phases of the spec. Phase 1 stands up the server lifecycle and handshake; Phase 2 wires read tools; Phase 3 adds the four opt-in write tools and the frontend reading-state bridge; Phase 4 ships the settings UI.

---

## Architect decisions (locked)

These are the inputs to this plan. Do not relitigate while implementing — open a follow-up if a constraint conflicts with reality.

1. **Read-only by default.** Each of the four write tools (`add_highlight`, `add_bookmark`, `add_vocab_word`, `update_vocab_mastery`) gets its own opt-in toggle in settings. All four default to off. Read tools are always on whenever the server is on.
2. **`search_highlights` / FTS — deferred to v1.1.** No FTS infra exists in `quill.db` today; AI clients can call `get_highlights(book_id)` and filter client-side for v1. Spec's "Out of scope" should record this.
3. **`get_vocab_stats` — included.** `commands/vocab.rs:251` already exposes the aggregate; wiring it into MCP is a free win. Reading-stats tool is deferred until feature 27 ships.
4. **MCP writes propagate to peers.** Writes go through `SyncWriter::with_tx`, hit the LWW outbox, and replay on peer devices like any other write. This is intended behavior, not a leak; do not add a filter.
5. **Multi-window reading state — most-recently-focused wins.** The frontend bridge writes a single global "current reading state" row; whichever reader window pushes last is what `get_reading_state` returns.

---

## Hard constraints (security & integrity)

These come out of the impl-validation audit (settings.rs:10-23, secrets.rs:15-21, lib.rs:309). Any deviation is a revision.

- **`Db` is already `Arc`-cloneable** (db.rs:31-43). The MCP server holds a `Db` clone, never an `Arc<Db>` wrapper. Take the clone before `app.manage(db)` at lib.rs:309.
- **`SyncWriter` is `Arc`-shaped too** — write tools need a clone. Writes flow through `sync.with_tx(&db, ...)` (bookmarks.rs:52, 130) so the LWW outbox keeps working.
- **Bind explicitly to `127.0.0.1`**, never `0.0.0.0`. MCP is localhost-only per spec; misconfigured binds expose the user's library to the LAN.
- **MCP MUST NOT expose `settings` or `oauth` data.** `commands::settings::get_all_settings` (settings.rs:10-23, lines 18-20) merges `ai_api_key` from secrets into its return map — wrapping it as an MCP tool would leak the API key. If a future release ever wants partial settings exposure, filter via `Secrets::SENSITIVE_KEYS` at secrets.rs:15-21 (the canonical list).
- **Internal sync tables are off-limits.** `_replay_state`, `_tombstones`, `_pending_publish` (migrations 010/011) are sync infra, not user data. No MCP tool may read or write them.
- **Frontend bridge uses Tauri `invoke`, not events.** `useReadingState` debounces and `invoke`s a backend command to update a `reading_state` row. Events are the wrong shape (no acknowledgement, no replay on reconnect).
- **MCP-write notifications use a single fixed event name** (`mcp-data-changed`), payload includes a resource tag (e.g. `"highlights"`, `"bookmarks"`). Per-request channels (CLAUDE.md AI streaming pattern) are for streaming responses to the same caller — wrong shape for fan-out to UI listeners. The fixed-event pattern matches `app.emit(...)` calls in `commands/ai.rs:153,157`.

---

## Architecture

### Module layout

```
src-tauri/src/mcp/
  mod.rs              # public facade: McpServer, McpConfig, start/stop
  server.rs           # axum app + rmcp service wiring, oneshot shutdown
  state.rs            # McpState — Db + SyncWriter + AppHandle clones, write-tool toggles
  tools/
    mod.rs            # tool registry (rmcp #[tool] aggregation)
    library.rs        # list_books, get_book, get_collections
    highlights.rs     # get_highlights, add_highlight
    bookmarks.rs      # get_bookmarks, add_bookmark
    vocab.rs          # get_vocab_words, get_vocab_due, get_vocab_stats,
                      # add_vocab_word, update_vocab_mastery
    translations.rs   # get_translations
    chats.rs          # get_chat_history
    reading_state.rs  # get_reading_state
  notify.rs           # emit_data_changed(resource) helper
```

### Server lifecycle

A single `McpServer` struct owns:
- An `Option<oneshot::Sender<()>>` shutdown handle (None when stopped)
- The bound port (so the settings UI can read back the actual bind result)
- A `JoinHandle<()>` for the axum task (stored so we can `.await` it on shutdown)

State transitions, all driven from settings or app exit:
- `start(port)` — spawn axum on `tauri::async_runtime::spawn`, install the oneshot rx as `axum::Server::with_graceful_shutdown`. If `TcpListener::bind` fails, return the bind error and persist `mcp_last_error` to settings — do NOT auto-increment the port.
- `stop()` — drop the oneshot sender, await the join handle, clear state.
- `restart(port)` — `stop()` then `start(port)`.

`McpServer` lives in Tauri app state (`app.manage(McpServer::new())`). Settings commands toggle/configure it.

### Write-tool toggles

Four boolean settings, each independently togglable:
- `mcp_write_highlights` (default `false`)
- `mcp_write_bookmarks` (default `false`)
- `mcp_write_vocab_add` (default `false`)
- `mcp_write_vocab_mastery` (default `false`)

`McpState` holds these as `Arc<AtomicBool>` so the running server can observe live changes without restart. Each write tool's handler short-circuits with `McpError::tool_not_enabled` if its flag is false. Tool *visibility* (whether the tool is registered at all) stays static — clients can introspect what Quill could do, just not invoke disabled writes. This avoids `tools/list_changed` churn on every settings flip.

### Frontend bridge: reading state

A new `reading_state` table (single row, key = `"current"`) holds:
```sql
CREATE TABLE IF NOT EXISTS reading_state (
  key          TEXT PRIMARY KEY,    -- always "current" for v1
  book_id      TEXT,
  cfi          TEXT,
  chapter_idx  INTEGER,
  chapter_name TEXT,
  selection    TEXT,                -- currently-selected text, if any
  window_label TEXT,                -- which reader window pushed this
  updated_at   INTEGER NOT NULL
);
```
Written via a new `set_reading_state` Tauri command (debounced ~250ms in the frontend hook). `get_reading_state` MCP tool reads the single row. Most-recently-focused window is implicit — last write wins. NOT replicated through `SyncWriter`; this is local-only ephemeral state.

### Notification channel

`notify::emit_data_changed(app, resource)` calls `app.emit("mcp-data-changed", { resource })`. Frontend `useEffect` in each list view (`useBooks`, `useHighlights`, `useVocab`, `useBookmarks`) listens and refetches its query when the matching resource fires. One event name, one payload shape.

---

## Phase 1 — Server infrastructure

### Step 1.1: Add dependencies

**File: `src-tauri/Cargo.toml`**

```toml
# pin rmcp at the exact published version known to work with rmcp 0.1.x stable;
# audit before bumping.
rmcp = { version = "=0.1.5", features = ["server", "transport-sse-server"] }
axum = "0.7"
tokio-stream = "0.1"
```

Update existing `tokio` line to add `time`:
```toml
tokio = { version = "1", features = ["sync", "macros", "rt-multi-thread", "net", "io-util", "time"] }
```

`time` is required for axum interval/keepalive timers and rmcp SSE heartbeat. `tokio-stream` is required by rmcp's SSE transport (wraps an `mpsc::Receiver` into an axum `Sse` body).

### Step 1.2: Add migration for `reading_state`

**File: `src-tauri/migrations/012_mcp_reading_state.sql`** (new)

```sql
CREATE TABLE IF NOT EXISTS reading_state (
  key          TEXT PRIMARY KEY,
  book_id      TEXT,
  cfi          TEXT,
  chapter_idx  INTEGER,
  chapter_name TEXT,
  selection    TEXT,
  window_label TEXT,
  updated_at   INTEGER NOT NULL
);
```

**File: `src-tauri/src/db.rs`** — register migration 12.

### Step 1.3: Create `mcp` module skeleton

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
    shutdown_tx: oneshot::Sender<()>,
    join: JoinHandle<()>,
    port: u16,
}

impl McpServer {
    pub fn new() -> Self { /* ... */ }

    pub async fn start(&self, state: McpState, port: u16) -> Result<u16, McpError> {
        // Bind 127.0.0.1:{port}. NEVER 0.0.0.0.
        let addr: SocketAddr = ([127, 0, 0, 1], port).into();
        let listener = TcpListener::bind(addr).await?;
        let bound_port = listener.local_addr()?.port();
        // Build rmcp service from the tool registry, wrap in axum Router via
        // rmcp::transport::sse_server::SseServer. Install graceful_shutdown
        // on a oneshot rx.
        // ...
        Ok(bound_port)
    }

    pub async fn stop(&self) { /* drop tx, await join */ }
}
```

### Step 1.4: Wire setup() boot

**File: `src-tauri/src/lib.rs`**

Inside `.setup(|app| { ... })`, after `app.manage(db)` at lib.rs:309:

1. Read settings: `mcp_enabled` (default `false`), `mcp_port` (default `51983`).
2. Construct `McpServer::new()`.
3. If `mcp_enabled`, call `server.start(state, port)` on the Tauri runtime; log bind errors but do not fail setup.
4. `app.manage(server)`.

The `Db` clone happens implicitly — `McpState` carries its own `Db` clone obtained from `app.state::<Db>().inner().clone()`. **No `Arc<Db>` wrapper.**

App exit hook: in `app.run(|_, event|)` match `RunEvent::ExitRequested` and call `server.stop().await` (block via `tauri::async_runtime::block_on`).

### Step 1.5: Verification (Phase 1)

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
| `get_vocab_words` | `book_id?` | `Vec<VocabWord>` (incl. mastery, SRS) | vocab.rs `list_*` |
| `get_vocab_due` | — | `Vec<VocabWord>` due for review | vocab.rs `list_vocab_due_for_review` |
| `get_vocab_stats` | — | aggregate counts by mastery | vocab.rs:251 |
| `get_translations` | `book_id?` | `Vec<Translation>` | translation.rs `list_translations` |
| `get_collections` | — | `Vec<Collection>` + book counts | collections.rs `list_collections` |
| `get_chat_history` | `book_id`, `chat_id?` | chats + messages | chats.rs |
| `get_reading_state` | — | current book/chapter/selection | new `reading_state` table |

### Step 2.1: Extract shared query helpers

For each existing Tauri command listed above, factor the SELECT logic into a `pub(crate) fn query_*(db: &Db, ...) -> AppResult<...>` in the same module. The Tauri command becomes a thin wrapper. The MCP tool calls the same helper.

This avoids duplicating SQL, keeps the column shape canonical, and ensures schema migrations only touch one place.

### Step 2.2: Implement tools

Each tool file under `src-tauri/src/mcp/tools/` follows the rmcp `#[tool]` macro pattern. Example sketch (highlights.rs):

```rust
#[derive(Clone)]
pub struct HighlightTools {
    state: Arc<McpState>,
}

#[tool(tool_box)]
impl HighlightTools {
    #[tool(description = "List all highlights for a book, including the highlighted text content.")]
    async fn get_highlights(
        &self,
        #[tool(param)] book_id: String,
    ) -> Result<CallToolResult, McpError> {
        let highlights = bookmarks::query_highlights(&self.state.db, &book_id)?;
        Ok(CallToolResult::success(vec![Content::json(&highlights)?]))
    }
}
```

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

- Connect via Claude Code: `list_books` returns the library.
- `get_highlights(book_id)` returns rows with `text_content` populated.
- `get_vocab_due()` returns SRS-due rows (matches `list_vocab_due_for_review` Tauri command).
- `get_vocab_stats()` returns the same shape as the existing Tauri command.
- `get_reading_state()` returns the row written by the frontend bridge (Phase 3).
- Tool registry diff against the table above is empty — no extra tools snuck in.

---

## Phase 3 — Write tools + frontend bridge

### Step 3.1: Reading-state bridge command

**File: `src-tauri/src/commands/reading_state.rs`** (new)

```rust
#[tauri::command]
pub fn set_reading_state(
    book_id: Option<String>,
    cfi: Option<String>,
    chapter_idx: Option<i64>,
    chapter_name: Option<String>,
    selection: Option<String>,
    window_label: String,
    db: State<'_, Db>,
) -> AppResult<()> {
    let now = chrono::Utc::now().timestamp_millis();
    let conn = db.conn.lock().map_err(...)?;
    conn.execute(
        "INSERT INTO reading_state (key, book_id, cfi, chapter_idx, chapter_name, selection, window_label, updated_at)
         VALUES ('current', ?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT(key) DO UPDATE SET
            book_id=?1, cfi=?2, chapter_idx=?3, chapter_name=?4,
            selection=?5, window_label=?6, updated_at=?7",
        params![book_id, cfi, chapter_idx, chapter_name, selection, window_label, now],
    )?;
    Ok(())
}
```

Register in `lib.rs` invoke handler. NOT routed through `SyncWriter` — local-only.

### Step 3.2: `useReadingState` frontend hook

**File: `src/hooks/useReadingState.ts`** (new)

```ts
export function useReadingState(args: {
  bookId?: string;
  cfi?: string;
  chapterIdx?: number;
  chapterName?: string;
  selection?: string;
}) {
  const windowLabel = useMemo(() => getCurrentWindow().label, []);
  const debounced = useDebounce(args, 250);
  useEffect(() => {
    invoke("set_reading_state", { ...debounced, window_label: windowLabel });
  }, [debounced, windowLabel]);
}
```

Call from `Reader.tsx` with the current book/chapter/selection. Debounce is 250ms — chapter scrolls and selection drags fire fast, no need to round-trip every keystroke.

### Step 3.3: Write tools

Each of the four write tools sits behind its `Arc<AtomicBool>` toggle. Skeleton (highlights):

```rust
#[tool(description = "Add a highlight to a book. Disabled unless the user has enabled MCP highlight writes in settings.")]
async fn add_highlight(
    &self,
    #[tool(param)] book_id: String,
    #[tool(param)] cfi_range: String,
    #[tool(param)] text_content: String,
    #[tool(param)] color: Option<String>,
    #[tool(param)] note: Option<String>,
) -> Result<CallToolResult, McpError> {
    if !self.state.write_highlights.load(Ordering::Relaxed) {
        return Err(McpError::invalid_request("MCP highlight writes are disabled. Enable in Quill → Settings → MCP."));
    }
    // Reuse the same with_tx call as commands::bookmarks::add_highlight (bookmarks.rs:130).
    // text_content is REQUIRED for MCP (the AI knows what it highlighted; the
    // frontend Tauri command makes it Optional only because legacy code paths
    // don't always have it).
    let highlight = highlights::insert_via_sync(
        &self.state.db, &self.state.sync_writer,
        book_id, cfi_range, color, note, Some(text_content),
    )?;
    crate::mcp::notify::emit_data_changed(&self.state.app, "highlights");
    Ok(CallToolResult::success(vec![Content::json(&highlight)?]))
}
```

The four write tools and their constraint table:

| Tool | Toggle setting | Required args | Optional args | Source helper |
|------|----------------|---------------|---------------|---------------|
| `add_highlight` | `mcp_write_highlights` | `book_id`, `cfi_range`, `text_content` | `color`, `note` | bookmarks.rs:130 |
| `add_bookmark` | `mcp_write_bookmarks` | `book_id`, `cfi` | `label` | bookmarks.rs:52 |
| `add_vocab_word` | `mcp_write_vocab_add` | `book_id`, `word` | `definition`, `context_sentence` | vocab.rs `add_vocab_word` |
| `update_vocab_mastery` | `mcp_write_vocab_mastery` | `id`, `mastery` | — | vocab.rs `update_vocab_mastery` |

`text_content` upgrade to required for MCP `add_highlight`: the AI knows what it highlighted (it constructed the `cfi_range` from selection). Making it optional just means orphaned highlights show empty rows in the UI.

### Step 3.4: Notify on writes

Each write tool calls `notify::emit_data_changed(&app, resource)` after a successful commit. Resource tags: `"highlights"`, `"bookmarks"`, `"vocab"` (covers both add and mastery update — the vocab list view re-queries either way), `"reading_state"` (frontend bridge writes already trigger UI re-fetch implicitly, but emitting here keeps the channel uniform).

### Step 3.5: Frontend listeners

**Files (modify):** `src/hooks/useBooks.ts`, `src/hooks/useVocab.ts` (new helper if absent), `src/components/BookmarksPanel.tsx`, `src/components/DictionaryPanel.tsx`.

Pattern (per hook):
```ts
useEffect(() => {
  const unlisten = listen<{ resource: string }>("mcp-data-changed", (e) => {
    if (e.payload.resource === "highlights") refetch();
  });
  return () => { unlisten.then(fn => fn()); };
}, []);
```

### Step 3.6: Verification (Phase 3)

- Default state: each write tool returns "disabled" error. UI does not refresh.
- Toggle each write setting individually → corresponding tool succeeds → UI refreshes via `mcp-data-changed`.
- Toggle off mid-flight: in-flight call may complete (atomic bool is sampled at entry); subsequent calls reject. Acceptable.
- Reader window currently in focus: `get_reading_state()` returns its book/chapter/selection. Switching focus to a second reader window updates the state within 250ms.
- Sync regression check: write via MCP, observe `_pending_publish` row, observe peer device receiving the event.

---

## Phase 4 — Settings UI

### Step 4.1: Settings rows

**File: `src/components/settings/McpSettings.tsx`** (new)

Follow the 73px-tall row pattern from `GeneralSettings.tsx` (1px `black/10` dividers, `flex justify-between`).

Rows, in order:

1. **Enable MCP server** — `Toggle`. Saves to `mcp_enabled`. Toggling off calls `stop_mcp_server`; on calls `start_mcp_server` and reads back the bound port.
2. **Port** — `Input` (numeric, default `51983`). Saves to `mcp_port` on blur. Restart server on change.
3. **Connection URL** — readonly text + copy button. Renders `http://localhost:{actual_bound_port}/mcp`. Shows `mcp_last_error` if non-empty.
4. **Localhost-trust caveat** — copy block:
   > Quill's MCP server only listens on `localhost` (`127.0.0.1`). Any program running on this Mac under your account can connect to it without authentication. Quill is designed for single-user, single-machine use; do not enable MCP on a shared machine without trusting every signed-in user.
   Use `text-text-muted text-[12px] leading-5` and indent under the URL row.
5. **Section divider:** "Write tools (opt-in)"
6. **Add highlights** — `Toggle`. `mcp_write_highlights`. Subtext: "Allow MCP clients to add highlights. Off by default."
7. **Add bookmarks** — `Toggle`. `mcp_write_bookmarks`. Subtext: "Allow MCP clients to add bookmarks. Off by default."
8. **Add vocab words** — `Toggle`. `mcp_write_vocab_add`. Subtext: "Allow MCP clients to add vocabulary words. Off by default."
9. **Update vocab mastery** — `Toggle`. `mcp_write_vocab_mastery`. Subtext: "Allow MCP clients to mark vocab as learned/mastered. Off by default."

### Step 4.2: Settings backend commands

**File: `src-tauri/src/commands/mcp.rs`** (new)

```rust
#[tauri::command]
pub async fn start_mcp_server(server: State<'_, McpServer>, ...) -> AppResult<u16>;

#[tauri::command]
pub async fn stop_mcp_server(server: State<'_, McpServer>) -> AppResult<()>;

#[tauri::command]
pub async fn restart_mcp_server(server: State<'_, McpServer>, port: u16) -> AppResult<u16>;
```

Toggles for the four write flags don't need dedicated commands — they go through the existing `set_setting` path. The MCP server reads them at process start and the `Arc<AtomicBool>` clones are updated by a small `settings_changed` listener (or on each `set_setting` for the four `mcp_write_*` keys).

### Step 4.3: i18n keys

**Files:** `src/i18n/en.json`, `src/i18n/zh.json`

Add `settings.mcp.*` keys for: title, enable, port, url, copy, copied, localhostCaveat (multi-line), writeToolsHeader, writeHighlights, writeBookmarks, writeVocabAdd, writeVocabMastery, bindError, restartHint.

### Step 4.4: Wire into settings modal

**File: `src/components/settings/SettingsModal.tsx`** (or wherever tab list lives) — add an "MCP" tab between "AI" and "Sync" (or wherever feels natural in the existing list). Tab icon: `Plug` from lucide-react.

### Step 4.5: Verification (Phase 4)

- Toggle on/off → server starts/stops; `lsof -iTCP:51983 -sTCP:LISTEN` confirms.
- Change port → server restarts on the new port; URL row reflects the actual bound port.
- Bind to a port already in use → toggle stays off, error message appears below URL row, no crash.
- Copy button copies the URL.
- Localhost caveat is visible and reads cleanly in both EN and ZH.
- Each write-tool toggle independently gates its corresponding MCP tool (verified by attempting the tool from Claude Code).

---

## Figma design prompt

> **MCP Settings tab** — a single settings tab inside the existing Quill settings modal. Same shell, same 73px-tall row pattern, same 1px `black/10` dividers as the General tab.
>
> **Structure (top to bottom):**
> 1. **Header row** — "MCP Server" title + a small "Beta" pill on the right.
> 2. **Enable row** — label "Enable MCP server", subtext "Lets MCP-compatible AI clients (Claude Code, Claude Desktop, Codex, Cursor) read your library and reading data.", `Toggle` on the right.
> 3. **Port row** — label "Port", numeric `Input` on the right (max width ~140px), default value `51983`. Subtext: "Local port for the MCP server. Default: 51983."
> 4. **Connection URL row** — label "Connection URL" + readonly text showing `http://localhost:51983/mcp` + small `Copy` button. When copied, button briefly shows `Check` + "Copied". On bind error, replace the URL line with red error text and a `RotateCw` retry button.
> 5. **Localhost-trust caveat** — full-width muted text block (`text-text-muted text-[12px] leading-5`), indented to align with the URL field. Reads: "Quill's MCP server only listens on `localhost` (`127.0.0.1`). Any program running on this Mac under your account can connect to it without authentication. Quill is designed for single-user, single-machine use; do not enable MCP on a shared machine without trusting every signed-in user." A small `ShieldAlert` icon in the gutter on the left.
> 6. **Section header** — "Write tools (opt-in)" — small uppercase muted label, with a 16px top margin separating it from the localhost caveat.
> 7. **Four write-tool toggle rows**, identical row shape to the Enable row. Each has a label, a one-line "Allow MCP clients to ..." subtext, and a `Toggle`. All default off. Order: Add highlights / Add bookmarks / Add vocab words / Update vocab mastery.
>
> **States:**
> - Server off (everything below the Enable row collapsed but visible).
> - Server on, healthy (URL row populated).
> - Server on, bind error (URL row replaced with red error + retry).
> - Each write toggle independently on or off.
> - Restart in flight (URL row shows a thin progress bar across its bottom edge for ~500ms).
>
> **Theme:** follows app theme variables. `bg-bg-surface`, `text-text-primary`, `text-text-muted`. Caveat block uses `bg-bg-muted/40` to softly differentiate from the toggle rows above.
>
> **Tab icon:** `Plug` from lucide-react.

---

## Files to add / modify

| File | Change |
|------|--------|
| `src-tauri/Cargo.toml` | Add `rmcp = "=0.1.5"` (server + transport-sse-server), `axum = "0.7"`, `tokio-stream = "0.1"`; add `time` to `tokio` features |
| `src-tauri/migrations/012_mcp_reading_state.sql` | New: `reading_state` table |
| `src-tauri/src/db.rs` | Register migration 12 |
| `src-tauri/src/mcp/mod.rs` | New: module facade |
| `src-tauri/src/mcp/state.rs` | New: `McpState` (Db + SyncWriter + AppHandle + write toggles) |
| `src-tauri/src/mcp/server.rs` | New: `McpServer` with start/stop/restart, oneshot shutdown |
| `src-tauri/src/mcp/notify.rs` | New: `emit_data_changed` |
| `src-tauri/src/mcp/tools/mod.rs` | New: tool registry + forbidden-surface comment |
| `src-tauri/src/mcp/tools/library.rs` | New: list_books, get_book, get_collections |
| `src-tauri/src/mcp/tools/highlights.rs` | New: get_highlights, add_highlight |
| `src-tauri/src/mcp/tools/bookmarks.rs` | New: get_bookmarks, add_bookmark |
| `src-tauri/src/mcp/tools/vocab.rs` | New: get_vocab_words, get_vocab_due, get_vocab_stats, add_vocab_word, update_vocab_mastery |
| `src-tauri/src/mcp/tools/translations.rs` | New: get_translations |
| `src-tauri/src/mcp/tools/chats.rs` | New: get_chat_history |
| `src-tauri/src/mcp/tools/reading_state.rs` | New: get_reading_state |
| `src-tauri/src/commands/mcp.rs` | New: start/stop/restart_mcp_server |
| `src-tauri/src/commands/reading_state.rs` | New: set_reading_state Tauri command |
| `src-tauri/src/commands/mod.rs` | Register `mcp` and `reading_state` modules |
| `src-tauri/src/commands/bookmarks.rs` | Extract `query_highlights`, `query_bookmarks`, `insert_*_via_sync` helpers |
| `src-tauri/src/commands/books.rs` | Extract `query_books`, `query_book` helpers |
| `src-tauri/src/commands/vocab.rs` | Extract query/write helpers shared with MCP |
| `src-tauri/src/commands/translation.rs` | Extract `query_translations` helper |
| `src-tauri/src/commands/chats.rs` | Extract `query_chat_history` helper |
| `src-tauri/src/commands/collections.rs` | Extract `query_collections` helper |
| `src-tauri/src/lib.rs` | Boot `McpServer` in `setup()` (after app.manage(db)); register MCP + reading_state commands; stop server on `RunEvent::ExitRequested` |
| `src/hooks/useReadingState.ts` | New: debounced bridge hook |
| `src/hooks/useBooks.ts` | Listen for `mcp-data-changed` and refetch |
| `src/hooks/useVocab.ts` | Listen for `mcp-data-changed` and refetch |
| `src/components/BookmarksPanel.tsx` | Listen for `mcp-data-changed` and refetch |
| `src/components/DictionaryPanel.tsx` | Listen for `mcp-data-changed` and refetch |
| `src/pages/Reader.tsx` | Wire `useReadingState` with current book/chapter/selection |
| `src/components/settings/McpSettings.tsx` | New: settings tab |
| `src/components/settings/SettingsModal.tsx` | Register MCP tab |
| `src/i18n/en.json` | Add `settings.mcp.*` keys |
| `src/i18n/zh.json` | Add `settings.mcp.*` keys (Chinese) |

---

## Verification (full)

1. `cargo check` — compiles with all new deps (rmcp, axum, tokio-stream, tokio time feature).
2. Backend unit tests:
   - `set_reading_state` upserts the single `current` row.
   - Each `query_*` helper round-trips a seeded fixture.
   - Each write tool's helper goes through `SyncWriter::with_tx` (verified by checking `_pending_publish` row count).
3. Integration:
   - Claude Code connects to `http://localhost:51983/mcp` and lists tools.
   - Each read tool returns expected shape against a seeded library.
   - Each write tool, when its toggle is off, returns "disabled" error.
   - Each write tool, when its toggle is on, mutates the DB AND emits `mcp-data-changed`.
   - Frontend list views refresh on receipt of `mcp-data-changed`.
4. Lifecycle:
   - Toggle off → port no longer listening (`lsof -iTCP:{port}`).
   - Restart on port change → old port released, new port bound.
   - Bind to port-in-use → settings UI surfaces error, server stays off, no crash.
   - App exit → port released cleanly (no orphan).
5. Multi-window:
   - Open two reader windows on different books → most-recently-focused window's state is what `get_reading_state` returns.
6. Sync regression:
   - MCP-added highlight propagates to a peer device through the existing LWW outbox.
   - In-app AI features (chat, lookup, translate) continue to work independently.
7. Security:
   - `netstat -an | grep {port}` shows the listening socket bound to `127.0.0.1` only, never `0.0.0.0`.
   - Tool registry diff against the spec table is empty (no settings/oauth/sync-infra surfaces snuck in).
