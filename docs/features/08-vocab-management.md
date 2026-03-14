# Vocabulary Management System

**Version:** 0.2
**Date:** March 14, 2026
**Status:** Design (backend complete, frontend pending)

---

## Motivation

Quill's AI Lookup lets users right-click a word in the reader to get an AI-powered definition. But once the popover closes, the knowledge is lost. Users reading in a second language or encountering unfamiliar vocabulary need a way to save, revisit, and learn new words. This feature turns ephemeral AI lookups into a durable vocabulary learning tool with spaced repetition.

---

## Architecture

- **Save from LookupPopover** — primary entry point, captures word + AI definition + context sentence + CFI
- **Per-book VocabPanel** in the reader sidebar (new panel type alongside AI + Bookmarks)
- **Global `/vocab` page** accessible from Home sidebar — cross-book browsing, sorting, search

---

## Backend (Complete)

All backend infrastructure is already implemented and registered.

### Database Schema — `src-tauri/migrations/002_vocab.sql`

```sql
CREATE TABLE IF NOT EXISTS vocab_words (
  id TEXT PRIMARY KEY,
  book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  word TEXT NOT NULL,
  definition TEXT NOT NULL,
  context_sentence TEXT,
  cfi TEXT,
  mastery TEXT NOT NULL DEFAULT 'new',
  review_count INTEGER NOT NULL DEFAULT 0,
  next_review_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

### Commands — `src-tauri/src/commands/vocab.rs`

| Command | Signature | Notes |
|---------|-----------|-------|
| `add_vocab_word` | `(book_id, word, definition, context_sentence?, cfi?) → VocabWord` | Dedup by word+book_id (case-insensitive) |
| `remove_vocab_word` | `(id) → ()` | |
| `list_vocab_words` | `(book_id) → Vec<VocabWord>` | Per-book, ordered by created_at DESC |
| `check_vocab_exists` | `(book_id, word) → Option<String>` | Returns id if exists |
| `list_all_vocab_words` | `() → Vec<VocabWord>` | Cross-book, ordered by created_at DESC |
| `update_vocab_mastery` | `(id, mastery, next_review_at?) → ()` | Increments review_count |
| `list_vocab_due_for_review` | `() → Vec<VocabWord>` | Where next_review_at <= now |
| `get_vocab_stats` | `() → VocabStats` | { total, new_count, learning_count, mastered_count, due_for_review } |

---

## Frontend Implementation Plan

Based on six Figma designs:
- **Design 1** (108:225): Home sidebar with "Vocabulary" under new "Tools" section
- **Design 2** (108:429): Global `/vocab` page — card view (grouped by book, Newest/Oldest sort)
- **Design 3** (108:2): Reader with LookupPopover footer + VocabPanel in sidebar
- **Design 4** (109:572): Global vocab page — empty state
- **Design 5** (109:788): Reader VocabPanel — empty state
- **Design 6** (110:941): Global vocab page — A-Z list view (alphabetical grouping)

### Phase 1: Hook + LookupPopover Save

#### 1.1 Create `src/hooks/useVocab.ts`

Follow `useBookmarks.ts` pattern (useState + useCallback + invoke):

```typescript
interface VocabWord {
  id: string; book_id: string; word: string; definition: string;
  context_sentence: string | null; cfi: string | null;
  mastery: string; review_count: number;
  next_review_at: string | null; created_at: string; updated_at: string;
}

// Per-book hook (for VocabPanel in reader sidebar)
function useVocab(bookId: string) → { words, refresh, add, remove, checkExists }

// Global hook (for VocabPage)
function useAllVocab() → { words, refresh, remove }
```

#### 1.2 Modify `src/components/LookupPopover.tsx`

Add footer bar with "Save to Vocab" and "Copy" buttons (from Design 3).

**New props:**
```typescript
interface LookupPopoverProps {
  // ... existing props
  bookId: string;
  cfi?: string;
}
```

**Behavior:**
- Footer bar appears below content, separated by `border-t`, subtle bg `bg-[#fafafa]/50`
- Two buttons in footer: "Save to Vocab" (left, purple text `#9810fa`, BookmarkPlus icon 12px) + "Copy" (right, muted text, Copy icon 12px)
- Both buttons are 28.5px tall, rounded-lg, 11px medium font
- On mount: call `check_vocab_exists(bookId, word)` — if exists, show "Saved" with check icon instead
- "Save to Vocab" captures `contentRef.current` as definition, calls `add_vocab_word(...)`
- After save: button becomes "Saved" with green check, non-interactive
- "Copy" copies the definition text to clipboard

**Layout change:**
- Current: header + scrollable content
- New: header + scrollable content + footer (sticky at bottom)

#### 1.3 Modify `src/pages/Reader.tsx`

- Extend `lookup` state to include `cfi`: grab from `contextMenu.cfiRange`
- Pass `bookId={bookId}` and `cfi={lookup.cfi}` to `<LookupPopover>`

---

### Phase 2: VocabPanel in Reader Sidebar

#### 2.1 Create `src/components/VocabPanel.tsx`

New reader sidebar panel (from Design 3). Replaces the existing BookmarksPanel when the vocab tab is selected.

**Layout (same dimensions as BookmarksPanel):**

```
┌─ Header (45px) ─────────────────────────────┐
│ [purple gradient icon] "Vocabulary"  "N word" │
├─ Search (49px) ──────────────────────────────┤
│ [search icon] Search vocabulary...            │
├─ Scrollable word list ───────────────────────┤
│ [purple left-border] word entry               │
│   word (14px semibold)                        │
│   definition (12px, 2-line clamp)             │
│   context sentence (11px italic, 1-line)      │
│   [book] Book Title  [page] p.1  [clock] 6m  │
├─ Footer (37.5px) ────────────────────────────┤
│              "N word"                         │
└──────────────────────────────────────────────┘
```

**Styling details from Figma:**
- Header: purple gradient 20px icon (linear-gradient 135deg, #AD46FF → #7F22FE), "Vocabulary" 14px semibold, "N word" 11px muted right-aligned
- Search: bg-[#f4f4f5] border-[rgba(228,228,231,0.6)], 12px placeholder, rounded-lg, 28px tall, search icon 12px
- Word entry: left border 2px `#c27aff`, pl-[18px] pr-4, pt-3
  - Word: 14px semibold text-text-primary
  - Definition: 12px regular text-text-body, 2-line clamp
  - Context: 11px italic text-[#9f9fa9], 1-line clamp
  - Metadata row: book icon 12px + book title (11px muted), page icon 12px + "p. N", clock icon 12px + timeAgo
- Footer: border-t, 11px center-aligned "N word"
- Hover: trash icon on hover (same as BookmarksPanel)
- Click word → `onNavigate(cfi)` to jump to location

**Empty state (from Design 5):**
- Centered vertically in the scrollable area
- 48px circle, bg-[#f4f4f5], containing BookOpen icon 20px muted
- "No saved words yet" — 14px regular text-[#71717b]
- `Use "Look Up" on selected text and tap Save` — 12px regular text-[#9f9fa9]

#### 2.2 Modify `src/pages/Reader.tsx`

- Change `SidePanel` type: `type SidePanel = "ai" | "bookmarks" | "vocab" | null`
- Add vocab button to toolbar (purple sparkles icon from Figma, between bookmark and AI Assistant)
- Toggle: `setSidePanel(sidePanel === "vocab" ? null : "vocab")`
- Render `<VocabPanel>` when `sidePanel === "vocab"`
- VocabPanel props: `bookId`, `onNavigate` (same pattern as BookmarksPanel)

---

### Phase 3: Home Sidebar + Global Vocab Page

#### 3.1 Modify `src/components/Sidebar.tsx`

Add new "Tools" section between Library and Collections (from Design 1):

```
LIBRARY
  All Books (6)
  Currently Reading (4)
  Finished (1)

TOOLS                    ← new section
  Vocabulary             ← navigates to /vocab

COLLECTIONS
  ...
```

- "TOOLS" heading: same 12px semibold uppercase muted style as "Library"/"Collections"
- "Vocabulary" button: same h-9 rounded-lg style, icon from lucide-react (`Languages` or `BookA`)
- On click: `navigate("/vocab")` via react-router

#### 3.2 Modify `src/App.tsx`

Add route:
```tsx
<Route path="/vocab" element={<VocabPage />} />
```

#### 3.3 Create `src/pages/VocabPage.tsx`

Full-page vocabulary view (from Design 2). No sidebar — standalone page with back button.

**Layout:**

```
┌─ Header ─────────────────────────────────────┐
│ [←] [purple icon] Vocabulary    [Newest|Oldest|A-Z] │
│                   N words saved               │
├─ Search ─────────────────────────────────────┤
│ [🔍] Search words, definitions, or books...   │
├─ Book Filter Pills ──────────────────────────┤
│ [All Books N] [Book Title 1 N] [Book Title 2 N] │
├─ Scrollable Content ─────────────────────────┤
│                                               │
│ 📖 BOOK TITLE (UPPERCASE)  (count)           │
│ ┌─ Word Card ───────────────────────────────┐│
│ │ word (15px semibold)                      ││
│ │ definition (13px, 2-3 line clamp)         ││
│ │ ┃ context sentence (11px italic, purple   ││
│ │ ┃ left border #e9d4ff, 2px)               ││
│ │ [page] p.1  [clock] 6m ago               ││
│ └───────────────────────────────────────────┘│
└──────────────────────────────────────────────┘
```

**Header (from Figma):**
- Back button: 36px, rounded-lg, ArrowLeft icon 16px → navigates to `/`
- Purple gradient icon: 32px rounded-[14px], linear-gradient(135deg, #AD46FF → #7F22FE), sparkles icon 16px white
- Title: "Vocabulary" 20px semibold
- Subtitle: "N words saved" 12px muted

**Sort control (top-right):**
- Segmented pill: bg-[#f4f4f5] rounded-[10px], 32.5px tall
- Three options: "Newest" (icon + label), "Oldest" (icon + label), "A-Z" (label only)
- Active tab: white bg, rounded-lg, shadow-sm
- Inactive: text-muted
- 11px medium font

**Search:**
- bg-[#f3f3f5], rounded-lg, 36px tall, search icon 16px left, 14px placeholder
- Width: 448px (same as Home search)

**Book filter pills (horizontal row, overflow-x):**
- "All Books" active: bg-[#faf5ff] border-[#e9d4ff], text-[#8200db], book icon 12px purple, count 11px purple
- Per-book inactive: bg-white border-[#e4e4e7], text-[#52525c], book icon 12px, count 11px muted
- Pill shape: h-[32px] rounded-full, 12px medium font, px-[13px], gap-[6px]
- Pills generated from words grouped by book — only show books that have vocab words

**Word list (grouped by book):**
- Section header: book icon 14px + "BOOK TITLE" 12px semibold uppercase muted + "(count)" 11px text-[#d4d4d8]
- gap-[24px] between book groups, gap-[12px] between header and cards
- Word card: max-w-[525px], bg-[#fafafa], border-[rgba(228,228,231,0.6)], rounded-[14px], p-[17px]
  - Word: 15px semibold text-primary
  - Definition: 13px regular text-[#52525c], line-height 20.15px, multi-line
  - Context: 2px left-border #e9d4ff, pl-[8px], 11px italic text-[#9f9fa9], 2-line clamp
  - Footer: gap-[12px], page icon 12px + "p. N" 11px muted, clock icon 12px + timeAgo 11px muted
- Card hover: could add delete action (trash on hover)

**View toggle (from Design 6):**

A grid/list toggle sits to the LEFT of the sort control in the top-right header area:
- Two icon buttons in a bg-[#f4f4f5] rounded-[10px] pill, 30px tall, 56px wide
  - Grid icon (card view) — left
  - List icon (list view) — right
  - Active state: white bg, shadow-sm, rounded-lg
- **List view is the default**

**A-Z list view (default, from Design 6):**

The default layout is a compact alphabetical list:
- No book filter pills row (only shown in card view)
- **Letter section headers**: letter in 18px bold text-[#ad46ff], followed by 1px divider bg-[#f4f4f5], count in 11px text-[#d4d4d8] right-aligned
- **Word rows** (full-width, horizontal layout):
  - Left column (~160px fixed): word (14px semibold) + book icon 10px + book title (11px muted) below
  - Middle (flex-1): definition (13px regular text-[#52525c], single line truncated) + context sentence (11px italic text-[#9f9fa9], single line truncated) below
  - Right: timestamp "4m ago" (11px text-[#d4d4d8])
  - Row: rounded-[10px], px-[12px], pt-[12px], gap-[16px], ~64px tall
  - Hover: bg-bg-input (same as other list items)
- More scannable and space-efficient than card view for large vocab lists

**Card view (from Design 2):**

Toggled via the grid icon. Shows book filter pills + words grouped by book in card layout (see card view section above).

**Empty state (from Design 4):**
- Centered in the scrollable content area (both vertically and horizontally)
- 64px circle, bg-[#f4f4f5], containing sparkles/vocab icon 28px muted
- "Start Building Your Vocabulary" — 18px medium text-primary
- `Select a word while reading, use "Look Up" to see its definition, then tap "Save to Vocab" to add it here.` — 14px regular text-[#71717b], max-w-[296px], text-center
- No book filter pills shown when empty (header shows "0 words saved")

**Data flow:**
```typescript
const { words, refresh, remove } = useAllVocab();
// Group by book_id, need book titles → join or separate fetch
// Sort: newest (default, created_at DESC), oldest (created_at ASC), A-Z (word ASC)
// Search: filter by word/definition containing search text
// Book filter: filter by book_id
```

**Note: Need book title for display.** Current `list_all_vocab_words` returns `book_id` but not book title. Options:
1. Add a SQL JOIN to include book title in the vocab query (backend change)
2. Fetch books separately and join on frontend

Recommend option 1: modify `list_all_vocab_words` to JOIN with books table and return `book_title` as an additional field.

---

## Backend Additions Needed

### Join book title for global vocab list

Add `book_title` field to `VocabWord` (optional, only populated for cross-book queries):

**Option A** — add a new command `list_all_vocab_words_with_books`:
```rust
pub fn list_all_vocab_words(db) -> AppResult<Vec<VocabWordWithBook>>
// SELECT v.*, b.title as book_title FROM vocab_words v JOIN books b ON v.book_id = b.id
```

**Option B** — add `book_title: Option<String>` to `VocabWord` struct, populate via JOIN only in `list_all_vocab_words`.

Recommend Option B for simplicity — single struct, `book_title` is `None` for per-book queries and `Some(...)` for global queries.

---

## Files Summary

| Action | File | Phase |
|--------|------|-------|
| Create | `src/hooks/useVocab.ts` | 1 |
| Create | `src/components/VocabPanel.tsx` | 2 |
| Create | `src/pages/VocabPage.tsx` | 3 |
| Modify | `src/components/LookupPopover.tsx` — add footer with Save + Copy buttons | 1 |
| Modify | `src/pages/Reader.tsx` — pass bookId/cfi to LookupPopover, add vocab SidePanel | 1+2 |
| Modify | `src/components/Sidebar.tsx` — add "Tools" section with Vocabulary item | 3 |
| Modify | `src/App.tsx` — add `/vocab` route | 3 |
| Modify | `src-tauri/src/commands/vocab.rs` — add book_title to VocabWord, JOIN in list_all | 3 |

Backend files already complete (no changes needed for phases 1-2):
- `src-tauri/migrations/002_vocab.sql` ✅
- `src-tauri/src/commands/vocab.rs` ✅ (8 commands registered)
- `src-tauri/src/commands/mod.rs` ✅
- `src-tauri/src/lib.rs` ✅

---

## Spaced Repetition Schedule

Mastery transitions and review intervals (for future flashcard feature):
- new → learning: next_review = +1 day
- learning → learning: next_review = +3 days
- learning → mastered: next_review = +7 days
- mastered review: next_review = +30 days

---

## Verification

### Phase 1 — LookupPopover Save
- [ ] "Save to Vocab" button appears in LookupPopover footer after streaming completes
- [ ] Click Save → word stored to DB with definition + context_sentence + cfi
- [ ] Re-open Look Up for same word → shows "Saved" immediately
- [ ] "Copy" button copies definition to clipboard
- [ ] Dedup: saving same word+book twice returns existing record

### Phase 2 — VocabPanel in Reader
- [ ] Purple vocab icon appears in reader toolbar
- [ ] Clicking it opens VocabPanel in sidebar (replaces bookmarks/AI)
- [ ] VocabPanel shows saved words for current book with search
- [ ] Click word → reader navigates to CFI location
- [ ] Delete word via hover trash → removed from list
- [ ] Footer shows correct word count
- [ ] Empty state: "No saved words yet" with icon + hint text when no words saved for this book

### Phase 3 — Global Vocab Page
- [ ] "Vocabulary" item appears under "Tools" in Home sidebar
- [ ] Clicking navigates to `/vocab`
- [ ] **Card view (Newest/Oldest)**: words grouped by book with correct book titles, card layout
- [ ] **List view (A-Z)**: words grouped by letter, compact row layout with word/book/definition/timestamp
- [ ] View toggle switches between card and list layouts
- [ ] Sort works: Newest / Oldest / A-Z (A-Z forces list view)
- [ ] Search filters by word and definition text in both views
- [ ] Book filter pills show per-book counts in card view
- [ ] Back arrow navigates to Home
- [ ] Delete a book → its vocab words cascade-deleted from page
- [ ] Empty state: "Start Building Your Vocabulary" with icon + instructional text when no words saved globally
