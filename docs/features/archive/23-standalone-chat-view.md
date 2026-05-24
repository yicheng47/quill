# 23 — Standalone Chat View

**GitHub Issue:** https://github.com/yicheng47/quill/issues/123

## Motivation

AI chats are currently only viewable inside the Reader, which requires loading the full book. Users should be able to browse and continue conversations directly from the main window — useful for reviewing past discussions, asking follow-up questions, or chatting without needing the book open.

## Scope

### In Scope

- **Chat detail view** in the main window: clicking a chat in the existing list navigates to a full conversation view (messages, input box, chat header)
- **Continue chatting**: users can send new messages from the detail view. No book context (chapter, highlighted text) is injected — if they want context-aware chat, the "Open in Reader" button takes them there
- **Quoted text display**: messages that reference book passages show the quoted text inline (read-only, no CFI navigation since we're not in the reader)
- **Back navigation**: back button or breadcrumb to return to the chat list
- **Open in Reader**: button in the detail view header to open the book's reader with this chat loaded
- **Delete & rename**: available from the detail view (same as reader AiPanel)

### Out of Scope

- Creating new chats from the main window (chats originate in the Reader)
- Book context injection (chapter, selection) — this is Reader-only
- CFI navigation from quoted passages (no book loaded)

## Implementation Phases

### Phase 1 — Chat Detail Component

1. Create `ChatDetailView` component that renders the full conversation:
   - Header: back button, chat title (editable on double-click), book name badge, "Open in Reader" button
   - Messages area: reuse `MessageBubble` from `AiPanel.tsx` (extract to shared component or duplicate with modifications — quoted text is display-only, no `onNavigateToCfi`)
   - Input area: textarea + send button, same UX as AiPanel
2. Wire up `useAiChat` hook — it already supports operating without book context (just pass `bookId` from the chat record, no chapter/selection context)

### Phase 2 — Navigation State in ChatsContent

1. Add `selectedChatId` state to `ChatsContent`
2. Clicking a chat row sets `selectedChatId` instead of opening the reader
3. When `selectedChatId` is set, render `ChatDetailView` instead of the list
4. Back button clears `selectedChatId`, returning to the list
5. Keep "Open in Reader" as a secondary action (button in detail header)

### Phase 3 — Polish

1. Add i18n keys for new UI strings (`chats.back`, `chats.openInReaderShort`, etc.)
2. Transition animation between list and detail (optional, simple fade or slide)
3. Auto-scroll to bottom on load and new messages

## Verification

- [ ] Can click a chat in the list and see full conversation in the main window
- [ ] Can send new messages and receive streamed AI responses
- [ ] Quoted text passages display inline without being clickable
- [ ] "Open in Reader" button opens the reader with the correct chat loaded
- [ ] Back button returns to the chat list with filters/scroll preserved
- [ ] Delete and rename work from the detail view
- [ ] Sidebar remains visible throughout list ↔ detail navigation

## Figma Design Prompt

**Chat Detail View — Main Window**

A full-height panel that replaces the chat list content area (sidebar stays). Three sections stacked vertically:

**Header bar** (same height as the chat list header, ~63px): Left side has a back arrow button followed by the chat title (semibold, 15px). Below the title in smaller muted text, show the book name. Right side has an "Open in Reader" pill button (accent-bg style, same as existing) and a delete icon button.

**Messages area** (flex-1, scrollable): Same bubble layout as the Reader's AiPanel. Assistant messages in surface-colored rounded cards. User messages right-aligned in purple-tinted cards. Quoted passages shown as a purple left-bordered block above the user message — but NOT clickable (no hover state, no pointer cursor). Generous padding, 14px text.

**Input bar** (pinned to bottom, border-top): Same layout as Reader AiPanel — textarea on the left, square send button on the right. Include the "Ctrl+Enter to send" hint text below.

Overall feel: identical to the Reader chat panel but wider (uses full content area width) and without any book-specific chrome. Clean, spacious, conversation-focused.
