# 331 M3 — Home Bento, Full ⌘K, Highlights, Words (#322) and Chats

**Starting point.** Issue #331, Mission 3 of the [plan](../331-rebrand/plan.md); closes #322. Work in `/Volumes/samsung/repos/yicheng47/quill/.worktrees/feat-331-m3-main-views` on branch `feat/331-m3-main-views`, based on `origin/main` `cdb13e9` (M2, [#334](https://github.com/yicheng47/quill/pull/334), merged: `TopBar`, `CommandSearchModal`, Dawn Violet Mist main window, Library and collections). Two sibling missions run in parallel; treat their worktrees as another machine's: M4 (`feat/331-m4-settings-and-updates`, in-window Settings) and M6 (`feat/331-m6-reader-shell`, reader windows). Whichever PR merges second rebases onto `origin/main`.

**Outcome.** All five `TopBar` tabs are live with `Home` as the default route. `⌘K` searches across `All · Books · Highlights · Words · Chats`. Home, Highlights, Words and Chats are rebuilt with their filter, inline-edit, delete and empty states. The plan's Mission 3 section sets scope and behavior; the design wins on visual detail.

**Design.** `quill/desktop/specs/331-rebrand.pen` at `323c398` in `YeelinksCo/yeelinks_design`, checked out at `/Volumes/samsung/repos/yeelinks/yeelinks_design` (pull before opening). Nodes: `m2srt`, `XkjMq` (`OqN9H`), `CjQ94`, `eKFrn`, `zWiKF`, `SiLV6`, `JSI0p`, `rylLh`, `A4GWjG`, `l6BCnh`, `DjXY3`, `ETt8K`, `BsJqG`, `S4d1bF`, `y4fAJ`; tokens and components in [`design-map.md`](../331-rebrand/design-map.md). Read through the Pencil MCP by node ID; do not edit the `.pen`.

**Decisions (operator, 2026-11-18, under Jason's delegation).**

- Ownership with M4: M3 adds the `home` and `highlights` routes to `MainRoute` and makes `home` the default. M4 owns the Settings view and the gear's active state. Keep `TopBar.tsx` edits to the route list and search scopes.
- Highlights' "Book chapter order" groups by book, then orders by position: foliate-js's `compare` from `public/foliate-js/epubcfi.js` for EPUB CFIs, page order for PDF. Do it client-side unless a Rust sort is simpler; `list_all_highlights` already filters and sorts by date. Do not change the foliate submodule.
- Words' pronunciation button uses the system speech API (`speechSynthesis`) and is hidden when no voice is available. IPA and part of speech keep coming from the saved definition text (`VocabDetailModal.tsx` parsing); no schema change.
- `⌘K` combines the existing search paths (`list_books`, `list_all_highlights`, vocabulary, `list_all_chats`) in the renderer; no new backend search unless one is needed for performance, with tests.
- Home's `Turn On iCloud Sync…` opens Settings at iCloud Sync (the modal until M4 lands, then the in-window view). Home's `Ask about this part` opens the reader with the latest highlight quoted into Ask Quill through the existing quote path.
- Reader windows are M6's and M7's. Deep links from Home, Highlights, Words, Chats and `⌘K` open or focus the reader at the saved location through the existing open-reader path.

**Read first.** [`plan.md`](../331-rebrand/plan.md) Mission 3, the [spec](../../features/331-rebrand.md), [`design-map.md`](../331-rebrand/design-map.md) and [AGENTS.md](../../../AGENTS.md). In code: `src/components/TopBar.tsx`, `src/components/CommandSearchModal.tsx`, `src/pages/Home.tsx`, `src/components/DictionaryContent.tsx`, `src/components/VocabDetailModal.tsx`, `src/components/ChatsContent.tsx`, `src/components/ChatDetailView.tsx`, `src/hooks/useAiChat.ts`, and `crates/quill-core/src/commands/{bookmarks,vocab,chats}.rs`.

## Deliverables

1. The six deliverables in the plan's Mission 3 section.
2. Any new backend command gets Rust unit and dispatch parity tests first; no schema or sync event changes.
3. Replaced views and their dead code, styles and i18n keys are removed; `en.json` and `zh.json` stay in sync.
4. Regression cases whose expected UI changes are updated in `docs/tests/regression/` (at least `VOC-01` and `AI-05`).

## Validation

- **Automated:** `make typecheck`, `make lint`, `npm test`, `npm run electron:build`, `cargo test --workspace`, `cargo clippy --workspace -- -D warnings`; CI green on macOS and Windows. Component tests cover each view's empty, filtered-no-match and delete-confirmation states, the 3-second two-click delete in Words, and chapter-order sorting.
- **Live, `qa` in `make dev` on macOS with iCloud sync off.** The dev app is shared with M4's and M6's qa: check port 1430 first, wait for a release if another development Quill is running, and send a release message to the waiting qa when you finish. Back up `~/Library/Application Support/com.wycstudios.quill-dev` and `com.wycstudios.quill-chromium-dev` first and restore them afterwards.
  - `VOC-01`, `AI-05`, and `RDR-01` for the deep links from Home, Highlights, Words, Chats and `⌘K`.
  - `F-331-HOME`: populated bento against `m2srt`, and the first-launch empty state against `XkjMq` using an empty dev library (restore it after).
  - `F-331-CMDK`: every scope chip, keyboard navigation (`↑↓`, `↵`, `⌘↵`, `Tab`, `Esc`), and opening a hit of each kind.
  - `F-331-HL`: book rail and all-books stream, colour filter, text filter, the three sorts, hover recolor, inline note edit, and delete.
  - Chats: inline rename, the thread menu (`Copy as Markdown` included), delete confirmation, and one streamed reply on an inexpensive model with a tiny prompt.
  - Compare each changed screen against its design node and screenshot it.
- Record the run in `docs/tests/runs/331-m3-main-views-mac.md`. The Windows live smoke is left to Jason.

## Authorization

`hydrogen trio`, started by the operator under Jason's standing approval for #331 (2026-11-18). The crew may commit on `feat/331-m3-main-views` (folding this brief into an implementation commit), push, and open a PR against `main` labeled `needs-live-test` with the risk label its diff warrants, then drive CI green and stop; the operator merges.
