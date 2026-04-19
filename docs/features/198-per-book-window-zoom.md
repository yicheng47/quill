# 198 — Persist Per-Book Window Size and PDF Zoom

**GitHub Issue:** https://github.com/yicheng47/quill/issues/198

## Motivation

Reader windows are per-book (`reader-${bookId}` `WebviewWindow`), but every book opens at a fixed 1440×960 regardless of what size the user last chose. PDF zoom has the same problem: dial in 150% for a small-print academic paper, close the book, reopen — you're back at 100%.

Quill already persists reading progress, reading mode, theme, page layout, and other per-book settings via `book_settings`. Window size and PDF zoom are the last user-controlled knobs that get forgotten every session. Closing a gap users hit every day; no new infrastructure needed.

## Scope

### In scope

- **Persist reader window size per book** — width and height saved on resize, restored on next open.
- **Persist PDF zoom % per book** — saved on change, restored when the book loads.
- **Use `localStorage`, keyed by bookId** — matches the existing `reader-settings-${bookId}` pattern that already persists theme, font, reading mode, etc. The `book_settings` SQLite table exists but is currently unused from the frontend; reusing localStorage keeps all per-book display state in one place. Keys: `reader-zoom-${bookId}`, `reader-window-${bookId}`.
- **Debounced writes** — live resize/zoom generates many events; writes debounce at ~500ms so storage isn't hammered.
- **Clamp on load** — saved window dimensions clamped to the existing `minWidth: 700` / `minHeight: 500` from `openReaderWindow.ts`; zoom clamped to the valid zoom range (50–300).
- **Document the resize-normalizes-zoom interaction** — the reader already resets PDF zoom to 100% on any `window.resize` so the document re-fits to the new viewport. That's unchanged. Persistence captures whatever zoom the user ends on: if they resize, their zoom is normalized to 100% and 100% is what gets saved. The persisted value is "zoom on close," not "last zoom I ever chose."

### Out of scope

- **Window position persistence** — deferred. Multi-monitor and off-screen-window edge cases deserve their own issue.
- **Main (library) window size** — this issue is about per-book reader windows only. Tauri already handles the main window via default platform behavior.
- **EPUB zoom** — foliate-js handles EPUB text scaling through font-size, not a zoom control. Only window size applies to EPUBs.
- **Retroactive migration** — missing keys fall back to defaults; no backfill needed.

## Key decisions

- **Storage layout** — two `localStorage` keys scoped by bookId:
  - `reader-zoom-${bookId}` — string integer percent
  - `reader-window-${bookId}` — JSON `{width, height}` in logical pixels

  Chose `localStorage` over the `book_settings` SQLite table because the reader's other per-book display settings (`reader-settings-${bookId}`) already live in `localStorage`. Keeping all per-book reader state in one mechanism avoids split-brain reads and matches how the rest of the reader works today. `book_settings` remains in the schema as reserved infrastructure but is unused from the frontend.
- **Window size load timing** — the saved size is read synchronously (from `localStorage`) in `src/utils/openReaderWindow.ts` **before** `new WebviewWindow(...)`. Passing the size to the constructor avoids a visible resize flash on open and keeps the helper's existing call signature intact.
- **Zoom load timing** — loaded inside `Reader.tsx` alongside the other per-book settings that seed state on book load. After `bookReady`, an effect applies the seeded value to the renderer so the PDF actually renders zoomed (state alone doesn't transform the DOM).
- **Save timing** — `appWindow.onResized` (Tauri) fires continuously during a drag-resize; we buffer via a 500ms trailing debounce so only the final size is written. Zoom changes debounce the same way.
- **Clamping** — on load, clamp saved width/height to `max(700, saved)` / `max(500, saved)`. Zoom clamped to `[50, 300]`. Garbage values (non-numeric JSON, corrupt integers) silently fall through to defaults.
- **Defaults unchanged** — absent keys → today's behavior (1440×960 window, 100% zoom). No user action required; the feature is invisible until they resize or zoom.
- **Per-window identity** — the window label `reader-${bookId}` already makes each window book-scoped. Saving per book is trivial; no label parsing gymnastics needed.
- **Resize normalizes zoom** — this is pre-existing, intentional behavior. When the user drags to resize a reader window, a `window.resize` DOM listener resets PDF zoom to 100% so the document re-fits. Persistence captures whatever zoom the user ends on — so resizing a 150%-zoomed book and closing will persist 100%, not 150%. For this app, zoom is tied closely to "fit this PDF to my current viewport," so reset-on-resize is the less surprising behavior. Documented here so the interaction between the two features is explicit and not mistaken for a persistence bug.

## Implementation Phases

### Phase 1 — PDF zoom persistence

- In `Reader.tsx`, when the book loads, read `reader-zoom-${bookId}` from `localStorage`; clamp to [50, 300]; seed `zoomLevel`.
- After `bookReady`, a follow-up effect applies the seeded zoom to the renderer (extracted `applyZoomToRenderer`) so the PDF visually reflects the seeded value, not just the UI badge.
- Debounced write (500ms trailing) to `reader-zoom-${bookId}` on `zoomLevel` change, PDF-only, guarded on `dbSettingsLoaded` so the initial default-state value doesn't clobber the saved one.

### Phase 2 — Per-book window size persistence

- `openReaderWindow.ts` reads `reader-window-${bookId}` synchronously from `localStorage` before `new WebviewWindow(...)`, clamps to min 700×500, falls back to 1440×960 on missing/invalid values. No API shape change.
- In `Reader.tsx`, when running as a standalone reader window (`appWindow.label.startsWith("reader-")`), subscribe to `appWindow.onResized`. Convert the emitted `PhysicalSize` to logical via `appWindow.scaleFactor()` and debounced-write `{width, height}` to `localStorage`.
- Unsubscribe on effect teardown to avoid leaks across HMR.

## Verification

- [ ] Open book A, resize the window, close. Reopen A → window restores to the last size.
- [ ] Open PDF book A (without resizing), set zoom to 150%, close. Reopen A → still 150%.
- [ ] Open PDF book A at 150%, drag-resize the window (zoom resets to 100% — expected), close. Reopen A → 100% (normalized zoom was persisted, as documented).
- [ ] Book A and book B have independent window sizes and zoom levels.
- [ ] First-time open of a fresh book uses the default 1440×960 and 100%.
- [ ] Rapid dragging of the resize handle doesn't produce dozens of localStorage writes — confirm via DevTools Application panel or a counter that writes debounce.
- [ ] Zoom scrubbed with rapid clicks on zoom-in/out buttons debounces similarly.
- [ ] EPUB book closed and reopened → window size restored; no `reader-zoom-*` key written.
- [ ] Saved width/height below the minimums are clamped up to 700/500 (simulate by manually editing the localStorage entry).
- [ ] Corrupt `reader-zoom-*` value ("foo") or `reader-window-*` JSON falls back to defaults and doesn't crash the reader.
- [ ] Multiple reader windows open at once (books A and B side by side) persist their sizes independently.
