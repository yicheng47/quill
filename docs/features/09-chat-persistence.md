# 09 — Chat Persistence

## Motivation

The AI chat in Quill is currently fully stateless — messages live only in React state and are lost when the user navigates away or closes the app. Users want to:

- **Revisit past discussions** about a book without losing context
- **Maintain multiple chat threads** per book (e.g. one for plot analysis, another for vocabulary questions)
- **Retain the highlighted text** that triggered each chat

## Scope

- Persist AI chats to SQLite, scoped per book
- Multiple chats per book
- Store associated text context (highlighted passages) with each message
- UI for creating, switching between, renaming, and deleting chats
- Auto-save messages during streaming
- Auto-title chats after first exchange

---

## Database Schema

### Migration: `src-tauri/migrations/003_chats.sql`

```sql
CREATE TABLE IF NOT EXISTS chats (
  id TEXT PRIMARY KEY,
  book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  title TEXT NOT NULL DEFAULT 'New chat',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS chat_messages (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  role TEXT NOT NULL,           -- 'user' | 'assistant' | 'system'
  content TEXT NOT NULL,
  context TEXT,                 -- highlighted passage that triggered this message (nullable)
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_chat_book_id ON chats(book_id);
CREATE INDEX IF NOT EXISTS idx_chat_msg_chat_id ON chat_messages(chat_id);
```

- `chats` stores per-book threads with a user-editable title
- `chat_messages` stores each message with its role and optional context passage
- CASCADE delete ensures removing a chat cleans up all its messages
- Removing a book cascades to all its chats

---

## Backend Commands

New file: `src-tauri/src/commands/chats.rs`

| Command | Params | Returns | Notes |
|---------|--------|---------|-------|
| `create_chat` | `book_id`, `title?` | `Chat` | UUID id, defaults title to "New chat" |
| `list_chats` | `book_id` | `Vec<Chat>` | Ordered by `updated_at DESC` |
| `list_all_chats` | — | `Vec<Chat>` | All chats across all books, ordered by `updated_at DESC` |
| `get_chat` | `chat_id` | `Chat` | Single chat metadata |
| `delete_chat` | `chat_id` | `()` | CASCADE deletes messages |
| `rename_chat` | `chat_id`, `title` | `()` | |
| `list_chat_messages` | `chat_id` | `Vec<ChatMsg>` | Ordered by `created_at ASC` |
| `save_chat_message` | `chat_id`, `role`, `content`, `context?` | `ChatMsg` | Also updates `chats.updated_at` |

### Rust Structs

```rust
#[derive(Serialize, Deserialize, Clone)]
pub struct Chat {
    pub id: String,
    pub book_id: String,
    pub title: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct ChatMsg {
    pub id: String,
    pub chat_id: String,
    pub role: String,
    pub content: String,
    pub context: Option<String>,
    pub created_at: String,
}
```

---

## Frontend Hook Changes

### `src/hooks/useAiChat.ts`

Extend `ChatMessage` with persistence fields:

```ts
export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  context?: string;  // highlighted text that was sent with this message
  dbId?: string;     // ID from chat_messages table
}
```

New hook signature:

```ts
useAiChat(bookId?: string) → {
  messages, streaming, send, reset, initialize,
  chatId, chats,
  loadChat, createChat, deleteChat
}
```

### Behavior Changes

- **`initialize(bookId)`** — loads the most recent chat for the book, or creates one if none exists
- **`send(content, context?)`** — persists the user message immediately via `save_chat_message`, then on stream completion (`done: true`), persists the full assistant response
- **`reset()`** — creates a new chat (instead of just clearing state)
- **`loadChat(id)`** — fetches messages from DB and replaces current state
- **`createChat(bookId)`** — creates a new empty chat and switches to it
- **`deleteChat(id)`** — deletes from DB, switches to next available or creates new
- **Auto-title** — after the first assistant response, renames "New chat" using first ~40 chars of the user's first message

---

## UI Changes

### `src/components/AiPanel.tsx`

**Props change:**
```ts
interface AiPanelProps {
  bookId?: string;    // needed for chat scoping
  context?: string;
  onContextConsumed?: () => void;
}
```

**Header:** Replace static "AI Reading Assistant" title with a chat picker dropdown:
- Current chat title in header
- Dropdown lists all chats for the book (title + relative date)
- "New chat" button with + icon
- Each item has a delete button (trash icon) on hover
- Rename on double-click (inline edit)

**Context display:** When a user message has associated `context`, render it as a subtle blockquote above the user message bubble.

### `src/pages/ChatsPage.tsx` (NEW)

Global chats management page at `/chats`, accessible from sidebar Tools section (below Vocabulary).

- Lists all chats across all books, sorted by most recent
- Search bar to filter by chat title (prefix match)
- Book filter pills (like VocabPage)
- Each row: chat title, book title, message count/preview, timestamp, "Open in Reader →" link
- Delete on hover
- Empty state when no chats exist

### `src/components/Sidebar.tsx`

Add "Chats" entry in the Tools section below Vocabulary, using `MessageSquare` icon, linking to `/chats`.

### `src/pages/Reader.tsx`

Pass `bookId` to AiPanel:
```tsx
<AiPanel bookId={bookId} context={aiContext} onContextConsumed={() => setAiContext(undefined)} />
```

---

## Data Flow

### Sending a Message
1. User types message → `send(content, context?)` called
2. User message added to React state immediately (optimistic)
3. User message persisted via `save_chat_message`
4. `ai_chat` invoke starts streaming
5. Stream chunks update assistant message in React state
6. On `done: true`, full assistant content persisted via `save_chat_message`

### Loading a Chat
1. User selects chat from dropdown
2. `loadChat(id)` fetches messages via `list_chat_messages`
3. Messages mapped to `ChatMessage[]` and replace React state

### Switching Books
1. Reader navigates to different book
2. `initialize(newBookId)` loads most recent chat for new book
3. Previous book's chats remain in DB, unaffected

---

## Implementation Sequence

1. **Migration** — Create `003_chats.sql`, register in `db.rs`
2. **Backend** — Write `chats.rs` with all 7 commands, register in `mod.rs` and `lib.rs`
3. **Hook** — Extend `useAiChat.ts` with chat persistence
4. **UI** — Add chat picker to `AiPanel.tsx`, pass `bookId` from `Reader.tsx`
5. **Polish** — Auto-titling, context display, edge cases (empty state, deletion of active chat)

## Files to Modify

| File | Action |
|------|--------|
| `src-tauri/migrations/003_chats.sql` | NEW |
| `src-tauri/src/db.rs` | Add migration registration |
| `src-tauri/src/commands/chats.rs` | NEW — 8 commands |
| `src-tauri/src/commands/mod.rs` | Add `pub mod chats;` |
| `src-tauri/src/lib.rs` | Register 7 commands in invoke_handler |
| `src/hooks/useAiChat.ts` | Add chat lifecycle, persist messages |
| `src/components/AiPanel.tsx` | Chat picker dropdown, context display |
| `src/pages/ChatsPage.tsx` | NEW — global chats management page |
| `src/components/Sidebar.tsx` | Add "Chats" entry in Tools section |
| `src/pages/Reader.tsx` | Pass `bookId` prop to AiPanel |
