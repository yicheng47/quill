# 198 — Persist Per-Book Window Size and PDF Zoom

**GitHub Issue:** https://github.com/yicheng47/quill/issues/198

## Motivation

Reader windows are per-book (`reader-${bookId}` `WebviewWindow`), but every book opens at a fixed 1440×960 regardless of what size the user last chose. PDF zoom has the same problem: dial in 150% for a small-print academic paper, close the book, reopen — you're back at 100%.

Quill already persists reading progress, reading mode, theme, page layout, and other per-book settings via `book_settings`. Window size and PDF zoom are the last user-controlled knobs that get forgotten every session. Closing a gap users hit every day; no new infrastructure needed.

## Scope

### In scope

- **Persist reader window size per book** — width and height saved on resize, restored on next open.
- **Persist PDF zoom % per book** — saved on change, restored when the book loads.
- **Reuse `book_settings`** — the existing key-value-per-book table (`migrations/007_book_settings.sql`) is the right home. New keys: `window_width`, `window_height`, `zoom_level`.
- **Debounced writes** — live resize/zoom generates many events; writes debounce at ~500ms so the DB isn't hammered.
- **Clamp on load** — saved window dimensions clamped to the existing `minWidth: 700` / `minHeight: 500` from `openReaderWindow.ts`; zoom clamped to the valid zoom range.

### Out of scope

- **Window position persistence** — deferred. Multi-monitor and off-screen-window edge cases deserve their own issue.
- **Main (library) window size** — this issue is about per-book reader windows only. Tauri already handles the main window via default platform behavior.
- **EPUB zoom** — foliate-js handles EPUB text scaling through font-size, not a zoom control. Only window size applies to EPUBs.
- **Retroactive migration** — missing keys fall back to defaults; no backfill needed.

## Key decisions

- **Storage layout** — three string-valued keys in `book_settings`: `window_width`, `window_height`, `zoom_level`. Matches the existing pattern; no schema change.
- **Window size load timing** — the saved size must be read in `src/utils/openReaderWindow.ts` **before** `new WebviewWindow(...)`. Passing them to the constructor avoids a visible resize flash on open. The helper becomes async (already returns a `Promise`).
- **Zoom load timing** — loaded inside `Reader.tsx` alongside the other per-book settings that seed state on book load. No flash concern — zoom is applied after the book is ready.
- **Save timing** — `appWindow.onResized` (Tauri) fires continuously during a drag-resize; we buffer via a 500ms trailing debounce so only the final size hits the DB. Zoom changes debounce the same way (zoom buttons can fire fast).
- **Clamping** — on load, clamp `window_width` to `max(700, saved)`, same for height (500). If the saved value is garbage (non-numeric), fall back to defaults silently.
- **Defaults unchanged** — absent keys → today's behavior (1440×960 window, 100% zoom). No user action required; the feature is invisible until they resize or zoom.
- **Per-window identity** — the window label `reader-${bookId}` already makes each window book-scoped. Saving per book is trivial; no label parsing gymnastics needed.

## Implementation Phases

### Phase 1 — PDF zoom persistence

- In `Reader.tsx`, when the book loads, call `get_book_settings(bookId)` (already wired) and seed `zoomLevel` from `zoom_level` if present and the book is a PDF.
- Wrap `setZoomLevel` with a debounced write to `set_book_settings_bulk` keyed on `zoom_level`.
- Guard on `book.format === "pdf"` so EPUBs don't write a meaningless `zoom_level` key.

### Phase 2 — Per-book window size persistence

- Change `openReaderWindow.ts` to `await` a `get_book_settings(bookId)` call before constructing `WebviewWindow`. Read `window_width` / `window_height`, clamp, and pass to the constructor. On any error, fall through to the current defaults.
- In `Reader.tsx`, subscribe to `appWindow.onResized` during the lifetime of the reader. On each event, read `logicalSize()` and debounced-write `window_width` / `window_height` to `book_settings`.
- Unsubscribe on unmount to avoid leaks across hot-reloads.

## Verification

- [ ] Open book A, resize the window, close. Reopen A → window restores to the last size.
- [ ] Open PDF book A, set zoom to 150%, close. Reopen A → still 150%.
- [ ] Book A and book B have independent window sizes and zoom levels.
- [ ] First-time open of a fresh book uses the default 1440×960 and 100%.
- [ ] Rapid dragging of the resize handle doesn't produce dozens of DB writes — confirm via logging or a counter that writes are debounced.
- [ ] Zoom scrubbed with rapid clicks on zoom-in/out buttons debounces similarly.
- [ ] EPUB book closed and reopened → window size restored; no `zoom_level` key written.
- [ ] Saved width/height below the minimums are clamped up to 700/500 (simulate by manually setting `book_settings`).
- [ ] Corrupt `zoom_level` value ("foo") falls back to 100% and doesn't crash the reader.
- [ ] Multiple reader windows open at once (books A and B side by side) persist their sizes independently.
