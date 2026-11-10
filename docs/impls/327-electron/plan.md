# 327 — Electron Migration Plan

Spec: [`docs/features/327-electron-shell.md`](../../features/327-electron-shell.md). Issue: [#327](https://github.com/yicheng47/quill/issues/327). Regression suite: [`docs/tests/regression/`](../../tests/regression/README.md). Upgrade cases: [below](#upgrade-cases).

The spec says *what* and *why*; this plan says how each phase lands, what it touches, and how each phase is proven on its own before the next one builds on it.

## Delivery model

**Phases land on the umbrella branch `feat/327-electron`, one pull request each, while `main` keeps shipping 1.x.** Jason chose this on 2026-11-10, so that `main` stays free for minor fixes and 1.x Tauri releases for the whole migration. Every phase PR targets the umbrella. At the cutover, once phase 8 passes, the umbrella merges into `main` in one pull request and the Electron release ships from `main`.

- **Docs.** The spec, this plan and the regression suite landed on `main` before the umbrella was cut. From then on, the plan's current copy lives on the umbrella: a phase updates it in its own PR, and `main`'s copy catches up at the cutover.
- **Branches.** The umbrella's worktree is `.worktrees/feat-327-electron`. Each phase gets its own branch and worktree from `origin/feat/327-electron` instead of `origin/main`, named `feat/327-p<N>-<slug>`, such as `feat/327-p1-core`. Its PR targets the umbrella, and it catches up by rebasing onto `origin/feat/327-electron`. The phase's mission brief goes in `docs/impls/briefs/327-p<N>-<slug>.md` on that branch.
- **Syncing from `main`.** `main` is merged into the umbrella, never rebased onto: phase PRs have already merged into the umbrella, so rewriting it would break every open phase branch. This is the exception to the rebase rule in `AGENTS.md`. Sync after every 1.x release, before each phase starts, and whenever `main` changes code an open phase is moving. A sync is a `sync/327-<YYYY-MM-DD>` branch cut from the umbrella with `origin/main` merged into it, opened as a PR into the umbrella so CI runs; `ci.yaml` checks pull requests into the umbrella as well as `main`. A sync that resolves conflicts in the core gets the codex reviewer; a clean one merges once CI is green.
- **1.x on `main`.** Fixes and 1.x releases continue as usual. Keep them small, because every change to files a phase has moved costs a conflict at the next sync. A command added on `main` must be registered in the Electron dispatcher in the sync that brings it over; the parity test fails that sync until it is.
- **Cutover.** Phase 8 starts with a final sync, and `main` then freezes: anything urgent still lands on `main`, syncs again, and phase 8 reruns the cases it affects. The release candidate is built from the umbrella's head. Once phase 8 passes, the umbrella merges into `main` as a merge commit, so `main` holds exactly the tree that was tested, and the release is tagged on `main`.
- **Gates.** A phase merges only when its automated gate is green and its live checks have passed. Each phase below lists both. Live checks use case IDs from the regression suite, and a phase records its results in `docs/tests/runs/` (see the suite). From phase 3, each phase also adds Playwright end-to-end tests for the cases it touches that a test can judge, and those run in its automated gate.
- **Crews.** Each phase is one mission, and Jason confirms the crew before each start (`AGENTS.md`, Crew Missions). Any phase with live checks runs as the claude trio. Phase 0's baseline and phase 8 are qa-only missions.
- **Labels.** Phase PRs that touch data-directory resolution, sync boot or secrets carry `core-review`: phases 1, 3 and 7. The cutover PR carries `core-review` and `risk-high`.

```
main               ─┬── P0 ─ 1.x fixes and releases ──────────────────────┬──► release ──► P9
                    │              │ sync             │ sync              ▲
                    │              ▼                  ▼                   │ cutover PR
feat/327-electron   └── P1 ∥ P2 ──► P3 ──► P4 ∥ P5 ──► P6 ──► P7 ──► P8 ──┘
```

Phase 0 runs on `main`, since the baseline is today's app. Phases 1 and 2 run in parallel on the umbrella, and phases 4 and 5 run in parallel after phase 3. Phase 9 lands on `main` after the release.

## Target architecture

```
Electron main process (TypeScript, electron/main/)
 ├─ windows, menus, lifecycle, protocol, updater, dialogs, shell
 ├─ ipcMain.handle("quill:invoke")  ──►  quill-node (napi-rs, Rust)
 │                                        └─ quill-core: commands, db, sync, ai, mcp
 │   events  ◄── EventSink callback ──────┘   (one tokio runtime, off the JS thread)
 └─ quill-file:// protocol ──► book and cover files in the data and iCloud dirs

Renderer (React, unchanged) ──► src/platform (interface)
                                 ├─ electron impl ── contextBridge preload (electron/preload/)
                                 └─ tauri impl ───── @tauri-apps/* (removed in P9)

quill-mcp (Rust binary, bundled) ── stdio MCP server for Claude Code and Codex
```

Workspace after phase 3:

- `crates/quill-core/` — everything in today's `src-tauri/src` except the Tauri glue. No `tauri` dependency.
- `src-tauri/` — the Tauri shell, reduced to command wrappers, setup, menus and windows. Deleted in phase 9.
- `crates/quill-node/` — the napi-rs module: `init`, `invoke`, and event subscription.
- `crates/quill-mcp/` — the stdio MCP server binary. Today it is `quill mcp` inside the app binary.
- `electron/` — main process, preload, electron-builder config.
- `src/platform/` — the frontend's only path to the shell.
- `e2e/` — Playwright end-to-end tests and their fixture books.

## Phase 0 — Regression suite and Tauri baseline

**Goal:** a fixed definition of "the app works", measured on today's shell before anything moves.

**Work:**

1. **A permanent suite.** The [regression suite](../../tests/regression/README.md) lives in `docs/tests/regression/` and outlasts #327: `AGENTS.md`'s Test Scope selects live checks from it, and every release runs its smoke tier. The [upgrade cases](#upgrade-cases), which matter only for this migration, stay in this plan. A doc-only commit to `main` before the baseline runs.
2. **Vitest in CI.** The frontend job in `ci.yaml` runs `npm test`. CI runs only `tsc` and lint today, so the 30 Vitest tests never run there, and phase 2's gate relies on them. A one-line pull request, done inline.
3. **Test corpus.** Assemble the files the suite names, kept outside the repo where Jason chooses.
4. **Baseline run.** Pin one commit on `main` as the candidate, and run the suite against the Tauri development app built from it:
   - every `dev` case on macOS, through computer use
   - the `win` instances on the Windows machine
   - LIB-04 and APP-06 in the signed environment, once Jason prepares it
   - the sync cases in Jason's environment
   - the measurements: sizes from the latest release's artifacts, and memory and cold start in the signed environment, since a debug build is not representative

   Phases 1 and 2 do not change behavior, so they can start while the baseline runs; their own live checks queue behind it for the screen.

**Gate:** a baseline record in `docs/tests/runs/`, with every case Passed, Failed (with an issue filed or linked), or Blocked with the reason. Pre-existing failures are baseline facts, not migration regressions. A case blocked on an environment runs once Jason sets it up, and at the latest before the first phase whose gate compares against it: phase 6 for the signed cases, phase 8 for Windows and sync.

**Crew:** inline for steps 1–3. The baseline is a qa-only mission: the codex `qa` role, through computer use, in the Tauri development app. Jason runs or sets up the signed, Windows and sync instances.

## Phase 1 — Rust core out of Tauri

**Goal:** the Rust core builds and is tested without Tauri, so a second shell can load it. Behavior does not change.

**Work:**

1. Turn `src-tauri/` into a Cargo workspace member, and move `db`, `secrets`, `sync`, `ai`, `mcp`, `epub`, `pdfium`, `icloud`, `error` and the command bodies into `crates/quill-core`.
2. Replace `tauri::AppHandle` with a small `EventSink` trait in the core. It has two methods: `emit(event, payload)` for everything, and `emit_to(window, event, payload)` for window-scoped events such as `open-settings` and `book-availability-changed`. Today `AppHandle` reaches the core only to emit events: in the AI providers, `sync/replay.rs`, `mcp/notify.rs`, and the ai, sync, oauth, settings, translation and app commands.
3. Replace Tauri's managed state with a `Core` struct that owns `Db`, `Secrets`, `DeviceIdentity`, `SyncWriter`, `SyncState` and `LocalDir`. Core command functions take `&Core` and typed arguments.
4. Move app setup out of `lib.rs` (`run()` → `setup`) into `quill_core::boot(config)`. That covers resolving local and data directories, the stale-marker self-heal, the sync boot thread, the cover writer and the MCP notify watcher. The shell passes in what used to come from Tauri: the app-data base directory, the log directory, and whether this is a development build. Today `cfg!(debug_assertions)` decides the `-dev` suffix; from now on the shell decides.
5. Keep each `#[tauri::command]` as a thin wrapper that calls the core function. The handler list in `generate_handler!` stays identical.
6. Move `quill mcp` into the `crates/quill-mcp` binary. The app binary keeps its `mcp` argument, which delegates to the same function, so existing configs keep working.

**Gate:**

- Automated: `cargo test` across the workspace passes with every existing test kept. `cargo clippy -- -D warnings` passes. `cargo tree -p quill-core` contains no `tauri`. The frontend is untouched.
- Live checks: the smoke tier on the Tauri development app, plus MCP-01. The refactor touches every command, the boot sequence and the MCP entry point.

**Crew:** claude trio. Labels: `core-review` and `risk-high`.

## Phase 2 — Frontend platform layer

**Goal:** the frontend talks to the shell through one interface, so phase 3 only has to add a second implementation. Behavior does not change.

**Work:**

1. Add `src/platform/` with a typed interface covering everything the 26 Tauri-importing files use:
   - `invoke` and `listen`, both global and for the current window
   - windows: open or focus a reader window by label, get or focus the main window, show, unminimize, set title, start dragging, close
   - webview zoom
   - file drag and drop
   - the open-file dialog
   - `openUrl` and reveal in Finder or Explorer
   - app version
   - the updater: check, download and install, relaunch
   - file URLs, replacing `convertFileSrc`
   - menu events
2. Add `src/platform/tauri/`, implemented with today's calls, and switch every call site over. Leave the 112 `invoke` and `listen` call sites' command names and arguments untouched; only their import changes.
3. Add an ESLint `no-restricted-imports` rule that forbids `@tauri-apps/*` outside `src/platform/tauri/`.
4. Move the Vitest mocks from `@tauri-apps/api` to `src/platform`.

**Gate:**

- Automated: `tsc`, lint (including the new rule) and `npm test` pass in CI.
- Live checks: the smoke tier on the Tauri development app, plus RDR-08, RDR-09, LIB-03, APP-03 and SET-03. Those exercise the window, zoom, drag-drop, update-check and opener paths that moved.

**Crew:** claude trio. Label: `risk-medium`.

## Phase 3 — Electron shell

**Goal:** `make electron-dev` runs the full app in Electron against the development data, end to end. It is not yet polished and not yet packaged.

**Work:**

1. **Tooling.** Pin an exact Electron version. Use electron-vite for the main, preload and renderer builds, with the renderer reusing `vite.config.ts`, and electron-builder for packaging, which phase 6 configures fully. Add `make electron-dev`, and give the Electron dev server a fixed port. It shares development data with the Tauri dev app, so only one of them runs at a time.
2. **`quill-node`.** A napi-rs module exposing:
   - `init(config)`, which runs `quill_core::boot`
   - `invoke(command, argsJson)`, which returns a Promise of JSON
   - `subscribe(callback)`, which delivers events through a thread-safe function

   The dispatcher must accept exactly what Tauri accepts. Arguments arrive with camelCase keys, as Tauri 2 converts them by default. Return values use the same serde output. Errors must serialize to the same shape the frontend already parses, including codes such as `AI_NOT_CONFIGURED`. Every command runs on the core's tokio runtime, never on the JS thread. Panics are caught at the dispatcher boundary and returned as errors, so a bug cannot take down the main process.
3. **Parity test.** A Rust test asserts that the dispatcher's command table equals the Tauri `generate_handler!` list, so a command added to one shell and not the other fails CI. Golden tests check argument casing and error shapes on a few commands.
4. **Main process.**
   - Create the main window and reader windows, keyed by the same labels: `main` and `reader-*`.
   - Handle `ipcMain` for invoke.
   - Route events: global events go to every window; `emit_to` events go to the window with that label.
   - Register a privileged `quill-file://` protocol in place of Tauri's asset protocol. Serve only files inside the app-data and iCloud directories, as the current asset scope does, and support range requests for large PDFs.
   - Keep Chromium's own profile (`userData`) in its own directory, never inside the core's data directory. The development build gets a separate profile.
5. **Preload and `src/platform/electron/`.** A minimal `contextBridge` surface with context isolation on, the renderer sandboxed and no Node integration in the renderer. Select the platform implementation at build time.
6. **Data directory.** The core receives the same base path Tauri used: `~/Library/Application Support/com.wycstudios.quill` on macOS and `%APPDATA%\com.wycstudios.quill` on Windows, with `-dev` for the development build. A test pins both paths against the values `lib.rs` resolves today.
7. **End-to-end tests.** Playwright drives the Electron app through its Electron support (`_electron.launch`), from `e2e/`, with a `make e2e` target.
   - **Isolated data.** The main process accepts a test data directory from the environment (`QUILL_TEST_DATA_DIR`) and uses it as both the core's base directory and Chromium's profile. A run then starts from an empty library and never sees the development or production data. Today the data path comes only from `HOME` or `APPDATA` plus the identifier (`src-tauri/src/lib.rs`); after phase 1 the shell passes it to `boot`, so the override lives in the shell.
   - **Fixtures.** Small EPUB and PDF files, generated for the tests or in the public domain, committed under `e2e/fixtures/`. The regression corpus stays outside the repo.
   - **Stubs.** The open-file dialog is stubbed in the main process (`electronApp.evaluate` on `dialog.showOpenDialog`). AI uses the Ollama provider pointed at a local mock server through the existing `ai_base_url` setting, which needs no API key, so no test calls a real model.
   - **Book content.** foliate-js renders inside closed shadow roots (`paginator.js`, `fixed-layout.js`, `pdf-scroll.js`), which selectors cannot enter. Tests reach book text through `page.frames()` and pointer coordinates, behind shared helpers.
   - **First tests:** APP-01, LIB-01 and RDR-01. RDR-01 also compares screenshots of the first page of an EPUB and a PDF, with per-platform baselines generated on the CI runners. Because the engine is pinned, these screenshots change only when Quill changes them or bumps Electron.
   - **The suite** gains an Auto column naming the test that covers each automated case.

**Gate:**

- Automated: the parity and golden tests, the workspace tests, and a CI job that builds `quill-node` and the Electron app on macOS and Windows and runs the end-to-end tests.
- Live checks, on the Electron development app with the same dev library the Tauri dev app uses: the smoke tier plus RDR-02, RDR-03, RDR-05, RDR-07, AI-02, AI-03, AI-05, VOC-01, LIB-05 to LIB-09 and SET-01. qa also records PDF selection quality and large-book timing (RDR-05, RDR-10) against the baseline, which is the first evidence for the motivation.

**Crew:** claude trio. Labels: `core-review`, because it touches data-directory resolution, and `risk-high`.

## Phase 4 — Desktop integration parity

**Goal:** the Electron app behaves like the Tauri app everywhere outside the web content.

**Work:**

- **Menus:** the default app, Edit, View and Window menus; "Check for Updates…" next to About on macOS and under Help on Windows; "Reveal Logs" under Help. Keep the English-at-boot behavior unless localizing is trivial in Electron.
- **macOS window chrome:** a hidden-inset titlebar with traffic lights repositioned for app zoom, replacing `window_set_titlebar_zoom` and its `objc2-app-kit` observer. Windows use the same drag regions (#321).
- **Window lifecycle:**
  - On macOS, closing the main window hides it, the dock click reopens it, and ⌘Q quits.
  - On Windows, closing the main window closes every window.
  - `app_ready` shows a window only once it has painted, so there is no white flash.
- **File opening:**
  - On macOS, `open-file` events (file associations, dropping a file on the dock) feed the existing `file-open` event.
  - On Windows, a second-instance launch with file arguments does the same, under a single-instance lock.
  - Drag and drop onto the library window, replacing `onDragDropEvent`.
- **Zoom:** app zoom and reader zoom, scoped per window as today (#318, #319), through `webContents` zoom.
- **Logging:** the Rust log keeps the same log directory, rotation and file name. The panic hook stays in the core. Main-process errors go to the same log.
- **Security:** a strict CSP for the renderer, navigation and new-window blocking (links open through `openUrl`), and no remote content.

**Gate:**

- Automated: unit tests for the event routing and window-label logic. End-to-end tests for RDR-08, RDR-09 and APP-03's menu actions, which read window focus and zoom levels from `webContents` and trigger menu items through the application menu in the main process.
- Live checks: APP-01 to APP-05, LIB-03, RDR-08, RDR-09 and SET-03 on the Electron development app, on macOS and Windows. File opening is exercised with `open -a` against the development build; the installed file association (LIB-04) is checked in phase 6.

**Crew:** claude trio. Label: `risk-medium`.

## Phase 5 — MCP server and integrations

**Goal:** Claude Code and Codex keep working with Quill under Electron, including configs written by the Tauri app.

**Work:**

- Bundle `quill-mcp` inside the app: in `Contents/MacOS/` on macOS and next to the executable on Windows. The integration toggles and the config snippet write its path. They no longer use `current_exe() mcp`, because under Electron `current_exe()` is Electron itself.
- **Shim for old configs.** Configs written by the Tauri app run `/Applications/Quill.app/Contents/MacOS/quill mcp`. Under Electron, that path launches the Electron executable with `mcp`. On a case-insensitive volume `quill` resolves to `Quill`; otherwise the bundle keeps a `quill` executable name. The main process detects `mcp` before creating any window or dock icon and hands stdio to `quill-mcp`.
- **Repair on first launch.** When Quill's entry in `~/.claude.json` or the Codex config points at an old Quill path, rewrite it to `quill-mcp`. The shim is then only a safety net. Only the production build repairs: the development build writes the same `quill` entry, so a repair from it would repoint Jason's real integration at the development app.
- The MCP notify watcher still pushes changes made through MCP into the open app.

**Gate:**

- Automated: unit tests for the config rewrite, covering present, absent, already current and foreign entries, and the existing `mcp.rs` tests. An end-to-end test for MCP-02's second half: a book added through `quill-mcp` against the test data directory appears in the running app.
- Live checks: MCP-01 and MCP-02 with a real `claude` and `codex`, and both a fresh config and a Tauri-written one, with both config files backed up and restored as the suite describes.

**Crew:** claude trio. Label: `risk-medium`.

## Phase 6 — Packaging, signing and updates

**Goal:** a signed, notarized Electron release candidate that installs and updates itself, built by CI and not yet published.

**Work:**

- **electron-builder on macOS:**
  - DMG and zip for arm64 and x64; Electron's updater needs the zip.
  - Hardened runtime, `Entitlements.plist` with the iCloud container, and the embedded provisioning profile, mirroring today's `tauri.conf.json` bundle settings.
  - Notarization.
  - `libpdfium.dylib`, the `.node` module and `quill-mcp` signed inside the bundle.
- **electron-builder on Windows:** an NSIS installer for x64, with `pdfium.dll`. Windows signing stays as it is today, which is unsigned unless Jason decides otherwise.
- **File associations** for EPUB and PDF, carried over from today's config.
- **Updates:** Electron's updater reads GitHub releases. Prove it between two candidate builds against a staging feed, not the public one.
- **CI:** a release workflow that builds the Electron artifacts into a draft release, alongside the existing Tauri `release.yml` until phase 7 switches them over. The end-to-end job also runs against the packaged, unsigned app, which catches what only packaging breaks: native module loading, bundled paths and the file protocol. Candidates build from the umbrella, so they cannot use `workflow_dispatch`, which runs only workflows on the default branch. They build from a pre-release tag such as `v2.0.0-rc.1` on an umbrella commit instead, and since `release.yml` fires on every `v*` tag, it must skip `rc` tags until phase 7 replaces it.
- **Measurements:** app size, memory and cold start, compared with the phase 0 baseline.

**Gate:**

- Automated: the CI workflow produces every artifact.
- Signing checks: `codesign --verify --deep --strict`, `spctl -a -vv` and `codesign -d --entitlements -` show the iCloud container on the candidate.
- Live checks, in the environment Jason prepares for signed builds (see the suite): APP-01, APP-06 (Electron to Electron update), LIB-04, and one case each from RDR and AI on the installed candidate.

**Crew:** claude trio, with Jason for the signing secrets and the test environment. Label: `risk-high`.

## Phase 7 — Upgrade bridge from Tauri

**Goal:** a user on the last Tauri release upgrades in place through the update they are already offered, and lands in the Electron app with everything intact.

**Work:**

- **macOS.** The Tauri updater reads `latest.json`, downloads the `.app.tar.gz`, checks its minisign signature against the key in `tauri.conf.json`, and replaces the app bundle. The cutover release publishes a `latest.json` whose macOS entries point at the Electron app as a `.app.tar.gz`, signed with the same minisign key, so the installed Tauri app installs Electron as an ordinary update.
- **Windows.** The Tauri updater runs the installer named in `latest.json`. The Electron installer must take over the Tauri install: the same install directory or a clean removal of the old one, no duplicate Start-menu or uninstall entries, and the same app-data directory. Investigate the two installers' defaults first, and record the chosen path here.
- **First launch of the Electron build:**
  - the MCP config repair from phase 5
  - a one-time check that the data directory, `secrets.db` and the sync marker were found where Tauri left them, logged so a failed upgrade is diagnosable
  - no data copy or move of any kind
- **Release pipeline.** `release.yml` switches to the Electron build. The cutover version is Jason's call; a runtime change suggests 2.0.0.
- **Docs.** `AGENTS.md` (Stack, Development Commands), `docs/arch/overview.md` (runtime picture, boot sequence, MCP), and the README.

**Gate:**

- Automated: tests for the `latest.json` generation and for the first-launch checks.
- Live checks, in Jason's test environment, from an installed Tauri 1.3.x with a populated library: the [upgrade cases](#upgrade-cases), UPG-01, UPG-02 and UPG-04 on macOS, and UPG-01 and UPG-03 on Windows.

**Crew:** claude trio, with Jason. Labels: `core-review` and `risk-high`.

## Phase 8 — Final QA

**Goal:** prove the release candidate against the whole suite before Jason publishes it. The phase opens with the final sync and the freeze on `main`, and closes with the cutover PR (see [Delivery model](#delivery-model)).

**Work:** run every required case in the regression suite on the signed release candidate:

- macOS on Apple Silicon and Intel
- Windows x64
- the sync cases in Jason's sync environment
- the [upgrade cases](#upgrade-cases) from Tauri
- the measurements

The end-to-end tests run first, against the candidate in the signed environment. Computer use then covers every case they do not, and everything the suite keeps with computer use.

Compare each result with the phase 0 baseline. A failure goes back to a fix mission, and the affected cases rerun on the new candidate. The phase passes when every required case passes, or a difference is accepted by Jason in writing in the run record.

**Crew:** qa only, with Jason for sync and the Windows machine. Jason publishes the release; nothing in this program publishes it.

## Phase 9 — Remove Tauri

Once the Electron release is live and its first patch window has passed without a rollback, delete:

- the `src-tauri` shell
- the `@tauri-apps/*` dependencies and `src/platform/tauri/`
- the Tauri parity test
- the Tauri release jobs

For at least one release after the cutover, keep publishing a Tauri-format `latest.json` that points at the current Electron build, and keep the minisign key. That way Tauri installs that skipped the cutover release still get bridged.

**Gate:** CI green, including the end-to-end tests; the smoke cases they do not cover, on the Electron development app. **Crew:** claude duo. Label: `risk-medium`.

From here the end-to-end tests are a regression gate on every pull request, and a release's smoke run needs computer use only for the cases they do not cover.

## Upgrade cases

These matter only for this migration, so they live here instead of the regression suite. They run in phases 7 and 8, in Jason's environment, and are recorded like any suite case.

| ID | Platforms | Check |
|---|---|---|
| UPG-01 | mac, win | From an installed Tauri 1.3.x with a populated library, update in-app. Electron opens with the same books, progress, highlights, bookmarks, vocabulary, chats, collections and settings, and AI works without re-entering API keys or signing in again. |
| UPG-02 | mac | An MCP integration enabled before the upgrade still answers afterwards, and its config now points at `quill-mcp`. |
| UPG-03 | win | On Windows, the old install is replaced: one app, one Start-menu entry, one uninstall entry, and the data is intact. |
| UPG-04 | mac | A sync-enabled install upgrades and keeps syncing with a second device, with no duplicate events and no re-copy of the library. |

## Risks

- **iCloud under Electron.** Entitlements and the provisioning profile must be on the main executable, which loads the core in-process. Phase 6's entitlement check and phase 8's sync cases cover this. A helper process was rejected for this reason.
- **Main-process stalls.** A synchronous napi call would block every window. `quill-node` exposes no synchronous command entry point: every command goes through the async dispatcher on the core's tokio runtime (phase 3).
- **Silent IPC drift.** Argument casing or error shapes that differ from Tauri's would break call sites quietly. The phase 3 golden tests and parity test catch this.
- **Umbrella drift.** The longer the umbrella lives, the more 1.x work it has to absorb. Phase 1 moves every Rust file and phase 2 rewrites every Tauri import, so a sync after them can conflict wherever `main` touched the same code. Frequent small syncs, small 1.x changes, and phases 3–8 kept moving keep this bounded.
- **Two shells on the umbrella.** Every new command and platform call needs both implementations until phase 9, including those that arrive from `main` in a sync. The parity test and the ESLint rule enforce it.
- **Windows upgrade path.** This is the least known part. Phase 7 investigates before it builds.
- **Size and memory.** Electron is larger. Phase 6 measures, and the spec treats this as something to report rather than a gate.
- **Chromium upgrades.** After the cutover, every Electron bump is a deliberate change with its own smoke-tier run, which is the point of the migration. The end-to-end screenshots turn most of that run into a CI result.
- **Playwright's Electron support is labeled experimental.** The tests add to the live checks and replace none of them until they have proven stable in CI; computer use remains the fallback for any case.

## Open questions for Jason

- **Cutover version.** 2.0.0 is suggested.
- **Intel Macs.** Keep separate arm64 and x64 builds, as today, or ship one universal build?
- **Test environments.** A separate macOS user account or VM for signed candidates and upgrade tests, so the real library is never touched. A Windows machine for the Windows cases. An iCloud setup for the sync cases.
- **Test corpus.** Where the corpus lives, and whether it comes from the NAS library or from public-domain books.
