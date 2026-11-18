# 331 M7 — Reader Selection Menu, Reading Popovers, Words in Book and Ask Quill

**Starting point.** Issue #331, Mission 7 of the [plan](../331-rebrand/plan.md). Work in `/Volumes/samsung/repos/yicheng47/quill/.worktrees/feat-331-m7-reader-ai-and-popovers` on branch `feat/331-m7-reader-ai-and-popovers`, based on `origin/main` `1ed2244`. M2–M6 have merged: the reader shell, toolbar, Contents and Highlights / Bookmarks islands, progress pills and `Aa` popover are Dawn (M6); `Settings → AI Assistant`, the `AI_REAUTH_REQUIRED` / `AI_NOT_CONFIGURED` cards and the 12px `--radius-control` are in (M5). No sibling mission is running. M8 (Nocturne for the main window) follows this one.

**Outcome.** The reader's AI and word surfaces move to Dawn: the selection menu, the Look Up, Explain and Translate popovers, the Words in Book island and the Ask Quill island (thread header and switcher, starter prompts, pending quote chip, streaming thread with follow-up chips, composer and model footer). Every reader side panel, pill and popover takes the page theme's material. Chat text is larger in Ask Quill and in the merged Chats view. The plan's Mission 7 section sets scope; the design wins on visual detail.

**Design.** `quill/desktop/specs/331-rebrand.pen` at `fd7c334` in `YeelinksCo/yeelinks_design`, checked out at `/Volumes/samsung/repos/yeelinks/yeelinks_design` (pull before opening). Nodes: `ECLAp`, `rdcDH`, `xqqVr`, `ZpzpR`, `GWA41` (left half, Translate), `N4bEY` (right half, Thread Switcher), `o04NH` (the prompt cards), `luJ5A` (page-theme materials, including `Db9UA` and `RSlKX`), and `ETt8K` for the Chats text sizes. Tokens and component IDs are in [`design-map.md`](../331-rebrand/design-map.md). Read through the Pencil MCP by node ID; do not edit the `.pen`.

**Decisions (Jason, 2026-11-18/19; binding, see the [program README](../331-rebrand/README.md)).**

- **Reader side panels follow the page theme.** `Contents`, `Highlights / Bookmarks`, `Words in Book`, `Ask Quill`, the progress pills, the `Aa` popover, the selection menu and the Look Up / Explain / Translate popovers take the page's material: Dawn glass on `Original`, `reader-island-sepia` (`#F7F0E1`, border `#E4D8BE`) on `Sepia`, `reader-island-gray` (`#EDEDF0`, border `#D4D4DA`) on `Gray`, and the Nocturne values M6 already defines on `Dark`. This includes M6's merged islands, pills and popover. Stored theme IDs do not change (`original`, `paper`, `quiet`, `dark`).
- **Chat text is 16px.** User bubbles and Quill replies are 16px (bubbles line height 1.5, replies 1.6) in `Ask Quill` and in the merged `Chats` view (`src/components/ChatsView.tsx`); the `Chats` passage quote is 16px Literata, the `Ask Quill` quote 15px, and chat composers 15px.
- **Buttons use the 12px control radius** (`--radius-control`, from M5); tabs, segments, chips, badges and status pills stay pills.
- The M5 prompt cards (`AI_REAUTH_REQUIRED`, `AI_NOT_CONFIGURED`) stay in every restyled surface and keep routing to `Settings → AI Assistant`.
- Presentation and reader-side UI only. No change to AI request, streaming, title-generation, vocabulary or highlight backends, the foliate submodule, or stored settings. If a design element needs new backend behavior (for example the Look Up `IN THIS PASSAGE` field or the model/effort footer), use what the existing commands return and raise any gap with the operator instead of adding a command.

**Read first.** [`plan.md`](../331-rebrand/plan.md) Mission 7, the [spec](../../features/331-rebrand.md), [`design-map.md`](../331-rebrand/design-map.md) and [AGENTS.md](../../../AGENTS.md). In code: `src/pages/Reader.tsx`, `src/components/ReaderContextMenu.tsx`, `LookupPopover.tsx`, `ExplainPopover.tsx`, `TranslationPopover.tsx`, `DictionaryPanel.tsx`, `AiPanel.tsx`, `MessageBubble.tsx`, `ChatsView.tsx`, `src/index.css` (the `reader-shell-*` classes) and `src/components/ui/`.

## Deliverables

1. The deliverables in the plan's Mission 7 section, including deliverable 5 (chat text size).
2. The page-theme materials above, applied through tokens and shared classes, not per-component colour literals.
3. Replaced chrome, dead styles and i18n keys are removed; `en.json` and `zh.json` stay in sync.
4. Component tests for the restyled surfaces' states (streaming, done, error, the two prompt cards) and for the page-theme material per theme. Update regression cases in `docs/tests/regression/` whose expected UI changes.

## Validation

- **Automated:** `make typecheck`, `make lint`, `npm test`, `npm run electron:build`, `cargo test --workspace`, `cargo clippy --workspace -- -D warnings`; CI green on macOS and Windows.
- **Live, `qa` in `make dev` on macOS with iCloud sync off.** Check port 1430 first and wait if another development Quill runs. Back up `~/Library/Application Support/com.wycstudios.quill-dev` (including `secrets.db`) and `com.wycstudios.quill-chromium-dev`, and restore both byte-for-byte afterwards. Use the AI provider the dev profile already has, with tiny prompts on an inexpensive model; never complete a ChatGPT sign-in. If no provider works, record the AI checks as blocked.
  - `AI-01`..`AI-04`: Look Up and Save to Words, Explain and Quote in Chat, Translate, and reader chat with title generation and `open in reader`, through the restyled surfaces.
  - `AI-07` on the restyled surfaces; restore the provider after.
  - `VOC-01`'s reader entry points: Words in Book and `Open in Words →`.
  - `F-331-PAGE-MATERIAL`: on `Original`, `Sepia`, `Gray` and `Dark` pages, open Contents, Highlights, Ask Quill, Words in Book, the `Aa` popover, the selection menu and one reading popover; each takes its page's material per `luJ5A`. Screenshot each theme.
  - `F-331-CHAT-TEXT`: chat text sizes in Ask Quill and the main Chats view match `ECLAp` and `ETt8K`.
  - Compare each changed screen against its node and screenshot it.
- Record the run in `docs/tests/runs/331-m7-reader-ai-and-popovers-mac.md`. The Windows live smoke is left to Jason.

## Authorization

`hydrogen trio`, started by the operator under Jason's standing approval for #331 (2026-11-18). The crew may commit on `feat/331-m7-reader-ai-and-popovers` (folding this brief into an implementation commit, and folding review and QA fixes into the commits they correct), push, and open a PR against `main` labeled `needs-live-test` with the risk label its diff warrants, then drive CI green and stop; the operator merges.
