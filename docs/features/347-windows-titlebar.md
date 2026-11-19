# 347 — Windows Title Bar (Quill-Drawn Window Controls)

**Issue:** #347. **Design:** `quill/desktop/specs/347-windows-titlebar.pen` in `YeelinksCo/yeelinks_design`, board `liOpI`: `Option B1` (Home `DsUPu`, Reader `MK5zb`, control states `gvhJm`), with `Option Today` (`cnXer`, `SEiBH`) kept as the before reference. Jason chose B1 on 2026-11-19.

## Problem

On Windows every Quill window uses Electron's default frame: a native title bar (icon, title, minimize/maximize/close) and the native menu bar (File · Edit · View · Window · Help) sit above Quill's own Dawn header, which is the 71px `TopBar` in the main window and the 64px toolbar in readers. That's about 54px of white chrome that ignores Dawn, Nocturne and the reader page themes. macOS doesn't have the problem: it uses `titleBarStyle: "hiddenInset"` and draws the header under the traffic lights.

## Decision (B1, divided cluster)

- **No native title bar or menu bar on Windows.** Quill's header is the title bar. The window keeps its native resize border, shadow and Windows 11 rounded corners.
- **Quill draws the window controls.** Minimize, maximize/restore and close sit at the end of the header's right cluster, after a 1px × 20px `border-subtle` divider. They're 32 × 32 glyph buttons with no glass fill, the icon-button corner radius (the same radius token the header's icon buttons use, so they follow any future button-radius change), a 4px gap, and `text-secondary` lucide glyphs: `minus` (15), `square` (12) and `x` (15). While the window is maximized, the maximize glyph becomes a restore glyph (two overlapping squares, e.g. lucide `copy`).
- **States** (`gvhJm`): hover fills the button with `border-subtle`. Close hover is Windows red `#C42B1C` with a white glyph, in every theme. Focus-visible uses the standard focus ring. Each button has an `aria-label` and `title` (i18n keys in `en.json` and `zh.json`).
- **Main window:** the controls are part of `TopBar`'s right cluster after Search, Import and Settings. The nav pill stays centred on the window, because the left and right clusters keep equal widths.
- **Reader window:** the controls follow the toolbar's right cluster (Typography, Bookmarks, Translate, Ask) after the same divider. The reader page themes recolour them through the same tokens, so they work on the Original, Sepia, Gray and Dark pages.
- **Dragging:** the main header and the reader toolbar are drag regions on Windows as well as macOS. Every button stays no-drag. Double-clicking an empty part of the header maximizes or restores, and dragging to a screen edge snaps (both native with an app drag region).
- **The menu bar's items:** Help → Show Logs is covered by Settings → About → Diagnostics, Help → Check for Updates by Settings → Updates, and File → Close/Exit by the close button. Keyboard shortcuts that only reached the app through the menu (F11 full screen, and the dev-only Reload and Toggle DevTools) must still work. If hiding the menu bar disables their accelerators, handle them another way, for example with `before-input-event`.
- **Out of scope:** the Windows 11 snap-layout flyout on maximize hover. Quill-drawn controls don't get it; Win+Arrow and edge snapping still work. macOS behaviour is unchanged.

## Implementation notes

- `electron/main/windows.ts` `createWindow`: on `win32`, use `titleBarStyle: "hidden"` with no `titleBarOverlay`, so Quill draws the controls. macOS keeps `hiddenInset` + `trafficLightPosition`.
- IPC: add window-control actions (minimize, toggle maximize, close) for the sender's own window, plus a maximized/restored event so the glyph tracks state, including a maximize triggered by double-click or snap. Expose them through `electron/preload/index.ts` and `src/platform/`.
- Renderer: add a small `WindowControls` component rendered only on Windows (add an `isWindows()` helper next to `isMacOS()` in `src/lib/platformEnv.ts`), used in `TopBar.tsx` and in the reader toolbar in `Reader.tsx`, and enable `data-drag-region` on the reader toolbar for Windows.
- Leave the header layout untouched in full screen (F11). The controls can stay; nothing needs to hide them.

## Validation

- **Automated:** unit tests for the `win32` window options in `windows.test.ts`, the IPC handlers, `WindowControls` rendering only on Windows, the maximize/restore glyph swap, the close-hover class, and TopBar/Reader rendering no controls on macOS. Run `make typecheck`, `make lint`, `npm test` and `npm run electron:build`. CI must pass on macOS and Windows.
- **Live, macOS (`qa`), `F-347-MAC-UNCHANGED`:** in `make dev`, the main window and a reader look exactly as before: traffic lights in place, no window controls drawn, the nav pill centred, header drag still working, and no extra menu changes. This is the regression the diff could cause on the platform qa can run.
- **Live, Windows (left to Jason on a Windows PC, `needs-live-test` until done):**
  - `F-347-WIN-CHROME`: no native title bar or menu bar on the main window or a reader; controls match `DsUPu` / `MK5zb`.
  - `F-347-WIN-CONTROLS`: minimize, maximize/restore (the glyph swaps) and close all work in both windows. The hover and close-hover states match `gvhJm`.
  - `F-347-WIN-DRAG`: drag the window by the header, double-click to maximize/restore, and drag to an edge to snap. Buttons don't start a drag.
  - `F-347-WIN-THEMES`: controls stay legible in Nocturne and on the Sepia, Gray and Dark reader pages.
  - `F-347-WIN-SHORTCUTS`: F11 toggles full screen. In a dev build, Ctrl+R reloads and Ctrl+Shift+I opens DevTools.
