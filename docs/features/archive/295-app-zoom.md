# 295 — App-Level UI Zoom

GitHub issue: https://github.com/yicheng47/quill/issues/295

## Motivation

Quill has no way to scale its interface. Text, covers, and chrome render at a fixed size, which is cramped on high-DPI displays and hard to read on large monitors at a distance. Every browser and most desktop apps bind Cmd/Ctrl +/-/0 to app zoom; Quill currently swallows those keys in the Reader (PDF content zoom only) and ignores them everywhere else.

Quill's existing zoom controls are *content* zoom: per-book PDF zoom (`reader-zoom-${bookId}`, 50–300% + fit) and EPUB font size. Neither scales the app's own UI — sidebar, toolbars, library grid, settings, chat panel. App zoom is a separate axis and both must keep working independently.

The sibling `runner` project ships this end to end (`src/lib/appZoom.ts`, `src/lib/settings.ts`, `src-tauri/src/commands/window.rs`). Quill can port the same design; the architectural preconditions already match.

## Reference: how runner does it

| Concern | runner's approach |
|---|---|
| Levels | Discrete `ZOOM_STEPS = [0.8, 0.9, 1.0, 1.1, 1.2, 1.3, 1.4, 1.5]` — not free-form. `readAppZoom()` snaps to the nearest step on read (no write-back), so off-step values from older builds or hand-edited storage still resolve to something the UI can step from. |
| Apply path | One function, `applyAppZoom(next)`: persist → sync titlebar → `getCurrentWebview().setZoom(next)` → notify same-window storage listeners. Shared by the Settings stepper and the keyboard shortcuts so they cannot drift. |
| Stepping | `nudgeAppZoom(1 \| -1 \| "reset")` — index into `ZOOM_STEPS`, clamped at both ends; `"reset"` jumps to 1.0. |
| Boot restore | In the root component's mount effect: read zoom, `setZoom`, sync titlebar, and only then invoke `app_ready` to reveal the window — no flash of unzoomed UI. Explicitly *not* wrapped in `requestAnimationFrame`, because macOS pauses rAF for hidden windows and the callback would never fire. |
| Shortcuts | A single `keydown` listener on `window` in the **capture** phase, so focused embedded content (xterm in runner; the foliate iframe in Quill) can't swallow the keys first. `preventDefault()` only on a match, so other Cmd combos still work. |
| Native titlebar | Rust `window_set_titlebar_zoom(window, zoom)` repositions the macOS traffic lights via `objc2_app_kit` `NSWindow::standardWindowButton`, because webview zoom scales the CSS overlay titlebar but not the native buttons. No-ops while fullscreen. Paired with a CSS var for the zoom-adjusted control gutter. |
| Multi-window | Every window runs the same restore effect and resolves "the invoking window" for both commands; the level itself is global. |
| Tests | `src/lib/appZoom.test.ts` covers the apply path, titlebar sync, and the step table. |

Preconditions that already hold in Quill: `visible: false` + an `app_ready` reveal command (`src-tauri/src/commands/app.rs`), `titleBarStyle: "Overlay"` + `hiddenTitle: true` on both window types, and a settings-mirrored-to-localStorage precedent (`theme` / `quill-theme`) for synchronous boot reads.

## Scope

In scope:

- **All windows.** App zoom applies to the main library window and every `reader-{bookId}` window. The level is global, not per-window or per-book; each window restores it on mount.
- **Steps.** Port runner's `[0.8 … 1.5]` table with snap-on-read.
- **Shortcuts.** Cmd/Ctrl `+` zoom in, Cmd/Ctrl `-` zoom out, Cmd/Ctrl `0` reset to 100%. Capture-phase listener.
- **PDF content zoom remap.** The Cmd/Ctrl `+`/`-` handler inside the foliate iframe (`Reader.tsx`) moves to Cmd/Ctrl+Shift `+`/`-`. The toolbar zoom panel, fit mode, and per-book persistence are unchanged.
- **Settings row.** A zoom stepper in Appearance settings following the standard row pattern, sharing `applyAppZoom` with the shortcut path.
- **Persistence.** SQLite `settings` table (`app_zoom`) as the source of truth, mirrored to localStorage for the synchronous boot read — the same split the theme setting already uses.
- **macOS titlebar.** `window_set_titlebar_zoom` Tauri command repositioning the traffic lights; no-op while fullscreen and on non-macOS.

Out of scope:

- Per-book or per-window zoom levels.
- Pinch-to-zoom / trackpad gestures.
- Changing EPUB font-size or PDF fit behavior.
- Zooming the standalone chat window's message content independently of the app.

## Implementation Phases

1. **Zoom module + persistence.** `src/lib/appZoom.ts` with the step table, snap-on-read reader, `applyAppZoom`, and `nudgeAppZoom`. Write to the SQLite setting and mirror to localStorage.
2. **Boot restore.** Apply the stored zoom in the root mount effect of both window types; for the main window, complete it before invoking `app_ready` so the reveal shows already-zoomed UI. No rAF wrapper.
3. **Shortcuts.** Capture-phase `keydown` handler for zoom in/out/reset. Remap the PDF content-zoom branch in `Reader.tsx` to require Shift.
4. **macOS titlebar command.** `window_set_titlebar_zoom` in a Rust window command module, with unit tests for the geometry math and the fullscreen no-op.
5. **Settings + i18n.** Appearance settings stepper row; en/zh strings for the label, hint, and level display.

## Verification

- Cmd `+`/`-` in the library window steps the whole UI (sidebar, grid, toolbar) through the step table and stops at 0.8 / 1.5; Cmd `0` returns to 100%.
- Same shortcuts work in a reader window while the foliate iframe has focus — the iframe does not swallow them.
- Cmd+Shift `+`/`-` still zooms PDF content, independent of app zoom; the toolbar zoom panel and fit mode are unaffected; per-book zoom still persists.
- Zoom set in one window applies to windows opened afterward, and survives an app restart with no flash of unzoomed UI on launch.
- macOS: traffic lights stay aligned with the overlay titlebar at every zoom level; entering/leaving fullscreen doesn't misplace them.
- Appearance settings stepper and the keyboard shortcuts stay in sync in both directions.
- Non-macOS builds compile and zoom works with the titlebar command a no-op.
