# #331 Mission 1 foundations QA — macOS

## Verdict

**Passed.** APP-01, LIB-01, RDR-01, and LIB-09 passed. The Lens Q mark passed in the sidebar, Settings → About, and the unpacked bundle. Jason confirmed the live macOS Dock icon on 2026-11-18, completing F-331-ICON.

## Candidate and environment

- Repository `yicheng47/quill`, branch `feat/331-rebrand`, worktree `/Users/jason/repos/yicheng47/quill/.worktrees/feat-331-rebrand`.
- Reviewed candidate `4286004f420416a2ade460d9a7fb8dfc02d37898`, base `83a3940e3f325dba59760ce2a0fcb5ad5c74740a`, Foliate submodule `4a060bcf4c1c58f9bfb5a70106a00b13a0b91f04`.
- Clean tracked and untracked source at handoff. The empty diff against HEAD hashed to `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`. HEAD and the tracked diff remained fixed during the checks.
- 2026-11-18, macOS 26.6.2 (25G83), Apple Silicon. Quill 2.0.0, Electron 45.3.3, Node 24.19.0, npm 11.17.0, Vite 7.3.1, Cargo and rustc 1.97.1, electron-builder 26.18.0, Runner 0.20.0, Codex CLI 0.170.0, Claude Code 2.1.327.
- `make dev` built the native addon and ran the worktree's `node_modules/electron/dist/Electron.app/Contents/MacOS/Electron` against `http://localhost:1430/`. The running executable's SHA-256 was `92309ac8b73c40e088d994e3857abe1ef17b940c69e6c084f9477b47f4a80555` and `crates/quill-node/index.node` was `b107719baf60c53d7c5599f9b44db30321529b993404cd65dd6bc44323559513`. The process path, Vite endpoint, dev-data path in the startup log, and the Quill 2.0.0 version shown in About confirmed the running candidate.
- Jason authorized the standalone macOS run in the 2026-11-18 Runner handoff for PR #332. The Windows smoke check is outside this QA run.

## Results

| Case | Result | Check and evidence |
| --- | --- | --- |
| APP-01 | Passed | A synchronized launch capture began before Electron started. Frames 1 and 2 show the dark legacy sidebar and library loading. Frame 7 shows the populated 315-book grid, 284 ms after the first captured frame. No white frame appeared in the 12 samples. DevTools Elements showed `<html lang="en" class="dark">`. At 2× capture scale, the red light centers were at y≈44 px in the 44 pt main titlebar and y≈32 px in the 32 pt reader titlebar. All three lights were visible and aligned. `foundations-15-first-frames-{1..12}.jpg`, `foundations-04-root-theme.jpg`, `foundations-08-reader-resumed.jpg`. |
| F-331-ICON, sidebar and Settings → About | Passed | Both rendered the violet rounded tile and off-white Lens Q glyph, including the ring and diagonal tail from `Qn3yN.svg` and `YJzBT.png`. About reported Quill 2.0.0. `foundations-03-main-shell.jpg`, `foundations-02-about-lens-q.jpg`. |
| F-331-ICON, macOS Dock (initial attempt) | Blocked | The window screenshots exclude the OS Dock. Native computer use timed out when opening the Dock by its bundle ID and by name. The separate Electron menu's native About panel showed Electron's stock icon and version. Quill's in-app About showed Lens Q. `foundations-10-native-about.jpg`. |
| F-331-ICON, macOS Dock (follow-up) | Passed | Jason confirmed the Dock icon looked correct and closed this check in the QA conversation on 2026-11-18. |
| F-331-ICON, unpacked bundle | Passed | Rebuilt the Electron bundles and MCP binary, then ran `CSC_IDENTITY_AUTO_DISCOVERY=false QUILL_PACK_ALLOW_DEBUG=1 npx electron-builder --mac --dir --publish never` with the output directory redirected to QA scratch and `node scripts/validate-pack.mjs --dist <QA output>`. The validator passed for arm64. The bundle plist names `icon.icns`, the packaged resource is byte-identical to `build/icons/icon.icns`, and the extracted icon shows the reference Lens Q mark. The icon SHA-256 is `5bcd7d8beac24d1704f3bda198cdbad4c694ed98a3f13900aabfebe56cdaed2f`. `foundations-unpacked-bundle.log`, `foundations-packaged-icon-preview.png`. |
| LIB-01 | Passed | From the library's import control, selected `01-plain-frankenstein.epub` in the native file picker. The count increased from 315 to 316. The new first card showed the Frankenstein cover, title, and Mary Shelley. `foundations-05-import.jpg`. |
| RDR-01 | Passed | Opened the imported EPUB in its own window at page 17 of 327, advanced to page 19 with Right Arrow, closed its window, and opened the same card again. It resumed in Chapter 8 at page 19 with the same visible passage and reader chrome. `foundations-06-reader-open.jpg`, `foundations-07-reader-before-close.jpg`, `foundations-08-reader-resumed.jpg`. |
| LIB-09 | Passed | Used Delete Book from the newly imported card's context menu. The card disappeared and the count returned to 315. After quitting and relaunching with `make dev`, the count was still 315 and the imported card was absent. `foundations-09-after-delete.jpg`, `foundations-11-restart-1.jpg`. |

## Safety, cleanup, and evidence

- With port 1430 free and the dev directory unused, copied `~/Library/Application Support/com.wycstudios.quill-dev` to `~/QuillQA/331-m1/dev-data-backup/` with `ditto` and verified the copy with `diff -qr` before launch.
- Confirmed iCloud Sync was off at the first launch and after each of three relaunches. No settings, authentication, or MCP client entries were changed. The only library item removed was the new test import. The installed and unpacked Quill apps were never launched.
- Used the Frankenstein fixture named in the handoff. Its SHA-256 is `2809c5ba9434a4973735e160aa3d4fa2ff360297a796e3a0f4b1b8d1c1d8693f`, which differs from the regression index. Its EPUB archive integrity passed, and the app rendered its expected title, author, cover and text.
- Quit all four QA-launched instances. Checked the process list for the worktree's Electron, helper and native MCP processes and verified port 1430 was free.
- Screenshots are under `~/QuillQA/331-m1/screenshots/`. The plan, launch logs, first-frame timing, build hashes and unpacked-bundle validation log are under `~/QuillQA/331-m1/evidence/`. The unpacked artifact is under `~/QuillQA/331-m1/unpacked-foundations/`.
