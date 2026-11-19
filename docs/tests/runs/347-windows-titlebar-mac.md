# #347 Windows Title Bar — macOS Live QA

## 2026-11-19 — `5f7af16`

**Verdict: Incomplete.** The main and reader chrome, centered nav pill, native menus and reader Typography placement passed. Native window movement from dragging the two macOS headers remains unverified and needs a physical pointer check.

### Candidate and method

Quill `feat/347-windows-titlebar`, reviewed candidate `5f7af16babd03959ea254209f33cfdd47460565f` on base `435bc2aa114632ce941817f1ce62d74449cf354a`, in `quill/.worktrees/feat-347-windows-titlebar`. The working tree was clean before launch and after shutdown, before this record. The empty diff SHA-256 was `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`. The Foliate submodule was `54407aad6c25695afdc103447c5f361f9c6104a9`.

Tested the crew-authorized `make dev` build on Apple Silicon macOS 26.6.2 (25G83). Quill reported version 2.0.0. Tool versions were Electron 45.3.3, Node 24.19.0, npm 11.17.0, GNU Make 3.81, Cargo and rustc 1.97.1, Runner 0.20.1 and Codex CLI 0.170.0. `make dev` exited 0 after native quit. Before UI checks, verified the Electron and Vite processes were running from the candidate worktree, Vite at `http://localhost:1430/` returned HTTP 200, and the startup log named the development data directory. `build-identity.txt` records executable, native addon and bundle SHA-256 hashes. Coder ran the automated suite separately.

Used the native computer-use driver to open Settings and verify sync was off, import the checksum-verified public-domain EPUB *The Waste Land* through the native file dialog, then open its reader from Library. The selected portions of APP-04 cover the traffic lights and drag regions affected by the Windows title-bar change. The additional Typography check covers the popover positioning code shared with macOS.

### Results

| Check | Platform | Result | Observation and evidence |
|---|---|---|---|
| F-347-MAC-UNCHANGED — main chrome and nav | macOS | Passed | Three native traffic lights occupy the upper-left header. The renderer ends at Search, Import and Settings, with no Quill-drawn window controls. The nav pill is centered. `04-main.jpg`, `04-main.txt`. |
| F-347-MAC-UNCHANGED — reader chrome | macOS | Passed | The active reader has three native traffic lights in the toolbar. Its right cluster ends at AI Assistant, with no Quill-drawn window controls. `13-reader-active.jpg`, `13-reader-active.txt`. |
| F-347-MAC-UNCHANGED — native menus | macOS | Passed | Both windows expose the native Electron, File, Edit, View, Window and Help menus. View shows Reload, Force Reload, Toggle Developer Tools and Toggle Full Screen. Help shows Reveal Logs in Finder. Reader Window retains Minimize, Zoom and Bring All to Front. The app-menu source matches the base. `02-main-view-menu.txt`, `03-main-help-menu.txt`, `16-reader-window-menu.txt`. |
| F-347-MAC-UNCHANGED — main header drag | macOS | Blocked | Expected the window to follow a held drag from the empty area between the logo and nav. After calibrating coordinates against the Library tab, dragged from screenshot pixel (610, 70) to (910, 234), then retried to (990, 70). Both attempts left the persisted native frame at (195, 65, 1407, 890). A double-click at the same origin did zoom the window and a second double-click restored it. The result requires a physical pointer check to establish whether the native drag works. `06-main-after-calibrated-drag.jpg`, `07-main-after-header-double-click.jpg`, `09-main-after-horizontal-drag.jpg`, `main-frame-*.json`. |
| F-347-MAC-UNCHANGED — reader toolbar drag | macOS | Blocked | Expected the window to follow a held drag from the empty toolbar above the page. Dragged from screenshot pixel (1120, 64) to (1460, 154). The driver returned a window-relative capture without screen position, so movement could not be established. The same driver dragged the in-reader Brightness slider from 100 to 90, which establishes renderer input. Physical title-bar movement remains open. `12-reader-drag-control.txt`, `14-reader-after-header-drag.jpg`, `15-reader-after-header-double-click.jpg`. |
| Reader Typography anchor | macOS | Passed | Clicking Typography opened the popover below the trigger, aligned with the trigger's right edge and fully inside the viewport. The font, brightness, theme, mode and margin controls were visible. `11-reader-typography.jpg`, `11-reader-typography.txt`. |
| F-347-WIN-CHROME, F-347-WIN-CONTROLS, F-347-WIN-DRAG, F-347-WIN-THEMES, F-347-WIN-SHORTCUTS | Windows | Skipped | The mission assigns these checks to Jason on a Windows PC. They remain required for the PR's live-test gate. |

### Cleanup

Moved both original development profile directories to the same filesystem's scratch directory before launch. The candidate created fresh profiles. The import and temporary Brightness change were confined to those profiles, and iCloud sync stayed off. After native quit, confirmed the candidate process group had ended and port 1430 was free. Parked the test profiles in scratch and moved the original directories back. Both original directory inodes and the per-file SHA-256 manifest matched the pre-run copies. Evidence includes `01-sync-off.jpg`, `01-sync-off.txt` and `cleanup.txt`.

Evidence is stored outside the worktree at `~/QuillQA/347-windows-titlebar-5f7af16.9ZnJsx/`.

## 2026-11-19 — Native drag retry

**Passed on macOS.** The main and reader windows moved by their empty headers. Dragging from the main Search button left the window in place and did not open Search. This resolves the two blocked macOS checks above. The Windows live checks remain open.

Reran on the reviewed `5f7af16` product tree using PR head `62092a59fe11aa534570b11ab6d24e8421b284b1`, whose sole delta was the first QA record. Rebuilt with `make dev` on the same host and toolchain, verified the candidate Electron and Vite processes and bundle hashes, and reused a copy of the prior disposable EPUB profile with fresh Chromium data. Confirmed iCloud sync was off in Settings. Used the authorized `mac-drag` script with `--dry-run`, `--move-only` and `--report-window`. Coordinates and movement are macOS screen points. CoreGraphics identified the same window before and after each drag, with its dimensions unchanged.

| Check | Platform | Result | Requested and observed movement |
|---|---|---|---|
| F-347-MAC-UNCHANGED — main header drag | macOS | Passed | From the empty area between Quill's logo and the nav, requested (−300, +75) and measured (−300, +75). `10-main-before-return-drag.jpg`, `11-main-return-after.jpg`, `11-main-return-drag.json`. |
| F-347-MAC-UNCHANGED — reader toolbar drag | macOS | Passed | From the empty toolbar of *The Waste Land*, requested (−300, +210) and measured (−300, +219). `08-reader-before.jpg`, `09-reader-after.jpg`, `09-reader-drag.json`. |
| Header Search button as no-drag control | macOS | Passed | From the Search icon, requested (−120, +71) and measured (0, 0). The main window stayed on Home with no Search dialog in the screenshot or accessibility tree. `06-search-control-after.jpg`, `06-search-control-after.txt`, `06-search-control-drag.json`. |

The first main header drags moved in the requested direction but fell short. The script measured (+93, +36) against requested (+120, +65), (−82, 0) against (−110, 0), and (+317, 0) against (+360, 0). These results are preserved in `04-main-drag.json`, `05-main-retry-drag.json`, and `07-main-long-drag.json`. A return attempt started inside the nav pill and measured (0, 0). It was excluded from the header check and repeated from the empty header in the passing row.

The script output for the passing checks follows table order.

```jsonl
{"posted":true,"from":{"x":777,"y":104},"to":{"x":477,"y":179},"window":{"before":{"number":116964,"x":472,"y":69,"width":1440,"height":960},"after":{"number":116964,"x":172,"y":144,"width":1440,"height":960},"moved":{"dx":-300,"dy":75}}}
{"posted":true,"from":{"x":848,"y":102},"to":{"x":548,"y":312},"window":{"before":{"number":116997,"x":288,"y":70,"width":1440,"height":960},"after":{"number":116997,"x":-12,"y":289,"width":1440,"height":960},"moved":{"dx":-300,"dy":219}}}
{"posted":true,"from":{"x":1456,"y":104},"to":{"x":1336,"y":175},"window":{"before":{"number":116964,"x":155,"y":69,"width":1440,"height":960},"after":{"number":116964,"x":155,"y":69,"width":1440,"height":960},"moved":{"dx":0,"dy":0}}}
```

Quit Quill through the native interface. `make dev` exited 0, the process group ended and port 1430 was free. Restored both original profile directories and verified that their inodes and per-file SHA-256 manifests matched the pre-run state. Sync stayed off. Retry evidence, including the raw JSON, native window screenshots, accessibility snapshots and cleanup log, is at `~/QuillQA/347-windows-titlebar-5f7af16.9ZnJsx/hid-drag.sIRlD5/`.
