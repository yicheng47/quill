# Chat Persistence — Figma Design Prompt

## Context

Quill is a desktop ebook reader (macOS). The AI chat panel lives in the right sidebar of the Reader page, alongside Bookmarks and Vocab panels. The panel is ~360px wide, full height.

Currently the chat has a static header ("AI Reading Assistant"), a message area, and an input bar. We're adding **persistent chats** — users can have multiple chat threads per book, switch between them, and pick up where they left off.

Use the existing Quill design system in the Figma file for all tokens (colors, typography, radii, shadows, icons).

## Screens to Design

### 1. Chat header (updated)

Replace the static "AI Reading Assistant" title. New header should include:
- Sparkles icon (20px, muted) on the left
- Current chat title (truncated, semibold, ~15px) — editable on click
- Chevron-down icon indicating a dropdown
- "New chat" button (+ icon) on the right side of the header
- Header height stays at 63px, border-bottom `#e4e4e7`

### 2. Chat picker dropdown

Triggered by clicking the title/chevron area. Appears below the header.
- List of chats for the current book, sorted by most recent
- Each row: chat title (truncated, 13–14px), relative timestamp ("2h ago", "Mar 12"), delete button (trash, appears on hover)
- Active chat highlighted with subtle accent bg (`#e0e7ff`)
- Max height ~300px, scrollable
- Empty state: "No other chats" (muted text)
- Style: white bg, `popover` shadow, 10px radius, 1px border

### 3. Context blockquote on user messages

When a user message was triggered by selecting text ("Ask AI"), show the highlighted passage above the user's message bubble:
- Small blockquote: 2px left border in `#c084fc` (lavender), 12px italic text in muted color
- Sits just above the dark user bubble, same max-width (85%)
- Truncated to 2 lines with ellipsis

### 4. Empty chat state

When a new chat is created and has no messages yet:
- Centered content in the message area
- Sparkles icon (32px, muted)
- "Start a new chat" title (16px, semibold)
- "Ask anything about the book you're reading" subtitle (13px, muted)
- Optionally: 2–3 suggested prompt pills (e.g. "Summarize this chapter", "Explain the main themes")

### 5. Chats page (full page, `/chats`)

A global chats management page accessible from the sidebar (under "Tools", below Vocabulary). Shows all chat threads across all books.

- **Sidebar**: "Chats" entry with `MessageSquare` icon, sits below Vocabulary in the Tools section
- **Header**: Same style as VocabPage — icon, "Chats" title, subtitle with total count
- **Search bar**: Filter chats by title (prefix match)
- **Filter pills**: Filter by book (show book titles as pills, similar to VocabPage book filter)
- **Chat list**: Each row shows:
  - Chat title (truncated)
  - Book title (muted, smaller text)
  - Message count or last message preview (truncated, muted)
  - Relative timestamp ("2h ago", "Mar 12")
  - "Open in Reader →" link to jump to the book with this chat active
  - Delete button on hover
- **Empty state**: When no chats exist yet — illustration/icon + "No chats yet" + "Start a chat from the reader's AI panel"

### 6. Inline title rename

When user clicks the chat title in the header:
- Title text becomes an input field (same size/position)
- Subtle border or underline to indicate edit mode
- Enter to save, Escape to cancel
- Auto-select all text on focus

## States to Cover

- **Default**: Chat with messages, dropdown closed
- **Dropdown open**: Showing chat list
- **Hover on chat row**: Trash icon appears
- **Empty chat**: No messages yet (new chat)
- **Renaming**: Inline title edit
- **Single chat**: Only one chat exists (no dropdown needed? or show it with just one item)

## Notes

- Keep it minimal — this is a sidebar panel, not a full page
- The message bubbles, input bar, and streaming indicators stay unchanged
- Match the existing visual language of other sidebar panels (Bookmarks, Vocab)
- Consider the transition: dropdown should feel snappy, not heavy
