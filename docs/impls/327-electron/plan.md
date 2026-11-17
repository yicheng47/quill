# 327 — Electron Migration Plan

Spec: [`docs/features/327-electron-shell.md`](../../features/327-electron-shell.md). Issue: [#327](https://github.com/yicheng47/quill/issues/327). Regression suite: [`docs/tests/regression/`](../../tests/regression/README.md).

The spec says *what* and *why*; this plan says how the two missions land and how each is proven. Quill's users today are mainly Jason, so the plan keeps only the safeguards that protect his own data and integrations, and drops the upgrade machinery a wider user base would need (Jason, 2026-11-17).

## Delivery model

- **One branch, one pull request.** Both missions work on `feat/327-electron` in `.worktrees/feat-327-electron`, and #328 merges it into `main` once mission 2 passes. The branch catches up by rebasing onto `origin/main`, as any branch does.
- **`main` during the migration.** Small 1.x fixes may still land and ship from `main`. Mission 1 deletes `src-tauri/`, so a fix to Rust code on `main` is carried over by hand into the matching `crates/` file at the next rebase.
- **Briefs.** Each mission's brief goes in `docs/impls/briefs/327-m<N>-<slug>.md` on the branch.
- **Crews.** Both missions are claude trios, because both need live checks. Jason confirms the crew before each start.
- **Labels.** #328 carries `core-review` (data-directory resolution, sync boot and secrets move) and `risk-high`.
- **Baseline.** There is no separate baseline run. When a result looks different, qa compares it with the 1.x app built from `main` (`make dev` in the root checkout), which uses the same development data. Only one development app runs at a time.

## Target architecture

```
Electron main process (TypeScript, electron/main/)
 ├─ windows, menus, lifecycle, protocols, updater, dialogs, shell
 ├─ ipcMain.handle("quill:invoke")
 │   ├─ shell window commands (app_ready, window_set_titlebar_zoom)
 │   └─ core commands ──► quill-node (napi-rs, Rust)
 │                         └─ quill-core: commands, db, sync, ai, mcp
 │   host callbacks ◄── ShellHost (emit, emit_to, open_url, reveal_path)
 │                      (one tokio runtime, off the JS thread)
 ├─ quill-app:// protocol  ──► bundled renderer + foliate-js with SPA fallback
 └─ quill-file:// protocol ──► book and cover files in local_dir and icloud_dir

Renderer (React, unchanged) ──► src/platform ── contextBridge preload (electron/preload/)

quill-mcp (Rust binary, bundled) ── stdio MCP server for Claude Code and Codex
```

Workspace after mission 1:

- `crates/quill-core/` — everything in today's `src-tauri/src` except the Tauri glue. No `tauri` dependency.
- `crates/quill-node/` — the napi-rs module: `init`, `invoke`, and event subscription.
- `crates/quill-mcp/` — the stdio MCP server binary. Today it is `quill mcp` inside the app binary.
- `electron/` — main process, preload, electron-builder config.
- `src/platform/` — the frontend's only path to the shell.
- `src-tauri/` and `@tauri-apps/*` — deleted.

## Mission 1 — Electron app in development

**Goal:** `make dev` runs the full app in Electron against the development data, end to end, with Tauri gone. Not yet signed or packaged for release.

**Work:**

1. **Rust core.** Make a Cargo workspace and move `db`, `secrets`, `sync`, `ai`, `mcp`, `epub`, `pdfium`, `icloud`, `error` and the command bodies into `crates/quill-core`.
   - Replace `tauri::AppHandle` with a `ShellHost` trait: `emit(event, payload)`, `emit_to(window, event, payload)` for window-scoped events such as `open-settings` and `book-availability-changed`, `open_url(url)` for `openai_oauth_login`, and `reveal_path(path)` for `reveal_logs`.
   - Replace Tauri's managed state with a `Core` struct that owns `Db`, `Secrets`, `DeviceIdentity`, `SyncWriter`, `SyncState`, `LocalDir` and the host. Command functions take `&Core` and typed arguments.
   - Move setup out of `lib.rs` into `quill_core::boot(config)`: data-directory resolution, the stale-marker self-heal, the sync boot thread, the cover writer and the MCP notify watcher. `BootConfig` carries the app-data base directory, the log directory, whether this is a development build (the `-dev` suffix, decided by the shell instead of `cfg!(debug_assertions)`), the `quill-mcp` binary path (used by `commands/mcp.rs` instead of `current_exe()`, which is now Electron), and an optional pdfium path.
   - Move `ensure_pdfium` from `src-tauri/build.rs` into `crates/quill-core/build.rs`, so `PDFIUM_DEV_LIB_PATH` still resolves in `cargo test` and in development.
   - The log keeps its directory, rotation and file name; the panic hook stays in the core.
2. **`quill-mcp`.** The stdio server as its own binary. It runs with no shell, so it keeps its own `cfg!(debug_assertions)` dev/prod suffix, and accepts an optional ignored `mcp` argument.
3. **`quill-node`.** A napi-rs module:
   - `init(config, hostCallbacks)` wires `ShellHost` through thread-safe functions (`open_url` via `shell.openExternal`, `reveal_path` via `shell.openPath`) and runs `boot`.
   - `invoke(command, argsJson)` returns a Promise of JSON. It accepts exactly what Tauri accepted: camelCase argument keys, the same serde output, and errors in the shape the frontend parses, including codes such as `AI_NOT_CONFIGURED`. Every command runs on the core's tokio runtime, never on the JS thread, and there is no synchronous entry point. Panics are caught and returned as errors.
   - Golden tests pin argument casing and error shape on a few commands. A test asserts the dispatcher's command table matches the command names the frontend invokes, so nothing from `generate_handler!` is dropped in the move.
4. **Main process.**
   - Main and reader windows keyed by the same labels (`main`, `reader-*`), passing `--quill-window-label=<label>` in `additionalArguments` so the preload exposes the label synchronously at module load.
   - `ipcMain` handles invoke, runs `app_ready` and `window_set_titlebar_zoom` against `BrowserWindow.fromWebContents(event.sender)`, and forwards everything else to `quill-node`. Events, including renderer-originated `emitTo`, go to every window or to the labeled one.
   - A privileged `quill-app://` scheme (`standard`, `secure`, `supportFetchAPI`, `corsEnabled`, `stream`) serves the built renderer and `foliate-js/` with SPA fallback to `index.html`. Never `loadFile`: `file://` breaks `<BrowserRouter>` routes and root-relative `/foliate-js/view.js` imports, and only shows up once packaged.
   - A privileged `quill-file://` scheme replaces Tauri's asset protocol: `realpath` the request, then require it inside the app-data or iCloud directory, with range requests.
   - Chromium's profile (`userData`) stays in its own directory, never inside the core's data directory, with a separate one for development.
   - Navigation and new-window blocking; links open through `openUrl`. No CSP, matching Tauri's `csp: null`.
   - The data directory is the one Tauri used: `~/Library/Application Support/com.wycstudios.quill` and `%APPDATA%\com.wycstudios.quill`, with `-dev` for development. A test pins both.
   - When `quill-theme` is not yet in `localStorage` (first Electron launch), `App.tsx` waits for `get_all_settings` to apply the stored theme before `app_ready`, with a short timeout, so dark mode does not flash light.
5. **Preload and `src/platform/`.** A minimal `contextBridge` surface with context isolation, a sandboxed renderer and no Node integration. `src/platform/` covers everything the Tauri-importing files use today: `invoke`, `listen` (global and current window), `emitTo`, a synchronous `getWindowLabel()`, opening or focusing reader windows, the main window, show, unminimize, set title, close, `onWindowResized` in CSS pixels, webview zoom, file drops, the open-file dialog, `openUrl`, reveal, app version, the updater and relaunch, file URLs in place of `convertFileSrc`, and menu events. The `invoke` and `listen` call sites keep their command names and arguments; only the import changes. The Vitest mocks move from `@tauri-apps/api` to `src/platform`.
6. **Desktop integration.**
   - **Menus:** the app, Edit, View and Window menus; "Check for Updates…" next to About on macOS and under Help on Windows; "Reveal Logs" under Help.
   - **Chrome:** on macOS, `titleBarStyle: "hiddenInset"` with the traffic lights repositioned for app zoom, replacing the `objc2-app-kit` observer; on Windows, the native titlebar. `[data-tauri-drag-region]` becomes `-webkit-app-region: drag` (#321), with `no-drag` on `button, input, select, textarea, a, [role="button"]` inside it, since `Home.tsx` puts the Grid/List toggle in a drag region.
   - **Lifecycle:** on macOS, closing the main window hides it, the dock click reopens it, and ⌘Q quits; on Windows, closing the main window closes every window. A window shows only once painted. Single-instance lock.
   - **Opening files:** macOS `open-file` events and Windows second-instance arguments feed the existing `file-open` event. Drops resolve paths through `webUtils.getPathForFile` in the preload, with enter/leave depth tracked at the window so the overlay does not flicker.
   - **Zoom:** app and reader zoom, per window as today (#318, #319), through `webContents` zoom.
7. **MCP.** The integration toggles and the config snippet write the `quill-mcp` path. In development that is the cargo-built binary.
8. **Tooling.** Pin exact Electron and `electron-vite` versions; `electron-vite` must support Vite 7 and `@tailwindcss/vite` 4, with the renderer reusing `vite.config.ts`. `make dev` starts Electron on Vite's fixed port 1430. CI builds `quill-node` and runs the Rust and frontend checks on macOS and Windows, with Node 22 and `submodules: true` on checkout.
9. **Delete Tauri.** `src-tauri/`, the `@tauri-apps/*` dependencies, the Tauri jobs in `ci.yaml`, and Tauri-specific `Makefile` targets.

Before the first Electron launch against the development data, copy `~/Library/Application Support/com.wycstudios.quill-dev` aside.

**Gate:**

- Automated: `cargo test` and `cargo clippy -- -D warnings` across the workspace with every existing test kept; the golden and command-table tests; `tsc`, lint and `npm test`; CI green on macOS and Windows.
- Live checks, in the Electron development app on macOS: the smoke tier, plus RDR-02, RDR-03, RDR-05, RDR-07, RDR-08, RDR-09, LIB-03, LIB-05 to LIB-09, AI-02, AI-03, AI-05, VOC-01, SET-01, SET-03, APP-01 to APP-05, MCP-01 and MCP-02. qa notes PDF selection and large-book timing (RDR-05, RDR-10) against the 1.x app, the first evidence for the motivation. On Windows, Jason launches the development app once and runs the smoke tier.

## Mission 2 — Ship it

**Goal:** a signed, notarized 2.0 release built by CI, installed by hand over 1.x on Jason's Mac, and updating itself from then on.

**Work:**

- **macOS, electron-builder:** DMG and zip, separate `arm64` and `x64` builds (the zip is what the updater downloads). Hardened runtime and `embedded.provisionprofile`, with two entitlement files:
  1. `entitlements.mac.plist`, for `Quill.app` only: today's iCloud/ubiquity, `application-identifier` and `team-identifier` keys plus `com.apple.security.cs.allow-jit` (and `allow-unsigned-executable-memory` if V8 needs it).
  2. `entitlements.mac.inherit.plist` (`entitlementsInherit`), for the `Quill Helper*.app` bundles and `quill-mcp`: the JIT keys only, with no iCloud or `application-identifier`. The provisioning profile covers only `com.wycstudios.quill`, so those keys on a helper make `amfid` kill it at launch.
  `libpdfium.dylib`, the `.node` module and `quill-mcp` are signed inside the bundle with the same Team ID, and the app is notarized.
- **Windows, electron-builder:** an NSIS installer for x64 with `pdfium.dll` and `quill-mcp.exe`, unsigned as today.
- **File associations** for EPUB and PDF, as today.
- **Updates:** `electron-updater` against GitHub releases (`latest-mac.yml` + zip, `latest.yml` + installer). The 2.0 release publishes no Tauri `latest.json`, so 1.x installs are not offered it.
- **MCP config repair.** On first launch, the production build rewrites Quill's entry in `~/.claude.json` and the Codex config when it points at an old Quill path, so it runs `quill-mcp`. The development build never repairs, because its entry would repoint the real integration at the development app. Unit tests cover present, absent, already current and foreign entries.
- **Release workflow.** `release.yml` builds the Electron artifacts into a draft release on a `v*` tag. Pre-release tags (`v2.0.0-rc.N`) build GitHub pre-releases, which 1.x's `releases/latest` endpoint never sees.
- **Docs.** `AGENTS.md` (Stack, Project Map, Development Commands, Worktrees), `docs/arch/overview.md` (runtime picture, boot sequence, MCP) and the README, with the manual upgrade steps for the release notes.

**Gate:**

- Automated: CI produces every artifact; the config-repair tests pass.
- Signing: `codesign --verify --deep --strict`, `spctl -a -vv`, and `codesign -d --entitlements -` showing the iCloud container on `Quill.app` and not on `Quill Helper*.app` or `quill-mcp`; helpers and `quill-mcp` launch cleanly.
- Update: an installed `v2.0.0-rc.1` updates itself to `rc.2` and relaunches.
- Jason's install, by Jason, after copying `~/Library/Application Support/com.wycstudios.quill` aside: 2.0 over 1.3.x in `/Applications`. The library, progress, highlights, bookmarks, vocabulary, chats, collections and settings are intact, AI works without signing in again, MCP answers from `claude` and `codex`, and sync keeps working with his other device. LIB-04 (file association) on the installed app. On Windows, uninstall 1.x keeping its app data, install 2.0, and run the smoke tier.
- App size and memory are noted in #328 against 1.3.x, not gated.

## Manual upgrade

For the 2.0 release notes:

- **macOS:** quit Quill, open the 2.0 DMG and drag Quill into Applications, replacing the old one. Everything opens as it was. Per-book PDF zoom, reader window sizes and sidebar width reset once.
- **Windows:** uninstall Quill 1.x and leave "delete app data" unticked, then run the 2.0 installer.
- **Rollback:** reinstall 1.3.x. 2.0 adds no migrations, so 1.x opens the same data. Toggle MCP off and on in Settings afterwards, since 2.0 repointed it at `quill-mcp`.

## Risks

- **Helper entitlements.** iCloud keys on a helper or `quill-mcp` get them killed at launch; the mission 2 signing checks catch it. The core runs in-process in the main app for the same reason.
- **Packaged-only breakage.** `file://` origins, native-module loading and bundled paths work in development and break only when packaged. `quill-app://` from mission 1 and installing the rc in mission 2 cover it.
- **Main-process stalls.** A synchronous napi call would freeze every window; `quill-node` has no synchronous command entry point.
- **Silent IPC drift.** Argument casing or error shapes that differ from Tauri's break call sites quietly; the golden and command-table tests catch it.
- **Size and memory.** Electron is much larger. Noted, not gated.

## Open questions for Jason

- **Cutover version.** 2.0.0 is recommended: a new engine and a manual upgrade are a clear major boundary.
- **Intel Macs.** Separate `arm64` and `x64` builds are recommended over universal, which roughly doubles the Chromium payload and needs `quill-node.node`, `quill-mcp` and `libpdfium.dylib` lipo'd.
