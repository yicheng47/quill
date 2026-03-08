# AI Thinking Mode

**Version:** 0.2
**Date:** March 8, 2026
**Status:** Design

---

## 1. Motivation

Quill's AI chat currently operates in a single "fast" mode — standard chat completions with no reasoning visibility. For complex literary analysis, thematic questions, and nuanced passage interpretation, users benefit from seeing the model's chain-of-thought reasoning and getting deeper, more considered responses.

**Thinking mode** lets the user toggle between:
- **Fast** — Standard completions (current behavior). Low latency, good for definitions, translations, and quick questions.
- **Think** — Extended thinking / reasoning mode. The model reasons step-by-step before answering. The reasoning trace is shown in a collapsible block above the final response.

---

## 2. UX Design

### 2.1. Toggle Location

A **Fast / Think** segmented toggle in the AiPanel header bar, next to the "AI Reading Assistant" title. This keeps the mode choice contextual to the chat, not buried in global settings.

```
┌─────────────────────────────────────────────┐
│ ✦ AI Reading Assistant       [Fast | Think] │
├─────────────────────────────────────────────┤
│  ...messages...                             │
```

- The toggle is disabled while a response is streaming.
- Default mode is **Fast**.

### 2.2. Thinking Display

When a response arrives in Think mode, the assistant message renders as:

```
┌─ Thinking ──────────────────────── ▾ ──────┐
│ Let me consider the themes in this passage… │
│ The author uses the metaphor of…            │
│ This connects to the earlier chapter…       │
└────────────────────────────────────────────-┘

Here is my analysis:

The passage explores the tension between…
```

- **Collapsed by default** once streaming finishes (so the final answer is prominent).
- **Expanded while streaming** (so the user can watch the model think in real time).
- Styled with a muted background and smaller font to visually differentiate from the final answer.
- A "Thinking" label with a chevron toggle to expand/collapse.

### 2.3. Thinking Budget (Settings)

For Anthropic and MiniMax (which use the Anthropic Messages API), the thinking budget is configurable in **SettingsPage → AI Assistant Configuration**:

- **Slider:** "Thinking Budget" — range 1024–16384 tokens, default 4096.
- **Only visible** when provider is `anthropic` or `minimax`.
- Stored as setting key `ai_thinking_budget`.

Ollama does not expose a budget parameter — the model decides how much to think internally.

---

## 3. Provider-Specific Implementation

### 3.1. Anthropic (and MiniMax)

**API:** Anthropic Messages API (`/v1/messages`) — already used today.

When thinking mode is enabled, the request body changes:

```json
{
  "model": "claude-sonnet-4-20250514",
  "max_tokens": 16000,
  "thinking": {
    "type": "enabled",
    "budget_tokens": 4096
  },
  "temperature": 1,
  "stream": true,
  "system": "...",
  "messages": [...]
}
```

Key constraints from the Anthropic API:
- `temperature` **must be `1`** when thinking is enabled (enforced server-side). The backend overrides the user's temperature setting.
- `max_tokens` must be greater than `budget_tokens`. The backend sets `max_tokens` to `budget_tokens + 8192` (ensuring room for the final answer).
- `budget_tokens` minimum is 1024.

**SSE events** with thinking enabled include a new content block type:

```
event: content_block_start
data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"Let me analyze..."}}

event: content_block_stop
data: {"type":"content_block_stop","index":0}

event: content_block_start
data: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}

event: content_block_delta
data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"Here is my analysis..."}}
```

The backend maps these to `AiStreamChunk` events with a `kind` field:
- `thinking_delta` → `kind: "thinking"`
- `text_delta` → `kind: "text"`

MiniMax uses the same Anthropic-compatible API at `https://api.minimax.io/anthropic`, so the same code path applies (with `use_bearer_auth: true`).

### 3.2. Ollama (Native API)

**Problem:** Ollama's OpenAI-compatible endpoint (`/v1/chat/completions`) has inconsistent thinking support across versions and models. The native `/api/chat` endpoint is stable and well-documented for thinking.

**Solution:** Create a new provider file `src-tauri/src/ai/ollama.rs` that uses Ollama's native `/api/chat` endpoint.

**Request (thinking enabled):**
```json
{
  "model": "deepseek-r1",
  "messages": [
    {"role": "system", "content": "..."},
    {"role": "user", "content": "..."}
  ],
  "stream": true,
  "think": true,
  "keep_alive": "30m"
}
```

**Request (thinking disabled — fast mode):**
```json
{
  "model": "llama3.2",
  "messages": [...],
  "stream": true,
  "keep_alive": "30m",
  "options": {
    "temperature": 0.3
  }
}
```

Note: When `think: true` is set, Ollama ignores the `temperature` option (the model controls its own sampling during reasoning). When `think` is omitted or false, temperature is passed via `options`.

**Response (NDJSON, not SSE):**

Ollama's native streaming returns newline-delimited JSON objects (not SSE `data:` lines):

```json
{"model":"deepseek-r1","message":{"role":"assistant","content":"","thinking":"Let me analyze"},"done":false}
{"model":"deepseek-r1","message":{"role":"assistant","content":"","thinking":" this passage"},"done":false}
{"model":"deepseek-r1","message":{"role":"assistant","content":"Here is","thinking":""},"done":false}
{"model":"deepseek-r1","message":{"role":"assistant","content":" my analysis","thinking":""},"done":false}
{"model":"deepseek-r1","message":{"role":"assistant","content":""},"done":true}
```

- `message.thinking` contains thinking content (streamed first).
- `message.content` contains the final answer (streamed after thinking completes).
- The backend emits `kind: "thinking"` chunks for non-empty `thinking` fields, then `kind: "text"` chunks for non-empty `content` fields.

**Routing change:** In `commands/ai.rs`, when provider is `ollama`, route to `crate::ai::ollama::stream_chat()` instead of `openai_compat`. Other OpenAI-compatible providers (OpenAI, Google) continue using `openai_compat`.

### 3.3. Other OpenAI-Compatible Providers (OpenAI, Google)

No thinking support. All chunks emitted with `kind: "text"` (matching current behavior). The thinking toggle is hidden in AiPanel when the provider doesn't support it, or simply ignored on the backend.

---

## 4. Technical Architecture

### 4.1. Data Model Changes

**`AiStreamChunk` (Rust, emitted via Tauri events):**

```rust
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AiStreamChunk {
    pub delta: String,
    pub done: bool,
    pub kind: String, // "text" | "thinking"
}
```

All existing providers emit `kind: "text"` for backward compatibility.

**`ChatMessage` (TypeScript, frontend):**

```typescript
export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  thinking?: string; // accumulated thinking text
}
```

**`ai_chat` command signature:**

```rust
pub async fn ai_chat(
    messages: Vec<ChatMessage>,
    context: Option<String>,
    thinking: bool,           // NEW
    app: AppHandle,
    db: State<'_, Db>,
) -> AppResult<()>
```

### 4.2. Backend Flow

```
ai_chat(messages, context, thinking=true)
  │
  ├── provider == "anthropic" or "minimax"
  │     → anthropic::stream_chat(..., thinking=true, budget=<from settings>)
  │       → POST /v1/messages with thinking: { type: "enabled", budget_tokens }
  │       → Parse thinking_delta → emit AiStreamChunk { kind: "thinking" }
  │       → Parse text_delta    → emit AiStreamChunk { kind: "text" }
  │
  ├── provider == "ollama"
  │     → ollama::stream_chat(..., thinking=true)
  │       → POST /api/chat with think: true
  │       → Parse NDJSON: message.thinking → emit { kind: "thinking" }
  │       → Parse NDJSON: message.content  → emit { kind: "text" }
  │
  └── provider == "openai" / "google" / other
        → openai_compat::stream_chat(...) (unchanged)
        → All chunks emit { kind: "text" }
```

### 4.3. Frontend Flow

```
User toggles Think mode → state: thinkingMode = true
User sends message →
  invoke("ai_chat", { messages, context, thinking: true })
  │
  listen("ai-stream-chunk") →
    ├── kind == "thinking" → append to assistantMessage.thinking
    └── kind == "text"     → append to assistantMessage.content
  │
  Render:
    ├── msg.thinking → collapsible "Thinking" block
    └── msg.content  → main answer (Markdown)
```

---

## 5. Files to Modify

| File | Change |
|------|--------|
| `src-tauri/src/commands/ai.rs` | Add `kind: String` to `AiStreamChunk`. Add `thinking: bool` param to `ai_chat`. Read `ai_thinking_budget` from settings. Pass `thinking` + budget to provider functions. |
| `src-tauri/src/ai/anthropic.rs` | Accept `thinking: bool` and `budget: u32` params. Conditionally add `thinking` object to request body. Override temperature to 1.0 and set `max_tokens` to `budget + 8192`. Parse `thinking_delta` events and emit chunks with `kind: "thinking"`. Emit `text_delta` chunks with `kind: "text"`. |
| `src-tauri/src/ai/ollama.rs` | **NEW FILE.** Native Ollama provider using `POST /api/chat`. Accept `thinking: bool`. Parse NDJSON streaming response. Emit `kind: "thinking"` for `message.thinking` and `kind: "text"` for `message.content`. |
| `src-tauri/src/ai/openai_compat.rs` | Add `kind: "text"` to all emitted `AiStreamChunk`s (no other changes). |
| `src-tauri/src/ai/mod.rs` | Add `pub mod ollama;` |
| `src/hooks/useAiChat.ts` | Add `thinking?: string` to `ChatMessage`. Update event listener to branch on `event.payload.kind`: append to `thinking` or `content`. Add `thinkingMode` param to `send()`. Pass `thinking: thinkingMode` to `invoke("ai_chat")`. |
| `src/components/AiPanel.tsx` | Add `thinkingMode` state with Fast/Think toggle in header. Pass `thinkingMode` to `send()`. Render collapsible thinking block when `msg.thinking` is present. Disable toggle while streaming. |
| `src/pages/SettingsPage.tsx` | Add "Thinking Budget" slider (1024–16384, default 4096). Only shown when provider is `anthropic` or `minimax`. Save as `ai_thinking_budget` setting. |

---

## 6. Implementation Plan

### Phase 1: Backend Infrastructure

1. Add `kind` field to `AiStreamChunk` in `commands/ai.rs`.
2. Add `thinking` param to `ai_chat` command and read `ai_thinking_budget` from settings.
3. Update `openai_compat.rs` to emit `kind: "text"` on all chunks.
4. Update `anthropic.rs` to accept thinking params, conditionally build thinking request body, and parse `thinking_delta` / `text_delta` SSE events.
5. Create `ollama.rs` with native `/api/chat` streaming and thinking support.
6. Register `ollama` module in `ai/mod.rs`.
7. Update provider routing in `ai_chat` to use `ollama::stream_chat` for the `ollama` provider.

### Phase 2: Frontend Integration

1. Extend `ChatMessage` in `useAiChat.ts` with `thinking` field.
2. Update event listener to branch on `kind` and accumulate thinking vs content.
3. Pass `thinking` param through to `invoke("ai_chat")`.
4. Add Fast/Think toggle to `AiPanel.tsx` header.
5. Render collapsible thinking block in assistant messages.
6. Add thinking budget slider to `SettingsPage.tsx`.

### Phase 3: Polish

1. Auto-collapse thinking block when streaming finishes.
2. Add streaming indicator specific to thinking phase ("Reasoning...") vs answer phase ("Writing...").
3. Test with all three provider paths: Anthropic, MiniMax, Ollama.
4. Verify that non-thinking providers (OpenAI, Google) work unchanged.

---

## 7. Edge Cases & Considerations

- **Model compatibility:** Not all Ollama models support thinking (only reasoning models like `deepseek-r1`, `qwq`). If `think: true` is sent to a non-reasoning model, Ollama returns normal responses with empty `thinking` fields — this is handled gracefully (no thinking block rendered).
- **Temperature override:** When thinking is enabled for Anthropic/MiniMax, temperature is forced to 1.0 per API requirements. The user's configured temperature is restored for non-thinking requests.
- **Token budget:** The thinking budget only applies to Anthropic/MiniMax. Ollama models manage their own thinking length internally.
- **Message history:** Thinking content is display-only and is **not** sent back in conversation history. The API messages array only includes `role` and `content` fields.
- **Error handling:** If a provider doesn't support thinking and returns an error, the backend catches it and emits an error chunk as it does today.
