# AI Translation — Passage Translation (Phase 1)

## Context

Quill's AI features only support word-level lookup. For foreign-language books, users need to select a sentence/paragraph and get a full passage translation. Translations should be saveable and browsable — like dictionary words — not just throwaway cache entries.

This implements Phase 1 of the [AI Translation spec](../features/15-ai-translation.md).

Issue: #73

## Approach

Add a "Translate" context menu action that opens a `TranslationPopover` showing the original text and a streaming translation. The user can **save** translations (like "Save to Dict" in LookupPopover). Saved translations are browsable in:
- **Reader side panel** — new "Translations" tab alongside bookmarks/vocab
- **Main window sidebar** — new "Translations" item under Tools (like Dictionary/Chats)

Data model: a `translations` table with a `saved` boolean. All translations are inserted on completion (enabling instant repeat lookups). The user explicitly saves the ones they want to keep. "Clear cache" only removes unsaved rows.

---

## Step 1: Add `translations` migration

**File: `src-tauri/migrations/006_translations.sql`** (new)

```sql
CREATE TABLE IF NOT EXISTS translations (
    id TEXT PRIMARY KEY,
    book_id TEXT NOT NULL,
    section_index INTEGER NOT NULL DEFAULT 0,
    source_hash TEXT NOT NULL,
    source_text TEXT NOT NULL,
    translated_text TEXT NOT NULL,
    target_language TEXT NOT NULL,
    saved INTEGER NOT NULL DEFAULT 0,
    cfi TEXT,
    created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_translations_lookup
    ON translations (book_id, section_index, source_hash, target_language);

CREATE INDEX IF NOT EXISTS idx_translations_saved
    ON translations (saved, book_id);
```

**File: `src-tauri/src/db.rs`**

- Add `(6, include_str!("../migrations/006_translations.sql"))` to `MIGRATIONS` array.

---

## Step 2: Backend commands

**File: `src-tauri/src/commands/translation.rs`** (new)

Add `sha2 = "0.10"` to `Cargo.toml` dependencies.

### `ai_translate_passage`

```rust
#[tauri::command]
pub async fn ai_translate_passage(
    text: String,
    context: Option<String>,  // surrounding paragraph for short selections
    book_id: String,
    section_index: Option<i64>,
    target_language: Option<String>,
    cfi: Option<String>,
    request_id: String,
    app: AppHandle,
    db: State<'_, Db>,
    secrets: State<'_, Secrets>,
) -> AppResult<Option<String>>  // Returns existing translation ID if cache hit
```

Logic:
1. Read `translation_target_language` setting (fall back to `native_language`, then `"en"`).
2. Compute `source_hash` = SHA-256 hex of `text`.
3. Query `translations` for a hit on `(book_id, section_index, source_hash, target_language)`.
4. **Cache hit**: emit cached `translated_text` as `AiStreamChunk` events on `ai-translate-chunk-{request_id}`. Return the row `id` so the frontend knows it already exists.
5. **Cache miss**: read AI provider settings (same pattern as `ai_lookup` in `commands/ai.rs:34-54`), build context-aware translation prompt, spawn async streaming task. Accumulate full response, insert into `translations` with `saved = 0` on completion. Return `null`.

**Context-aware prompt design:**

When `context` is provided and differs from `text` (short selection within a paragraph):
```
You are a translator embedded in an ebook reader. The user selected a portion
of text they want translated into {target_language}.

Full paragraph for context:
"{context}"

Translate ONLY the selected portion below — not the full paragraph. Use the
surrounding context to ensure accuracy of meaning, tone, and any pronouns
or references.

Selected text:
"{text}"

Produce only the translation. No commentary, no labels, no original text.
```

When `context` is absent or same as `text` (full paragraph or long selection):
```
You are a translator embedded in an ebook reader. Translate the following
passage into {target_language}.

"{text}"

Produce only the translation. No commentary, no labels, no original text.
Preserve paragraph structure and tone.
```

Use `ChatMessage` / `AiStreamChunk` from `commands/ai.rs`. Same provider routing pattern (`ai_lookup` lines 133-162).

### `save_translation`

```rust
#[tauri::command]
pub fn save_translation(id: String, db: State<'_, Db>) -> AppResult<()>
```

Sets `saved = 1` for the given translation ID.

### `remove_saved_translation`

```rust
#[tauri::command]
pub fn remove_saved_translation(id: String, db: State<'_, Db>) -> AppResult<()>
```

Sets `saved = 0` (unsaves but keeps for cache). If we want to fully delete, delete the row.

### `list_translations`

```rust
#[tauri::command]
pub fn list_translations(
    book_id: Option<String>,
    saved_only: Option<bool>,
    db: State<'_, Db>,
) -> AppResult<Vec<Translation>>
```

Returns translations. When `saved_only = true`, filter by `saved = 1`. When `book_id` is provided, filter by book. Order by `created_at DESC`.

### `check_translation_exists`

```rust
#[tauri::command]
pub fn check_translation_exists(
    book_id: String,
    source_hash: String,
    target_language: String,
    db: State<'_, Db>,
) -> AppResult<Option<String>>  // Returns translation ID if saved
```

Check if a saved translation already exists for this passage.

### `clear_translation_cache`

```rust
#[tauri::command]
pub fn clear_translation_cache(db: State<'_, Db>) -> AppResult<u64>
```

Deletes all rows where `saved = 0`. Returns count deleted.

**File: `src-tauri/src/commands/mod.rs`** — add `pub mod translation;`

**File: `src-tauri/src/lib.rs`** — register all commands under `// Translation` comment block.

---

## Step 3: Create `TranslationPopover` component

**File: `src/components/TranslationPopover.tsx`** (new)

A popover positioned near the selection (same pattern as `LookupPopover.tsx`). Width: `520px`, max content height `420px` — wider and taller than LookupPopover to accommodate paragraph-length text.

Layout:
- **Header**: accent background, `Languages` icon + "Translation" title + close button (same style as `LookupPopover.tsx:221-234`)
- **Original text**: collapsed by default, showing first ~80 chars truncated in `text-[12px] text-text-muted italic`. Chevron toggle to expand. When expanded, scrollable container with max-height ~120px.
- **Translation body**: streaming text with `Loader2` spinner (same pattern as LookupPopover definition section, lines 262-278)
- **Footer**: visible when streaming is done. Left: **"Save"** button (like "Save to Dict" — `BookmarkPlus` icon, toggles to `Check` + "Saved" when saved). Right: **"Copy"** button. Same style as `LookupPopover` footer (lines 305-322).

Internal hook `useStreamingTranslation(text, bookId, sectionIndex, cfi)`:
- Same pattern as `useStreamingLookup` in `LookupPopover.tsx:20-87`
- Event name: `ai-translate-chunk-{requestId}`
- Invokes `ai_translate_passage` command
- Tracks the translation `id` (returned from cache hit, or generated client-side for new translations)
- Returns `{ content, streaming, notConfigured, translationId }`

Props:
```typescript
interface TranslationPopoverProps {
  x: number;
  y: number;
  text: string;
  context?: string;  // surrounding paragraph for short selections
  bookId: string;
  sectionIndex?: number;
  cfi?: string;
  onClose: () => void;
}
```

---

## Step 4: Create `TranslationsPanel` (reader side panel)

**File: `src/components/TranslationsPanel.tsx`** (new)

Reader-side panel showing saved translations for the current book. Same structure as `DictionaryPanel.tsx`:

- **Header**: title + count badge
- **Search**: filters by source/translated text
- **List**: each card shows source text (truncated, muted), translated text, target language tag, timestamp. Trash icon on hover to unsave.
- **Empty state**: guidance text
- Click a translation → navigate to its CFI location in the book (if `cfi` is set)

Props: `{ bookId: string; onNavigateToCfi?: (cfi: string) => void }`

---

## Step 5: Create `TranslationsContent` (main window page)

**File: `src/components/TranslationsContent.tsx`** (new)

Full-page translations view in the main window. Same pattern as `DictionaryContent.tsx`:

- **Header**: "Translations" title + count
- **Search bar**: filter by source/translated text
- **Book filter pills**: filter by book (like DictionaryContent)
- **Sort**: newest/oldest
- **Cards**: each shows source text (truncated), translated text, book title breadcrumb, target language, timestamp. Click → open reader at that location via `openReaderWindow(bookId, { cfi })`
- **Empty state**: "No saved translations yet" with guidance

---

## Step 6: Add "Translate" to context menu

**File: `src/components/ReaderContextMenu.tsx`**

- Add `onTranslate` to `ReaderContextMenuProps`.
- Add "Translate" button between "Ask AI Assistant" and "Highlight", using `Languages` icon from lucide-react. Same button style as existing items (line 95-103).

---

## Step 7: Wire up in Reader.tsx

**File: `src/pages/Reader.tsx`**

1. Extend `SidePanel` type: `"ai" | "bookmarks" | "vocab" | "translations" | null`

2. Add `translation` popover state:
   ```typescript
   const [translation, setTranslation] = useState<{
     x: number; y: number; text: string;
     context?: string;  // surrounding paragraph for short selections
     sectionIndex?: number; cfi?: string;
   } | null>(null);
   ```

3. Add `onTranslate` handler to `<ReaderContextMenu>`:
   ```typescript
   onTranslate={() => {
     setTranslation({
       x: contextMenu.x, y: contextMenu.y,
       text: contextMenu.text,
       context: contextMenu.sentence,  // block-level surrounding text
       sectionIndex: currentChapterIndex >= 0 ? currentChapterIndex : undefined,
       cfi: contextMenu.cfiRange,
     });
     setContextMenu(null);
   }}
   ```

4. Render `<TranslationPopover>` alongside `<LookupPopover>`.

5. Add translations toggle button in reader header (next to vocab button). Use `Languages` icon.

6. Render `<TranslationsPanel>` in the side panel area alongside vocab/bookmarks/AI panels.

---

## Step 8: Wire up in main window

**File: `src/components/Sidebar.tsx`**

Add "Translations" button under Tools section (after Chats), using `Languages` icon. `onClick={() => onFilterChange("translations")}`.

**File: `src/pages/Home.tsx`**

Add conditional render for `activeFilter === "translations"` → `<TranslationsContent />`.

---

## Step 9: Add i18n keys

**File: `src/i18n/en.json`**

```json
"sidebar.translations": "Translations",
"contextMenu.translate": "Translate",
"translation.title": "Translations",
"translation.original": "Original",
"translation.translating": "Translating...",
"translation.save": "Save",
"translation.saved": "Saved",
"translation.copy": "Copy",
"translation.copied": "Copied",
"translation.empty": "No Saved Translations",
"translation.emptySub": "Select text while reading, use \"Translate\" to see its translation, then tap \"Save\" to add it here.",
"translation.panelEmpty": "No saved translations yet",
"translation.panelEmptySub": "Use \"Translate\" on selected text and tap Save",
"translation.noMatches": "No matches found",
"translation.search": "Search translations...",
"translation.newest": "Newest",
"translation.oldest": "Oldest",
"translation.count_one": "{{count}} translation",
"translation.count_other": "{{count}} translations",
"settings.translation.clearCache": "Clear Translation Cache",
"settings.translation.clearCacheHint": "Remove unsaved cached translations",
"settings.translation.cacheCleared": "Translation cache cleared",
"settings.translation.targetLanguage": "Translation Language",
"settings.translation.targetLanguageHint": "Target language for passage translations"
```

**File: `src/i18n/zh.json`**

```json
"sidebar.translations": "翻译",
"contextMenu.translate": "翻译",
"translation.title": "翻译",
"translation.original": "原文",
"translation.translating": "翻译中...",
"translation.save": "保存",
"translation.saved": "已保存",
"translation.copy": "复制",
"translation.copied": "已复制",
"translation.empty": "暂无保存的翻译",
"translation.emptySub": "阅读时选中文本，使用「翻译」查看译文，然后点击「保存」将其添加到这里。",
"translation.panelEmpty": "暂无保存的翻译",
"translation.panelEmptySub": "选中文本后使用「翻译」，然后点击保存",
"translation.noMatches": "未找到匹配",
"translation.search": "搜索翻译...",
"translation.newest": "最新",
"translation.oldest": "最早",
"translation.count_one": "{{count}} 条翻译",
"translation.count_other": "{{count}} 条翻译",
"settings.translation.clearCache": "清除翻译缓存",
"settings.translation.clearCacheHint": "移除未保存的缓存翻译",
"settings.translation.cacheCleared": "翻译缓存已清除",
"settings.translation.targetLanguage": "翻译语言",
"settings.translation.targetLanguageHint": "段落翻译的目标语言"
```

---

## Step 10: Add translation settings

**File: `src/components/settings/LookupSettings.tsx`**

Add two rows after existing lookup settings (73px row pattern):

1. **Translation Language** — `Select` dropdown, saves to `translation_target_language`. Default: `native_language` value.
2. **Clear Translation Cache** — Button that invokes `clear_translation_cache` (only clears unsaved) and shows toast.

---

## Figma design prompt

> **TranslationPopover** — a floating popover (520px wide, taller than LookupPopover) for streaming AI passage translations. Visually a sibling of the existing LookupPopover.
>
> **Structure (top to bottom):**
> 1. **Header bar** — accent background (`bg-accent-bg`), same height/style as LookupPopover header. Left: `Languages` icon (16px) + "Translation" label (14px medium). Right: close `X` button.
> 2. **Original text block** — collapsed by default, showing first ~80 characters truncated with "..." in 12px muted italic. A small chevron toggle on the right expands/collapses the full original. When expanded, scrollable container with max-height ~120px, same 12px muted italic. Subtle bg-muted background to separate from translation.
> 3. **Translation body** — main content area with 13px text, same leading/color as LookupPopover definition text. While streaming, show an inline `Loader2` spinner at the end. Before content arrives, show "Translating..." with spinner (same as "Looking up..." in LookupPopover).
> 4. **Footer** — visible when done. Left: "Save" button (`BookmarkPlus` icon, accent text; toggles to `Check` + "Saved" when saved — mirrors the "Save to Dict" pattern). Right: "Copy" button (muted text, `Copy` icon). Same style as LookupPopover footer.
>
> **States:** loading, streaming, complete (footer visible with Save + Copy), saved (Save button shows checkmark), not-configured (guidance card), cached (instant display, no spinner).
>
> **TranslationsPanel (reader side panel)** — same structural pattern as DictionaryPanel. Header with title + count badge, search bar, scrollable list of saved translation cards. Each card: source text (12px muted, 2-line clamp), translated text (13px primary, 3-line clamp), timestamp. Trash icon on hover. Tap to navigate to book location.
>
> **TranslationsContent (main window page)** — same structural pattern as DictionaryContent. Header, search bar, book filter pills, sort buttons, card list. Each card: source text (truncated), translated text, book title breadcrumb, target language badge, timestamp. Click opens reader at location.
>
> **Positioning:** same viewport-clamped fixed positioning as LookupPopover.
> **Theme:** follows app theme variables. Same shadow-context, border-border/80, bg-bg-surface.

---

## Files to modify

| File | Change |
|------|--------|
| `src-tauri/migrations/006_translations.sql` | New: translations table with `saved` flag |
| `src-tauri/src/db.rs` | Register migration 6 |
| `src-tauri/Cargo.toml` | Add `sha2 = "0.10"` |
| `src-tauri/src/commands/translation.rs` | New: translate, save, remove, list, check, clear commands |
| `src-tauri/src/commands/mod.rs` | Add `pub mod translation` |
| `src-tauri/src/lib.rs` | Register translation commands |
| `src/components/TranslationPopover.tsx` | New: streaming translation popover with Save button |
| `src/components/TranslationsPanel.tsx` | New: reader side panel for saved translations |
| `src/components/TranslationsContent.tsx` | New: main window full-page translations view |
| `src/components/ReaderContextMenu.tsx` | Add "Translate" action + `onTranslate` prop |
| `src/pages/Reader.tsx` | Wire translation popover, side panel tab, header button |
| `src/components/Sidebar.tsx` | Add "Translations" under Tools |
| `src/pages/Home.tsx` | Render `TranslationsContent` for translations filter |
| `src/i18n/en.json` | Add translation i18n keys |
| `src/i18n/zh.json` | Add translation i18n keys (Chinese) |
| `src/components/settings/LookupSettings.tsx` | Add target language + clear cache rows |

## Verification

1. `cargo check` — compiles with new migration and commands.
2. Backend unit tests:
   - `ai_translate_passage`: cache hit returns instantly, cache miss streams + inserts with `saved = 0`.
   - `save_translation` / `remove_saved_translation`: toggle `saved` flag.
   - `list_translations`: filter by `book_id`, `saved_only`.
   - `clear_translation_cache`: only deletes unsaved rows.
3. Manual tests:
   - Select text → "Translate" → popover shows streaming translation.
   - Click "Save" → translation appears in reader Translations panel and main window Translations page.
   - Translate same passage again → instant from cache.
   - Unsave a translation → removed from panels, still cached for repeat lookup.
   - Clear cache in settings → unsaved entries gone, saved entries remain.
   - Click saved translation → navigates to location in book.
   - Main window Translations page: search, filter by book, sort work correctly.
   - Works with all AI providers (Ollama, Anthropic, OpenAI).
