# 331 M4 — In-Window Settings, iCloud Sync States, Updates and About

**Starting point.** Issue #331, Mission 4 of the [plan](../331-rebrand/plan.md). Work in `/Volumes/samsung/repos/yicheng47/quill/.worktrees/feat-331-m4-settings-and-updates` on branch `feat/331-m4-settings-and-updates`, based on `origin/main` `cdb13e9` (M2, [#334](https://github.com/yicheng47/quill/pull/334), merged: `TopBar`, quiet update indicator, Dawn Violet Mist main window). Two sibling missions run in parallel; treat their worktrees as another machine's: M3 (`feat/331-m3-main-views`, Home, Highlights, Words, Chats) and M6 (`feat/331-m6-reader-shell`, reader windows). Whichever PR merges second rebases onto `origin/main`.

**Outcome.** `SettingsModal.tsx` is replaced by an in-window Settings view under the `TopBar` with the 4-group, 9-tab `cmp/SettingsNav`, Dawn sections, the complete iCloud Sync UI state machine, the Updates tab with its six hero states and cancel/skip, and About. The plan's Mission 4 section sets scope and behavior; the design wins on visual detail.

**Design.** `quill/desktop/specs/331-rebrand.pen` at `323c398` in `YeelinksCo/yeelinks_design`, checked out at `/Volumes/samsung/repos/yeelinks/yeelinks_design` (pull before opening). Nodes: `eY7n3`, `xEUTG`, `dkFHc` (section 1 only), `MR9Fc`, `a1k3n`, `qbLwo`, `HUr9u`, `MpBgt`, `stXkC`, `tcZmU`, `t47BM`, `HnSex`, `Rh6Ai` (right half), `TL2Mh`; tokens and components in [`design-map.md`](../331-rebrand/design-map.md). Read through the Pencil MCP by node ID; do not edit the `.pen`.

**Decisions (Jason and operator, 2026-11-18).**

- Ownership with M3: M4 owns the Settings view, the gear's active state, `⌘,` and the `open-settings` routing; M3 owns the route list and Home. Keep `TopBar.tsx` edits to the gear and Settings entry.
- `#276` Reset All Data stays out: omit the `DATA` card. `AI Assistant` mounts the existing `AiSettings` unchanged until M5.
- `Appearance`: `Light` active, `System` and `Dark` visible but disabled until M8; `App zoom` stepper.
- `Reading` follows M6's reader decisions: the four page themes (`Original`, `Sepia`, `Gray`, `Dark`, stored IDs `original`, `paper`, `quiet`, `dark` unchanged), `Literata` in the font list, Word spacing kept as a stepper, margins as Narrow/Normal/Wide (0/60/120px) showing the nearest preset without rewriting a custom stored value.
- `General`'s `Display name` inline edit persists through the settings table (today `GeneralSettings.tsx` holds it in component state).
- **iCloud Sync is presentation-only.** Re-skin `LibrarySyncSettings.tsx` onto the Dawn cards and modals and keep every invariant: `sync_enabled` (durable intent) stays separate from `enabled` (session engine), and turning sync off keeps the blocking `Copying library to this Mac…` verification before storage is repointed. No edits under `crates/quill-core/src/sync/` or to the order of any sync, copy or repoint call. If the work needs such a change, stop and ask the operator: it would make the PR `core-review` and Jason must review it before merge.

**Read first.** [`plan.md`](../331-rebrand/plan.md) Mission 4, the [spec](../../features/331-rebrand.md), [`design-map.md`](../331-rebrand/design-map.md) and [AGENTS.md](../../../AGENTS.md). In code: `src/components/SettingsModal.tsx`, `src/components/settings/` (especially `LibrarySyncSettings.tsx`), `src/components/TopBar.tsx`, `src/contexts/UpdateContext.tsx`, `electron/main/updater.ts`, `electron/main/ipc.ts` and `crates/quill-core/src/commands/settings.rs`.

## Deliverables

1. The six deliverables in the plan's Mission 4 section, including `cancelUpdateDownload()` through electron-updater's `CancellationToken`, `skipped_update_version`, `last_update_check_at`, byte progress and the open-books count, with Vitest coverage.
2. Component tests for every `LibrarySyncSettings` state: Off, `!available`, Paused, Error with Retry, Syncing with Cancel, Copying locally, single-device peers, Remove peer and Rebuild.
3. `SettingsModal.tsx` and replaced section chrome are removed with their dead styles and i18n keys; `en.json` and `zh.json` stay in sync.
4. Regression cases whose expected UI changes are updated in `docs/tests/regression/` (at least `SET-01`).

## Validation

- **Automated:** `make typecheck`, `make lint`, `npm test`, `npm run electron:build`, `cargo test --workspace`, `cargo clippy --workspace -- -D warnings`; CI green on macOS and Windows.
- **Live, `qa` in `make dev` on macOS with iCloud sync off.** The dev app is shared with M3's and M6's qa: check port 1430 first, wait for a release if another development Quill is running, and send a release message to the waiting qa when you finish. Back up `~/Library/Application Support/com.wycstudios.quill-dev` and `com.wycstudios.quill-chromium-dev` first and restore them afterwards.
  - `SET-04` (documented successor to `SET-01`; every tab opens and saves, language switch, Appearance cards as decided), `SET-03`, and `APP-03`.
  - `MCP-01`: back up `~/.claude.json` and `~/.codex/config.toml` first and restore both byte-for-byte afterwards.
  - `F-331-SETTINGS-NAV`: gear, `⌘,`, `Esc`, a `TopBar` route exiting Settings, and `open-settings` indicator/cross-window routing landing on the right tab (`electron/main/menu.ts` leaves `APP-03` Help/Settings entry points unchanged while owning macOS `Window → Zoom` via `toggleWindowZoom` to capture pre-zoom bounds before animation).
  - `F-331-UPD-SETTINGS`: the up-to-date hero, Check Now and its dev feedback. The other hero states and packaged macOS bundle icon cache invalidation across upgrades (`electron/main/macIconRefresh.ts`) are covered by tests and left to Jason (`needs-live-test`) on the next nightly.
  - `F-331-SYNC-UI`: the Off and `!available` states as they appear with sync off, plus opening the Turn on iCloud Sync confirmation to verify full-window portal containment and clicking Cancel with sync remaining off. States that need sync on are covered by component tests and left to Jason.
  - Main window bounds persistence (`electron/main/windowState.ts`, `electron/main/windows.ts`, `electron/main/menu.ts`): move/resize (both native `Window → Move & Resize` tiling followed by `Window → Zoom` and completed manual drag-resize `'resized'`) the main window, quit with `⌘Q`, relaunch, and verify it reopens at the same position and size; repeat maximized (including unzoom after relaunch) and fullscreen, plus verify macOS `Window` menu items (`Move & Resize` and open windows) and focused reader `Window → Zoom`. Back up and restore `~/Library/Application Support/com.wycstudios.quill-chromium-dev` (as above). (`Option`+green-button / titlebar double-click within <250 ms after non-drag tiling bypasses both `toggleWindowZoom` and `'resized'` due to lack of an Electron pre-zoom hook.)
  - Compare each changed screen against its design node and screenshot it.
- Record the run in `docs/tests/runs/331-m4-settings-and-updates-mac.md`. The Windows live smoke is left to Jason.

## Authorization

`hydrogen trio`, started by the operator under Jason's standing approval for #331 (2026-11-18). The crew may commit on `feat/331-m4-settings-and-updates` (folding this brief into an implementation commit), push, and open a PR against `main` labeled `needs-live-test` with the risk label its diff warrants, then drive CI green and stop; the operator merges.
