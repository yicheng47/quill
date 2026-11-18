# 331 M2 — TopBar, Quiet Updates, ⌘K (Books), Library and Collections

**Starting point.** Issue #331, Mission 2 of the [plan](../331-rebrand/plan.md). Work in `/Volumes/samsung/repos/yicheng47/quill/.worktrees/feat-331-m2-topbar-and-library` on branch `feat/331-m2-topbar-and-library`, based on `origin/main` `084ff4b`. M1 ([#332](https://github.com/yicheng47/quill/pull/332)) already landed the `.dawn` tokens (inactive), bundled fonts, the Lens Q icon and the `src/components/ui/` primitives this mission builds on.

**Outcome.** The main window moves to Dawn light. A 71px `TopBar` replaces `Sidebar.tsx` and `UpdateToast.tsx`, with the quiet update indicator, the `⌘K` palette scoped to Books, and Import and Settings actions. `Library` is rebuilt as Grid and List with the full collection flows, and import gets its separate drop, progress and error states. The plan's Mission 2 section sets scope and behavior; the design wins on visual detail.

**Design.** `quill/desktop/specs/331-rebrand.pen` at `f7cb448` in `YeelinksCo/yeelinks_design`, checked out at `/Volumes/samsung/repos/yeelinks/yeelinks_design` (pull before opening). Nodes: `pL47g` TopBar, `Rh6Ai` left half (indicator and Ready popover), `tcZmU` `yMmME` sync chip, `CjQ94` palette (Books scope only), `BC0DA`, `BUxUo`, `J6aW1P` import states, `RhsF8`, `A03E8`, `Zzvta`, `F7B1gQ`, `r532a5` Library and collections, with tokens and component IDs in [`design-map.md`](../331-rebrand/design-map.md). Read frames through the Pencil MCP by node ID; export to your own scratch directory if you need an image. Do not edit the `.pen`.

**Decisions (Jason, 2026-11-18).**

- One mission; not split.
- Windows keeps its native title bar. The `TopBar` drops the traffic-light spacer on Windows; no custom Windows title bar.
- Only the main window gets `.dawn`, and it stays light whatever the theme setting until M8. Reader windows keep today's theme handling and chrome until M6.
- Home and Highlights tabs stay hidden until M3. The Words and Chats tabs show the existing vocab and chats views unchanged; their redesign is M3. The Settings gear opens the existing `SettingsModal` until M4.

**Read first.** [`plan.md`](../331-rebrand/plan.md) Mission 2, the [spec](../../features/331-rebrand.md), [`design-map.md`](../331-rebrand/design-map.md) and [AGENTS.md](../../../AGENTS.md). In code: `src/App.tsx`, `src/pages/Home.tsx` (today's library and the vocab/chats switch), `src/components/Sidebar.tsx`, `src/components/UpdateToast.tsx`, `src/components/BookContextMenu.tsx`, `src/components/EditMetadataModal.tsx`, `src/components/ui/`, `src/index.css`, `electron/main/windows.ts`, `electron/main/ipc.ts`, `crates/quill-core/src/commands/collections.rs` and `crates/quill-core/src/dispatch.rs`.

## Deliverables

1. The six deliverables in the plan's Mission 2 section.
2. `list_book_collections(book_id)` and a batch `add_books_to_collection(collection_id, book_ids)` with Rust unit and dispatch parity tests. The batch reuses the existing per-book write path so it emits the same sync events as repeated `add_book_to_collection`; no sync event format or schema changes.
3. `Sidebar.tsx`, `UpdateToast.tsx` and their tests are removed once replaced, with no dead imports or i18n keys left behind. `en.json` and `zh.json` stay in sync.
4. Regression cases whose expected UI changes are updated in `docs/tests/regression/`, at least `APP-03` (Check for Updates no longer shows a toast) and `LIB-03` (drop overlay), plus any case that names the sidebar.

## Validation

- **Automated:** `make typecheck`, `make lint`, `npm test`, `npm run electron:build`, `cargo test --workspace`, `cargo clippy --workspace -- -D warnings`; CI green on macOS and Windows. Component tests cover every update-indicator state (hidden, Available, Downloading, Verifying, Ready, Failed) and the import states.
- **Live, `qa` in `make dev` on macOS with iCloud sync off:** back up `~/Library/Application Support/com.wycstudios.quill-dev` first and restore anything a check changes.
  - `APP-01`..`APP-04`: launch without a white flash; the TopBar is the drag region, its controls are not, and traffic lights align at 100% and another app zoom.
  - `LIB-01`..`LIB-03`, `LIB-05`..`LIB-09`, `RDR-08`.
  - `F-331-UPD-TOPBAR`: the indicator is hidden when up to date, and Check for Updates in dev gives its dev feedback without a toast. States that need a published release are left to Jason on the next nightly.
  - `F-331-CMDK`: `⌘K` opens the palette scoped to Books, typing filters, `↵` opens the book (focusing an open reader window), `Esc` closes; `⌘F` on Library focuses the inline filter.
  - `F-331-COLLECTIONS`: create a collection in the popover, fill it with the Add Books picker, toggle one book into two collections from the context menu (checkmarks match), quick-create-and-add from the submenu, drag-reorder, rename inline, then delete a collection and confirm its books remain in All books.
  - Compare each changed screen against its design node and screenshot it.
- Record the run in `docs/tests/runs/331-m2-topbar-and-library-mac.md`. The Windows live smoke is left to Jason.

## Authorization

`hydrogen trio`, approved by Jason on 2026-11-18. The crew may commit on `feat/331-m2-topbar-and-library` (folding this brief into an implementation commit), push, and open a PR against `main` labeled `risk-high` and `needs-live-test`, then drive CI green and stop; never merge.
