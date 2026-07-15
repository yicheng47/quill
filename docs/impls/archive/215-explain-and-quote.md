# Impl — 215: Split Ask AI into Explain (inline) and Quote (side panel)

Feature spec: [`docs/features/215-explain-and-quote.md`](../features/215-explain-and-quote.md) · GitHub: [#215](https://github.com/yicheng47/quill/issues/215)

## Summary

Today the reader selection menu has one **Ask AI Assistant** entry. It opens the side panel and — via `AiPanel`'s context effect — **resets the chat and auto-sends** `"Explain"` with the selection as context. This both (a) conflates quick comprehension with conversation, and (b) destroys the running session every time.

We split it into two intents:

- **Explain** — inline one-shot popover (sibling of `LookupPopover`), streams an explanation of the passage in context. No chat, no side panel.
- **Quote** — opens the side panel and pins the passage as a **quote chip** above the composer. The user types their own question; the quote rides along as the message's citation. **Crucially, it attaches to the existing session chat instead of resetting it.**

### Key discoveries from the codebase (drive the design below)

1. **i18n keys are flat dotted strings**, not nested objects (e.g. `"contextMenu.askAI": "Ask AI Assistant"` is a top-level key in `en.json`). Add/rename keys as flat strings.
2. **The chat data model already supports per-message quotes.** `useAiChat.send(content, context?, contextCfi?)` persists `context`/`cfi`, inlines it into the API call as `[Selected passage: "…"]`, and `MessageBubble` already renders `msg.context` as a left-border block-quote. Quote needs **no new data plumbing** — only a pending-quote UI and a changed trigger.
3. **Session reuse is mostly subtractive.** `initialize()` (AiPanel mount) already loads the most-recent chat for the book (`chatList[0]`), or shows the empty state with lazy-create-on-send when none exists. The *only* reason a new chat is forced today is the context effect calling `reset()` then auto-sending. Quote = "don't reset, don't auto-send, show a chip." That single change satisfies the "reuse existing session chat / create only if none exists" requirement for free.
4. **Explain gets its own `ai_explain` command — do not reuse `ai_lookup`.** `ai_lookup` is built for *words*: the frontend fires it **twice concurrently** (`kind: "definition"` + `kind: "context"`) and it carries word-specific translation-prepend logic (prepend a few-word native gloss before the definition). Explain is a *passage*: one stream, one prompt, and a translation gloss makes no sense for a whole sentence. A `"explain"` `kind` would bolt a third unrelated branch onto a function whose whole shape (two streams, definition/context split) is wrong for it. New command keeps both prompts short and single-purpose. It reuses the same provider-settings read block, the per-request `ai-lookup-chunk-{requestId}` channel convention, and the `AI_NOT_CONFIGURED` guard.
5. **No `ai.explain` rename needed in the chat path** — once Quote no longer auto-sends `t("ai.explain")`, that string is only referenced by the old flow. Keep it (or drop it) but it's no longer load-bearing.

## Phase 1 — Context menu split

**`src/components/ReaderContextMenu.tsx`**

- Replace the `onAskAI: () => void` prop with `onExplain: () => void` and `onQuote: () => void`.
- Replace the single "Ask AI Assistant" `<button>` with two buttons, in order: **Explain**, then **Quote**.
- Icons (lucide): Look Up keeps `Sparkles`; **Explain → `WandSparkles`** (AI-explanation feel, distinct glyph from Look Up); **Quote → `Quote`**. Drop the now-unused `Bot` import.
- Both Explain and Quote are shown for **any** selection length. Look Up stays gated behind `wordCount <= 5`. Final order: `Look Up?` · `Explain` · `Quote` · `Translate` · divider · `Highlight` · divider · `Copy`.
- Strings: `t("contextMenu.explain")`, `t("contextMenu.quote")`.

**`src/pages/Reader.tsx`**

- Add an `explain` popover state mirroring the existing `lookup` state:
  ```ts
  const [explain, setExplain] = useState<{
    x: number; y: number; text: string; sentence: string;
    bookTitle?: string; chapter?: string; cfi?: string;
  } | null>(null);
  ```
- In the `<ReaderContextMenu>` usage (~line 1394), replace `onAskAI` with:
  - `onExplain={() => { setExplain({ x, y, text, sentence, bookTitle, chapter, cfi }); setContextMenu(null); }}` — derive `chapter`/`bookTitle` exactly like the `onLookup` handler does.
  - `onQuote={() => { setAiContext({ text: contextMenu.text, cfi: contextMenu.cfiRange }); setSidePanel("ai"); setContextMenu(null); }}` — same payload the old `onAskAI` set; the behavior change lives entirely in `AiPanel` (Phase 3).
- Render `<ExplainPopover …>` next to `<LookupPopover>` (Phase 2), wired to `explain` state with `onClose={() => setExplain(null)}`.

**i18n** (`src/i18n/en.json`, `src/i18n/zh.json`)

- Rename `contextMenu.askAI` → `contextMenu.explain` (en: `"Explain"`, zh: `"解释"`).
- Add `contextMenu.quote` (en: `"Quote"`, zh: `"引用"`).

## Phase 2 — Explain popover

**`src-tauri/src/commands/ai.rs`** — **new `ai_explain` command** (separate from `ai_lookup`; see discovery #4 for why).

- Signature:
  ```rust
  #[tauri::command]
  pub async fn ai_explain(
      passage: String,            // the selected sentence/passage
      surrounding: Option<String>,// optional wider paragraph for context
      book_title: Option<String>,
      chapter: Option<String>,
      request_id: String,
      app: AppHandle, db: State<'_, Db>, secrets: State<'_, Secrets>,
  ) -> AppResult<()>
  ```
- Reuse `ai_lookup`'s provider-settings read block and the OAuth/`AI_NOT_CONFIGURED` handling verbatim. Stream a **single** response on `ai-lookup-chunk-{request_id}` (same channel convention `LookupPopover` listens on), spawned the same way (anthropic / responses-api / openai-compat match).
- **Keep it short — via the prompt, not a token cap.** This is the key difference from `ai_lookup`. The prompt must produce a tight 2–3 sentence explanation, not an essay:
  > You are a reading assistant embedded in an ebook reader. The user selected a sentence or passage and wants to understand it **in context**. In **2–3 sentences**, explain what it means and why it matters here — clarify any difficult phrasing, allusion, or tone. Be direct and concise. Do **not** restate the passage, add headers/labels, or pad with preamble. Plain prose only.
- **Pass `max_tokens: None`** (like `ai_chat` does) — don't impose an output-token ceiling; a hard cap would truncate mid-sentence. Brevity is the prompt's job. Temperature `0.3`, matching the other commands.
- **Language:** apply only the *response-language* half of `ai_lookup`'s logic — if `lookup_language` (falling back to system `language`) is non-English, prepend `"Respond entirely in {lang}."`. **No translation-gloss branch** (that's a word-level concept; irrelevant for a passage). So `show_translation` / `native_language` are not read here.

**`src/components/ExplainPopover.tsx`** — new, modeled on `LookupPopover` but simplified to a single stream.

- Props: `{ x, y, text, sentence, bookTitle?, chapter?, bookId, cfi?, onClose }`.
- One streaming hook (adapt `LookupPopover`'s `useStreamingLookup` into a single-stream `useExplainStream`) calling `invoke("ai_explain", { passage: text, surrounding: sentence, bookTitle, chapter, requestId })` and listening on `ai-lookup-chunk-{requestId}`.
- Layout reuses the Look Up popover chrome: same `w-[440px]`, `bg-bg-surface`, `rounded-xl`, `shadow-context`; same position-clamping `ResizeObserver` effect; same Escape + click-outside dismissal; same `LOOKUP_PROSE` markdown styling.
  - Header: `WandSparkles` icon + `t("explain.title")` ("Explain") in the `accent-bg` bar with the `X` close button.
  - Body: a truncated quote of the selected passage (2–3 lines, `line-clamp`, muted) as the subject, then the streaming explanation. Loading state: `t("explain.thinking")`.
  - Footer (when `!streaming && content`): a **Copy** button (mirror Look Up's). **No Save-to-Dict** — Explain is passage-level, not a vocab word. (Spec open-question "save as note" is deferred to v2; do not build it now.)
- Reuse the `AI_NOT_CONFIGURED` handling from `LookupPopover` verbatim (open-settings affordance).

**Register the command:** add `ai_explain` to the `invoke_handler!`/`generate_handler!` list (alongside `ai_lookup`) in `src-tauri/src/lib.rs`.

**i18n**: `explain.title` ("Explain" / "解释"), `explain.thinking` ("Explaining…" / "正在解释…"), `explain.copy`/`explain.copied` (or reuse `lookup.copy`/`lookup.copied`).

## Phase 3 — Quote chip in the AI panel

This is where session reuse is enforced. **No backend changes.**

**`src/components/AiPanel.tsx`**

- **Replace** the auto-send context effect (current lines ~63–73). New behavior: when `context` arrives, set a local `pendingQuote` state and **do not** `reset()` or `send()`:
  ```ts
  const [pendingQuote, setPendingQuote] = useState<{ text: string; cfi?: string } | undefined>();
  useEffect(() => {
    if (!context) return;
    setPendingQuote(context);
    onContextConsumed?.();   // clear Reader's aiContext so re-quoting the same passage re-triggers
  }, [context, onContextConsumed]);
  ```
- **Remove the `if (context) return;` guard** in the mount/initialize effect (lines ~46–49). With the auto-send flow gone, the race it guarded against no longer exists, and we *want* `initialize()` to run so the existing session chat loads (or empty-state when none) before the chip is attached. This is the core of "reuse existing chat; create only if none exists" — `send()`'s lazy-create path handles the no-chat case automatically.
- Render the **quote chip** as the first child of the input container (above the textarea row), only when `pendingQuote`:
  - Left-border (`#c084fc`/lavender) + faint lavender background, rounded, small padding.
  - 2-line clamped italic muted preview of `pendingQuote.text`.
  - A dismiss `X` button → `setPendingQuote(undefined)`.
- **Send wiring:** `handleSend` and the suggested-prompt buttons pass the quote through and clear it:
  ```ts
  const handleSend = () => {
    if (!input.trim() || streaming) return;
    send(input.trim(), pendingQuote?.text, pendingQuote?.cfi);
    setPendingQuote(undefined);
    setInput("");
  };
  ```
  The block-quote rendering in the user turn and the inlined model context are already handled by `MessageBubble` + `useAiChat` — no change there.
- **Esc clears the chip** when the composer is focused (Phase 4).

**`src/hooks/useAiChat.ts`** — audit only; expected **no change**. `send(content, context, contextCfi)` already: persists `context` + `{cfi}` metadata, renders via `MessageBubble`, and inlines `[Selected passage: "…"]` into `apiMessages`. The auto-title path already prefers `context || content`, so a quoted first message still titles sensibly. Confirm the `deriveTitle` regex (strips `"Explain this passage:"`) still produces reasonable fallbacks; tweak only if needed.

### Session-reuse behavior matrix (verification-driving)

| Existing session chat? | Panel state | Quote action result |
|---|---|---|
| Yes (has turns) | open or closed | Panel opens to that chat, prior turns intact, chip attached. **No new chat.** |
| No chat yet | n/a | Empty state shown, chip attached; first send lazily creates the chat. |
| In-flight stream | open | Chip attaches without interrupting the stream (no reset). Send is disabled until stream completes (existing `streaming` guard). |

## Phase 4 — Polish

- **Keyboard:** `ExplainPopover` closes on `Esc` (same handler as Look Up). In `AiPanel`, `Esc` in the textarea clears `pendingQuote` (and only the chip — don't also blur/close the panel).
- **Hover/active states** match existing popovers and the user-context block-quote (`MessageBubble` `qL8wm` styling: left border lavender, italic muted).
- **i18n — all new strings in both `en.json` and `zh.json`:**
  - `contextMenu.explain`, `contextMenu.quote`
  - `explain.title`, `explain.thinking`, (`explain.copy`/`explain.copied` or reuse lookup)
  - `aiPanel.quoteChip.dismiss` (tooltip/aria for the chip's X), optionally `aiPanel.quoteChip.label`.
- Remove dead code: unused `Bot` import in `ReaderContextMenu`; if `ai.explain` is now unreferenced, leave it (harmless) or remove in the same PR.

## Backend tests

Per project convention (test new backend commands first). The `ai_explain` stream hits a network provider and isn't unit-testable directly, so extract the pure prompt-building into a small helper (e.g. `explain_system_prompt(language: &str) -> String`) and test that:

- The base prompt asks for a **2–3 sentence**, context-aware, no-headers explanation (assert on the key constraints, not the exact wording).
- A non-English `language` prepends `"Respond entirely in {lang}."`; English prepends nothing.
- **No** translation-gloss preamble appears (guards against accidentally copying `ai_lookup`'s word-level logic).

## Files touched

| File | Change |
|---|---|
| `src/components/ReaderContextMenu.tsx` | `onAskAI` → `onExplain` + `onQuote`; icons; order |
| `src/components/ExplainPopover.tsx` | **new** — inline one-shot explanation popover |
| `src/components/AiPanel.tsx` | pending-quote chip; drop auto-send/reset; let initialize run |
| `src/pages/Reader.tsx` | `explain` state; wire `onExplain`/`onQuote`; render `ExplainPopover` |
| `src-tauri/src/commands/ai.rs` | **new `ai_explain` command** — single short stream, own brevity-tuned prompt |
| `src-tauri/src/lib.rs` | register `ai_explain` in the command handler list |
| `src/i18n/en.json`, `src/i18n/zh.json` | rename `contextMenu.askAI`→`.explain`; add `.quote`, `explain.*` |

## Out of scope (deferred)

- Save-Explain-as-note (spec open question) — v2.
- "Quote → send immediately" setting — not in v1.

## Design

Pencil source: `design/quill-desktop.pen`. Frames added for this feature:

- **Reader — Context Menu + Explain (215):** reader with the selection context menu open (Look Up · **Explain** · **Quote** · Translate · Highlight · Copy) and the **Explain popover** streaming a passage explanation.
- **Reader — Quote chip (215):** the AI side panel with a dismissable **quote chip** above the composer and a sent user turn showing the quote as a block-quote citation.

### Figma/design prompt (text-based, intent-level)

> **Explain popover** — Reuse the Look Up popover shell exactly (440-wide card, rounded-xl, soft shadow, accent-tinted header bar). Header: a wand-sparkles icon + "Explain". Body: show the selected sentence as a short, italic, muted 2–3 line quote at the top, then the AI explanation as flowing prose that reads like a knowledgeable friend clarifying the passage in its context. Footer: a single quiet "Copy" action (no Save-to-Dict — this isn't a vocab word). One-shot, dismissible; same loading shimmer/spinner language as Look Up.
>
> **Quote chip** — Above the chat composer, a compact dismissable chip representing the passage the user is about to ask about: a lavender left-rule, faint lavender wash, 2-line-clamped italic preview of the quoted text, and a small × to remove it. It should feel like an attachment pinned to the next message — clearly pending, not yet sent. On send it migrates into the user's message bubble as the existing block-quote citation. The chip must not look like it reset or replaced the conversation: the prior turns stay visible behind/above it.
>
> **Context menu** — Replace the single "Ask AI Assistant" row with two rows, "Explain" (wand-sparkles) then "Quote" (quote glyph), keeping the existing row height, spacing, hover wash, and dividers. "Look Up" still only appears for short (≤5-word) selections; "Explain" and "Quote" appear for any selection.
