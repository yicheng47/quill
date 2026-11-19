# 347 — Windows Title Bar (Quill-Drawn Window Controls)

**Starting point.** Issue #347. Work in `/Users/jason/repos/yicheng47/quill/.worktrees/feat-347-windows-titlebar` on branch `feat/347-windows-titlebar`, based on `origin/main` `435bc2a`. The [spec](../../features/347-windows-titlebar.md) sets scope, decisions and checks; read it first, together with [AGENTS.md](../../../AGENTS.md).

**Sibling mission.** `01M7RPEWZM8ZWNE72HSEMACDF8` (#342/#343/#345/#346, branch `fix/342-343-reading-status-window-size`) is still open and also touches `electron/main/windows.ts`, `src/pages/Reader.tsx`, `src/components/HomeView.tsx` and `src/index.css` (radius tokens and a global `user-select` rule). Keep this diff to the title bar so a later rebase stays easy. If that PR merges first, rebase onto `origin/main` and use its radius token for the window-control corners. Both qa slots share the one development app: qa checks port 1430 first and waits, through Runner messages, while the other mission's app is running.

**Design.** `quill/desktop/specs/347-windows-titlebar.pen` in `YeelinksCo/yeelinks_design`, board `liOpI`: `Option B1` (Home `DsUPu`, Reader `MK5zb`, control states `gvhJm`) and the before reference `Option Today`. Read it from the working copy at `/Users/jason/repos/yeelinks/yeelinks_design` through the Pencil MCP. It may not be committed yet, so do not pull or reset that repo, and do not edit the `.pen`.

## Deliverables

1. Windows windows (main and reader) use `titleBarStyle: "hidden"`, so neither the native title bar nor the menu bar shows. macOS is unchanged.
2. Window-control IPC (minimize, toggle maximize, close for the sender's window, plus a maximized-state event), exposed through the preload and `src/platform/`.
3. A `WindowControls` component, rendered on Windows only, at the end of `TopBar`'s right cluster and of the reader toolbar's right cluster, after a divider. It follows the spec's sizes, glyphs, restore swap and states, with i18n labels in `en.json` and `zh.json`. The nav pill stays centred.
4. The reader toolbar is a drag region on Windows too. Every button stays no-drag.
5. Menu-only shortcuts still work on Windows: F11, plus Reload and Toggle DevTools in dev builds.
6. The unit tests the spec lists.

## Validation

- **Automated:** `make typecheck`, `make lint`, `npm test`, `npm run electron:build`; CI green on macOS and Windows.
- **Live, `qa` on macOS, `make dev`, iCloud sync off:** `F-347-MAC-UNCHANGED` from the spec, with screenshots of the main window and a reader. Back up `~/Library/Application Support/com.wycstudios.quill-dev` and `com.wycstudios.quill-chromium-dev` first, and restore both byte-for-byte afterwards. Record the run in `docs/tests/runs/347-windows-titlebar-mac.md`.
- **Live, Windows:** the spec's `F-347-WIN-*` checks are left to Jason on a Windows PC. List them in the PR description, and keep `needs-live-test` on the PR until he has run them.

## Authorization

`hydrogen trio`, approved by Jason on 2026-11-19. The crew may commit on `feat/347-windows-titlebar`, folding this brief and the spec into the implementation commit and review/QA fixes into the commits they correct. It may push and open a PR against `main` that closes #347, with the risk label its diff warrants and `needs-live-test`, then drive CI green and stop. Jason merges.
