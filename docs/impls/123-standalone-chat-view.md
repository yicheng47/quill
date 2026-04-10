# Standalone Chat View

**Issue:** [#123](https://github.com/yicheng47/quill/issues/123)
**Design:** `quill-design/quill-desktop.pen` → frames "Chat List View" and "Chat Detail View"

## Context

AI chats are currently only viewable inside the Reader, which requires loading the full book. Users should be able to browse and continue conversations directly from the main window. Clicking a chat in the list navigates to a full conversation view; sending messages works without book context (chapter/selection). "Open in Reader" is available in the detail header for context-aware chat.

## Approach

Add a `ChatDetailView` component that replaces the chat list when a chat is selected. Extract `MessageBubble` from `AiPanel.tsx` into a shared component. Reuse `useAiChat` hook as-is — it already supports operating without book context. No backend changes needed.

The chat list view also gets a layout refresh: remove "Open in Reader" from rows (it lives in the detail header now), show msg count as a pill badge next to the title, and show time on the right.

---

## Data shape

`ChatSummary` (from `useChats.ts`) has everything the list needs:

```typescript
{
  id: string;
  book_id: string;
  title: string;
  book_title: string | null;
  message_count: number | null;
  last_message: string | null;
  updated_at: string;
}
```

`ChatMessage` (from `useAiChat.ts`) drives the detail view:

```typescript
{
  id: string;
  role: "user" | "assistant";
  content: string;
  context?: string;      // quoted book passage
  contextCfi?: string;   // CFI pointer (ignored in standalone)
}
```

---

## Step 1: Extract `MessageBubble` to shared component

**File: `src/components/MessageBubble.tsx`** (new)

Move the `MessageBubble` function from `AiPanel.tsx:282-347` into its own file. Keep the same props:

```typescript
interface MessageBubbleProps {
  msg: ChatMessage;
  messages: ChatMessage[];
  streaming: boolean;
  onNavigateToCfi?: (cfi: string) => void;
}
```

Fix quoted text clickability — only show pointer cursor when **both** `contextCfi` exists **and** `onNavigateToCfi` is provided:

```tsx
// Before:
className={`... ${msg.contextCfi ? "cursor-pointer hover:opacity-70" : "cursor-default"}`}
// After:
className={`... ${msg.contextCfi && onNavigateToCfi ? "cursor-pointer hover:opacity-70" : "cursor-default"}`}
```

**File: `src/components/AiPanel.tsx`** (modify)

Remove the inline `MessageBubble` function, import from new file. No behavior change.

---

## Step 2: Create `ChatDetailView` component

**File: `src/components/ChatDetailView.tsx`** (new)

### Props

```typescript
interface ChatDetailViewProps {
  chat: ChatSummary;
  onBack: () => void;
  onChatDeleted: (id: string) => void;
}
```

### Hook usage

```typescript
const {
  messages, streaming, send, initialize,
  chatId, chats, titling, loadChat, deleteChat, renameChat,
} = useAiChat(chat.book_id, { title: chat.book_title ?? undefined });
```

No `author` or `chapter` context — per spec, standalone chats don't inject book context.

### Mount sequence

```typescript
useEffect(() => { initialize(); }, [initialize]);
useEffect(() => {
  if (chat.id && chats.length > 0) loadChat(chat.id);
}, [chat.id, chats.length, loadChat]);
```

### Layout — three sections stacked vertically

**Header (border-bottom, bg-surface, pt-11 for drag region):**
- Left: back arrow button (`ArrowLeft`, 18px, text-muted) + title column:
  - Chat title (15px semibold, editable on double-click via inline input)
  - Book name (12px muted text)
- Right: "Open in Reader" pill (`openReaderWindow(chat.book_id, { openChat: true, chatId: chat.id })`) + delete icon button

**Messages area (flex-1, overflow-auto, bg-muted, px-6 py-4, gap-3):**
- Maps `messages` to `<MessageBubble>` with `onNavigateToCfi={undefined}`
- Empty state: sparkle icon + "No messages yet" text (no suggested prompts — can't create context-aware chats from here)
- Auto-scroll via `messagesEndRef`

**Input bar (border-top, px-6 pt-[17px] pb-4):**
- Same layout as `AiPanel`: textarea (flex-1, h-[60px]) + send button (60x60, accent bg)
- `send(input.trim())` — no context/CFI
- Enter to send, Shift+Enter for newline
- Hint text below

### Delete flow

Same confirmation dialog pattern as `ChatsContent`:
- Modal with title, message, Cancel/Delete buttons
- On confirm: `deleteChat(chat.id)` then `onChatDeleted(chat.id)`

### Rename flow

- Double-click title → inline input (same as `AiPanel` pattern)
- On blur/Enter: `renameChat(chatId, titleDraft.trim())`

---

## Step 3: Update `ChatsContent` — navigation + list redesign

**File: `src/components/ChatsContent.tsx`** (modify)

### Navigation state

```typescript
const [selectedChat, setSelectedChat] = useState<ChatSummary | null>(null);
```

When `selectedChat` is set, render `ChatDetailView` instead of the list:

```tsx
if (selectedChat) {
  return (
    <ChatDetailView
      chat={selectedChat}
      onBack={() => setSelectedChat(null)}
      onChatDeleted={(id) => {
        setSelectedChat(null);
        remove(id);
      }}
    />
  );
}
// ...existing list render
```

### Chat row click

Make the entire chat row clickable → `onClick={() => setSelectedChat(chat)}`. Cursor pointer.

### Remove "Open in Reader" from rows

Delete the `handleOpenInReader` function and the "Open in Reader" button from each row. This action now lives in the detail view header.

### List row layout refresh

Update each chat row to match the new design:
- **Title row**: chat title + small pill badge showing msg count (rounded-full, bg-bg-input, 10px muted text)
- **Right side**: just the time (`timeAgo`), no stacked count
- **Delete icon**: inline next to time, low opacity

---

## Step 4: Add i18n keys

**File: `src/i18n/en.json`** (modify)

```json
"chats.detailEmpty": "No messages yet",
"chats.detailEmptySub": "Send a message to continue the conversation."
```

**File: `src/i18n/zh.json`** (modify)

```json
"chats.detailEmpty": "还没有消息",
"chats.detailEmptySub": "发送消息继续对话。"
```

Reuse existing keys: `chats.openInReader`, `chats.deleteTitle`, `chats.deleteMsg`, `ai.placeholder`, `ai.sendHint`, `ai.thinking`, `common.cancel`, `common.delete`.

---

## Files summary

| File | Action |
|------|--------|
| `src/components/MessageBubble.tsx` | **Create** — extracted from AiPanel |
| `src/components/ChatDetailView.tsx` | **Create** — standalone chat detail |
| `src/components/AiPanel.tsx` | **Modify** — import MessageBubble |
| `src/components/ChatsContent.tsx` | **Modify** — navigation state + list redesign |
| `src/i18n/en.json` | **Modify** — add 2 keys |
| `src/i18n/zh.json` | **Modify** — add 2 keys |

No backend changes. No new routes. No new hooks.

## Verification

- [ ] Click a chat in the list → full conversation renders in main window, sidebar stays
- [ ] Send new messages → streamed AI responses appear
- [ ] Quoted text passages display inline but are NOT clickable (no pointer, no hover)
- [ ] "Open in Reader" in detail header opens reader with correct chat
- [ ] Back button returns to chat list with filters/scroll preserved
- [ ] Delete from detail view → returns to list, chat removed
- [ ] Rename via double-click title works
- [ ] Chat list rows show msg count badge + time (no "Open in Reader" button)
- [ ] `npm run build` succeeds with no TS errors
- [ ] Both `en.json` and `zh.json` have new keys
