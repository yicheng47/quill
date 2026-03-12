# Vocabulary Management System

**Version:** 0.1
**Date:** March 12, 2026
**Status:** Design

---

## Motivation

Quill's AI Lookup lets users right-click a word in the reader to get an AI-powered definition. But once the popover closes, the knowledge is lost. Users reading in a second language or encountering unfamiliar vocabulary need a way to save, revisit, and learn new words. This feature turns ephemeral AI lookups into a durable vocabulary learning tool with spaced repetition.

---

## Architecture

- **Per-book vocab tab** in the existing BookmarksPanel (alongside Bookmarks/Highlights) — no new SidePanel type needed
- **Global `/vocab` page** accessible from Home sidebar — cross-book browsing, stats, flashcard review
- **Save from LookupPopover** — primary entry point, captures word + AI definition + context sentence + CFI

---

## Phase 1: Core Save & List

### 1.1 Database Schema

**Create: `src-tauri/migrations/002_vocab.sql`**

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

CREATE INDEX IF NOT EXISTS idx_vocab_book_id ON vocab_words(book_id);
CREATE INDEX IF NOT EXISTS idx_vocab_mastery ON vocab_words(mastery);
```

**Modify: `src-tauri/src/db.rs`** — load second migration after `001_init.sql`:
```rust
let schema2 = include_str!("../migrations/002_vocab.sql");
conn.execute_batch(schema2)?;
```

### 1.2 Backend Commands

**Create: `src-tauri/src/commands/vocab.rs`**

Follow the exact pattern from `bookmarks.rs` (struct + `#[tauri::command]` + `State<'_, Db>` + `AppResult<T>`):

```rust
pub struct VocabWord {
    id, book_id, word, definition, context_sentence, cfi,
    mastery, review_count, next_review_at, created_at, updated_at
}

pub fn add_vocab_word(book_id, word, definition, context_sentence, cfi, db) -> AppResult<VocabWord>
  // Dedup: check if same word+book_id exists, return existing if so
pub fn remove_vocab_word(id, db) -> AppResult<()>
pub fn list_vocab_words(book_id, db) -> AppResult<Vec<VocabWord>>
pub fn check_vocab_exists(book_id, word, db) -> AppResult<Option<String>>
  // Returns the id if exists, None otherwise — used by LookupPopover
```

**Modify: `src-tauri/src/commands/mod.rs`** — add `pub mod vocab;`

**Modify: `src-tauri/src/lib.rs`** — register 4 commands under `// Vocabulary` section

### 1.3 Frontend Hook

**Create: `src/hooks/useVocab.ts`**

Follow `useBookmarks.ts` pattern (useState + useCallback + invoke):

```typescript
interface VocabWord { id, book_id, word, definition, context_sentence, cfi, mastery, review_count, next_review_at, created_at, updated_at }

function useVocab(bookId: string) → { words, refresh, add, remove }
```

### 1.4 LookupPopover Integration

**Modify: `src/components/LookupPopover.tsx`**

- Add props: `bookId: string`, `cfi?: string`
- Add state: `saved: boolean`, `vocabId: string | null`
- On mount: call `check_vocab_exists(bookId, word)` — if exists, show "Saved" immediately
- After streaming completes (`!streaming && content`): show footer bar with "Save to Vocab" button
- On save: call `add_vocab_word(...)` capturing `contentRef.current` as definition
- After save: button changes to "Saved" checkmark (non-interactive)

**Modify: `src/pages/Reader.tsx`**

- Extend `lookup` state to include `cfi`: grab from `contextMenu.cfiRange`
- Pass `bookId={bookId}` and `cfi={lookup.cfi}` to `<LookupPopover>`

### 1.5 BookmarksPanel Vocab Tab

**Modify: `src/components/BookmarksPanel.tsx`**

- Extend tab type: `type Tab = "bookmarks" | "highlights" | "vocab"`
- Add third tab button "Vocab" with same styling
- Import and use `useVocab(bookId)` hook
- Vocab tab content:
  - Filter bar: mastery chips (All / New / Learning / Mastered) as rounded-full pills + search input (same layout as highlights filter bar)
  - Word list: each item shows word (14px semibold), mastery badge (small colored pill), definition preview (13px, 2-line clamp), timestamp
  - Click → `onNavigate(cfi)` to jump to the word location in book
  - Hover → trash icon to delete
  - Footer: word count

---

## Phase 2: Global Vocab Page + Sidebar

### 2.1 Additional Backend Commands

**Modify: `src-tauri/src/commands/vocab.rs`** — add:

```rust
pub fn list_all_vocab_words(db) -> AppResult<Vec<VocabWord>>
pub fn update_vocab_mastery(id, mastery, next_review_at, db) -> AppResult<()>
pub fn list_vocab_due_for_review(db) -> AppResult<Vec<VocabWord>>
  // WHERE next_review_at IS NOT NULL AND next_review_at <= datetime('now')
pub fn get_vocab_stats(db) -> AppResult<VocabStats>
  // VocabStats { total, new_count, learning_count, mastered_count, due_for_review }
```

**Modify: `src-tauri/src/lib.rs`** — register 4 additional commands

### 2.2 Global Vocab Hook

**Modify: `src/hooks/useVocab.ts`** — add:

```typescript
function useAllVocab() → { words, stats, refresh, remove, updateMastery, dueForReview }
```

### 2.3 Vocab Page

**Create: `src/pages/VocabPage.tsx`**

Layout matches Home.tsx (224px sidebar + main content):
- Header: "Vocabulary" title + row of 5 stat cards (Total, New, Learning, Mastered, Due)
- Filters: book dropdown, mastery chips, search input
- Word list: expandable cards — collapsed shows word + book title + mastery badge; expanded shows full definition + context sentence + "Open in Book" button
- "Review" button in header (launches Phase 3 flashcards)

### 2.4 Navigation

**Modify: `src/components/Sidebar.tsx`** — add "Vocabulary" item (BookA icon from lucide-react) below Library section, navigates to `/vocab`

**Modify: `src/App.tsx`** — add `<Route path="/vocab" element={<VocabPage />} />`

---

## Phase 3: Flashcard Review

### 3.1 Flashcard Component

**Create: `src/components/FlashcardReview.tsx`**

Full-viewport overlay with centered card (max 480px wide):
- **Front**: word (24px semibold) + context sentence (14px italic, word highlighted)
- **Back** (click/spacebar): full AI definition with markdown rendering
- **Actions**: "Still Learning" (amber) + "I Know This" (green)
- Progress bar at top ("3 of 12")

Spaced repetition scheduling (frontend logic):
- new → learning: next_review = +1 day
- learning → learning: next_review = +3 days
- learning → mastered: next_review = +7 days
- mastered review: next_review = +30 days

### 3.2 Integration

- VocabPage: "Review (N due)" button launches FlashcardReview overlay
- BookmarksPanel vocab tab: "Review" quick-action for per-book review
- Sidebar: badge on Vocabulary item showing due-for-review count

---

## Files Summary

| Action | File | Phase |
|--------|------|-------|
| Create | `src-tauri/migrations/002_vocab.sql` | 1 |
| Create | `src-tauri/src/commands/vocab.rs` | 1+2 |
| Create | `src/hooks/useVocab.ts` | 1+2 |
| Create | `src/pages/VocabPage.tsx` | 2 |
| Create | `src/components/FlashcardReview.tsx` | 3 |
| Modify | `src-tauri/src/db.rs` — load 002 migration | 1 |
| Modify | `src-tauri/src/commands/mod.rs` — add vocab module | 1 |
| Modify | `src-tauri/src/lib.rs` — register vocab commands | 1+2 |
| Modify | `src/components/LookupPopover.tsx` — add Save button + bookId/cfi props | 1 |
| Modify | `src/pages/Reader.tsx` — pass bookId/cfi to LookupPopover | 1 |
| Modify | `src/components/BookmarksPanel.tsx` — add Vocab tab | 1 |
| Modify | `src/components/Sidebar.tsx` — add Vocabulary nav item | 2 |
| Modify | `src/App.tsx` — add /vocab route | 2 |

---

## Figma Design Prompts

### LookupPopover Save Button
> The current Look Up popover is a 360px-wide fixed-position panel with frosted glass background (white at 95% opacity, backdrop blur, rounded-xl, shadow). It has a header with "Look Up" label and close button, and a scrollable content area showing a markdown AI definition. **Add a footer bar** below the content, separated by a 1px border-t. The footer is 36px tall with 12px horizontal padding. It contains a single button on the right: "Save to Vocab" pill (rounded-lg, bg-accent, text-white, 12px font, medium weight, BookmarkPlus icon 14px). When already saved: muted "Saved" label with green checkmark icon, no click action. Button only appears after streaming completes.

### BookmarksPanel Vocab Tab
> The current side panel has a two-tab bar: "Bookmarks" and "Highlights" with underline active indicators. **Add a third tab "Vocab"** with the same styling. When active, show a filter bar (45px height): mastery chips as small rounded-full pills ("All" filled, "New" gray, "Learning" amber, "Mastered" green) and a compact search input on the right (same as highlights search). Below: a scrollable word list. Each word card is a full-width row (hover:bg-bg-input) showing: word in 14px semibold, small mastery badge pill (colored by level), definition truncated to 2 lines in 13px text-muted, timestamp in 11px muted. Hover shows trash icon. Footer shows word count. Match existing bookmark/highlight card styling exactly.

### Vocabulary Page (Global)
> Design a full-page vocabulary management view. Layout matches the Home page: 224px sidebar on left (same Sidebar component, "Vocabulary" highlighted), main content area. Header: "Vocabulary" title (24px semibold), row of 5 compact stat cards (Total/New/Learning/Mastered/Due — each a rounded-lg card with count in 20px bold and label in 12px muted, color-coded: gray/blue/amber/green/red). Below: filter row with book dropdown, mastery chips, search input. Word list uses expandable cards: collapsed shows word + book title pill + mastery badge + timestamp; expanded shows full markdown definition, context sentence in italic, "Open in Book" button. Top-right: "Review" primary button with Layers icon and due-count badge.

### Flashcard Review Modal
> Full-viewport overlay with semi-transparent dark backdrop. Centered card (max 480px wide, min 300px tall, rounded-2xl, white bg). Top: thin accent progress bar + "3 of 12" text + close X button. **Front state**: word in 24px semibold centered, context sentence in 14px muted italic below (word bold within sentence), "Show Definition" hint in 13px muted. **Back state** (click/spacebar): fades in the full AI definition in 14px markdown below the word. Bottom: two action buttons — "Still Learning" (amber outline, RotateCcw icon) and "I Know This" (green filled, Check icon), both 44px tall.

---

## Verification

### Phase 1
- [ ] `cargo build` passes, `cargo test` passes
- [ ] Select word in reader → Look Up popover shows AI definition
- [ ] After streaming completes, "Save to Vocab" button appears in popover footer
- [ ] Click "Save" → button changes to "Saved" checkmark
- [ ] Re-open Look Up for same word in same book → shows "Saved" immediately
- [ ] BookmarksPanel has "Vocab" tab alongside Bookmarks and Highlights
- [ ] Vocab tab shows saved words with word, definition preview, mastery badge
- [ ] Search and mastery filter work in vocab tab
- [ ] Click word → reader navigates to CFI location
- [ ] Delete word via hover trash → removed from list
- [ ] Delete a book → its vocab words cascade-deleted

### Phase 2
- [ ] "Vocabulary" item in Home sidebar navigates to `/vocab`
- [ ] VocabPage shows correct stats across all books
- [ ] Book filter dropdown lists only books with vocab words
- [ ] Word card expands to show full definition + context
- [ ] "Open in Book" navigates to reader at the correct location

### Phase 3
- [ ] "Review" button shows correct due count
- [ ] Flashcard shows word + context on front
- [ ] Click/spacebar reveals definition
- [ ] "Still Learning" / "I Know This" update mastery and schedule next review
- [ ] Progress bar tracks review session
- [ ] Words don't reappear until their next_review_at date
