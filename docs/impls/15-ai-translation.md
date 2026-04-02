# Passage Translation (Phase 1)

## Context

Quill's AI features only support word-level lookup. For foreign-language books, users need to select a sentence/paragraph and get a full passage translation. This implements Phase 1 of the [AI Translation spec](../features/15-ai-translation.md) — on-demand passage translation with caching.

Issue: #73

## Approach

Add a "Translate" context menu action that opens a `TranslationPanel` popover (similar to `LookupPopover`) showing the original text (collapsed) and a streaming translation. Cache translations in a new `translation_cache` SQLite table so repeat requests return instantly. The backend command checks cache first, falls back to streaming AI translation, then writes the result to cache.

---

## Step 1: Add `translation_cache` migration

**File: `src-tauri/migrations/006_translation_cache.sql`** (new)

```sql
CREATE TABLE IF NOT EXISTS translation_cache (
    id TEXT PRIMARY KEY,
    book_id TEXT NOT NULL,
    section_index INTEGER NOT NULL DEFAULT 0,
    source_hash TEXT NOT NULL,
    source_text TEXT NOT NULL,
    translated_text TEXT NOT NULL,
    target_language TEXT NOT NULL,
    element_index INTEGER,
    created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_translation_cache_lookup
    ON translation_cache (book_id, section_index, source_hash, target_language);
```

**File: `src-tauri/src/db.rs`**

- Add `(6, include_str!("../migrations/006_translation_cache.sql"))` to `MIGRATIONS` array.
- Update the version 4/5 lenient handling comment — migration 6 uses `IF NOT EXISTS` so it's safe with the normal path.

---

## Step 2: Add `ai_translate_passage` and `clear_translation_cache` backend commands

**File: `src-tauri/src/commands/translation.rs`** (new)

Two commands:

### `ai_translate_passage`

```
#[tauri::command]
pub async fn ai_translate_passage(
    text: String,
    book_id: String,
    section_index: Option<i64>,
    target_language: Option<String>,
    request_id: String,
    app: AppHandle,
    db: State<'_, Db>,
    secrets: State<'_, Secrets>,
) -> AppResult<()>
```

Logic:
1. Read `translation_target_language` setting (fall back to `native_language`, then `"en"`).
2. Compute `source_hash` = SHA-256 hex of `text`.
3. Query `translation_cache` for a hit on `(book_id, section_index, source_hash, target_language)`.
4. **Cache hit**: emit the cached `translated_text` as a single `AiStreamChunk { delta, done: false }` followed by `{ delta: "", done: true }` on the event channel `ai-translate-chunk-{request_id}`. Return immediately.
5. **Cache miss**: read AI provider settings (same pattern as `ai_lookup` in `commands/ai.rs:34-54`), build a system prompt for translation, spawn an async streaming task. Accumulate the full response in the spawned task. After the `done` signal, insert into `translation_cache`.

System prompt:
```
You are a translator. Translate the following passage into {target_language}.
Produce only the translation — no commentary, no labels, no original text.
Preserve paragraph structure and tone.
```

Use the `ChatMessage` and `AiStreamChunk` types from `commands/ai.rs`. Use the same provider routing pattern (`ai_lookup` lines 133-162).

Use `sha2` crate for hashing — add `sha2 = "0.10"` to `[dependencies]` in `Cargo.toml`.

### `clear_translation_cache`

```
#[tauri::command]
pub fn clear_translation_cache(
    book_id: Option<String>,
    db: State<'_, Db>,
) -> AppResult<u64>
```

If `book_id` is provided, delete cache for that book only. Otherwise delete all rows. Return the number of rows deleted.

**File: `src-tauri/src/commands/mod.rs`** — add `pub mod translation;`

**File: `src-tauri/src/lib.rs`** — register both commands in `invoke_handler` under a `// Translation` comment block.

---

## Step 3: Create `TranslationPanel` component

**File: `src/components/TranslationPanel.tsx`** (new)

A popover component positioned near the selection (same positioning pattern as `LookupPopover.tsx`). Layout:

- **Header**: accent background, `Languages` icon + "Translation" title + close button (same style as `LookupPopover.tsx:221-234`)
- **Original text**: collapsed by default, expand on click. Show first ~80 chars with "..." truncation. `text-[12px] text-text-muted italic`. A small `ChevronDown`/`ChevronUp` toggle.
- **Translation body**: streaming text with `Loader2` spinner pattern (same as `LookupPopover` definition section, lines 262-278)
- **Footer**: "Copy" button (same style as `LookupPopover` footer, lines 305-322). Show only when streaming is done.

Width: `440px` (same as LookupPopover).

Internal hook `useStreamingTranslation(text, bookId, sectionIndex, targetLanguage)`:
- Same pattern as `useStreamingLookup` in `LookupPopover.tsx:20-87`
- Event name: `ai-translate-chunk-{requestId}`
- Invokes `ai_translate_passage` command
- Returns `{ content, streaming, notConfigured }`

Props:
```typescript
interface TranslationPanelProps {
  x: number;
  y: number;
  text: string;
  bookId: string;
  sectionIndex?: number;
  onClose: () => void;
}
```

---

## Step 4: Add "Translate" to context menu

**File: `src/components/ReaderContextMenu.tsx`**

- Add `onTranslate` callback to `ReaderContextMenuProps` interface.
- Add a "Translate" button between "Ask AI Assistant" and "Highlight", using `Languages` icon from lucide-react. Same button style as existing items (line 95-103).
- Add separator divider before Highlight section only (keep the existing `{onHighlight && (<>` block as-is, the new Translate button goes before it).

---

## Step 5: Wire up in Reader.tsx

**File: `src/pages/Reader.tsx`**

1. Add `translation` state (same shape as `lookup` state but without `sentence`/`bookTitle`/`chapter`):
   ```typescript
   const [translation, setTranslation] = useState<{
     x: number;
     y: number;
     text: string;
     sectionIndex?: number;
   } | null>(null);
   ```

2. Add `onTranslate` handler to `<ReaderContextMenu>` (after `onLookup`, around line 1247):
   ```typescript
   onTranslate={() => {
     setTranslation({
       x: contextMenu.x,
       y: contextMenu.y,
       text: contextMenu.text,
       sectionIndex: currentChapterIndex >= 0 ? currentChapterIndex : undefined,
     });
     setContextMenu(null);
   }}
   ```

3. Render `<TranslationPanel>` alongside `<LookupPopover>` (after line 1277):
   ```typescript
   {translation && (
     <TranslationPanel
       x={translation.x}
       y={translation.y}
       text={translation.text}
       bookId={bookId!}
       sectionIndex={translation.sectionIndex}
       onClose={() => setTranslation(null)}
     />
   )}
   ```

---

## Step 6: Add i18n keys

**File: `src/i18n/en.json`**

```json
"contextMenu.translate": "Translate",
"translation.title": "Translation",
"translation.original": "Original",
"translation.translating": "Translating...",
"translation.copy": "Copy",
"translation.copied": "Copied",
"settings.translation.clearCache": "Clear Translation Cache",
"settings.translation.clearCacheHint": "Remove all cached translations",
"settings.translation.cacheCleared": "Translation cache cleared",
"settings.translation.targetLanguage": "Translation Language",
"settings.translation.targetLanguageHint": "Target language for passage translations"
```

**File: `src/i18n/zh.json`**

```json
"contextMenu.translate": "翻译",
"translation.title": "翻译",
"translation.original": "原文",
"translation.translating": "翻译中...",
"translation.copy": "复制",
"translation.copied": "已复制",
"settings.translation.clearCache": "清除翻译缓存",
"settings.translation.clearCacheHint": "移除所有已缓存的翻译",
"settings.translation.cacheCleared": "翻译缓存已清除",
"settings.translation.targetLanguage": "翻译语言",
"settings.translation.targetLanguageHint": "段落翻译的目标语言"
```

---

## Step 7: Add translation settings to Lookup settings section

**File: `src/components/settings/LookupSettings.tsx`**

Add two rows after the existing lookup settings (following the 73px row pattern):

1. **Translation Language** — `Select` dropdown with language options, saves to `translation_target_language` setting. Default: value of `native_language` setting.
2. **Clear Translation Cache** — Button that invokes `clear_translation_cache` command and shows a saved toast.

---

## Figma design prompt

> **TranslationPanel popover** — a floating popover (440px wide) for displaying streaming AI passage translations. Visually related to the existing LookupPopover.
>
> **Structure (top to bottom):**
> 1. **Header bar** — accent background (`bg-accent-bg`), same height/style as LookupPopover header. Left: `Languages` icon (16px) + "Translation" label (14px medium). Right: close `X` button.
> 2. **Original text block** — collapsed by default, showing first ~80 characters truncated with "..." in 12px muted italic. A small chevron toggle on the right expands/collapses the full original. When expanded, show the full text in a scrollable container with max-height ~120px, same 12px muted italic style. Light border-bottom or subtle bg-muted background to separate from translation.
> 3. **Translation body** — main content area with 13px text, same leading/color as LookupPopover definition text. While streaming, show a small inline `Loader2` spinner at the end of the text. Before any content arrives, show a "Translating..." line with spinner (same as "Looking up..." state in LookupPopover).
> 4. **Footer** — only visible when streaming is done. A single "Copy" button (13px medium, muted text, `Copy` icon) aligned right. Same style as LookupPopover footer but without the "Save to Dict" button.
>
> **States:** loading (spinner + "Translating..."), streaming (text appearing incrementally with inline spinner), complete (full text, footer visible), not-configured (same guidance card as LookupPopover), cached (instant display, no spinner visible).
>
> **Positioning:** same viewport-clamped fixed positioning as LookupPopover — appears near the text selection, repositions to stay within viewport with 16px padding.
>
> **Theme:** follows app theme variables. Same shadow-context, border-border/80, bg-bg-surface as LookupPopover.

---

## Files to modify

| File | Change |
|------|--------|
| `src-tauri/migrations/006_translation_cache.sql` | New migration for translation cache table |
| `src-tauri/src/db.rs` | Register migration 6 |
| `src-tauri/Cargo.toml` | Add `sha2 = "0.10"` dependency |
| `src-tauri/src/commands/translation.rs` | New: `ai_translate_passage` + `clear_translation_cache` commands |
| `src-tauri/src/commands/mod.rs` | Add `pub mod translation` |
| `src-tauri/src/lib.rs` | Register translation commands |
| `src/components/TranslationPanel.tsx` | New: streaming translation popover |
| `src/components/ReaderContextMenu.tsx` | Add "Translate" action + `onTranslate` prop |
| `src/pages/Reader.tsx` | Wire translation state + context menu handler + render panel |
| `src/i18n/en.json` | Add translation i18n keys |
| `src/i18n/zh.json` | Add translation i18n keys (Chinese) |
| `src/components/settings/LookupSettings.tsx` | Add target language + clear cache rows |

## Verification

1. `cargo check` — compiles with new migration and commands.
2. Backend unit tests:
   - `ai_translate_passage` with mocked DB: verify cache hit returns immediately, cache miss triggers streaming.
   - `clear_translation_cache` with/without `book_id` filter.
3. Manual tests:
   - Select text → "Translate" in context menu → panel shows streaming translation.
   - Translate same passage again → instant load from cache (no spinner delay).
   - Works with Ollama, Anthropic, OpenAI providers.
   - Change target language in settings → next translation uses new language.
   - Clear cache in settings → previously cached passage re-translates via AI.
   - Panel dismisses on Escape, click outside, and close button.
   - Panel stays within viewport bounds on all edges.
