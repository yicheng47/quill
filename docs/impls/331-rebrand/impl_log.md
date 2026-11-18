# 331 — Implementation Log

Dated entries for the [331 Desktop Rebrand program](README.md), newest last. Mission handoffs, QA findings, measurements, and operator rulings go here; [`plan.md`](plan.md) changes only when a decision alters how the remaining missions land.

## 2026-11-18

- Initial Dawn design system, main screens, Reader 12-screen suite, grouped 9-tab `Settings` (`APP · AI · INTEGRATIONS · SYSTEM`), Runner-style quiet `Updates` (`Rh6Ai` / `HnSex` in `$accent` violet), and `AI Assistant` / `#325` session-expiry flows drawn in `quill/desktop/specs/331-rebrand.pen` (`YeelinksCo/yeelinks_design` `6dff67a`, `4c9c391`).
- **M1 (`331-m1-foundations`)** started in `.worktrees/feat-331-rebrand` (PR [#332](https://github.com/yicheng47/quill/pull/332)) covering Dawn tokens scoped under `.dawn`, Lens Q icons, bundled fonts, `cmp/*` primitives, and read-only highlight/unread queries.
- Completed and signed off the remaining 28 detail frames, boards, and Nocturne dark theme in `YeelinksCo/yeelinks_design` `f7cb448` (bringing `331-rebrand.pen` to 58 frames/boards + 29 reusable components), exported at 2x PNG + SVG to `/Users/jason/QuillQA/331/design-refs/`:
  - **Home & TopBar:** `⌘K` Command Search Palette (`CjQ94`), separated single-state `Drag & Drop Overlay` (`BC0DA`), `Importing Progress` (`BUxUo`), and `Import Error Toast` (`J6aW1P`), plus `First Launch (Empty Library)` (`XkjMq`) with tactile miniature highlight, lexicon, and AI chat specimens (`OqN9H`).
  - **Library & Collections:** `List View & iCloud Books` (`A03E8`), end-to-end `Collections & Add New Collection` popover (`Zzvta`), `BookContextMenu` multi-collection checkmarks + inline create-and-add (`F7B1gQ`), and `r532a5` (`Add Books Picker Modal`, `Delete Collection` non-destructive modal, `Edit Book Info`, `Delete Book`, no-match filter).
  - **Highlights, Words & Chats:** Cross-book stream + color filter + hover actions (`zWiKF`), inline margin-note editor + sort/delete popovers (`SiLV6`), `A–Z` alphabetical sort + book-count popover (`A4GWjG`), 3s 2-click delete + filtered no-match (`l6BCnh`), chat book-count filter + inline rename + thread menu (`BsJqG`), `Generating title…` + delete modal (`S4d1bF`), and empty states (`JSI0p`, `DjXY3`, `y4fAJ`).
  - **Settings & iCloud Sync:** Inline `Display name` edit + `#276` 2-step `RESET` modals (`dkFHc`), plus the complete `iCloud Sync` state suite (`HUr9u`, `MpBgt`, `stXkC`, `tcZmU`).
  - **Nocturne Dark Mode:** `{mode: "light"}` / `{mode: "dark"}` semantic token axis and reference screens (`q62MgQ`, `Y803E5`, `T1qAJe`, `CPGY5`).
- Jason reviewed the updated scope and settled three program decisions:
  1. **Nocturne Dark Mode** joins `#331` as **Mission 8 (`331-m8-nocturne-dark-mode`)** after Dawn Light surfaces ship in M1–M7.
  2. **`#276` Reset All Data** stays out of M4 so M4 avoids `core-review` storage-wipe scope; `#276` lands separately as its own `core-review` PR when needed.
  3. Expanded `docs/impls/331-rebrand/` into a full program subdirectory (`README.md`, `plan.md`, `design-map.md`, `impl_log.md`).
- **M1 merged** ([#332](https://github.com/yicheng47/quill/pull/332)) after review and macOS live QA ([`331-m1-foundations-mac.md`](../../tests/runs/331-m1-foundations-mac.md)). **M2** and **M6** are unblocked.
- The `/Users/jason/QuillQA/331/design-refs/` exports are no longer present. The `.pen` file is the only design reference; crews read frames through the Pencil MCP by node ID ([`design-map.md`](design-map.md)).
- Jason deferred the Windows title bar: Windows keeps its native frame through the rebrand, and the `TopBar` and reader toolbar omit the traffic-light spacer there.
