# 15 — AI Translation

**Issue:** [#73](https://github.com/yicheng47/quill/issues/73)
**Status:** Planned
**Milestone:** 2 — Depth

## Motivation

Quill's current translation support is limited to word-level lookup with an optional native-language translation line. For reading entire foreign-language books, users need:

1. **Passage-level translation** — select a sentence or paragraph and get a full translation, not a dictionary definition.
2. **Bilingual reading mode** — a persistent toggle that renders translations inline alongside the original text so you can read in two languages simultaneously.

These two features are complementary: passage translation is the on-demand tool for tricky sections, bilingual mode is the always-on experience for cover-to-cover reading.

## Scope

### Passage translation

- Add a "Translate" action to the reader context menu (text selection required)
- Opens a translation panel showing the original text (collapsed) and streaming translation
- Uses the current AI provider/model from settings
- Target language configurable (defaults to `native_language` setting)
- Translations cached in SQLite — same passage returns instantly on repeat
- Copy button for the translated text

### Bilingual reading mode

- Toggle in the reader toolbar to enable/disable
- When active, translations appear below each paragraph in the reader
- **DOM injection approach:** after each EPUB section loads (`load` event), extract block elements from the iframe `Document`, translate them (checking cache first), and insert styled `<div>` elements after each paragraph
- foliate-js auto-repaginates via its ResizeObserver
- Batch translation: uncached paragraphs sent to the LLM in a single numbered-format call to minimize API requests
- Translations stream in progressively as the LLM responds
- Cached sections load instantly on revisit
- **Fallback:** if DOM injection breaks foliate-js pagination, fall back to a side panel showing paragraph-by-paragraph translations synced to reading position

### Translation cache

- `translation_cache` table: `id`, `book_id`, `section_index`, `source_hash` (SHA-256 of text), `source_text`, `translated_text`, `target_language`, `element_index`, `created_at`
- Unique index on `(book_id, section_index, source_hash, target_language)`
- "Clear cache" action in settings

### Settings

- `translation_target_language` — language to translate into (defaults to `native_language`)
- `bilingual_mode` — `"true"` / `"false"` (default `"false"`)

### Out of scope

- Offline translation (requires local model capable of translation)
- Translation of images, tables, or non-text content
- Side-by-side dual-column layout (may revisit later)

## Implementation Phases

### Phase 1 — Passage translation
1. Add `translation_cache` table migration
2. Add `ai_translate_passage` backend command with cache-first logic and streaming
3. Create `TranslationPanel` component (streaming translation UI)
4. Add "Translate" to `ReaderContextMenu`
5. Wire up in `Reader.tsx`

### Phase 2 — Bilingual reading mode
1. Add `ai_translate_section_batch` backend command (batched numbered-format translation)
2. Create `useBilingualMode` hook (extract paragraphs from iframe DOM, manage cache checks, inject translation elements)
3. Add bilingual toggle to reader toolbar
4. Inject CSS for translation styling into iframe
5. Test pagination behavior with injected content

### Phase 3 — Polish
1. Progress indicator during batch translation
2. Cancel in-flight translations on section change
3. Edge case handling (long paragraphs chunked, empty paragraphs skipped)
4. Translation settings in settings modal (target language, clear cache)
5. i18n keys for all new UI strings

## Verification

- [ ] Select text -> "Translate" in context menu -> panel shows streaming translation
- [ ] Translating the same passage a second time loads from cache instantly
- [ ] Toggle bilingual mode on -> translations appear below each paragraph
- [ ] Navigate to a new section -> translations load (cached or streamed)
- [ ] Toggle bilingual mode off -> translation elements removed, layout restored
- [ ] Works with all AI providers (Ollama, Anthropic, OpenAI)
- [ ] Long sections are batched without overwhelming the LLM
- [ ] Clear cache removes stored translations
