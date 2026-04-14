# 30 — MCP Server

**Status:** Planned
**GitHub Issue:** [#184](https://github.com/yicheng47/quill/issues/184)

## Motivation

Quill's AI features are currently self-contained — the app calls HTTP APIs (OpenAI, Anthropic, Ollama) and streams responses into its own chat/lookup/translate UI. This means the AI only knows what Quill explicitly puts in the prompt.

By exposing an MCP (Model Context Protocol) server, Quill becomes like Pencil: any MCP-compatible AI client (Claude Code, Claude Desktop, Codex, Cursor) can connect to Quill and get full, structured access to the user's reading data. The AI becomes a first-class citizen — it can see what the user is reading, browse their highlights and vocabulary, and take actions like adding bookmarks or highlights.

This is more powerful than adding CLI providers to Quill's settings because:
- **Bidirectional:** The AI can both read from and write to Quill
- **Structured:** MCP is a proper protocol, not CLI stdout parsing
- **Provider-agnostic:** Works with any MCP client, present and future
- **Context-rich:** The AI sees the full reading state, not just a formatted prompt

## Scope

### In scope

- MCP server running on a local HTTP port (SSE transport) using the official `rmcp` Rust SDK
- Read tools: library, book metadata, highlights (with text), bookmarks, vocabulary (with SRS state), translations, chat history, collections
- Write tools: add highlight, add bookmark, add vocab word, update vocab mastery
- Frontend bridge: push live reading state (selected text, current chapter) to backend for MCP exposure
- Settings UI: enable/disable MCP server, configure port

### Out of scope

- EPUB/PDF text extraction from backend (text only available via frontend rendering)
- Replacing the existing in-app AI (HTTP providers stay as-is)
- Remote/non-localhost access
- Authentication (localhost-only, single-user app)

## Implementation Phases

### Phase 1: Server infrastructure
- Add `rmcp` and `axum` to Cargo.toml
- Create `src-tauri/src/mcp/` module
- MCP server struct with shared `Arc<Db>` access
- Start HTTP server on background tokio task during Tauri setup
- Handshake working with Claude Code

### Phase 2: Read tools
- `list_books(filter?, search?)` — library with metadata
- `get_book(book_id)` — book details + reading progress
- `get_highlights(book_id)` — highlights with actual highlighted text
- `get_bookmarks(book_id)` — bookmarks with labels
- `get_vocab_words(book_id?)` — vocabulary with mastery/SRS data
- `get_vocab_due()` — words due for spaced repetition review
- `get_translations(book_id?)` — saved translations
- `get_collections()` — collections with book counts
- `get_chat_history(book_id, chat_id?)` — chat messages
- `get_reading_state()` — current book, position, chapter

### Phase 3: Write tools + frontend bridge
- `add_highlight(book_id, cfi_range, text_content, color?, note?)`
- `add_bookmark(book_id, cfi, label?)`
- `add_vocab_word(book_id, word, definition?, context_sentence?)`
- `update_vocab_mastery(id, mastery)`
- Frontend `useReadingState` hook pushes live state (selection, chapter) to backend
- Tauri events notify frontend when MCP writes data (refresh UI)

### Phase 4: Settings UI
- MCP settings section: toggle, port, connection URL (copyable)
- i18n for both languages

## Key Technical Decisions

- **`rmcp` crate (official Rust MCP SDK):** Provides `#[tool]` macros, JSON-RPC handling, SSE transport, axum integration. No need to implement the protocol manually.
- **SSE transport on localhost:** HTTP server on a configurable port (default `51983`). Users add `http://localhost:51983/mcp` to their MCP client config.
- **Shared `Arc<Db>`:** MCP server runs in the same process as Tauri, shares the database connection. Same query logic as existing Tauri commands.
- **Frontend state bridge:** Current selection and chapter are frontend-only. A debounced hook pushes these to the backend so `get_reading_state` can expose them.
- **Existing AI untouched:** In-app chat/lookup/translate continue using HTTP providers. MCP is an additional integration, not a replacement.

## Verification

- [ ] `cargo build` compiles with rmcp + axum
- [ ] Claude Code connects to Quill's MCP server
- [ ] "What books am I reading?" → `list_books` returns library
- [ ] "Show my highlights from [book]" → `get_highlights` returns text
- [ ] "What vocab words are due for review?" → `get_vocab_due` returns SRS data
- [ ] "Add a highlight" → `add_highlight` writes to DB, frontend refreshes
- [ ] Settings: toggle MCP on/off, change port
- [ ] Regression: in-app AI still works independently
