# Chat Persistence Implementation Plan

## Overview

Persistent AI chat threads scoped to books, with full CRUD backend, chat picker UI in the AI panel, and a global Chats management page. Follows existing patterns established by the vocabulary feature (migration, commands module, hook, page).

---

## Phase 1: Database Migration

**Goal:** Create the `chats` and `chat_messages` tables.

### Files

| File | Action |
|------|--------|
| `src-tauri/migrations/003_chats.sql` | CREATE |
| `src-tauri/src/db.rs` | MODIFY |

### Details

**`src-tauri/migrations/003_chats.sql`:**

```sql
CREATE TABLE IF NOT EXISTS chats (
  id TEXT PRIMARY KEY,
  book_id TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT 'New chat',
  model TEXT,                          -- AI model/provider used (e.g. "gpt-4o", "claude-3")
  pinned INTEGER NOT NULL DEFAULT 0,   -- 1 = pinned to top of list
  metadata TEXT,                       -- JSON blob for future extensibility
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS chat_messages (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  context TEXT,
  metadata TEXT,                       -- JSON blob for future extensibility
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_chat_book_id ON chats(book_id);
CREATE INDEX IF NOT EXISTS idx_chat_msg_chat_id ON chat_messages(chat_id);
```

No `ON DELETE CASCADE` — deletions are handled explicitly in application code with transactions:
- **`delete_chat`**: `DELETE FROM chat_messages WHERE chat_id = ?` then `DELETE FROM chats WHERE id = ?` in a transaction.
- **`delete_book`** (existing): Should be updated to also `DELETE FROM chats WHERE book_id = ?` (messages cleaned up by `delete_chat` logic, or a single `DELETE FROM chat_messages WHERE chat_id IN (SELECT id FROM chats WHERE book_id = ?)` followed by the chats delete).

**`src-tauri/src/db.rs`** — Add after the `002_vocab.sql` load, same pattern:

```rust
let schema3 = include_str!("../migrations/003_chats.sql");
conn.execute_batch(schema3)?;
```

### Testing
- Run app, verify tables exist with `sqlite3 quill.db ".tables"`.

---

## Phase 2: Backend Commands

**Goal:** Implement all 8 Tauri commands for chat CRUD and message persistence.

### Files

| File | Action |
|------|--------|
| `src-tauri/src/commands/chats.rs` | CREATE |
| `src-tauri/src/commands/mod.rs` | MODIFY |
| `src-tauri/src/lib.rs` | MODIFY |

### Details

**Structs:**

```rust
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Chat {
    pub id: String,
    pub book_id: String,
    pub title: String,
    pub model: Option<String>,
    pub pinned: bool,
    pub metadata: Option<String>,      // JSON blob
    pub created_at: String,
    pub updated_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub book_title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message_count: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_message: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ChatMsg {
    pub id: String,
    pub chat_id: String,
    pub role: String,
    pub content: String,
    pub context: Option<String>,
    pub metadata: Option<String>,      // JSON blob
    pub created_at: String,
}
```

Note: `Chat` includes optional `book_title`, `message_count`, and `last_message` fields populated only by `list_all_chats` (with LEFT JOIN). Same pattern as `VocabWord` with optional `book_title`.

**Commands (8 total):**

1. **`create_chat(book_id, title?)`** — UUID, inserts with `chrono::Utc::now()`, returns `Chat`. Default title "New chat".
2. **`list_chats(book_id)`** — `WHERE book_id = ?1 ORDER BY updated_at DESC`.
3. **`list_all_chats()`** — Joins `books` for `book_title`, subqueries for `message_count` and `last_message`. Ordered by `updated_at DESC`.
4. **`get_chat(chat_id)`** — Simple `WHERE id = ?1`.
5. **`delete_chat(chat_id)`** — In a transaction: `DELETE FROM chat_messages WHERE chat_id = ?1`, then `DELETE FROM chats WHERE id = ?1`.
6. **`rename_chat(chat_id, title)`** — `UPDATE chats SET title = ?1, updated_at = ?2 WHERE id = ?3`.
7. **`list_chat_messages(chat_id)`** — `WHERE chat_id = ?1 ORDER BY created_at ASC`.
8. **`save_chat_message(chat_id, role, content, context?)`** — UUID, inserts message, updates `chats.updated_at`. Returns `ChatMsg`.

**`src-tauri/src/commands/books.rs`** — Update `delete_book` to clean up chats in a transaction. Before `DELETE FROM books`, add:
```rust
conn.execute("DELETE FROM chat_messages WHERE chat_id IN (SELECT id FROM chats WHERE book_id = ?1)", params![id])?;
conn.execute("DELETE FROM chats WHERE book_id = ?1", params![id])?;
```

**`src-tauri/src/commands/mod.rs`** — Add `pub mod chats;`

**`src-tauri/src/lib.rs`** — Add 8 commands to `invoke_handler` under `// Chats` comment.

---

## Phase 3: Frontend Hook — Chat Persistence in `useAiChat`

**Goal:** Extend `useAiChat` to persist messages, manage multiple chat threads per book, and auto-title.

### Files

| File | Action |
|------|--------|
| `src/hooks/useAiChat.ts` | MODIFY (major rewrite) |
| `src/hooks/useChats.ts` | CREATE |

### Details

**`src/hooks/useChats.ts`** — New hook for the ChatsPage (global chat list). Follows `useAllVocab` pattern. Fetches via `list_all_chats`, returns `{ chats, refresh, remove }`.

**`src/hooks/useAiChat.ts`** — New signature:

```ts
useAiChat(bookId?: string) -> {
  messages, streaming, send, reset, initialize,
  chatId, chats,
  loadChat, createChat, deleteChat, renameChat
}
```

Key changes:

- **`initialize(bookId)`** — Loads most recent chat for the book, or creates one if none exist.
- **`send(content, context?)`** — Persists user message immediately via `save_chat_message`. On stream `done: true`, persists full assistant response. Auto-titles "New chat" using first ~40 chars of user's first message.
- **`loadChat(id)`** — Fetches messages from DB, replaces React state.
- **`createChat(bookId)`** — Creates new empty chat, switches to it.
- **`deleteChat(id)`** — Deletes, switches to next available or creates new.
- **`renameChat(id, title)`** — Updates DB and local state.
- **`reset()`** — Now calls `createChat(bookId)` instead of just clearing state.
- **`ChatMessage` interface** gains `context?: string` and `dbId?: string` fields.
- Remove the static "system-intro" message (empty state handled in UI).

### Dependencies
- Requires Phase 2.

---

## Phase 4: AiPanel UI — Chat Picker, Context Display, Empty State

**Goal:** Chat picker dropdown, context blockquotes, empty state with suggested prompts.

### Files

| File | Action |
|------|--------|
| `src/components/AiPanel.tsx` | MODIFY (major rewrite) |
| `src/pages/Reader.tsx` | MODIFY (pass `bookId` prop) |

### Details

**`src/pages/Reader.tsx`** — Pass `bookId` to AiPanel:
```tsx
<AiPanel bookId={bookId} context={aiContext} onContextConsumed={() => setAiContext(undefined)} />
```

**`src/components/AiPanel.tsx`:**

1. **Props** — Add `bookId?: string`.
2. **Header** — Replace static title with: Sparkles icon + current chat title + ChevronDown (toggles dropdown) + Plus button (creates new chat). Title editable on double-click.
3. **Chat picker dropdown** — White bg, border, `shadow-popover`, rounded-[10px]. Rows: chat title (13px) + "N messages · Xm ago" (11px, muted). Active row: `bg-[#faf5ff]`, semibold `text-[#59168b]`.
4. **Empty state** (when `messages.length === 0`) — Sparkles icon in 56px gray circle, "Start a new chat" title, subtitle, three suggested prompt pills (purple text on `bg-[#faf5ff]` with `border-[#e9d4ff]`, rounded-full). Clicking a pill calls `send(pillText)`.
5. **Context blockquote** — When user message has `context`: 2px left border `#c084fc`, italic 12px muted text above the user bubble.
6. **User message bubble** — Change to `bg-[rgba(192,132,252,0.15)]` with `text-text-primary` (per Figma).

### Dependencies
- Requires Phase 3.

---

## Phase 5: ChatsPage and Sidebar Entry

**Goal:** Global `/chats` page and sidebar navigation.

### Files

| File | Action |
|------|--------|
| `src/components/ChatsContent.tsx` | CREATE |
| `src/components/Sidebar.tsx` | MODIFY |
| `src/pages/Home.tsx` | MODIFY |

### Details

**Routing:** Same pattern as VocabPage — when `activeFilter === "chats"` in Home.tsx, render `<ChatsContent />` inline instead of the book grid.

**`src/components/Sidebar.tsx`** — Add "Chats" entry under Tools, below Vocabulary. `MessageSquare` icon.

**`src/pages/Home.tsx`** — Add `activeFilter === "chats"` branch to render `<ChatsContent />`.

**`src/components/ChatsContent.tsx`** — Follows `VocabContent.tsx` pattern:
- **Header:** Purple gradient icon + "Chats" title + "N chats across all books" subtitle.
- **Search bar:** Filters by title (client-side prefix match).
- **Chat list rows:** Sparkles icon + title + book title (with BookOpen icon, muted) + last message preview + timestamp + msg count + "Open in Reader →" purple pill button.
- **"Open in Reader"** navigates to `/reader/{bookId}` with `{ openChat: true, chatId }` state.
- **Empty state:** MessageSquare icon + "No chats yet" + subtitle.
- Uses `useAllChats()` hook.

### Dependencies
- Requires Phase 3 (`useChats.ts`). Independent of Phase 4 — can be done in parallel.

---

## Phase 6: Reader Integration for "Open in Reader"

**Goal:** When navigating from ChatsPage, open AI panel with the specified chat.

### Files

| File | Action |
|------|--------|
| `src/pages/Reader.tsx` | MODIFY |

### Details

Check `location.state` for `openChat` flag and `chatId`. Open AI panel and pass `chatId` to AiPanel as `initialChatId` prop. The hook loads that chat during initialization.

### Dependencies
- Requires Phases 4 and 5.

---

## Phase 7: Polish and Edge Cases

**Goal:** Auto-titling robustness, deletion edge cases, streaming interruption.

### Details

1. **Auto-title:** First 40 chars of user message, truncated at word boundary with "...". Strip "Explain this passage:" prefix. Only apply if title is "New chat".
2. **Delete active chat:** Switch to next available, or create new if last.
3. **Streaming interruption:** If user switches chats mid-stream, stop listening. Partial message not persisted (intentional).
4. **Book switch:** Re-initialize on `bookId` change.
5. **Error messages:** Don't persist error content to DB.

---

## File Summary

| File | Phase | Action |
|------|-------|--------|
| `src-tauri/migrations/003_chats.sql` | 1 | CREATE |
| `src-tauri/src/db.rs` | 1 | MODIFY (2 lines) |
| `src-tauri/src/commands/chats.rs` | 2 | CREATE (~200 lines) |
| `src-tauri/src/commands/mod.rs` | 2 | MODIFY (1 line) |
| `src-tauri/src/lib.rs` | 2 | MODIFY (8 lines) |
| `src/hooks/useAiChat.ts` | 3 | MODIFY (major rewrite) |
| `src/hooks/useChats.ts` | 3 | CREATE (~40 lines) |
| `src/components/AiPanel.tsx` | 4 | MODIFY (major rewrite) |
| `src/pages/Reader.tsx` | 4, 6 | MODIFY |
| `src/components/ChatsContent.tsx` | 5 | CREATE (~200 lines) |
| `src/components/Sidebar.tsx` | 5 | MODIFY (~15 lines) |
| `src/pages/Home.tsx` | 5 | MODIFY (~5 lines) |

## Phase Dependencies

```
Phase 1 (Migration)
  │
  v
Phase 2 (Backend Commands)
  │
  v
Phase 3 (Hooks) ────────┐
  │                      │
  v                      v
Phase 4 (AiPanel UI)   Phase 5 (ChatsPage + Sidebar)
  │                      │
  v                      │
Phase 6 (Reader nav) <───┘
  │
  v
Phase 7 (Polish)
```

Phases 4 and 5 can be done in parallel once Phase 3 is complete.
