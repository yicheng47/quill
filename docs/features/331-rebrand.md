# 331 — Desktop Rebrand (Dawn Design System & Shell)

GitHub issue: https://github.com/yicheng47/quill/issues/331

Plan: [`docs/impls/331-rebrand/plan.md`](../impls/331-rebrand/plan.md). Design source: `quill/desktop/specs/331-rebrand.pen` in `YeelinksCo/yeelinks_design`. Regression suite: [`docs/tests/regression/`](../tests/regression/README.md).

## Motivation

After completing the 2.0 Electron shell migration (#327), Quill still carries its Tauri-era interface: a feather icon, a flat zinc-and-deep-purple palette, a resizable left sidebar, a centered modal for settings, an interrupting update toast, and legacy reader panels/popovers. That chrome treats Quill mainly as a file shelf rather than a calm reading workspace where passages, saved words, and conversations stay connected across books.

The `#331` rebrand introduces the **Dawn** visual identity across the entire desktop app — foundations, brand icons, a unified top-bar shell, five first-class main-window views (`Home`, `Library`, `Highlights`, `Words`, `Chats`), a grouped 9-tab in-window `Settings` surface with quiet background updates and full AI authentication states (including `#325` session-expiry recovery), and a floating paper-on-Dawn `Reader` with redesigned islands, inline popovers, themes, PDF spread controls, and iCloud download state.

## Scope

In scope across all 30 frames in `quill/desktop/specs/331-rebrand.pen`:

- **Brand & Dawn foundations (`t405CC`, `Owck6`, `YJzBT`, `Qn3yN`):** Lens Q mark on a violet gradient tile across `build/icons/*`, `assets/icon.png`, and `src/components/QuillLogo.tsx`; Dawn lavender-to-peach atmosphere (`#ECE8FA` → `#F7F1EE` plus violet, peach, and mint radial glows); frosted glass surfaces (`surface-glass`, `surface-inset`, `surface-chip`) with violet-tinted shadows; `#6F63D2` dusty violet primary accent and `#E4DEFF` tonal selection; 5 translucent highlight colors; bundled offline `Geist`, `Geist Mono`, and `Literata` fonts; and the core `cmp/*` reusable UI primitives (`cmp/SettingsNav` `eY7n3` lands in M4 with the Settings shell).
- **TopBar shell & quiet background updates (`pL47g`, `Rh6Ai`):** 71px top bar replacing `Sidebar.tsx` and `UpdateToast.tsx`, housing macOS traffic lights + Quill lockup + quiet 24px background-update indicator (`Available` click downloads immediately, `Downloading`/`Verifying` stay non-interrupting, only `Ready` opens a 264px popover, `Failed` opens `Settings → Updates`), centered 5-tab pill navigation (`Home`, `Library`, `Highlights`, `Words`, `Chats`), and right-side `Search` (`⌘F`), `Import`, and `Settings` (`⌘,`) icon buttons.
- **Main-window views (`m2srt`, `RhsF8`, `eKFrn`, `rylLh`, `ETt8K`):**
  - **Home (`m2srt`):** Bento dashboard (`Now reading` with progress %, `~1.5 min/page` time-left estimate when `pages > 0`, latest highlight, `Continue reading`, and `Ask about this part`; `Saved words`; `Last conversation`; `Library` shelf; `Also reading` + `Collections` chips).
  - **Library (`RhsF8`):** Single header row (`All / Reading / Finished / Unread` segments with counts, `Collections` dropdown with collection CRUD, Grid/List toggle) over the 6-up `BookCard` grid and `ListRow/Book`.
  - **Highlights (`eKFrn`):** Cross-book highlights view grouped/filterable by book (`All highlights` + per-book rail with counts), `Newest` / `Oldest` sort, and `Ask`, `Copy`, and `Go to` actions, backed by `list_all_highlights` and `get_highlight_counts`.
  - **Words (`rylLh`, closes #322):** Month-grouped master-detail view with book filter, sort, and inline `Meaning`, `In context` (highlighted word + `Go to passage`), `In this passage`, and delete.
  - **Chats (`ETt8K`):** Month-grouped master-detail view with book filter, quoted passage + `Open in book`, thread bubbles, and live `Continue the conversation…` streaming composer.
- **In-window Settings, Updates & AI Auth (`eY7n3`, `xEUTG`, `MR9Fc`, `a1k3n`, `k9Vj9`, `XIfpn`, `lXiaG`, `o04NH`, `qbLwo`, `HUr9u`, `t47BM`, `HnSex`, `Rh6Ai`, `TL2Mh`):**
  - 4-group, 9-tab `cmp/SettingsNav` (`APP`: `General`, `Appearance`, `Reading`; `AI`: `AI Assistant`, `Tools`; `INTEGRATIONS`: `iCloud Sync`, `MCP`; `SYSTEM`: `Updates`, `About`).
  - Dedicated `Updates` tab (`HnSex` + `Rh6Ai` hero card states: checking, available + skip version + download, downloading + progress + cancel, ready + open-books count + restart, failed + retry/downloads).
  - `About` (`TL2Mh`) carrying version + platform pill (`macOS · arm64`), `DIAGNOSTICS` (`Reveal in Finder`), and `LINKS & LICENSE`.
  - Complete `AI Assistant` & `AI Auth` lifecycle (`k9Vj9`, `XIfpn`, `lXiaG`, `o04NH`): ChatGPT OAuth connected/signed-out/waiting-with-cancel/failed-retry states, sign-out confirmation dialog, API-key masked credential + temperature controls, local Ollama server status + keep-alive, and `#325` `AI_REAUTH_REQUIRED` session-expiry prompt cards (closes #325).
  - Dawn Light only on the main window (`Appearance` keeps `Light` active and `System`/`Dark` disabled with *"Light is Dawn. Dark is designed next."*).
- **Reader surface (`ECLAp`, `yvlbP`, `U3KZf8`, `pB71W`, `rdcDH`, `xqqVr`, `ZpzpR`, `GWA41`, `Zd3OK`, `N4bEY`, `ZKLDp`, `IjTTv`):**
  - Floating Paper page island on Dawn (`Original`, `Sepia`, `Gray`, `Dark` `#1B1B1F`), 64px toolbar, floating bottom `Progress pill` + `← Back to p. N` jump-back pill, two-page PDF spread + zoom/fit pill (`ZKLDp`), and `Book in iCloud` download view (`IjTTv`).
  - Left `Contents` island (`U3KZf8`), right `Highlights / Bookmarks` island + inline highlight toolbar (`pB71W`, `GWA41`), right `Words in Book` island (`xqqVr`), and `Typography` (`Aa`) popover (`Zd3OK`, `ZKLDp`).
  - Inline `Selection Menu` (`rdcDH`), floating `Look Up`, `Explain`, and `Translate` popovers (`xqqVr`, `ZpzpR`, `GWA41`), and the `Ask Quill` chat island (`ECLAp`, `ZpzpR`, `N4bEY`: starter prompts, quoted passage card, thread switcher, follow-up chips, model footer, and `#325` session-expired / unconfigured cards).

Out of scope:

- Dark Dawn main-window palette (deferred follow-up; Reader's `Dark` page theme `#1B1B1F` on Dawn *is* in scope under `N4bEY`).
- Changes to the iCloud sync event format or SQLite schema migrations unless `.quillbackup` requires none.

## Implementation Phases

Seven sequential Runner missions across three phases, each merging directly into `main` with `main` kept buildable and visually coherent at every step (see [`docs/impls/331-rebrand/plan.md`](../impls/331-rebrand/plan.md)):

1. **Phase 1 — Foundations & Main Shell:** **M1** (Dawn tokens, fonts, Lens Q icons, `cmp/*` primitives, highlight & unread queries) → **M2** (`TopBar` shell, quiet update indicator/popover, and `Library`).
2. **Phase 2 — Main Views, Settings & Auth:** **M3** (`Home` bento, `Highlights`, `Words`, and `Chats`) → **M4** (9-tab in-window `Settings`, `Updates` pane + updater IPC, and `About` diagnostics) → **M5** (`AI Assistant`, `AI Auth` lifecycle, and `#325` `AI_REAUTH_REQUIRED`).
3. **Phase 3 — Reader Surface & Reading AI:** **M6** (`Reader` Dawn chrome, Paper/Sepia/Dark/PDF surfaces, `Progress pill`, `Typography` popover, `Contents`, `Highlights / Bookmarks` island, and `Book in iCloud`) → **M7** (`Selection Menu`, `Look Up` / `Explain` / `Translate` popovers, `Words in Book` island, and `Ask Quill` island).

## Verification

Each mission runs automated checks (`cargo test --workspace`, `cargo clippy --workspace -- -D warnings`, `make typecheck`, `make lint`, `npm test`, `npm run electron:build`, CI on macOS & Windows) plus targeted live checks in the Electron development app (`make dev`, iCloud sync strictly off) mapped per mission in [`docs/impls/331-rebrand/plan.md`](../impls/331-rebrand/plan.md).
