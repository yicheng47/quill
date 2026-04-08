# 146 — PDF Continuous Scroll Mode

**GitHub Issue:** https://github.com/yicheng47/quill/issues/146

## Motivation

Quill's PDF reader only supports paginated (page-turn) navigation. That works for prose-style books, but it's a poor fit for the kind of content users actually read as PDFs:

- **Academic papers** — figures, tables, and footnotes straddle page boundaries; page turns break the read.
- **Reports and manuals** — users scan, skim, and jump around; continuous scroll is faster.
- **Trackpad and touch input** — scroll is the native gesture. Forcing click-to-paginate feels wrong on modern hardware.
- **Long selections** — text selection across pages is impossible in paginated mode; trivial in scroll mode.

Every mainstream PDF viewer (Preview, Adobe, macOS Books, pdf.js default) offers continuous scroll, and users expect it.

## Scope

### In scope

- **Continuous vertical scroll mode for PDFs** — all pages stacked in one scrollable column, users scroll freely through the entire document.
- **Both Single Page and Two Pages layouts in scroll mode** — Reading Mode (scroll vs paginated) and Page Layout (single vs two-page spread) are **orthogonal**. All four combinations are valid:
  - Paginated + Single Page (today's default)
  - Paginated + Two Pages (today's spread view)
  - Scrolling + Single Page (new — vertical column of single pages)
  - Scrolling + Two Pages (new — vertical column of page **pairs** rendered side-by-side)
- **Expose Reading Mode toggle for PDFs** — the toggle already exists in `ReaderSettings.tsx` for EPUBs but is hidden for PDFs (`bookFormat !== "pdf"` gate). Unhide it so PDFs get the same control.
- **Per-book toggle** — users can switch between paginated and scroll on a per-book basis, persisted via the existing `book_settings` table. Mirrors how other reader display settings work (theme, font, etc.). The `readingMode` key already exists from issue #119 — no new settings plumbing needed.
- **Preserve existing PDF features** in both scroll layouts:
  - Zoom in / out
  - Text selection (including across page boundaries where practical — see Key decisions)
  - AI Look Up / Ask AI context menu
  - Reading progress tracking (which page the user is currently on)
  - Bookmarks and highlights
  - TOC navigation (jump to a page)
  - Theme overlay (Original / Sepia / Gray / Dark)
  - Page Layout toggle (Single / Two Pages) — respected in both Reading Modes
- **Virtualized rendering** — only pages near the viewport are rendered to canvas; off-screen pages show a lightweight placeholder. Necessary for large PDFs (1000+ pages) to stay performant. Virtualization works per-row in two-page layout (a row is one page or a pair).
- **Reading progress updates as the user scrolls** — progress fraction reflects the page (or page pair) at the top of the viewport, not the last-clicked page.

### Out of scope

- **EPUB scroll mode** — foliate-js already handles this via `readingMode: "scrolling"`; no work needed.
- **Horizontal scroll** — vertical scroll only. Two-page layout still scrolls vertically; the two pages of a row sit side-by-side.
- **Smooth animation during scroll** — native scroll is already smooth. No custom easing.
- **Pre-rendering beyond the viewport window** — virtualization renders N±2 rows; we don't pre-render the entire doc in the background.
- **Scroll mode for comic-book (`.cbz`) files** — out of scope for v1. If it's easy once the PDF pipeline works, revisit.

## Key decisions

- **Rendering backend** — use **foliate-js** (add a new `foliate-pdf-scroll` custom element) rather than building a parallel React component. Rationale:
  - Theme overlay, text selection hooks, AI context menu, highlight system, and zoom are all wired through the foliate-js iframe model already. A parallel React component would re-implement all of that.
  - `pdf.js` (foliate-js) already exposes `book.sections[i].load()` which returns a rendered page iframe — the scroll renderer can reuse it page by page.
  - Keeping it in foliate-js means the `relocate` event mechanism that Reader.tsx listens to for progress still works.
- **Row-based layout primitive** — the scroll renderer works in terms of **rows**, not pages. In single-page layout, one row = one page. In two-page layout, one row = one page pair rendered side-by-side in a flex container. This keeps virtualization, progress tracking, and keyboard navigation uniform across both layouts.
- **Two-page pairing rule** — matches the existing paginated spread behavior: pairs start at even indices `[0,1], [2,3], …`. If a book uses `pageSpread` metadata (rare in PDFs), honor it the same way `fixed-layout.js` does.
- **Reading Mode × Page Layout matrix** — the two controls are fully orthogonal. Switching Reading Mode preserves the current Page Layout and vice versa. All four combinations are supported and persist per-book.
- **Virtualization strategy** — `IntersectionObserver` on lightweight row placeholders. When a placeholder comes within 2 viewport heights of the visible area, mount the row's iframe(s). When it leaves a 3-viewport buffer, tear them down and restore the placeholder. Keeps memory bounded regardless of PDF size. In two-page layout, both iframes in a row are mounted/unmounted together.
- **Page spacing** — 12px vertical gap between rows with a subtle shadow per page, matching the paginated mode's visual treatment. In two-page layout, the pages inside a row sit flush against each other (no gap between the pair). Background color follows the theme.
- **Default mode for new PDFs** — **paginated**, matching current behavior. Users who want scroll mode opt in per book. We can revisit the default after shipping and watching behavior.
- **Interaction with #141 (smooth PDF transitions)** — scroll mode eliminates page-turn flash by removing page turns entirely. But #141 is still needed for users who stick with paginated mode. The two features are independent and non-conflicting.
- **Zoom behavior** — in scroll mode, zoom changes the size of every row and re-renders visible rows at the new scale. Placeholders are resized to match the new bounding box without re-render. Same `zoomLevel` state in `Reader.tsx` drives both modes and both layouts.
- **Progress tracking** — "current page" = the first page of the topmost row whose midpoint is inside the viewport. In two-page layout, the reported index is the left page of the visible row. Updates throttled to ~200ms during active scroll. Same `relocate` event as paginated mode, so the existing progress bar code in Reader.tsx needs no changes.

## Implementation Phases

### Phase 1 — Scroll renderer in foliate-js

Add a new web component `foliate-pdf-scroll` that mirrors `foliate-fxl`'s public surface (`open`, `goTo`, `zoom`/`spread` attributes, `relocate` event) but renders pages in a virtualized scroll container instead of a spread viewer.

- One **row placeholder** div per row, sized to the row's bounding box (single page width or pair width), queried via `pdf.getPage(n).getViewport({ scale: 1 })` once at open time
- The row is computed from the `spread` attribute: `spread = "none"` → one page per row; `spread = "auto"` → pair pages `[0,1], [2,3], …` into rows (plus optional `pageSpread` metadata respect)
- `IntersectionObserver` watches row placeholders; when a placeholder enters the pre-render buffer, create the iframe(s) for the row and call `book.sections[i].load()` (same path paginated mode uses)
- When a placeholder leaves the tear-down buffer, destroy its iframe(s) but keep the placeholder div at its same size so scroll position is stable
- Dispatch `create-overlayer` per page when it loads, so the existing highlight/annotation pipeline works
- Dispatch `relocate` on scroll (throttled), reporting `{ index, fraction, size }` based on the first page of the topmost visible row

### Phase 2 — Wire into Reader.tsx

- Extend `ReaderSettings` to show the existing `readingMode` toggle for PDFs (remove the `bookFormat !== "pdf"` gate on that block) — it sits alongside the existing PDF-only Page Layout toggle
- In Reader.tsx's foliate init effect, pick the renderer based on `readerSettings.readingMode`:
  - `paginated` → existing `foliate-fxl` path (unchanged)
  - `scrolling` → new `foliate-pdf-scroll` path
- Pass the current `spread` value (mapped from `pageColumns`: `1 → "none"`, `2 → "auto"`) to the scroll renderer via the same `spread` attribute `foliate-fxl` uses, so the Page Layout toggle works identically in both modes
- Switching Reading Mode re-opens the book in the new renderer (same book object, new view element), preserving the current page and the current Page Layout
- Switching Page Layout in scroll mode re-lays out rows without destroying the component
- Keep the `book_settings` persistence — already works, just verify `readingMode` is in the PDF settings payload

### Phase 3 — Polish

- Text selection across page boundaries — verify selection ranges span iframes correctly within a row; cross-row selection is a known limitation (documented, not fixed in v1)
- Scroll-to-page on TOC click — use `placeholder.scrollIntoView({ block: "start" })` with `smooth` behavior. In two-page layout, scroll to the row containing the target page
- Zoom preserves scroll position anchored on the row at the top of the viewport
- Bookmarks / highlights render correctly on the scrolled-into-view page

## Verification

- [ ] Open a PDF → defaults to paginated + single-page (existing behavior unchanged)
- [ ] Reading Mode toggle is visible in Reader Settings for PDFs (previously hidden)
- [ ] Toggle to scroll mode (single-page) → reader switches to continuous scroll without closing/reopening the window
- [ ] Toggle to scroll mode (two-page) → reader shows a vertical column of page pairs side-by-side
- [ ] Switch Page Layout while in scroll mode (single ↔ two) → rows re-lay out, scroll position anchors on the top-visible row
- [ ] Switch Reading Mode while in two-page layout → paginated two-page ↔ scroll two-page preserve the current page
- [ ] Toggle persists: close reader, reopen same book → still in the same Reading Mode × Page Layout combination
- [ ] Toggle is per-book: Book A in scroll mode two-page, Book B stays paginated single-page
- [ ] Scroll through all pages of a 500+ page PDF → no crash, memory stays bounded (< 500MB growth)
- [ ] Same stress test in two-page scroll mode (250 rows × 2 pages) → same result
- [ ] Zoom in/out in scroll mode → visible rows re-render at new scale, scroll position stays anchored
- [ ] Select text that starts on page N and ends on page N+1 (same row in two-page layout) → selection works, AI Look Up receives the full text
- [ ] Progress bar updates as the user scrolls
- [ ] TOC jump scrolls to the right page (and the correct row in two-page layout)
- [ ] Theme overlay applies to every visible page in both layouts
- [ ] Keyboard navigation (Page Down / Space / Arrow keys) still works in scroll mode (scroll by viewport)
- [ ] Bookmarks and highlights render on the correct pages in scroll mode
- [ ] Scroll mode doesn't regress paginated mode — same PDF in paginated mode (single and two-page) still behaves identically to today
- [ ] EPUB scroll mode is unaffected (still handled by foliate-js paginator)
