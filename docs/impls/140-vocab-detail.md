# Vocab Word Detail View

**Issue:** [#140](https://github.com/yicheng47/quill/issues/140)
**Design:** `quill-design/quill-desktop.pen` → frame "Vocab Detail (modal over dictionary)"

## Context

Vocab words have no detail view. In `DictionaryPage.tsx`, `DictionaryContent.tsx`, and `DictionaryPanel.tsx` words are shown as rows/cards with truncated definitions (`line-clamp-3` or `truncate`). Users cannot see the full definition, the separated "in this context" explanation, or the original book sentence without clicking through to the reader.

## Approach

Add a single `VocabDetailModal` component that all three dictionary surfaces reuse. Clicking a word row/card opens the modal with that word. No backend, SQL, or new hook wrappers needed — everything we display is already on `DictionaryWord`. The row-level "Open in Reader" button is removed from list views since the modal now owns that action.

Chosen **modal over new route** because:
- `DictionaryPanel` lives inside the Reader window, which has no router — a route-based detail page wouldn't work there without duplicating logic.
- A single component reused across all surfaces keeps behavior consistent.
- Matches the `EditMetadataModal` pattern already used in the codebase.

Mastery, review count, and next review date are **intentionally omitted** from this iteration. The backend fields exist and can be surfaced later when a proper SRS UI is designed.

---

## Data shape

`DictionaryWord` already has everything we need:

```typescript
{
  id: string;
  book_id: string;
  word: string;
  definition: string;        // may contain "\n\n" separating dictionary def and contextual meaning
  context_sentence: string | null;  // the original quoted sentence from the book
  cfi: string | null;
  book_title: string | null;
  // ...other fields unused by this view
}
```

Definitions saved via `LookupPopover` look like:
```
/ˈkɔːrnjuˈkoʊpiə/ noun. A symbol shaped like a horn overflowing with fruits...

"In this context" body explaining how the word functions here.
```

The first chunk (before `\n\n`) is the dictionary definition; the second chunk is the contextual meaning. `context_sentence` is the quoted book sentence, stored separately.

---

## Step 1: Create `VocabDetailModal` component

**File: `src/components/VocabDetailModal.tsx`** (new)

### Props

```typescript
interface VocabDetailModalProps {
  word: DictionaryWord | null;  // null = closed
  onClose: () => void;
  onDelete: (id: string) => void | Promise<void>;
  /**
   * How to act when "Open in Reader" is clicked.
   * - "window" (default): opens a new reader window via openReaderWindow
   * - "inline": calls onNavigateInline with the cfi — used by DictionaryPanel
   *   which already lives inside the reader.
   */
  navigateMode?: "window" | "inline";
  onNavigateInline?: (cfi: string) => void;
}
```

### Layout

Backdrop and dismiss behavior mirror `EditMetadataModal`:
- `fixed inset-0 z-50` root with `bg-overlay` + `backdrop-blur-sm`
- Card centered, `520px` wide, `bg-bg-surface`, `rounded-xl`, `shadow-popover`
- `max-h-[85vh]` with internal scroll
- Escape key and click-outside dismiss

**Header** — `px-6 pt-5 pb-4 border-b border-border-light`, `flex justify-between items-start`
- Left column (`flex-col gap-1`):
  - Word: `text-[24px] font-bold tracking-[-0.3px] text-text-primary`
  - Subtitle line: `{pronunciation} · {partOfSpeech}` when parseable; falls back to `word` or hidden entirely if neither is available. `text-[13px] text-text-muted`.
- Right: close `X` button, 28×28 muted, hover `bg-bg-input`.

**Body** — `px-6 pt-4 pb-5 flex flex-col gap-5 overflow-auto`

1. **Source section** — label `SOURCE` (11px uppercase bold, `tracking-[0.4px] text-text-muted`) + a row card:
   - Container: `flex items-center justify-between gap-3 p-3 bg-bg-muted border border-border-light rounded-[10px]`
   - Left group: 32×32 `bg-accent-bg` rounded-lg box with `BookOpen` icon (16px, accent color), then a `flex-col gap-0.5` with book title (14px semibold) and a muted subtitle line. Subtitle uses `word.book_title` if present; author isn't on `DictionaryWord` so omit it or re-fetch lazily (for v1 just show the title, and put a friendly `"Unknown book"` fallback).
   - Right: primary "Open in Reader" button, `h-8 px-3 gap-1.5 bg-accent text-white rounded-lg text-[13px] font-medium`, with a trailing `ArrowRight` icon. Click handler:
     ```tsx
     const handleOpen = () => {
       if (!word) return;
       if (navigateMode === "inline") {
         if (word.cfi) onNavigateInline?.(word.cfi);
         onClose();
       } else {
         openReaderWindow(word.book_id, { openVocab: true, cfi: word.cfi ?? undefined });
         onClose();
       }
     };
     ```

2. **Definition section** — label `DEFINITION` + dictionary-meaning text:
   - `text-[14px] leading-[1.55] text-text-primary` for the body.
   - Then nested (same section, `gap-3` below the body): an "In this context" card, only shown when parsing finds a non-empty second chunk:
     - Container: `p-3.5 bg-bg-muted border border-border-light rounded-[10px]`
     - Label: `In this context` (12px medium `text-text-muted`)
     - Body: `text-[13px] leading-[1.5] text-text-secondary` — the parsed second chunk.

3. **From the Book section** — label `FROM THE BOOK` + blockquote for `word.context_sentence`. Only rendered if `context_sentence` is non-null and non-empty.
   - Container: `border-l-2 border-[color:var(--color-lavender)] pl-3.5 py-1.5`
   - Text: `text-[13px] italic text-text-secondary leading-[1.5]`, wrapped in quotes.

**Footer** — `px-5 py-3 border-t border-border-light flex items-center justify-end`
- Single action: Delete button, right-aligned
- Button: `flex items-center gap-1.5 h-8 px-3 rounded-lg text-[13px] font-medium text-red-500 hover:bg-red-500/10 cursor-pointer`
- Trash icon (`Trash2`, 14px) + `{t("vocab.detail.delete")}`
- Two-click confirm: first click switches the label to `{t("vocab.detail.deleteConfirm")}` and starts a 3s timer to revert. Second click within the window calls `onDelete(word.id)` then `onClose()`. Same UX pattern as the existing delete-confirm flows in the app.

### Definition parser

```typescript
function parseDefinition(raw: string): {
  pronunciation: string | null;
  partOfSpeech: string | null;
  definition: string;
  inContext: string | null;
} {
  const [head, ...rest] = raw.split(/\n\n+/);
  const inContext = rest.join("\n\n").trim() || null;
  // Match leading /.../ phonetic + optional "noun."/"verb."/etc prefix
  const match = head.match(/^\s*(\/[^/]+\/)\s*(?:(\w+)\.)?\s*([\s\S]*)$/);
  if (!match) {
    return { pronunciation: null, partOfSpeech: null, definition: head.trim(), inContext };
  }
  return {
    pronunciation: match[1] ?? null,
    partOfSpeech: match[2] ?? null,
    definition: (match[3] ?? "").trim(),
    inContext,
  };
}
```

If the first chunk has no phonetic prefix (e.g., older manually-added entries), `parseDefinition` just returns the chunk as-is in `definition` and `pronunciation`/`partOfSpeech` are `null`, which causes the header subtitle to hide.

### Design prompt (reference)

> Modal dialog, 520px wide, centered over a dimmed backdrop with slight blur. Rounded-xl white card with subtle shadow. Header shows a large bold word title with a muted pronunciation + part-of-speech subtitle, close X on the right. Body contains three sections with 20px vertical gap, each with an 11px uppercase muted label: SOURCE (rounded muted card with book icon, title, and a primary "Open in Reader" button on the right), DEFINITION (full plain text followed by a nested "In this context" card that uses the same muted background), FROM THE BOOK (italic blockquote with a lavender left border). Footer has a single Delete button right-aligned in danger red with a trash icon. Escape and click-outside dismiss. Uses existing tokens — no new colors.

---

## Step 2: Wire into `DictionaryPage`

**File: `src/pages/DictionaryPage.tsx`**

1. Add modal state:
   ```typescript
   const [activeWord, setActiveWord] = useState<DictionaryWord | null>(null);
   ```

2. **List view row (~line 218):**
   - Convert the `<div>` row container to a `<button type="button">` with `onClick={() => setActiveWord(word)}` and `text-left w-full`.
   - **Remove** the "Open in Reader" button that currently lives in the right column (the modal owns this action now).
   - Keep the trash button, but add `e.stopPropagation()` in its handler so it doesn't also open the modal.
   - Keep the `timeAgo(word.created_at)` timestamp so the row still has an identity cue.

3. **Card view card (~line 333):**
   - Same conversion: the card's outer `<div>` becomes a `<button>` with `onClick={() => setActiveWord(word)}`.
   - **Remove** the inline "Open in Reader" button in the card footer.
   - Keep the trash and page-number chip; stop-propagate the trash click.

4. Render the modal at the bottom of the page:
   ```tsx
   <VocabDetailModal
     word={activeWord}
     onClose={() => setActiveWord(null)}
     onDelete={async (id) => {
       await remove(id);
       setActiveWord(null);
     }}
   />
   ```

---

## Step 3: Wire into `DictionaryContent`

**File: `src/components/DictionaryContent.tsx`**

Same pattern as Step 2. This is the home-sidebar dictionary tab — uses `useAllDictionary` and currently has its own list+card view. Convert rows/cards to buttons, remove row-level "Open in Reader", stop-propagate trash, render `<VocabDetailModal>`. `navigateMode` stays at its `"window"` default.

---

## Step 4: Wire into `DictionaryPanel`

**File: `src/components/DictionaryPanel.tsx`**

Same pattern, with two differences:
- Use `navigateMode="inline"` on the modal, passing `onNavigateInline={onNavigate}` (the panel already accepts an `onNavigate?: (cfi: string) => void` prop used by the existing inline Open-in-Reader link).
- Remove the existing `onClick={() => onNavigate?.(word.cfi!)}` chevron in the row; clicking the row itself opens the modal.

---

## Step 5: i18n keys

**File: `src/i18n/en.json`** — add:
```json
"vocab.detail.source": "Source",
"vocab.detail.definition": "Definition",
"vocab.detail.inContext": "In this context",
"vocab.detail.fromBook": "From the book",
"vocab.detail.openInReader": "Open in Reader",
"vocab.detail.delete": "Delete",
"vocab.detail.deleteConfirm": "Click again to delete",
"vocab.detail.unknownBook": "Unknown book"
```

**File: `src/i18n/zh.json`** — matching zh translations:
```json
"vocab.detail.source": "来源",
"vocab.detail.definition": "释义",
"vocab.detail.inContext": "在此语境中",
"vocab.detail.fromBook": "书中原文",
"vocab.detail.openInReader": "在阅读器中打开",
"vocab.detail.delete": "删除",
"vocab.detail.deleteConfirm": "再次点击确认删除",
"vocab.detail.unknownBook": "未知书籍"
```

Section labels in the UI are rendered uppercase via CSS (`text-[11px] uppercase`), so the i18n values stay title-case for Chinese-friendliness.

---

## Files to modify

| File | Change |
|------|--------|
| `src/components/VocabDetailModal.tsx` | **New** — modal component |
| `src/pages/DictionaryPage.tsx` | Make rows/cards clickable, drop row-level Open in Reader, render modal |
| `src/components/DictionaryContent.tsx` | Same |
| `src/components/DictionaryPanel.tsx` | Same, with `navigateMode="inline"` |
| `src/i18n/en.json` | New translation keys |
| `src/i18n/zh.json` | New translation keys |

No backend, no Cargo.lock change, no migration, no new hook exports.

## Verification

- [ ] Click a word in `DictionaryPage` list view → modal opens with that word
- [ ] Click a word in `DictionaryPage` card view → modal opens
- [ ] Click a word in home-sidebar Dictionary tab (grid/list) → modal opens
- [ ] Click a word in reader-side `DictionaryPanel` → modal opens
- [ ] Source row renders at the top with book title + "Open in Reader" button
- [ ] Definition is shown in full (no truncation), scrollable within the card if long
- [ ] "In this context" card only appears when the stored definition has a second `\n\n` chunk
- [ ] "From the Book" blockquote only appears when `context_sentence` is present
- [ ] Pronunciation subtitle shows for AI-saved entries and hides for entries without a leading `/phonetic/` prefix
- [ ] "Open in Reader" in `DictionaryPage`/`DictionaryContent` opens a reader window with vocab sidebar + CFI, then closes the modal
- [ ] "Open in Reader" in `DictionaryPanel` calls `onNavigate(cfi)` inline, then closes the modal
- [ ] Row-level "Open in Reader" is gone from all three list views
- [ ] Trash button on a row does not bubble up to open the modal
- [ ] Delete button in the modal requires a second click within 3 seconds; then removes the word and closes the modal
- [ ] Escape and click-outside dismiss the modal
- [ ] Long definitions scroll inside the card; the card doesn't exceed 85vh
- [ ] i18n keys render correctly in both English and Chinese
