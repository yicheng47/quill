# 327 — Electron Shell

GitHub issue: https://github.com/yicheng47/quill/issues/327

Plan: [`docs/impls/327-electron/plan.md`](../impls/327-electron/plan.md). Regression suite: [`docs/tests/regression/`](../tests/regression/README.md).

## Motivation

Quill renders through the system webview. On macOS that is WKWebView, whose engine follows each user's macOS version. On Windows it is WebView2, which updates itself. One build therefore behaves differently from machine to machine, and the reading surface takes most of the damage. PDF import hung forever before macOS 14.4 because the bundled pdf.js needs Safari 17.4 (#216). PDF text selection was janky in WebKit (#52, #153). PDF.js performance is still open (#282).

Quill should ship and control its own rendering engine, so every user gets the same one and it changes only when Quill upgrades it. EPUB decides how: a book is XHTML and CSS with embedded fonts. Rendering it faithfully, and resolving the EPUB CFIs that every highlight, bookmark, vocabulary entry, translation and reading position is stored as, takes a browser engine. A native GPUI app would still have to embed a webview for EPUB, which would be the same system WebKit. Electron bundles Chromium, so it gives Quill a pinned engine while keeping the React UI and foliate-js as they are.

Decision: Jason, 2026-11-10, on #327.

## Scope

In scope:

- **The same app on a new shell.** The UI, the reader and every behavior stay as they are. The React frontend and foliate-js move over unchanged, apart from the calls into the shell. The Rust core keeps its behavior and is loaded into Electron's main process as a native module (napi-rs).
- **Existing users keep everything.** The app keeps the identifier `com.wycstudios.quill`, the app-data directory, `secrets.db` and the iCloud container. Libraries, reading progress, highlights, vocabulary, chats, settings, API keys and OAuth sign-ins all carry over. The last Tauri release upgrades itself to the Electron build through its own updater. Claude Code and Codex MCP integrations keep working.
- **Three UI preferences reset once.** App zoom, reader zoom and sidebar width live only in the webview's `localStorage` and do not carry over from WebKit to Chromium; this one-time reset is accepted. Theme and language are stored in SQLite and are unaffected.
- **Same platforms as today:** macOS on Apple Silicon and Intel, and Windows x64.
- **A pinned engine.** Electron's version is pinned exactly; Chromium changes only when Quill bumps it, and that bump gets its own regression pass.
- **Automated end-to-end tests.** Playwright can drive the Electron app, which nothing can do for the Tauri app on macOS. From phase 3, the regression cases a test can judge run in CI on macOS and Windows, and after the cutover they guard every pull request.
- **Phased delivery.** Each phase lands on the umbrella branch `feat/327-electron` behind its own gate. `main` keeps shipping 1.x Tauri fixes and releases, and the umbrella merges into `main` at the cutover. The phases, gates, crews and the branch mechanics are in the plan.

Out of scope:

- Native PDF rendering with PDFium. pdf.js moves to Chromium unchanged. A native PDF path is a follow-up only if pdf.js on Chromium fails the PDF cases of the regression suite.
- New features or UI changes. There is nothing to design in Pencil: the app must look the same.
- Linux.
- Changes to the sync, storage or database formats.

## Implementation Phases

Each phase is independently checkable: it has its own automated gate and its own live checks, drawn from the regression suite. Until the cutover, no phase changes what the shipping Tauri app does.

0. **Regression suite and Tauri baseline.** Make the regression suite permanent, run Vitest in CI, and run the suite against today's Tauri build through computer use, so every later result has something to compare with.
1. **Rust core out of Tauri.** Move the core into a crate with no Tauri dependency; Tauri commands become thin wrappers. No behavior change.
2. **Frontend platform layer.** Route every Tauri import in the frontend through one platform interface, with a Tauri implementation. No behavior change. Runs in parallel with phase 1.
3. **Electron shell.** The Rust core as a napi module, a command and event bridge, the file protocol, the data directory, and main and reader windows, plus the first Playwright tests. The development app becomes usable end to end.
4. **Desktop integration parity:** menus, titlebar, window lifecycle, file opening and drops, zoom, logs, single instance, and security settings.
5. **MCP server and integrations** under Electron, including existing client configs.
6. **Packaging, signing and updates:** a signed, notarized release candidate with iCloud entitlements, the Windows installer, Electron's updater, and the CI release workflow.
7. **Upgrade bridge from Tauri:** the last Tauri release installs the Electron build, and existing data and integrations carry over.
8. **Final QA:** the full regression suite and the upgrade cases on the signed release candidate, compared with the phase 0 baseline. Jason publishes the release.
9. **Remove Tauri** once the Electron release is live.

## Verification

- Phase 8 passes every required case in the [regression suite](../tests/regression/README.md) and the plan's [upgrade cases](../impls/327-electron/plan.md#upgrade-cases) on macOS (Apple Silicon and Intel) and Windows. Any difference from the phase 0 baseline is either a fix or is recorded and accepted by Jason.
- The PDF cases, which cover #216, #52 and #153, behave the same on every supported macOS version, because the engine no longer depends on the system.
- Upgrading in place from the last Tauri release keeps the library, reading progress, highlights, bookmarks, vocabulary, chats, collections, settings, API keys and OAuth sign-ins, and MCP integrations still answer.
- Sync keeps working across the upgrade, with no duplicate events and no re-copy of the library. These cases run in an environment Jason sets up, never in the development app.
- App size, idle memory, memory with a book open, and cold start time are recorded for both shells. They are not pass/fail, but any large regression is raised before release.
