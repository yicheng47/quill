# PR #330 — Packaged reader assets — macOS

## Candidate and environment

- Run: 2026-11-17, 22:37–22:41 Asia/Shanghai (14:37–14:41 UTC).
- PR: https://github.com/yicheng47/quill/pull/330.
- Exact candidate: `1c06c08f629abcec33ab22775bfc5d9492360c5f`.
- Worktree: `/Volumes/samsung/repos/yicheng47/quill/.worktrees/fix-packaged-reader-assets`.
- Working tree was clean before building and throughout live testing. QA added only this uncommitted run record after testing; product code and generated tracked declarations remained unchanged.
- macOS 26.6.2 (25G83), Apple Silicon arm64; Electron 45.3.3, Quill 2.0.0. Unpacked, unsigned macOS arm64 package with debug native artifacts and production Electron/renderer bundles.
- Evidence root: `/Users/jason/QuillQA/330-packaged-reader-assets/`. All screenshots, logs, scripts, fixture copies and disposable data remain there.
- Fixture: an owned copy of `/Users/jason/QuillTestCorpus/01-plain-frankenstein.epub` at `fixtures/01-plain-frankenstein.epub` under the evidence root. The packaged native addon imported it and created an empty local chat titled `PR330 query-route fixture` as setup, using `import_book` and `create_chat`; no AI request was made.
- Fixture book ID: `6a929848-1a0d-49af-a541-306aecf40294`; empty chat ID: `ef9a00bf-632d-499f-ad29-1cc697f2db44`.

## Selected checks and reasons

The independent clean review selected three macOS production-assets checks. APP-01 is narrowed to styled packaged library startup because the renderer base affects the main entry too. The opening portion of RDR-01 checks styled EPUB startup at a nested reader route because that route previously resolved entry assets below `/reader/assets/`. A fresh reader opened with query parameters checks the second affected nested route form. No page-turn, persistence, import, PDF, AI, sync, signed-upgrade or full-regression pass is claimed. Fixture import and the empty chat are setup only; Windows was outside this macOS task.

## Build and isolation

Commands ran from the candidate worktree, with its own `node_modules/` and `target/`; `CARGO_TARGET_DIR` was unset. Every command below passed:

```sh
npx napi build --manifest-path crates/quill-node/Cargo.toml -o crates/quill-node --dts index.d.ts
cargo build -p quill-mcp
npm run electron:build
CSC_IDENTITY_AUTO_DISCOVERY=false QUILL_PACK_ALLOW_DEBUG=1 npx electron-builder --mac --dir --publish never
node scripts/validate-pack.mjs
```

Corresponding evidence: `build-native.log`, `build-mcp.log`, `build-electron.log`, `package.log` and `validate-pack.log` under the evidence root. The author/reviewer's automated checks were already recorded in the PR and were not repeated as part of this live-only task.

The candidate's direct executable was `/Volumes/samsung/repos/yicheng47/quill/.worktrees/fix-packaged-reader-assets/dist-electron/mac-arm64/Quill.app/Contents/MacOS/Quill`. It ran as owned PID 2472 with child-process-only `HOME` and `CFFIXED_USER_HOME` set to `/Users/jason/QuillQA/330-packaged-reader-assets/home-bp_5p4_m`, `TMPDIR` set to that home's `tmp/`, and `ELECTRON_RENDERER_URL` absent. Launch flags were:

```text
--inspect=127.0.0.1:9330
--user-data-dir=/Users/jason/QuillQA/330-packaged-reader-assets/home-bp_5p4_m/Library/Application Support/com.wycstudios.quill-chromium
--enable-logging=file
--log-file=/Users/jason/QuillQA/330-packaged-reader-assets/chromium.log
```

A separate Electron path probe ran before candidate boot and confirmed that `home`, `appData` and `userData` resolved under the disposable home. After candidate launch and before UI actions, read-only main-process inspector diagnostics confirmed the exact executable, `app.isPackaged = true`, `app.getAppPath()` inside the candidate's `app.asar`, no development renderer URL, and these actual runtime paths:

| Resource | Actual path relative to the disposable home |
|---|---|
| Electron appData | `Library/Application Support` |
| Electron userData and sessionData | `Library/Application Support/com.wycstudios.quill-chromium` |
| Rust local library and secrets | `Library/Application Support/com.wycstudios.quill` |
| Electron and Rust logs | `Library/Logs/com.wycstudios.quill` |
| MCP integration lookup targets | `.claude.json` and `.codex/config.toml`, both absent |

The isolated library had no `.icloud_setting` marker; the isolated home had no `Library/Mobile Documents` directory. Code inspection confirmed that startup only resolves the iCloud library when that marker exists and that MCP integration paths use `HOME`. The seed result and Rust startup log confirm the isolated local data and log directories. An open-file audit of the candidate and all owned live descendants found no real production library, iCloud directory/container, or real MCP configuration paths. Evidence: `preflight-paths.json`, `runtime-startup.json`, `seed-result.json`, `candidate-processes.json`, `lsof-before-quit.txt`, `isolation-before-quit.json`, and the isolated `Library/Logs/com.wycstudios.quill/quill.log`.

No real development setting or installed application was operated. No settings were changed manually; the disposable database's only settings row was `language = en`. Reader progress/local UI state remained inside the disposable profile. Sync stayed off, and the fixture chat had zero messages.

## Native results

All interactions and screenshots used the computer-use skill's `@oai/sky` API via `node_repl`, targeting the absolute candidate `.app` path. Inspector access only read main-process identity, paths and window URLs; it did not navigate, create windows or supply UI input. Screenshot and accessibility evidence paths below are relative to the evidence root.

| Required check | Result | Reproduction and observed behavior | Evidence |
|---|---|---|---|
| APP-01, packaged startup only | Passed | Launch the direct executable with the isolated environment. The library at `quill-app://app/` displayed its dark styled sidebar, purple selection/icons, search field and the Frankenstein fixture's cover, title and author. | `01-packaged-library.png`, `01-packaged-library-ax.txt`, `runtime-startup.json` |
| RDR-01, EPUB opening only | Passed | Click the Frankenstein book card. A new reader window (ID 2) opened at `quill-app://app/reader/6a929848-1a0d-49af-a541-306aecf40294`. Styled toolbar and progress footer appeared; Letter I and its opening prose were visibly readable. | `02-reader-plain-startup.png`, `02-reader-plain-startup-ax.txt`, `runtime-reader-plain.json` |
| Query-bearing reader startup | Passed | Close the plain reader with Cmd+W, select Chats in the library, open `PR330 query-route fixture`, then click `Open in Reader`. A new reader window (ID 3) opened at `quill-app://app/reader/6a929848-1a0d-49af-a541-306aecf40294?openChat=true&chatId=ef9a00bf-632d-499f-ad29-1cc697f2db44`. The styled reader, Letter I prose, and styled chat sidebar all appeared. This was fresh document startup, not focus of the already loaded plain reader. | `03-reader-query-startup.png`, `03-reader-query-startup-ax.txt`, `runtime-reader-query.json`; setup screenshots `03a-query-route-chat-fixture.png` and `03b-query-route-open-button.png` |

Each required check passed on its first attempt. No required live check is Failed, Blocked or Skipped, and no required check remains unresolved.

The candidate log also contains a background updater HTTP 404 for the latest release's missing `latest-mac.yml`. No update was requested or applied, and startup/reader checks passed despite the logged error. Signed updates were outside scope; no baseline comparison was made, so this observation is not classified as pre-existing.

## Cleanup and verdict

Native Cmd+Q targeted only the absolute-path QA candidate. The immediate process snapshot still showed shutdown in progress (`cleanup-attempt1.json`); a later verification at 14:41:14 UTC confirmed that PID 2472 and all four tracked descendants were gone (`cleanup.json`). The installed Quill and existing MCP processes were not stopped. All evidence, the copied fixture and isolated data were retained.

NO REMAINING MUST-FIX QA ISSUES for the three selected macOS packaged-startup checks at candidate `1c06c08f629abcec33ab22775bfc5d9492360c5f`. This is a scoped feature pass, not a full regression pass. QA updates the PR description and removes `needs-live-test`; commits, any final-head review, CI, merge and worktree cleanup remain with the operator.
