# 331 — Desktop Rebrand (Dawn & Nocturne Design System & Shell)

GitHub issue: https://github.com/yicheng47/quill/issues/331

Program record: [`docs/impls/331-rebrand/README.md`](../impls/331-rebrand/README.md). Plan: [`docs/impls/331-rebrand/plan.md`](../impls/331-rebrand/plan.md). Design map: [`docs/impls/331-rebrand/design-map.md`](../impls/331-rebrand/design-map.md). Design source: `quill/desktop/specs/331-rebrand.pen` (`fd7c334` in `YeelinksCo/yeelinks_design`). Regression suite: [`docs/tests/regression/`](../tests/regression/README.md).

## Motivation

After completing the 2.0 Electron shell migration (#327), Quill still carries its Tauri-era interface: a feather icon, a flat zinc-and-deep-purple palette, a resizable left sidebar, a centered modal for settings, an interrupting update toast, and legacy reader panels/popovers. That chrome treats Quill mainly as a file shelf rather than a calm reading workspace where passages, saved words, and conversations stay connected across books.

The `#331` rebrand introduces the **Dawn** (light) and **Nocturne** (dark) visual identity across the entire desktop app — semantic tokens, brand icons, a unified top-bar shell with global `⌘K` search, five first-class main-window views (`Home`, `Library`, `Highlights`, `Words`, `Chats`), end-to-end collection creation and book-assignment workflows, a grouped 9-tab in-window `Settings` surface covering quiet background updates, full iCloud Sync states, and AI authentication (`#325` session-expiry recovery), plus a floating paper-on-Dawn/Nocturne `Reader` with redesigned islands, inline popovers, themes, PDF spread controls, and iCloud download state.

## Scope

In scope across the signed-off frames and components in `quill/desktop/specs/331-rebrand.pen` (full node inventory in [`design-map.md`](../impls/331-rebrand/design-map.md)):

- **Brand & Dawn/Nocturne foundations (`t405CC`, `Owck6`, `YJzBT`, `Qn3yN`):** Lens Q mark on a violet gradient tile across `build/icons/*`, `assets/icon.png`, and `src/components/QuillLogo.tsx`; Dawn "Violet Mist" atmosphere (`#EEEBF8` → `#F7F5F3` plus one soft violet radial glow) paired with Nocturne dark tokens (`#12111A` → `#17151F`, `#8477EE` accent, `#1E1D29CC` dark glass); frosted glass surfaces (`surface-glass`, `surface-inset`, `surface-chip`, `surface-solid`); 5 reader highlight colors; bundled offline `Geist`, `Geist Mono`, and `Literata` fonts; and the 29 `cmp/*` reusable UI primitives.
- **TopBar shell, Global Search (`⌘K`), Import states & quiet background updates (`pL47g`, `CjQ94`, `BC0DA`, `BUxUo`, `J6aW1P`, `Rh6Ai`):** 71px top bar replacing `Sidebar.tsx` and `UpdateToast.tsx`, housing macOS traffic lights + Quill lockup + sync `%` chip + quiet 24px background-update indicator (`Available` click downloads immediately, `Downloading`/`Verifying` stay non-interrupting, only `Ready` opens a 264px popover, `Failed` opens `Settings → Updates`), centered 5-tab pill navigation (`Home`, `Library`, `Highlights`, `Words`, `Chats`), right-side `Search` (`⌘K` Command Search Palette across `All · Books · Highlights · Words · Chats`), `Import` (native drag-and-drop overlay `BC0DA`, centered `>5s` slow-file progress `BUxUo`, and top non-blocking error toast `J6aW1P`), and `Settings` (`⌘,`) icon button.
- **Main-window views:**
  - **Home (`m2srt`, `XkjMq` / `OqN9H`):** Bento dashboard (`Now reading` with progress %, `~1.5 min/page` time-left estimate when `pages > 0`, latest highlight, `Continue reading`, and `Ask about this part`; `Saved words`; `Last conversation`; `Library` shelf; `Also reading` + `Collections` chips), plus the first-launch empty Home (`XkjMq`) with tactile miniature UI specimens (`OqN9H`).
  - **Library & Collections (`RhsF8`, `A03E8`, `Zzvta`, `F7B1gQ`, `r532a5`):** Single header row (`All / Reading / Finished / Unread` segments with counts, `Collections` pill dropdown, Grid/List toggle) over the 6-up `BookCard` grid (`RhsF8`) and rich `List` rows (`A03E8`, including undownloaded iCloud books with `Download from iCloud`); end-to-end **Add New Collection** flow inside `Collections` popover (`Zzvta`: drag-to-reorder, inline rename, non-destructive delete confirmation, and inline `NEW COLLECTION` form), right-click `BookContextMenu` (`F7B1gQ`: multi-collection checkmarks + inline `+ NEW COLLECTION & ADD BOOK` quick-create), empty-collection `Add Books from Library…` multi-select picker modal (`r532a5`), `Edit Book Info` modal, `Delete Book` confirmation, and no-match filter state.
  - **Highlights (`eKFrn`, `zWiKF`, `SiLV6`, `JSI0p`):** Book-scoped and `All highlights` cross-book stream (`zWiKF`) with 4-color swatch filter pill, text filter, `Newest` / `Oldest` / `Book chapter order` sort (`SiLV6`), hover recolor/note/copy/open/delete bar, inline margin-note editor (`SiLV6`), delete confirmation popover, and empty state (`JSI0p`), backed by `list_all_highlights` and `get_highlight_counts`.
  - **Words (`rylLh`, `A4GWjG`, `l6BCnh`, `DjXY3`, closes #322):** Master-detail view with month-grouped (`rylLh`) and `A–Z` alphabetical (`A4GWjG`) modes, per-book count filter popover, inline `Meaning`, `In context` (highlighted word + `Go to passage`), `In this passage`, 3-second 2-click `Click again to delete` confirmation (`l6BCnh`), filtered no-match state, and empty state (`DjXY3`).
  - **Chats (`ETt8K`, `BsJqG`, `S4d1bF`, `y4fAJ`):** Month-grouped master-detail view with per-book count filter (`BsJqG`), inline header title rename, thread `⋯` / context menu (`Rename`, `Open in book`, `Copy as Markdown`, `Delete`), `Generating title…` header spinner + `Delete conversation?` confirmation (`S4d1bF`), quoted passage + `Open in book`, streaming composer, and empty state (`y4fAJ`).
- **In-window Settings, iCloud Sync, Updates & AI Auth (`eY7n3`, `xEUTG`, `MR9Fc`, `a1k3n`, `k9Vj9`, `XIfpn`, `lXiaG`, `o04NH`, `qbLwo`, `HUr9u`, `MpBgt`, `stXkC`, `tcZmU`, `t47BM`, `HnSex`, `Rh6Ai`, `TL2Mh`):**
  - 4-group, 9-tab `cmp/SettingsNav` (`APP`: `General`, `Appearance`, `Reading`; `AI`: `AI Assistant`, `Tools`; `INTEGRATIONS`: `iCloud Sync`, `MCP`; `SYSTEM`: `Updates`, `About`).
  - `General` (`xEUTG` + inline `Display name` edit from `dkFHc`, `Interface language`), `Appearance` (`MR9Fc` / `CPGY5`: `System`, `Light` Dawn, `Dark` Nocturne + `App zoom`), `Reading` (`a1k3n`), `Tools` (`qbLwo`), and `MCP` (`t47BM`).
  - Complete `iCloud Sync` state machine (`HUr9u`, `MpBgt`, `stXkC`, `tcZmU`): healthy synced + cross-platform `DEVICES` + `Rebuild from iCloud`; local-only `Off` + `!available` macOS not-signed-in warning; offline queue-only `Paused` keeping durable `sync_enabled` toggle ON + binary-move error `Retry` + manifest-cached offline devices + disabled rebuild; active replay progress + `Cancel sync`; single-device empty peers; `Turn on`/`Turn off` confirmations; blocking `Copying library to this Mac…` local file verification modal; and Cancel-focused `Remove Device` + `Rebuild Library` confirmations.
  - Dedicated `Updates` tab (`HnSex` + `Rh6Ai` 6 hero states) and `About` (`TL2Mh`: platform pill, `DIAGNOSTICS` log reveal, `LINKS & LICENSE`).
  - Complete `AI Assistant` & `AI Auth` lifecycle (`k9Vj9`, `XIfpn`, `lXiaG`, `o04NH`), including `#325` `AI_REAUTH_REQUIRED` session-expiry recovery (closes #325).
- **Reader surface (`ECLAp`, `yvlbP`, `U3KZf8`, `pB71W`, `rdcDH`, `xqqVr`, `ZpzpR`, `GWA41`, `Zd3OK`, `N4bEY`, `ZKLDp`, `IjTTv`, `T1qAJe`):**
  - Floating Paper page island (`Original`, `Sepia`, `Gray`, `Dark` `#1B1B1F`), 64px toolbar, floating `Progress pill` + `← Back to p. N` jump-back pill, two-page PDF spread + zoom/fit pill (`ZKLDp`), and `Book in iCloud` download view (`IjTTv`).
  - Reader shell follows the page theme (`luJ5A`): `Original` → Dawn, `Sepia` → parchment, `Gray` → gray, `Dark` → Nocturne, independent of the app theme. New reader windows open cascaded diagonally from the main window.
  - Left `Contents` island (`U3KZf8`), right `Highlights / Bookmarks` island + inline highlight toolbar (`pB71W`, `GWA41`), right `Words in Book` island (`xqqVr`), and `Typography` (`Aa`) popover (`Zd3OK`, `ZKLDp`).
  - Inline `Selection Menu` (`rdcDH`), floating `Look Up`, `Explain`, and `Translate` popovers (`xqqVr`, `ZpzpR`, `GWA41`), and the `Ask Quill` chat island + thread switcher (`ECLAp`, `ZpzpR`, `N4bEY`).
- **Nocturne Dark Mode (`q62MgQ`, `Y803E5`, `T1qAJe`, `CPGY5`):** Semantic dark token mode across main and reader shells, shipped as the final rebrand slice once Dawn Light surfaces are complete.

Out of scope for `#331`:

- `#276` `Reset all data` (`dkFHc` reset modals and `reset_app_data` backend wipe): designed alongside `General` in `dkFHc` for visual alignment, but shipped separately under [#276](https://github.com/yicheng47/quill/issues/276) as its own `core-review` PR rather than bundled into M4.
- Changes to the iCloud sync event-log format or SQLite schema migrations.

## Implementation Phases

Eight sequential Runner missions across four phases, each merging directly into `main` with `main` kept buildable and visually coherent at every step (see [`docs/impls/331-rebrand/plan.md`](../impls/331-rebrand/plan.md)):

1. **Phase 1 — Foundations & Main Shell:** **M1** (Dawn tokens, fonts, Lens Q icons, `cmp/*` primitives, highlight & unread queries) → **M2** (`TopBar`, quiet update indicator, `⌘K` Books search, `Library` Grid/List, end-to-end `Collections` & import states).
2. **Phase 2 — Main Views, Settings & Auth:** **M3** (`Home` bento + empty specimen state, full `⌘K` search, `Highlights`, `Words` #322, and `Chats`) → **M4** (9-tab in-window `Settings`, full `iCloud Sync` UI states, `Updates` pane + updater IPC, and `About`) → **M5** (`AI Assistant`, `AI Auth` lifecycle, and `#325` `AI_REAUTH_REQUIRED`).
3. **Phase 3 — Reader Surface & Reading AI:** **M6** (`Reader` Dawn chrome, Paper/Sepia/Dark/PDF surfaces, `Progress pill`, `Typography` popover, `Contents`, `Highlights / Bookmarks` island, and `Book in iCloud`) → **M7** (`Selection Menu`, `Look Up` / `Explain` / `Translate` popovers, `Words in Book` island, and `Ask Quill` island).
4. **Phase 4 — Nocturne Dark Mode:** **M8** (`.dawn.dark` semantic token variables, `Appearance` `System` / `Light` / `Dark` activation, window background sync, and cross-surface dark verification).

## Verification

Each mission runs automated checks (`cargo test --workspace`, `cargo clippy --workspace -- -D warnings`, `make typecheck`, `make lint`, `npm test`, `npm run electron:build`, CI on macOS & Windows) plus targeted live checks in the Electron development app (`make dev`, iCloud sync strictly off) mapped per mission in [`docs/impls/331-rebrand/plan.md`](../impls/331-rebrand/plan.md).
