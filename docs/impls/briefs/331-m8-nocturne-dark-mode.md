# 331 M8 — Nocturne Dark Mode Across the Main Window

**Starting point.** Issue #331, Mission 8 of the [plan](../331-rebrand/plan.md), the last mission; its PR completes #331. Work in `/Volumes/samsung/repos/yicheng47/quill/.worktrees/feat-331-m8-nocturne-dark-mode` on branch `feat/331-m8-nocturne-dark-mode`, based on `origin/main` `c235ba7`. M2–M7 have merged. `src/index.css` already has a `.dawn.dark` layer, and reader windows already use it on the `Dark` page (M6, M7); `src/App.tsx` (`applyTheme`) keeps the main window light, `Settings → Appearance` (`AppearanceSettings.tsx`) offers Light only, and `electron/main/windows.ts` / `ipc.ts` already map themes to window background colours. No sibling mission is running.

**Outcome.** `Settings → Appearance` offers `System`, `Light` (Dawn) and `Dark` (Nocturne). The main window and everything it shows (TopBar, Home, Library, Highlights, Words, Chats, Settings, `⌘K`, menus, popovers, modals, toasts and the update popover) render in Nocturne when the app is dark, switch live, and launch without a white or light flash. The plan's Mission 8 section sets scope; the design wins on visual detail.

**Design.** `quill/desktop/specs/331-rebrand.pen` at `fd7c334` in `YeelinksCo/yeelinks_design`, checked out at `/Volumes/samsung/repos/yeelinks/yeelinks_design` (pull before opening). Nodes: `q62MgQ` (Home), `Y803E5` (Library), `T1qAJe` (Reader, Dark page), `CPGY5` (Settings → Appearance with `Dark` active). Every board has a `dark` theme axis: read any light board with `theme: {mode: "dark"}` for surfaces without a dedicated dark board. The Nocturne token values are in [`design-map.md`](../331-rebrand/design-map.md) §3 and in the `.pen` variables. Read through the Pencil MCP; do not edit the `.pen`.

**Decisions (operator, 2026-11-19, under Jason's delegation).**

- **Reader windows follow their page theme only.** The app theme does not change a reader: `Original` keeps the Dawn shell and light paper even when the app is dark, and the `Dark` page keeps Nocturne whatever the app theme. This settles the plan's open question on `T1qAJe`; Jason can reverse it after seeing the build.
- **Dark background keeps the design's three twilight glows** (`bg-glow-violet` `#42358A4D`, `bg-glow-peach` `#59352E33`, `bg-glow-mint` `#1D474233` over `#12111A` → `#17151F`). The Violet Mist decision removed the peach and mint glows from Dawn only.
- `System` follows the OS appearance live (`prefers-color-scheme` in the renderer, `nativeTheme` in main) and is the default for profiles with no stored theme only if that matches today's stored-value handling; do not migrate or rewrite stored theme values.
- Reuse the existing `.dawn.dark` tokens; add only what a main-window surface is missing. All colours go through tokens, never per-component dark literals. The 12px control radius, the page-theme reader materials and the 16px chat text stay as they are.
- `SET-01` is retired. The gate uses `SET-02`, `SET-04` (update its Appearance wording now that Dark is offered) and `APP-01`.

**Read first.** [`plan.md`](../331-rebrand/plan.md) Mission 8, the [spec](../../features/331-rebrand.md), [`design-map.md`](../331-rebrand/design-map.md) and [AGENTS.md](../../../AGENTS.md). In code: `src/App.tsx` and `App.theme.test.tsx`, `src/components/settings/AppearanceSettings.tsx`, `src/index.css` (`.dawn.dark`, `.dawn-atmosphere`), `electron/main/windows.ts`, `electron/main/ipc.ts` and their tests.

## Deliverables

1. The four deliverables in the plan's Mission 8 section, with deliverable 3 settled by the decision above.
2. Every main-window surface listed in Outcome is legible in Nocturne: no light-only literal left behind (search for hard-coded light colours, `bg-white`, `text-black` and `#FFF`-style values in `src/`).
3. `en.json` and `zh.json` stay in sync; regression cases whose expected UI changes are updated in `docs/tests/regression/`.
4. Tests: theme resolution (`System` / `Light` / `Dark`, OS change while on `System`), the main window's `.dark` class, the background colour sent to Electron on boot and on toggle, and a reader window that keeps its page theme while the app theme changes.

## Validation

- **Automated:** `make typecheck`, `make lint`, `npm test`, `npm run electron:build`, `cargo test --workspace`, `cargo clippy --workspace -- -D warnings`; CI green on macOS and Windows.
- **Live, `qa` in `make dev` on macOS with iCloud sync off.** Check port 1430 first and wait if another development Quill runs. Back up `~/Library/Application Support/com.wycstudios.quill-dev` and `com.wycstudios.quill-chromium-dev`, and restore both byte-for-byte afterwards. Changing the macOS system appearance for the `System` check is allowed; restore it to its original value afterwards.
  - `SET-02`: the theme survives a restart with no flash of the wrong theme at launch, for both Light and Dark.
  - `SET-04` (updated): Appearance switches between `System`, `Light` and `Dark` live, with the active border and check badge on the chosen card (`CPGY5`).
  - `APP-01`: launch in Dark shows no white flash.
  - `F-331-DARK`: Home, Library, Highlights, Words, Chats, Settings, `⌘K`, a context menu, a modal and the update popover in Nocturne against `q62MgQ`, `Y803E5`, `CPGY5` and the dark axis of their light boards; screenshot each.
  - `F-331-READER-THEME`: with the app dark, an `Original` reader stays Dawn and light, and a `Dark` reader is Nocturne; switching the app theme with a reader open leaves the reader's page theme in charge.
- Record the run in `docs/tests/runs/331-m8-nocturne-dark-mode-mac.md`. The Windows live smoke is left to Jason.

## Authorization

`hydrogen trio`, started by the operator under Jason's standing approval for #331 (2026-11-18). The crew may commit on `feat/331-m8-nocturne-dark-mode` (folding this brief into an implementation commit, and folding review and QA fixes into the commits they correct), push, and open a PR against `main` that closes #331, labeled `needs-live-test` with the risk label its diff warrants, then drive CI green and stop; the operator merges.
