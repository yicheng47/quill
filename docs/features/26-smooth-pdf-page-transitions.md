# 26 — Smooth PDF Page Transitions

**GitHub Issue:** https://github.com/yicheng47/quill/issues/141

## Motivation

Page turning in PDF mode currently destroys the entire iframe/view and rebuilds it from scratch on every navigation. This causes a visible flash (background exposed between DOM teardown and new content paint), making extended PDF reading sessions eye-straining and unpleasant.

EPUBs already feel smooth because foliate-js can reuse the same view for column-based pagination within a section. PDFs don't get this benefit — every page is a separate "section" that triggers full view destruction/recreation.

## Root Cause

In `public/foliate-js/paginator.js`, the `#goTo()` method (line ~1027) calls `#display()`, which calls `#createView()`. `#createView()`:

1. Calls `this.#view.destroy()` — tears down the old iframe
2. Removes the old element from the DOM
3. Creates a brand new `View` with a fresh iframe
4. Appends it and loads the PDF page content (canvas + text layer + annotations)

The gap between step 2 (old content gone) and step 4 (new content painted) is the visible flash.

## Scope

### In scope
- Eliminate the flash/flicker on PDF page forward/back navigation
- Optional: add a subtle crossfade or slide transition
- Maintain correct theme overlay behavior during transitions
- Keep keyboard nav, click nav, and TOC jump all working

### Out of scope
- EPUB rendering changes (already smooth)
- PDF zoom/resize behavior (separate concern)
- Page turn animations for EPUBs

## Implementation Phases

### Phase 1 — Double-buffered view swap (eliminates flash)

Instead of destroy-then-create, use two view slots and swap them:

1. Keep the **current view visible** while the next page loads in a **hidden second view**
2. Once the new view is fully rendered (canvas painted, text layer ready), swap visibility
3. Destroy the old view **after** the new one is displayed

This is the minimal change that kills the flash. It requires modifying `paginator.js` to maintain two view containers and coordinate the swap.

Key changes:
- `#createView()` becomes `#prepareNextView()` — creates the new view off-screen or hidden
- `#display()` awaits full render, then swaps `display`/`visibility` or `z-index`
- Old view cleanup happens post-swap

### Phase 2 — CSS transition (optional polish)

Once double-buffering works, layer on a CSS transition:

- **Crossfade** (default): new view fades in over ~150ms while old fades out
- Could offer a `none` option for users who prefer instant swap
- Transition via `opacity` + CSS `transition` on the view wrappers — no JS animation needed

### Phase 3 — Pre-rendering adjacent pages (optional perf)

Pre-render the next/previous page in hidden views so the swap is instant:

- On page load, kick off background render of page N+1 (and optionally N-1)
- Cache rendered views (limit to 3: prev, current, next)
- Invalidate cache on theme change or zoom change

This is a nice-to-have. Phase 1 alone should make the experience dramatically better.

## Verification

- [ ] PDF page forward/back shows no white flash or background exposure
- [ ] Theme overlay applies correctly on every page (paper, dark, sepia, etc.)
- [ ] Keyboard navigation (arrow keys) works smoothly
- [ ] Click/tap navigation works smoothly
- [ ] TOC jump navigation works (may still flash — acceptable for non-sequential jumps)
- [ ] Zoom level is preserved across page turns
- [ ] No memory leaks from view accumulation (verify old views are destroyed)
- [ ] EPUB rendering is unaffected
