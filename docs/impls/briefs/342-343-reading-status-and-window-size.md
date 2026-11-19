# 342 + 343 — Mark Opened Books as Reading, and Fit Home in the Default Window

**Starting point.** Issues #342 and #343. Work in `/Users/jason/repos/yicheng47/quill/.worktrees/fix-342-343-reading-status-window-size` on branch `fix/342-343-reading-status-window-size`, based on `origin/main` `aee9698` (the #331 rebrand has fully merged). No sibling mission is running. Read both issues first (`gh issue view 342`, `gh issue view 343`); they carry the investigation and file pointers.

## #342 — opening a book marks it as reading

**Outcome.** When the Reader loads a book whose status is `unread`, it becomes `reading`, and the change syncs. `finished` and `reading` books are left alone (Jason, 2026-11-19: reopening a finished book to look something up must not move it back; "Mark as reading" in the context menu covers a re-read).

**Approach.** In the `getBook` effect at `src/pages/Reader.tsx:~427`, after the book loads, call `updateBookStatus(b.id, "reading")` (`src/hooks/useBooks.ts`) when `b.status === "unread"`, and reflect the new status in local state. `update_book_status` → `do_update_book` already pushes a `BookStatusSet` sync event, so no Rust change is needed. The main window must pick up the change when the reader window is open beside it: check that Home and Library refresh (they refresh on focus; verify the existing `mcp:books-changed`/refresh path or the focus refresh covers it, and add the smallest notification needed if not). Fire once per load, not on every progress save. Test in `src/pages/Reader.test.tsx`: unread → one `update_book_status` call with `reading`; reading and finished → none.

## #343 — the default main window fits the whole Home page

**Outcome.** On first launch (no saved `window-state.json`), the main window shows the entire populated Home page (TopBar, Now reading, Saved words, Last conversation, Library shelf, Also reading + Collections) with no vertical scrolling. The Home design frame is `m2srt` (`331 / Home`, 1440×960) in `quill/desktop/specs/331-rebrand.pen` in `YeelinksCo/yeelinks_design` (checked out at `/Users/jason/repos/yeelinks/yeelinks_design`; pull first, read through the Pencil MCP, do not edit the `.pen`).

**Approach.** Measure first: at the default size (`DEFAULT_MAIN_WIDTH`/`HEIGHT` in `electron/main/windowState.ts`), find what the Home content height actually is against the viewport and which rows overflow. Then pick the smallest fix and state the reason in the PR: raise the default window size, and/or tighten `HomeView.tsx`'s min-heights and padding so the bento fits the 1440×960 frame as the design does. The design wins on layout. Also clamp the default size to the primary display's work area so a smaller display (a 14" MacBook's work area is about 1512×945) never gets a window larger than the screen; Home may still scroll when the work area itself is too small. A saved window state still overrides the default; do not migrate or reset existing users' saved size. Unit-test the default/clamp logic in `electron/main/windowState.test.ts`.

## Validation

- **Automated:** `make typecheck`, `make lint`, `npm test`, `npm run electron:build`; CI green.
- **Live, `qa` in `make dev` on macOS with iCloud sync off.** Check port 1430 first and wait if another development Quill runs. Back up `~/Library/Application Support/com.wycstudios.quill-dev` and `~/Library/Application Support/com.wycstudios.quill-chromium-dev`, and restore both byte-for-byte afterwards. Never touch the installed Quill or its data.
  - `F-342-OPEN-READING`: import a small book (status `unread`), open it, return to Home: it is the `Now reading` hero and appears under Library's Reading filter. Then mark a book `finished`, reopen it, and confirm it stays finished.
  - `F-343-DEFAULT-FIT`: move `window-state.json` aside in `com.wycstudios.quill-chromium-dev`, launch with a populated library (at least 5 books, a highlight, a saved word and a chat so every bento card renders), and confirm Home shows every row with no scrolling; screenshot it next to `m2srt`. Then restore `window-state.json`.
- Record the run in `docs/tests/runs/342-343-reading-status-and-window-size-mac.md`. Windows is left to Jason.

## Authorization

`hydrogen trio`, approved by Jason on 2026-11-19. The crew may commit on `fix/342-343-reading-status-window-size` (one commit per issue; fold this brief into one of them, and fold review and QA fixes into the commits they correct), push, and open one PR against `main` that closes #342 and #343, labeled with the risk label its diff warrants and `needs-live-test` until qa passes, then drive CI green and stop. Jason merges.
