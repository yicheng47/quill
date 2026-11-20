# App-Wide Fading Scrollbars (Drop macOS Light Gutter Everywhere)

**Starting point.** Work only in `/Volumes/samsung/repos/yicheng47/quill/.worktrees/fix-app-fading-scrollbars` on branch `fix/app-fading-scrollbars`, based on `origin/main` `26b22b1`. Read [AGENTS.md](../../../AGENTS.md) first. Other worktrees under `.worktrees/` belong to other work; never inspect or edit them.

## Problem and outcome

PR #365 (`272267a`) scoped custom `::-webkit-scrollbar` rules in `src/index.css` to `html:not(.platform-mac)` (and `getReaderCSS` in `src/pages/Reader.tsx` omitted custom scrollbars on macOS), assuming macOS Electron would draw native overlay scrollbars. PR #366 (`7b66290` and `public/foliate-js` `457de14`) confirmed that Electron on macOS instead paints a classic scrollbar with a permanent light gutter whenever custom `::-webkit-scrollbar` styling is omitted, and fixed the three `foliate-js` reader shadow-DOM scrollers (`foliate-paginator`, `foliate-pdf-scroll`, `foliate-fxl`) using a slim 4px inset thumb on an 8px transparent track that stays hidden at rest and appears while scrolling or hovering.

Every scrollable surface outside `foliate-js` still hits the `:not(.platform-mac)` gate and shows the permanent light-gutter scrollbar on macOS — including all main-window pages, split panes, modals, popovers, dropdowns, markdown code/table scrollers, textareas, Reader side islands/popovers, and inner EPUB iframe scrollbars.

**Outcome.** Every scrollable surface across the main app and reader shell uses the same transparent-track, 4px inset fading scrollbar behavior on every platform — no permanent light gutter on macOS, invisible at rest, revealed on scroll or scrollbar hover, held during hover and paused drag, fading ~1s after scrolling/hover stops, with readable contrast in both Light and Dark themes.

## Read first

- `src/index.css` (Dawn scrollbar tokens `--scrollbar-thumb` / `--scrollbar-thumb-hover`, `html:not(.platform-mac)::-webkit-scrollbar*` rules, `.scrollbar-none`, `.markdown-body pre/table`).
- `public/foliate-js/scrollbar.js` (reference implementation for fading slim scrollbars, hover tracking, and pointer-exit handling).
- `src/App.tsx` (root lifecycle setup for both main and reader windows) and `src/lib/platformEnv.ts`.
- `src/pages/Reader.tsx` (`getReaderCSS` iframe `scrollbarCSS` branch and `getReaderScrollbarVars`).
- `src/lib/platformEnv.test.ts`, `src/pages/Reader.test.tsx`, `src/components/MainViews.test.tsx`, `src/components/BookmarksPanel.test.tsx`.
- `docs/tests/runs/366-home-centering-reader-scrollbar-mac.md` (reference QA edge cases from PR #366).

## Affected surfaces inventory

Audit all non-`foliate-js` scrollable surfaces (every one currently hits `src/index.css` or `Reader.tsx`):

- **Main window pages:** `HomeView` (`src/components/HomeView.tsx` `<main>` scrollers), `Library` Grid & List (`src/pages/Home.tsx` `<main>`), `ChatsView` (`src/components/ChatsView.tsx` left chat rail, right thread scroller, book filter dropdown, composer `<textarea>`), `WordsView` (`src/components/WordsView.tsx` left word rail, right detail pane, book filter dropdown), `HighlightsView` (`src/components/HighlightsView.tsx` left book rail, right highlights pane, note `<textarea>`), `Settings` (`src/components/settings/SettingsNav.tsx` left rail and `src/components/settings/SettingsView.tsx` content pane), and `.markdown-body pre` / `.markdown-body table` horizontal scrollers (`src/index.css`).
- **Main window modals, popovers, menus:** `CommandSearchModal`, `AddBooksModal`, `CollectionsPopover`, `BookContextMenu` collections submenu, `Select` dropdown menu, `CodexFeaturePicker` menu.
- **Reader shell panels, popovers, and book iframe:** `TableOfContents`, `BookmarksPanel` (Highlights and Bookmarks tabs), `AiPanel` (thread list, messages, composer `<textarea>`), `DictionaryPanel`, `ReaderSettings`, `LookupPopover`, `ExplainPopover`, `TranslationPopover`, and `getReaderCSS` in `src/pages/Reader.tsx`.

## Deliverables

1. **All-platform transparent-track fading scrollbars in `src/index.css`.** Remove the `:not(.platform-mac)` gate from the `::-webkit-scrollbar*` rules so every platform gets an 8px transparent track and corner with a 4px inset rounded thumb (`border: 2px solid transparent; background-clip: content-box; border-radius: 9999px;`). Keep the thumb `background-color: transparent` at rest, paint it with `var(--scrollbar-thumb)` while the scroller carries the active scrolling/hover attribute (and `var(--scrollbar-thumb-hover)` on thumb `:hover` / `:active`). Preserve `.scrollbar-none` hiding where explicitly used (e.g. `TopBar`). Keep `.platform-mac` on `documentElement` intact (`applyPlatformClass` is still used/tested). Check Light and Dark Dawn thumb contrast on both canvas and `dawn-glass` / `surface-inset` backgrounds so the fading thumb is clearly visible when active.
2. **Global fading-scrollbar controller (e.g. `src/lib/fadingScrollbars.ts`, mounted once in `App.tsx`).** Automatically covers both Main and Reader windows, including portaled modals/popovers and dynamically mounted scrollers, without wiring every component by hand:
   - Capture-phase `scroll` listener reveals the scrolling element (mapping `document` scroll to `document.scrollingElement ?? document.documentElement`) and fades ~1000 ms after scroll stops, resetting on new scroll events.
   - Pointer hover detection reveals the thumb when the pointer rests in the vertical or horizontal scrollbar strip of an overflowing scroller (ignoring `.scrollbar-none`, respecting borders and only activating the hovered scroller rather than unrelated ancestor scrollers), holds while hovered or wheeling over it, starts the 1000 ms fade upon leaving the scrollbar strip into content or leaving the window / `window` blur, cancels fade on early return, and reveals again on late return.
   - Paused mid-drag: holding the pointer down on the thumb, pausing >1s mid-drag, resuming drag, and releasing keeps the thumb visible throughout and fades ~1s after release and exit.
   - Zero leaks: per-element timer/hover state in `WeakMap` and clean teardown on unmount.
3. **Reader book iframe CSS (`src/pages/Reader.tsx` `getReaderCSS`).** Drop the `isMacOS() ? "" :` guard so inner scrollable blocks inside EPUB iframes never paint the macOS light gutter either (keep transparent track and theme-matched 4px inset thumb on every platform).
4. **Layout & spacing check across the inventory.** Confirm the 8px transparent scrollbar track does not clip text, crowd card right edges, or create stray horizontal scrollbars on any main-window page, split pane, modal/popover, or reader side island. Adjust container padding/margins only where an actual layout regression appears. Keep `ChatsView` and `WordsView` free of `scrollbar-none` (preserving #322 / `MainViews.test.tsx`).
5. **Tests.** Add unit tests for the fading-scrollbar controller (scroll reveal + 1s fade + reset, hover reveal + persistence + exit fade + early/late return, nested scroller isolation, paused drag, window blur/leave, `.scrollbar-none` exclusion, teardown). Update `src/lib/platformEnv.test.ts` and `src/pages/Reader.test.tsx` to assert the new all-platform scrollbar rules.

**Non-goals:** Do not modify `public/foliate-js` (already fixed in PR #366) or touch Rust/sync code.

## Validation and handoffs

- **Automated (`coder`):** `make typecheck`, `make lint`, `npm test`, `npm run electron:build`; CI green on macOS and Windows after PR opens.
- **Review (`reviewer`):** Reviews frozen local commits before push/PR and signs off on the final head with the `reviewed` label and PR comment once the PR opens.
- **Live QA (`qa`, macOS dev app `make dev`, iCloud sync off):** Back up and restore dev profile/settings; never touch installed Quill. Check **both Light and Dark** app themes on macOS:
  1. Main-window overflowing pages: **Home** (when scrollable in a short window), **Library** (Grid and List views), **Chats** (left conversation rail and right message thread), **Words** (left word rail and right detail pane), **Highlights** (left book rail and right detail pane), and **Settings** (`SettingsNav` + `SettingsView`). Verify zero permanent light gutter at rest, thumb invisible at rest, reveals on wheel scroll and fades ~1s after stop, reveals on hovering the scrollbar strip and holds while hovered, fades ~1s after moving back into page content, and supports drag including a >1s paused mid-drag.
  2. Representative popovers/modals/nested scrollers: `CommandSearchModal`, a `Select` dropdown or `CollectionsPopover`, and a scrollable Reader side panel (`TableOfContents` or `AiPanel`) to confirm transparent track, fading behavior, and no nested-scroller leakage.
  3. Regression check: `TopBar` stays clean with no unintended scrollbar, and `foliate-js` reader scrolling still works without interference from the document-level controller.
  Record the run in `docs/tests/runs/fix-app-fading-scrollbars-mac.md` (screenshots outside the repo under `/tmp/...`).
- **Windows live check:** Left to Jason on a Windows PC (verify slim transparent-track fading scrollbars on Main window pages and Reader panels); list it in the PR description and keep `needs-live-test` on the PR until run or waived.

## Authorization

`neon trio`, approved by Jason on 2026-11-20. The crew may commit on `fix/app-fading-scrollbars`, folding this brief into an implementation commit and review/QA fixes into the commits they correct. After clean review and macOS QA, `coder` may push, open a PR against `main` with `risk-medium` and `needs-live-test` (for the pending Windows check, plus `reviewed` from `reviewer`), drive CI green, and stop. Jason merges.
