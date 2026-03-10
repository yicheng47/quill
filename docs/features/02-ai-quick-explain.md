# AI Quick Explain

**Version:** 0.2
**Date:** March 8, 2026
**Status:** Design

---

## 1. Motivation

When reading, users frequently encounter unfamiliar words, idioms, or short phrases whose meaning depends on the surrounding context. The existing "Ask AI Assistant" action opens the side panel and starts a full chat — too heavyweight for a quick definition lookup.

**Quick Explain** adds a lightweight, inline context menu action that sends the selected word/phrase along with its surrounding sentence to the AI, and displays the explanation in a transient popover anchored near the selection — no panel required.

---

## 2. UX Design

### 2.1. Context Menu Entry

When the user selects **a single word or short phrase (≤ 5 words)** and right-clicks, the context menu shows a new item between "Copy" and "Ask AI Assistant":

```
┌────────────────────────────────┐
│  📋  Copy               ⌘C    │
│────────────────────────────────│
│  💡  Quick Explain             │
│────────────────────────────────│
│  🤖  Ask AI Assistant          │
└────────────────────────────────┘
```

- **Only shown** when the selection is ≤ 5 words. For longer selections, the menu stays as-is (Copy + Ask AI Assistant).
- The word count threshold is checked via simple whitespace splitting: `text.trim().split(/\s+/).length <= 5`.

### 2.2. Explain Popover

Clicking "Quick Explain" dismisses the context menu and shows a floating popover near the selection:

```
┌─────────────────────────────────────────────┐
│  💡 Quick Explain                         ✕ │
│─────────────────────────────────────────────│
│  ● ● ● (streaming indicator)               │
│                                             │
│  "Ephemeral" means lasting for a very       │
│  short time. In this sentence, the author   │
│  uses it to describe the fleeting nature    │
│  of the character's happiness.              │
└─────────────────────────────────────────────┘
```

- **Position:** Anchored below the context menu location (same x/y), clamped to viewport.
- **Width:** 320px fixed.
- **Dismissal:** Click the ✕ button, press Escape, or click anywhere outside.
- **Streaming:** The response streams in real-time, same as the AI panel.
- **Rendered as Markdown** for bold, italic, etc.

### 2.3. Sentence Extraction

The AI needs the surrounding sentence for context. The backend receives both the selected word/phrase and the surrounding sentence. The frontend extracts the sentence as follows:

1. From the iframe document, get the Selection's anchor node (the text node containing the selection).
2. Walk to the containing block-level element (e.g., `<p>`, `<div>`, `<li>`, `<blockquote>`).
3. Get `textContent` of that block element — this is the "sentence context".
4. If the block text is very long (> 500 chars), trim to the nearest sentence boundary (`.`, `!`, `?`) surrounding the selection offset.

This approach is simple, robust, and doesn't require NLP sentence tokenization.

---

## 3. Technical Architecture

### 3.1. New Tauri Command

A lightweight command separate from `ai_chat` to keep concerns clean. It uses the same provider/model settings but a specialized system prompt, and emits events on a **different channel** so it doesn't interfere with an active AI panel chat.

```rust
#[tauri::command]
pub async fn ai_quick_explain(
    word: String,
    sentence: String,
    app: AppHandle,
    db: State<'_, Db>,
) -> AppResult<()>
```

- Reads provider settings from DB (same as `ai_chat`).
- Constructs a single-turn prompt with a focused system message.
- Streams response via event name `"ai-quick-explain-chunk"` (same `AiStreamChunk` shape).
- Uses `max_tokens: 256` to keep responses concise and fast.

**System prompt:**

```
You are a reading assistant. The user selected a word or phrase from a book
and wants a brief explanation. Explain the meaning in 2-3 sentences,
considering the context of the surrounding sentence. If it's a literary
device, idiom, or domain-specific term, note that. Be concise.
```

**User message:**

```
Word/phrase: "{word}"
Sentence: "{sentence}"
```

### 3.2. Frontend Event Flow

```
User selects word → right-click → "Quick Explain"
  │
  ├── Extract sentence context from iframe DOM
  ├── Show QuickExplainPopover at (x, y) with loading state
  ├── listen("ai-quick-explain-chunk") → stream into popover
  └── invoke("ai_quick_explain", { word, sentence })
        │
        Backend streams on "ai-quick-explain-chunk"
        │
        done: true → streaming complete
```

### 3.3. Data Flow (no persistence)

Quick Explain responses are **ephemeral** — they are not stored in chat history, bookmarks, or any database table. The popover is purely transient. If the user wants to keep the explanation, they can select and copy it.

---

## 4. Files to Modify

| File | Change |
|------|--------|
| `src-tauri/src/commands/ai.rs` | Add `ai_quick_explain` command. Reads same provider settings, builds single-turn messages with specialized system prompt, streams on `"ai-quick-explain-chunk"` event. Uses `max_tokens: 256`. |
| `src-tauri/src/main.rs` | Register `ai_quick_explain` in the Tauri invoke handler. |
| `src/components/ReaderContextMenu.tsx` | Accept new `onQuickExplain` callback prop. Conditionally render "Quick Explain" menu item when `wordCount <= 5`. |
| `src/components/QuickExplainPopover.tsx` | **NEW FILE.** Floating popover component. Accepts `word`, `sentence`, position `(x, y)`, `onClose`. Manages its own streaming state: listens to `"ai-quick-explain-chunk"`, invokes `ai_quick_explain`, renders streamed Markdown response. Handles viewport clamping, Escape/click-outside dismissal. |
| `src/pages/Reader.tsx` | Add `quickExplain` state `{ x, y, word, sentence } | null`. In context menu handler, extract surrounding sentence from iframe DOM. Pass `onQuickExplain` to `ReaderContextMenu`. Render `QuickExplainPopover` when state is set. |

---

## 5. Implementation Plan

### Phase 1: Backend

1. Add `ai_quick_explain` command to `commands/ai.rs` with specialized prompt and `max_tokens: 256`.
2. Emit chunks on `"ai-quick-explain-chunk"` event channel.
3. Register command in `main.rs`.

### Phase 2: Frontend — Context Menu

1. Add `onQuickExplain` prop to `ReaderContextMenu`.
2. Show "Quick Explain" item only when selection word count ≤ 5.
3. In `Reader.tsx`, extract sentence context from the iframe DOM when building context menu state.

### Phase 3: Frontend — Popover

1. Create `QuickExplainPopover.tsx` — self-contained component that handles its own `listen`/`invoke` lifecycle.
2. Wire up in `Reader.tsx`: clicking "Quick Explain" sets state, renders popover, popover self-manages streaming.

### Phase 4: Polish

1. Add loading shimmer / dot animation while waiting for first chunk.
2. Ensure popover doesn't overlap the header or bottom bar.
3. Test with all providers (Ollama, Anthropic, MiniMax, OpenAI).
4. Handle edge case: user triggers Quick Explain while another is already open (replace the previous one).

---

## 6. Edge Cases & Considerations

- **Long paragraph blocks:** If the containing `<p>` is very long (e.g., a 2000-char paragraph), trim to ~500 chars around the selection offset. This keeps the prompt small and the response focused.
- **Selection across elements:** If the selection spans two paragraphs, fall back to the selection text itself as context (skip sentence extraction). The 5-word limit makes this rare.
- **Concurrent with AI panel:** Quick Explain uses a separate event channel (`ai-quick-explain-chunk`), so it doesn't conflict with an active AI panel chat session. Both can run simultaneously.
- **Provider errors:** If the API call fails, display the error inline in the popover (same pattern as AI panel error handling).
- **Non-text content:** If the user selects text from an image alt-text or metadata, it still works — the word and sentence are just strings.
- **Keyboard shortcut (future):** A keyboard shortcut (e.g., `⌘D` for "define") could be added later to trigger Quick Explain without right-clicking.
