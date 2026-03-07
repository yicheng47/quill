# Quill Backend Implementation Plan

## Context
Quill is an AI-powered desktop EPUB reader built with Tauri v2 + React 19. The frontend MVP is complete with mock data. This plan covers building the Rust backend to replace mocks with real functionality: EPUB import/rendering, data persistence, bookmarks/highlights, settings, and AI assistant integration.

The current backend is bare-bones (`src-tauri/src/lib.rs` has only a `greet` command).

---

## Phase 1: Foundation + EPUB Library

### 1a. Dependencies (`src-tauri/Cargo.toml`)
Add crates:
| Crate | Purpose |
|-------|---------|
| `rusqlite` (bundled) | SQLite persistence |
| `epub` | EPUB parsing |
| `serde` / `serde_json` | Already present, serialization |
| `uuid` | Book/bookmark IDs |
| `chrono` | Timestamps |
| `tauri-plugin-dialog` | Native file picker |

### 1b. SQLite Schema
Create `src-tauri/migrations/001_init.sql`:

```sql
CREATE TABLE books (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  author TEXT NOT NULL,
  description TEXT,
  cover_path TEXT,
  file_path TEXT NOT NULL,
  genre TEXT,
  pages INTEGER,
  status TEXT NOT NULL DEFAULT 'unread',
  progress INTEGER NOT NULL DEFAULT 0,
  current_cfi TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE bookmarks (
  id TEXT PRIMARY KEY,
  book_id TEXT NOT NULL REFERENCES books(id),
  cfi TEXT NOT NULL,
  label TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE highlights (
  id TEXT PRIMARY KEY,
  book_id TEXT NOT NULL REFERENCES books(id),
  cfi_range TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT 'yellow',
  note TEXT,
  text_content TEXT,
  created_at TEXT NOT NULL
);
```

### 1c. Rust Module Structure
```
src-tauri/src/
├── lib.rs          -- Tauri setup, state management, plugin registration
├── db.rs           -- Database init, migrations, connection pool
├── commands/
│   ├── mod.rs
│   ├── books.rs    -- import_book, list_books, get_book, delete_book, update_progress
│   ├── settings.rs -- get_setting, set_setting, get_all_settings
│   ├── bookmarks.rs-- add/remove/list bookmarks & highlights
│   └── ai.rs       -- chat, stream response via Tauri events
├── epub.rs         -- EPUB parsing, metadata extraction, cover extraction
├── ai/
│   ├── mod.rs
│   ├── openai_compat.rs -- OpenAI-compatible provider (covers Ollama via base URL)
│   └── anthropic.rs     -- Anthropic provider
└── error.rs        -- Unified error type implementing serde::Serialize
```

### 1d. Core Tauri Commands — Books
- `import_book(file_path: String)` — Parse EPUB, extract metadata + cover, insert into DB, copy file to app data dir. Returns `Book`.
- `import_book_dialog()` — Open native file picker, then call import_book.
- `list_books(filter: Option<String>, search: Option<String>)` — Query books with optional status/genre filter and title/author search.
- `get_book(id: String)` — Single book by ID.
- `delete_book(id: String)` — Remove book + file from app data.
- `update_reading_progress(id: String, progress: u32, cfi: Option<String>)` — Update progress %, current CFI, set status to "reading".
- `mark_finished(id: String)` — Set status to "finished", progress to 100.

### 1e. Frontend Integration (Phase 1)
- Install `epub.js` npm package for EPUB rendering in the webview.
- Replace `mockBooks` with `invoke("list_books")` in `Home.tsx`.
- Replace static reader content with epub.js `Rendition` in `Reader.tsx`.
- Add "Import Book" button to `Sidebar.tsx` that calls `invoke("import_book_dialog")`.
- Wire up progress tracking: on epub.js location change, call `update_reading_progress`.

**Files to modify:** `Home.tsx`, `Reader.tsx`, `Sidebar.tsx`, `BookGrid.tsx`, `BookList.tsx`, `src-tauri/Cargo.toml`, `src-tauri/src/lib.rs`
**Files to create:** `db.rs`, `epub.rs`, `error.rs`, `commands/*.rs`, migration SQL, `src/hooks/useBooks.ts`

---

## Phase 2: Settings Persistence

### Tauri Commands
- `get_all_settings()` → `HashMap<String, String>`
- `get_setting(key: String)` → `Option<String>`
- `set_setting(key: String, value: String)`
- `set_settings_bulk(settings: HashMap<String, String>)` — For the Save button.

### API Key Storage
- Use `tauri-plugin-os` or the system keychain (via `keyring` crate) for API keys instead of plain SQLite.
- Fallback: encrypted storage in SQLite if keychain unavailable.

### Frontend Integration
- `SettingsPage.tsx`: Load settings on mount via `get_all_settings`, save via `set_settings_bulk`.
- `ReaderSettings.tsx`: Read/write font size and font family settings.
- Create `src/hooks/useSettings.ts` for shared settings access.

**Files to modify:** `SettingsPage.tsx`, `ReaderSettings.tsx`
**Files to create:** `commands/settings.rs`, `src/hooks/useSettings.ts`

---

## Phase 3: Bookmarks & Highlights

### Tauri Commands
- `add_bookmark(book_id, cfi, label)` / `remove_bookmark(id)` / `list_bookmarks(book_id)`
- `add_highlight(book_id, cfi_range, color, note, text_content)` / `remove_highlight(id)` / `list_highlights(book_id)` / `update_highlight_note(id, note)`

### Frontend Integration
- `BookmarksPanel.tsx`: Fetch real bookmarks/highlights, support add/delete.
- `ReaderContextMenu.tsx` → "Highlight" action creates a highlight via `add_highlight`.
- `ReaderContextMenu.tsx` → "Add Note" opens note input, saves via `add_highlight` with note.
- epub.js integration: Apply highlight overlays from DB on chapter load.

**Files to modify:** `BookmarksPanel.tsx`, `ReaderContextMenu.tsx`, `Reader.tsx`
**Files to create:** `commands/bookmarks.rs`, `src/hooks/useBookmarks.ts`

---

## Phase 4: AI Assistant

### Architecture
```
Frontend (AiPanel) → invoke("ai_chat") → Rust command
  → Rust spawns async task
  → Streams tokens via app.emit("ai-stream-chunk", payload)
  → Frontend listens via listen("ai-stream-chunk")
  → Final emit("ai-stream-done")
```

### Tauri Commands
- `ai_chat(book_id: String, messages: Vec<Message>, context: Option<String>)` — Starts streaming. The `context` param includes selected text or current chapter content for context-aware responses.
- `ai_cancel()` — Abort in-flight request via `AbortHandle`.

### Provider Implementation
- `ai/openai_compat.rs`: `reqwest` streaming POST to a configurable base URL + `/v1/chat/completions` with `stream: true`. Parse SSE lines. Covers both Ollama (`http://localhost:11434`) and any OpenAI-compatible API.
- `ai/anthropic.rs`: `reqwest` streaming POST to `https://api.anthropic.com/v1/messages` with `stream: true`. Parse SSE events.
- Both read API key and base URL from settings, model and temperature from settings.
- Supported providers: `anthropic`, `ollama` (no API key needed, local base URL).

### Frontend Integration
- `AiPanel.tsx`: Replace mock chat with real streaming. Use `listen("ai-stream-chunk")` to append tokens. Show typing indicator during stream.
- "Ask AI" from context menu sends selected text as context.

**Files to modify:** `AiPanel.tsx`, `ReaderContextMenu.tsx`
**Files to create:** `commands/ai.rs`, `ai/mod.rs`, `ai/openai_compat.rs`, `ai/anthropic.rs`, `src/hooks/useAiChat.ts`

---

## Error Handling Pattern
```rust
#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("Database error: {0}")]
    Db(#[from] rusqlite::Error),
    #[error("EPUB error: {0}")]
    Epub(String),
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),
    #[error("AI error: {0}")]
    Ai(String),
    #[error("{0}")]
    Other(String),
}

impl serde::Serialize for AppError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where S: serde::Serializer {
        serializer.serialize_str(&self.to_string())
    }
}
```

All commands return `Result<T, AppError>`.

---

## Tauri Config Changes (`tauri.conf.json`)
- Add `tauri-plugin-dialog` to plugins for file picker.
- Add `fs` scope permissions for reading EPUB files.
- Update capabilities for dialog and fs access.

---

## Verification
1. **Phase 1**: Import an EPUB → appears in library → open in reader → epub.js renders content → progress saves on navigation.
2. **Phase 2**: Change settings → restart app → settings persist.
3. **Phase 3**: Add bookmark/highlight in reader → appears in BookmarksPanel → persists across sessions.
4. **Phase 4**: Type message in AiPanel → tokens stream in real-time → "Ask AI" from context menu pre-fills context.
---

## Implementation Order
Phases are sequential — each builds on the previous. Phase 1 is the largest and should be tackled first as it establishes the core architecture (DB, error handling, module structure) that all other phases depend on.
