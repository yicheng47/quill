# PDF Highlights Not Working

**Status:** Known limitation
**Affects:** PDF format only (EPUBs work fine)

## Problem

Text selection works in PDFs (via the transparent text layer overlay), but highlights cannot be created or restored. When a user selects text and tries to highlight it, the annotation doesn't appear.

## Root Cause

PDF pages are rendered as canvas images by PDF.js. foliate-js generates CFI-like position references via `CFI.fake.fromIndex(index)` for PDFs, but:

1. **Creating highlights**: `getCFI(index, range)` produces a CFI from the text layer DOM, but the text layer has a flat structure that doesn't map well to CFI paths. `addAnnotation` tries to resolve the CFI back to a range via `CFI.toRange(doc, parts)`, which may fail because the PDF text layer DOM structure differs from what CFI expects.

2. **Restoring highlights**: Saved CFI strings from PDF text layers cannot be reliably resolved back to DOM ranges on subsequent loads, since PDF.js regenerates the text layer each time.

## Impact

- Users cannot highlight text in PDFs
- Bookmarks (which use page-level CFI, not text-range CFI) may still work
- Text selection, copy, and "Ask AI" all work correctly

## Possible Solutions

1. **Use PDF.js annotation API** — PDF.js has its own annotation system that works with page coordinates rather than DOM ranges. Store highlights as `{ page, rects[] }` instead of CFI.

2. **Patch foliate-js** — Modify the overlayer to handle PDF text layer DOM structure. The Readest fork of foliate-js appears to have working PDF highlights using CFI.

3. **Coordinate-based highlights** — Store the bounding rectangles of selected text relative to the page viewport, and redraw SVG overlays from those coordinates on each render.
