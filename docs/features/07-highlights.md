# Highlights & Highlight Management

**Version:** 0.1
**Date:** March 11, 2026
**Status:** Design

---

## 1. Motivation

Quill already stores highlights in the database and renders them as colored overlays in the reader. However, the only way to create a highlight is programmatically — there is no user-facing flow to highlight selected text, choose a color, add notes, change colors later, or manage highlights across books.

This feature turns highlights into a first-class reading tool: select text → pick a color. A dedicated highlights panel lets users browse, search, filter, and manage their annotations.

---

## 2. What Already Exists

| Layer | What's built | Where |
|-------|-------------|-------|
| DB schema | `highlights` table (id, book_id, cfi_range, color, note, text_content, created_at) | `migrations/001_init.sql` |
| Backend commands | `add_highlight`, `remove_highlight`, `list_highlights`, `update_highlight_note` | `src-tauri/src/commands/bookmarks.rs` |
| Frontend hook | `useHighlights` — add, remove, updateNote, refresh | `src/hooks/useBookmarks.ts` |
| Rendering | foliate-js `create-overlay` loads highlights, `draw-annotation` draws colored SVG rects | `src/pages/Reader.tsx:324-361` |
| Annotation click | `show-annotation` event fires on highlight click (currently just logs) | `src/pages/Reader.tsx:363-367` |
| Sidebar listing | BookmarksPanel shows highlights with color dot, text preview, note, delete | `src/components/BookmarksPanel.tsx` |
| Color map | yellow, green, blue, pink, purple → rgba overlay values | `src/pages/Reader.tsx:85-91` |

**What's missing:**
- Context menu "Highlight" action with color picker
- Inline highlight toolbar (on tap/click of existing highlight)
- Color changing for existing highlights
- Highlight filtering/searching in the side panel
- `update_highlight_color` backend command

---

## 3. Feature Design

### 3.1 Creating a Highlight

**Trigger:** User selects text in the reader.

**Flow:**
1. Text selection triggers the existing context menu (`ReaderContextMenu`)
2. A new **"Highlight"** option appears at the top of the context menu, with a row of 5 color dots (yellow, green, blue, pink, purple) inline
3. Tapping a color dot immediately creates the highlight in that color, closes the menu, and the overlay appears
4. Default color: yellow (leftmost dot, slightly larger or with a subtle checkmark)
5. The selected text content (`text_content`) is captured and stored for later display in the panel

**Context menu order (per Figma design):**
1. Look Up (short selections only)
2. Ask AI Assistant
3. Highlight (color dots inline)
4. Copy (⌘C)

### 3.2 Inline Highlight Toolbar

**Trigger:** User clicks/taps an existing highlight in the reader.

**Flow:**
1. The `show-annotation` event fires with the highlight's CFI range
2. A small floating pill toolbar appears near the tapped position with:
   - 5 color dots — tap to change color
   - Trash icon — tap to remove highlight
3. No dividers between elements, minimal pill shape
4. Toolbar dismisses on click outside or Escape

### 3.3 Highlights Panel (Side Panel)

Replaces the current combined Bookmarks panel when the "Highlights" tab is active.

**Layout (per Figma design):**
- **Tab bar at top:** "Bookmarks" | "Highlights" (active tab has bottom border underline)
- **Bookmarks tab:** Keeps existing layout with "Saved" button top-right
- **Highlights tab:**
  - **Filter bar:** "All" chip (filled when active) + 5 color dots + search input to the right
  - **Highlight list:** Scrollable, sorted by recency
  - **Each highlight card:** Color dot on the left, quoted text preview, page number + relative timestamp ("Just now", "2h ago")
  - **Footer:** count summary ("1 highlight" / "12 highlights")

---

## 4. Backend Changes

### New command: `update_highlight_color`

```rust
#[tauri::command]
pub fn update_highlight_color(id: String, color: String, db: State<'_, Db>) -> AppResult<()>
```

Updates the `color` column for a highlight. The frontend needs this to change colors from the inline toolbar.

No schema changes needed — the existing `highlights` table covers all required fields.

---

## 5. Frontend Changes

### Files to modify:

| File | Change |
|------|--------|
| `src/components/ReaderContextMenu.tsx` | Add "Highlight" row with inline color dots |
| `src/components/HighlightToolbar.tsx` | **New** — Floating toolbar for existing highlight interaction |
| `src/components/BookmarksPanel.tsx` | Refactor into tabbed panel: Bookmarks + Highlights tabs, add filter/search |
| `src/hooks/useBookmarks.ts` | Add `updateColor` to `useHighlights` hook |
| `src/pages/Reader.tsx` | Wire highlight creation from context menu, `show-annotation` → toolbar, pass new callbacks |

### Files to create:

| File | Purpose |
|------|---------|
| `src/components/HighlightToolbar.tsx` | Inline floating toolbar on highlight click |

---

## 6. Implementation Phases

### Phase 1: Highlight Creation from Context Menu
- Add color dots row to `ReaderContextMenu`
- Wire `add_highlight` through `useHighlights` hook on color tap
- Call `view.addAnnotation()` immediately after creation
- Capture `text_content` from selection

### Phase 2: Inline Highlight Toolbar
- Implement `HighlightToolbar` component
- Wire `show-annotation` event in Reader to show toolbar
- Add `update_highlight_color` backend command
- Add `updateColor` to `useHighlights` hook
- Color change → `view.deleteAnnotation()` + `view.addAnnotation()` with new color

### Phase 3: Enhanced Highlights Panel
- Refactor `BookmarksPanel` into tabbed layout
- Add color filter chips and text search
- Add sort toggle (by position / by date)
- Improve highlight card with chapter info and hover actions

---

## 7. Figma Design Prompts

Use these prompts to design the UX components in Figma before implementation.

### Prompt 1: Context Menu with Highlight Colors

> The current reader context menu is a 240px-wide floating panel with frosted glass background (white at 95% opacity with backdrop blur), rounded corners (8px), and a subtle shadow. It appears on text selection and contains: "Look Up" (sparkle icon, only for short selections), a 1px divider, "Copy" (with ⌘C shortcut hint), and "Ask AI Assistant" (bot icon). Each item is 31.5px tall with a 16px icon and 13px medium-weight label, and highlights with a light gray on hover. Add a new "Highlight" row between Look Up and Copy (after the first divider, before Copy). The row has a highlighter icon on the left and 5 small color dots (yellow #FBBf24, green #34D399, blue #60A5FA, pink #F472B6, purple #A78BFA) inline to the right. Dots are ~14px circles with 6px spacing. Tapping a dot creates the highlight immediately and closes the menu.

### Prompt 2: Inline Highlight Toolbar

> Design a small floating toolbar for a macOS ebook reader that appears when a user taps an existing highlight. It should match the app's frosted glass style (white at 95% opacity, backdrop blur, subtle shadow). The toolbar is a horizontal pill shape (~36px tall, rounded-full) with: 5 color circles (14px each — yellow, green, blue, pink, purple; the current active color has a small white checkmark overlay), a 1px vertical divider, and a trash icon (14px, muted gray). Anchored near the tapped highlight with a subtle caret/arrow pointing down to the text.

### Prompt 3: Highlights Panel (Side Panel)

> The current side panel is a 320px-wide "Bookmarks" panel. It has a 65px header with a bookmark icon (20px, muted), "Bookmarks" title (20px semibold), and an "Add" button (gray pill with BookmarkPlus icon). Below is a scrollable list — bookmark items show a bookmark icon, label text (14px), page number + relative timestamp (11px muted). Highlight items in the same list show a 16px color dot, left border in the highlight color, quoted text (13px, 2-line clamp), optional note (12px muted), and page + timestamp. On hover, a trash icon appears. The footer shows "X bookmarks · Y highlights" in 11px muted text. Refactor this into a tabbed layout: replace the header with a "Bookmarks" | "Highlights" tab bar (underline-style active indicator). Keep the "Add" button on the Bookmarks tab. When "Highlights" is active, show a filter row below with small color chips (All + 5 colored dots) and a compact search input. Keep the existing highlight card style but add hover actions for change color and delete. Footer shows count for the active tab only.

---

## 8. Verification

1. Select text → context menu shows highlight color dots → tap yellow → highlight appears immediately
2. Tap existing highlight → inline toolbar appears → change color to blue → overlay updates
3. Open Highlights panel → all highlights listed with correct colors and text
4. Filter by color → only matching highlights shown
5. Search → highlights matching text content appear
6. Click highlight in panel → reader navigates to that location
7. Delete highlight → overlay removed from reader, removed from panel
8. Works correctly with all 5 colors across light and dark reader themes
