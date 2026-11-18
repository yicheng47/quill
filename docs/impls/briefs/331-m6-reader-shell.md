# 331 M6 — Reader Dawn Shell, Themes, PDF Spread, Navigation Islands and iCloud State

**Starting point.** Issue #331, Mission 6 of the [plan](../331-rebrand/plan.md). Work in `/Volumes/samsung/repos/yicheng47/quill/.worktrees/feat-331-m6-reader-shell` on branch `feat/331-m6-reader-shell`, based on `origin/main` `084ff4b`. M1 ([#332](https://github.com/yicheng47/quill/pull/332)) landed the `.dawn` tokens (inactive), fonts and `src/components/ui/` primitives this mission builds on.

**Outcome.** Reader windows move to the Dawn shell: a 64px toolbar, the floating Paper island, the progress pill with the jump-back pill, the PDF progress and zoom pill, the `Aa` typography popover, the left Contents island, the right Highlights / Bookmarks island with the inline highlight toolbar, and the Book in iCloud screen. Nearly all of this behavior exists today; M6 re-skins it. The plan's Mission 6 section sets scope and behavior; the design wins on visual detail.

**Design.** `quill/desktop/specs/331-rebrand.pen` at `f7cb448` in `YeelinksCo/yeelinks_design`, checked out at `/Volumes/samsung/repos/yeelinks/yeelinks_design` (pull before opening). Nodes: `yvlbP`, `U3KZf8`, `pB71W`, `GWA41` right half, `Zd3OK`, `N4bEY` left half, `ZKLDp`, `IjTTv`, with tokens and component IDs in [`design-map.md`](../331-rebrand/design-map.md). Read frames through the Pencil MCP by node ID; export to your own scratch directory if you need an image. Do not edit the `.pen`.

**Decisions (Jason, 2026-11-18).**

- M6 runs in parallel with M2 (mission `01M7PYV0DPX3G135SP8AH54WWQ`, branch `feat/331-m2-topbar-and-library`). M2 owns the `"main"` window branch of `electron/main/windows.ts` and the main window's `.dawn` activation in `src/App.tsx`; M6 changes only the reader branches. Whichever PR merges second rebases onto `origin/main`.
- Windows keeps its native title bar. The reader toolbar drops the traffic-light spacer on Windows.
- The reader shell stays Dawn light whatever the app theme until M8. Page themes still apply inside the Paper island.
- Stored values do not change: the page theme IDs stay `original`, `paper` (Sepia), `quiet` (Gray) and `dark`, and highlight colors keep their stored names (the design's violet is the stored `purple`). Only their rendering changes.
- The selection menu, Look Up, Explain and Translate popovers, `AiPanel` and the Words in Book island are M7. In M6 they keep working unchanged, and the toolbar's Translate and Ask buttons open what they open today.

**Read first.** [`plan.md`](../331-rebrand/plan.md) Mission 6, the [spec](../../features/331-rebrand.md), [`design-map.md`](../331-rebrand/design-map.md) and [AGENTS.md](../../../AGENTS.md). In code: `src/pages/Reader.tsx` (theme palettes, PDF `spread` and `pageColumns`, `view.history` back/forward, the iCloud wait flow behind `icloudDownloading` and `initError`), `src/components/ReaderSettings.tsx`, `src/components/TableOfContents.tsx`, `src/components/BookmarksPanel.tsx`, `src/components/HighlightToolbar.tsx`, `src/App.tsx`, `src/index.css`, `src/components/ui/` and `electron/main/windows.ts`.

## Deliverables

1. The five deliverables in the plan's Mission 6 section.
2. No change to reading position, highlight, bookmark or iCloud download logic, the foliate submodule, or any backend command; this mission is presentation only. If a design element needs new behavior, raise it with the operator instead of adding it.
3. Replaced reader chrome and its dead styles and i18n keys are removed; `en.json` and `zh.json` stay in sync.
4. Regression cases whose expected UI changes are updated in `docs/tests/regression/` (for example `RDR-02`'s theme names or `RDR-03`'s panel wording).

## Validation

- **Automated:** `make typecheck`, `make lint`, `npm test`, `npm run electron:build`, `cargo test --workspace`, `cargo clippy --workspace -- -D warnings`; CI green on macOS and Windows. Component tests cover the Book in iCloud states (downloading, timed out, failed) and the typography popover's EPUB and PDF variants.
- **Live, `qa` in `make dev` on macOS with iCloud sync off:** back up `~/Library/Application Support/com.wycstudios.quill-dev` first and restore anything a check changes. The dev app is shared with M2's qa; if another development Quill is running, report it and wait.
  - `APP-04` for reader windows: traffic lights sit in the 64px toolbar at 100% and another app zoom.
  - `RDR-01`..`RDR-09` and `RDR-11`: the re-skinned toolbar, islands, popover and pills drive the same reader behavior.
  - `F-331-JUMPBACK`: following a Contents entry or an internal link shows `← Back to p. N` beside the progress pill, and clicking it returns to the earlier page.
  - `F-331-READER-VISUAL`: each designed state (Original, Sepia, Gray and Dark pages, PDF single page and two-page spread, Contents, Highlights, Bookmarks, typography popover) matches its node; screenshot each.
  - The Book in iCloud screen needs sync, so its live check is left to Jason.
- Record the run in `docs/tests/runs/331-m6-reader-shell-mac.md`. The Windows live smoke is left to Jason.

## Authorization

`hydrogen trio`, approved by Jason on 2026-11-18. The crew may commit on `feat/331-m6-reader-shell` (folding this brief into an implementation commit), push, and open a PR against `main` labeled `risk-high` and `needs-live-test`, then drive CI green and stop; never merge.
