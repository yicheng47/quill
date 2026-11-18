# #331 M4 — Settings and Updates macOS QA

## 2026-11-18 — Candidate 28a2fe0

Candidate `28a2fe0886066780eaa065ca6282f0bab849feb5` on `feat/331-m4-settings-and-updates`, clean before launch, from the mission worktree. macOS 26.6.2 (25G83), arm64. Evidence directory `/tmp/quill-331-m4-qa.BtOlNOAu`.

`make dev` built both debug native artifacts and launched Electron with Vite on port 1430. The boot log confirms Quill 2.0.0 and the development data path. Started with fresh development profiles and kept iCloud sync off. The original development data and Chromium directories were moved aside before launch and restored after stopping the candidate. Neither MCP client config was changed. Port 1430 was free at handoff.

The native computer-use tool failed before attaching to Quill. The full Electron app path, bundle ID, and app enumeration all returned `Sky Computer Use native pipe startup failed`. A fresh node_repl kernel reproduced it. The macOS unified log identifies the immediate failure as `Sender process is not authenticated` in `SkyComputerUseService`. See `native-control.txt` and `make-dev.log` in the evidence directory. No live screenshots were available because native capture failed at startup.

| Check | Result | Scope and evidence |
| --- | --- | --- |
| Candidate startup | Passed | `make-dev.log` records both debug builds, Vite startup, and Quill initialization in its development data directory. |
| SET-04 | Blocked | Settings navigation, nine tabs, persistence, language, Appearance, Reading, AI Assistant, Tools, and About require native control. |
| F-331-SETTINGS-NAV | Blocked | Gear, shortcuts, route exit, and targeted cross-window routing require native control. |
| SET-03 | Blocked | Verifying both Reveal Logs actions open Finder requires native control. The boot log separately confirms logging. |
| APP-03 | Blocked | Update feedback, Help menu entries, and Edit menu copy/paste require native control. The macOS update command is under the app menu. |
| MCP-01 | Blocked | Testing the switches, copied config, both clients, and the dev library depends on reaching the MCP tab. No client configuration writes were made. |
| F-331-UPD-SETTINGS | Blocked | Up-to-date hero, Check Now, last checked, and auto-check require native control. |
| F-331-SYNC-UI | Blocked | Off/unavailable UI and Turn On → Cancel require native control. The fresh development profile was started with sync off. |
| Design comparison | Blocked | Reference frames `eY7n3`, `xEUTG`, `dZCgL`, `MR9Fc`, `a1k3n`, `qbLwo`, `MpBgt`, `tcZmU`, `t47BM`, `HnSex`, and `TL2Mh` were captured from design revision `323c398`. Comparison requires live screenshots. |
| Packaged macOS icon refresh, signed update states, active iCloud states, and Windows smoke | Skipped | Deferred to Jason under the mission scope and outside this sync-off macOS development run. |

Required live checks remain unresolved. Keep `needs-live-test`.

## 2026-11-18 — Retry on PR #336 head b2ca5d8

Verified the clean worktree and PR head at `b2ca5d8256fb2abbddb0b4061440d919dbd250b9`. Port 1430 was free. The pre-launch native probe returned `Sky Computer Use native pipe startup failed`, and the macOS log again reported `Sender process is not authenticated`. See `/tmp/quill-331-m4-qa.BtOlNOAu/native-control-retry-b2ca5d8.txt`.

**Blocked:** The full live matrix above and the new window persistence check (move/resize, maximized and fullscreen, quit/relaunch, and normal geometry after leaving each mode) still require native control. The retry stopped before launch, so it produced no native screenshots and made no changes to the development profiles, MCP configurations, or sync state. Port 1430 remained free. Keep `needs-live-test`.

## 2026-11-18 — Live run on PR #336 head b2ca5d8

Candidate `b2ca5d8256fb2abbddb0b4061440d919dbd250b9` on macOS 26.6.2 (25G83), arm64. The restarted Runner session passed the native control probe. QA waited for M3's release after both missions tried to take port 1430. M3 identified the profile set aside during that overlap as its disposable fixture. The candidate worktree was clean for the native run, with the prior uncommitted QA entry preserved in scratch and restored when writing these results.

Launched with `make dev` from the mission worktree and drove the actual Electron window and menus with native computer use. Used a fresh development library and imported one synthetic EPUB. iCloud sync stayed off throughout. The development profile directories were restored with matching inodes, both MCP configs were restored byte-for-byte, and port 1430 was released to M3. No production library or installed Quill was used.

Live evidence is under `/tmp/quill-331-m4-live.7ZG0Vb81`. Pencil exports at design revision `323c398` are under `/tmp/quill-331-m4-qa.BtOlNOAu`.

### Must-fix

- **Failed — leaving maximized mode after relaunch restores the wrong window size.** In **Window → Move & Resize → Top Left**, set Quill to its normal `x=0, y=30, width=1281, height=660` bounds. Choose **Window → Zoom**, quit with `⌘Q`, relaunch with `make dev`, then choose **Window → Zoom** again. Quill reopened maximized as expected, but unzooming produced a `2540×1309` window instead of the original `1281×660`. The persisted maximized state already contained the larger geometry. Evidence includes `normal-quit-state.json`, `maximized-quit-state.json`, `unzoom-after-relaunch-state.json`, and screenshots `50-normal-tiled.png`, `56-maximized-before.png`, `57-maximized-relaunched.png`, and `58-unzoom-after-relaunch.png`. The relevant tracking code is `electron/main/windows.ts:451` and `:484`. The test establishes the geometry loss. The exact native event order was not measured.

### Live matrix

| Check | Result | Scope and evidence |
| --- | --- | --- |
| SET-04 | Passed | All nine tabs opened. Display name Save and Escape worked; English → 简体中文 → English rendered correctly; saved name persisted after quit. Light was active with System and Dark disabled, and 110% zoom persisted across restart. All four page themes were available and selectable, Literata and Word spacing persisted, Auto-save persisted off, and a test-only stored custom margin of 83 px selected Normal without changing the database value. AI's manual Save applied a local slider change and displayed feedback. The Tools Brief translation switch persisted. About rendered Quill 2.0.0, macOS · arm64 and MIT metadata, and opened the GitHub and Documentation destinations in Zen. See `02-general.png`–`18-tools-saved.png`, `25-about.png`, `46-github-open.png`, `47-docs-open.png`, `52-general-relaunched.png`, `66-normal-nearest.png`, `70-gray-theme.png`, `71-dark-theme.png`, and `74-zoom-relaunched.png`. |
| F-331-SETTINGS-NAV | Passed | Gear showed accent tint while active and toggled Settings. `⌘,` toggled; Escape exited Settings or closed only the focused name editor/language/font menu. Library, Words and Chats routes exited Settings. The reader's Open AI Settings affordance focused the main window and opened AI Assistant. See `31-command-comma-exit.png`–`34-library-route.png`, `45-cross-window-ai-settings.png`, `64-gear-active.png`, `65-gear-inactive.png`, and `72-chats-route.png`. |
| SET-03 | Passed | About and Help both revealed the dev log folder in Finder with `quill.log` visible and written. See `26-about-finder.png` and `28-help-finder.png`. |
| APP-03 | Passed | Help contained Reveal Logs and no Settings entries on macOS. The app menu's Check for Updates showed the transient inline Up to date pill with no toast and returned to quiet. Native Edit → Copy/Paste worked from the display-name field and selected EPUB text. See `27-help-menu.png`, `29-app-menu.png`, `30-menu-update-feedback.png`, `39-edit-copy-paste.png`, and `69-reader-copy-paste.png`. |
| MCP-01 | Passed | Both UI toggles disabled and re-enabled their registrations. Claude Code reported the dev server connected; Codex reported its dev binary registration. The copied snippet pasted as valid JSON. MCP stdio calls using each registered command and the copied snippet returned 16 tools and found the synthetic book via `list_books`. No model session was needed for the protocol checks. See `36-mcp.png`–`41-mcp-enabled.png`, `mcp-protocol-results.json`, and `mcp-restore.txt`. |
| F-331-UPD-SETTINGS | Passed | Idle hero, Check for updates, Up to date feedback, updated Last checked time, and the auto-check switch worked. The timestamp and auto-check preference persisted across restart. The native capture saw the completed response; it did not catch the brief Checking state on the dev build. See `22-updates-idle.png`–`24-check-now.png` and `55-updates-relaunched.png`. |
| F-331-SYNC-UI (Off) | Passed | Showed local-only storage with the switch off. Turn On confirmation covered the TopBar and rail. Cancel returned to Off and the test profile had no sync marker at cleanup. See `19-sync-off.png`–`21-sync-cancel.png`. |
| F-331-SYNC-UI (unavailable) | Blocked | The Mac had iCloud Drive available. The unavailable presentation requires a signed-out or isolated environment. Covered by the component tests. |
| Main window normal and fullscreen | Passed | Normal position and size returned across quit/relaunch. Fullscreen returned across quit/relaunch, and exiting fullscreen restored the earlier normal geometry. See `50-normal-tiled.png`, `51-normal-relaunched.png`, `61-fullscreen-entered.png`–`63-exit-fullscreen.png`, and the corresponding state JSON files. |
| Main window maximized | Failed | Relaunch restored maximized mode. Leaving it failed to restore the previously saved normal geometry. See the must-fix reproduction above. |
| Design comparison | Passed with a minor discrepancy | Compared the live rail and sections against `eY7n3`, `xEUTG`, `dZCgL`, `MR9Fc`, `a1k3n`, `qbLwo`, `MpBgt`, `tcZmU`, `t47BM`, `HnSex`, and `TL2Mh`. The Tools Lookup language control truncates the default label “Same as selection” at 100% zoom (`16-tools-small.png`). AI Assistant retains its existing controls per scope. About treats MIT as metadata, matching the Pencil frame. |
| Packaged macOS icon refresh, signed update states, active iCloud states, and Windows smoke | Skipped | Deferred to Jason under the mission scope. |

Keep `needs-live-test`. The maximized-window failure requires a reviewed fix and a focused native retest.

## 2026-11-18 — Focused window retest on f5013d2

Candidate `f5013d255aba7d94ed6b53b6ed2963f6250cdd30`, clean local reviewed head on `feat/331-m4-settings-and-updates`. macOS 26.6.2 (25G83), arm64. Verified with `make dev`, native computer use, and the saved `window-state.json` from the fresh development Chromium profile. Evidence is under `/tmp/quill-331-m4-window.69Q8gQ1o`.

| Check | Result | Scope and evidence |
| --- | --- | --- |
| Main window normal relaunch | Passed | Window → Move & Resize → Top Left, quit, relaunch. The normal window returned to `(0, 30) 1281×660`. See `03-normal-tiled.png`, `04-normal-quit.json` and `05-normal-restored.png`. |
| Original maximized-window regression | Passed | Top Left → Window → Zoom → quit → relaunch → Window → Zoom. Quill reopened maximized and unzoom returned to `(0, 30) 1281×660`. The saved maximized state also retained those normal bounds. See `06-main-zoomed.png`, `07-zoomed-quit.json`, `08-main-zoomed-relaunch.png`, `09-main-unzoomed-relaunch.png` and `09-main-unzoomed-state.json`. |
| Main window fullscreen relaunch and exit | Passed | Quill reopened fullscreen, then exiting fullscreen restored `1281×660`. See `10-fullscreen-entered.jpg`, `11-fullscreen-quit.json`, `12-fullscreen-relaunched.jpg` and `13-fullscreen-exited.jpg`. |
| Drag-resize followed by Zoom and relaunch | Passed | Dragged the right and bottom window edges to `1436×760`, then chose Window → Zoom, quit and relaunched. Unzoom returned to `1436×760`. See `17-manual-resized.jpg`–`21-manual-unzoomed.jpg` and `21-manual-unzoomed-state.json`. |
| macOS Window menu and reader Zoom | Passed | Native Move & Resize and tiling entries were present. Both the main and reader windows appeared in the menu. The reader zoomed and unzoomed back to `1440×960`, and selecting Quill in the menu refocused the main window. See `22-reader-normal.jpg`–`26-main-after-reader-zoom.jpg` and `23-reader-window-menu.txt`. |

No remaining must-fix issues in the focused retest. The prior failure on `b2ca5d8` remains recorded above. The reviewer disclosed a narrow, unverified race when Option-clicking the green button or double-clicking the title bar within 250 ms of native tiling. Those paths bypass the Window → Zoom capture hook. Prior Settings and MCP passes were carried forward. The iCloud-unavailable screen and Jason-deferred checks remain outstanding, so keep `needs-live-test`.

iCloud sync stayed off. Both original development profiles were restored with matching inodes, MCP configuration files were untouched, and port 1430 was released to M3.

## 2026-11-18 — Focused rebase QA on PR #336 head 74287be

Tested clean candidate `74287be7cc403282c24aa9704acc695179a2bc3a` on macOS 26.6.2 (25G83), arm64, with `make dev` and native computer use. Used a fresh development profile. Imported one synthetic EPUB, selected a highlight in the Reader, created a test chat, and seeded one vocabulary row in the stopped development profile to exercise nonempty filter controls. The unconfigured AI case used an OAuth provider with no signed-in account. Evidence is under `/tmp/quill-331-m4-rebase.4t8aMZY4`.

### Must-fix

- **Failed — update feedback clips TopBar actions at the minimum window width.** Resize the main window to 700 px wide, open Settings, then choose **Check for Updates…** from the macOS app menu. The idle TopBar fits five routes plus Search, Import, and Settings. While the inline **Up to date** pill is visible, Import and Settings move beyond the right edge. Both return at idle. At 1440 px, all controls remain visible during the same check. The affected layout is `src/components/TopBar.tsx:394`–`:475`. The screenshots establish the clipping on this candidate. Earlier baselines were not tested at the same minimum-width state.

| Check | Result | Scope and evidence |
| --- | --- | --- |
| F-331-SETTINGS-NAV after rebase | Passed | Default Home loaded. Gear and `⌘,` opened Settings from Home and Library. The gear tinted while active and all route pills were inactive. The first Escape closed only the language picker, the next exited Settings. All five routes exited Settings, including returning to the already-active Home and Library routes. See `01-default-home.jpg`, `05-settings-gear-active.jpg`–`12-library-gear.jpg`, and the five `10-route-*.jpg` captures. |
| Migrated Settings callers and sync portal | Passed | Home's Turn On iCloud Sync opened iCloud Settings with sync off. Its confirmation covered the new TopBar and Cancel preserved Off. In Chats, the unconfigured response's Open AI Settings button opened AI Assistant. See `02-home-sync-entry.jpg`–`04-sync-cancel.jpg` and `28-chats-unconfigured.jpg`–`29-chats-ai-routing.jpg`. |
| Search and filter shortcuts | Passed | TopBar Search opened from Settings and selecting the synthetic chat exited Settings and focused the matching chat. While Settings was open, `⌘K` and `⌘F` left it open without invoking a palette. Outside Settings, `⌘K` opened the All scope, Library `⌘F` selected Books, and `⌘F` focused the populated Highlights and Words filters. See `13-command-k-all.jpg`, `14-library-cmd-f.jpg`, `24-settings-shortcut-guard.jpg`–`26-settings-search-chat-result.jpg`, `32-highlights-cmd-f-filled.jpg`, and `33-words-cmd-f-filled.jpg`. |
| Five-route TopBar and update feedback | Failed | All controls fit at 1440 px and at idle at 700 px. The minimum-width update feedback clipped Import and Settings. See `34-normal-topbar.jpg`, `36-minimum-settings.jpg`, `37-minimum-update-feedback.jpg`, `42-normal-update-feedback.jpg`, and `minimum-window-state.json`. |
| Native TopBar window dragging | Blocked | Programmatic pointer drags from empty TopBar and brand areas did not move the app at either width. Native edge resizes worked. The result is inconclusive for a physical pointer drag. See `38-minimum-after-titlebar-drag.jpg`, `39-minimum-titlebar-brand-drag.jpg`, `41-normal-titlebar-drag.jpg`, and the state JSON snapshots. |

Prior Settings, MCP, and window restoration results carry forward. The iCloud-unavailable live case, fast native Zoom limitation, and previously deferred platform and packaged checks remain disclosed above. iCloud sync stayed off, MCP configs were untouched, original development profile inodes matched after restore, and port 1430 was released. Keep `needs-live-test`.

## 2026-11-18 — Focused TopBar retest on e46c5b0

Tested clean reviewed local head `e46c5b00e3dda1b723277726ee6452b6afba76cb` on macOS 26.6.2 (25G83), arm64, with `make dev`, fresh development profiles, and native computer use. Manually triggered Check for Updates from the macOS app menu. Evidence is under `/tmp/quill-331-m4-topbar.uwVAnKlM`.

| Native width and app zoom | Result | Idle, feedback, and expiry evidence |
| --- | --- | --- |
| 1440 px, 100% | Passed | Wordmark and full Up to date pill coexist, then the pill clears. See `01-1440-idle.jpg`, `02-1440-up-to-date.jpg`, and `18-1440-final-idle.jpg`. |
| 768 px, 100% | Passed | Wordmark yields to the full pill and returns after the pill clears. See `04-768-idle.jpg`, `05-768-up-to-date.jpg`, and `15-768-idle-wordmark-returned.jpg`. |
| 700 px, 100% | Passed | Wordmark yields to the pill and returns after expiry. The pill text truncates while the checkmark remains visible. See `07-700-idle.jpg`–`09-700-feedback-cleared.jpg`. |
| 700 px, 110% | Passed | The effective viewport is below the normal wordmark breakpoint, so the logo remains without the wordmark at idle. Feedback displays a checkmark and truncated text, then clears. See `10-700-110-idle.jpg`–`12-700-110-feedback-cleared.jpg`. |

At all four sizes and zoom levels, all five route pills and Search, Import, and Settings remained fully visible during feedback. The Settings gear remained tinted while Settings was open. Verified each route and action with actual coordinate clicks while the Up to date pill was active. Search opened the command palette, Import opened the native picker, and the tinted gear exited Settings. The `*-routes.txt` and `*-right-actions.txt` files record these checks. The brief Checking state was too fast to capture in the dev build.

No remaining must-fix issues in this focused retest. The original clipping failure on `74287be` remains recorded above. Zoom was restored to 100%, both development profiles were restored with matching inodes, and port 1430 was released. iCloud sync stayed off and MCP configurations were untouched. The earlier inconclusive title-bar drag check and the deferred checks were outside this retest. Keep `needs-live-test` for outstanding cases.
