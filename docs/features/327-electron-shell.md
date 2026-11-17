# 327 — Electron Shell

GitHub issue: https://github.com/yicheng47/quill/issues/327

Plan: [`docs/impls/327-electron/plan.md`](../impls/327-electron/plan.md). Regression suite: [`docs/tests/regression/`](../tests/regression/README.md).

## Motivation

Quill renders through the system webview. On macOS that is WKWebView, whose engine follows each user's macOS version. On Windows it is WebView2, which updates itself. One build therefore behaves differently from machine to machine, and the reading surface takes most of the damage. PDF import hung forever before macOS 14.4 because the bundled pdf.js needs Safari 17.4 (#216). PDF text selection was janky in WebKit (#52, #153). PDF.js performance is still open (#282).

Quill should ship and control its own rendering engine, so every user gets the same one and it changes only when Quill upgrades it. EPUB decides how: a book is XHTML and CSS with embedded fonts. Rendering it faithfully, and resolving the EPUB CFIs that every highlight, bookmark, vocabulary entry, translation and reading position is stored as, takes a browser engine. A native GPUI app would still have to embed a webview for EPUB, which would be the same system WebKit. Electron bundles Chromium, so it gives Quill a pinned engine while keeping the React UI and foliate-js as they are.

Decision: Jason, 2026-11-10, on #327. Quill's users today are mainly Jason, so the migration favors speed over upgrade machinery (Jason, 2026-11-17).

## Scope

In scope:

- **The same app on a new shell.** The UI, the reader and every behavior stay as they are. The React frontend and foliate-js move over unchanged, apart from the calls into the shell. The Rust core keeps its behavior and is loaded into Electron's main process as a native module (napi-rs).
- **Existing data opens as is.** The app keeps the identifier `com.wycstudios.quill`, the app-data directory, `secrets.db` and the iCloud container. Libraries, reading progress, highlights, vocabulary, chats, settings, API keys and OAuth sign-ins all carry over, because the Electron build reads the same files from the same place.
- **The upgrade from 1.x is manual.** Install the 2.0 DMG over the 1.x app on macOS, or the 2.0 installer on Windows after uninstalling 1.x with its app data kept. The 1.x updater is not offered 2.0: the 2.0 release publishes no Tauri `latest.json`, and the release notes say to download it. From 2.0 on, Electron's updater keeps the app current.
- **Rollback is reinstalling 1.3.x.** 2.0 adds no database migrations, so the 1.x app opens the same data.
- **Three UI preferences reset once.** Per-book PDF zoom (`reader-zoom-*`), reader window dimensions (`reader-window-*`) and sidebar width live only in the webview's `localStorage` and do not carry over from WebKit to Chromium; this one-time reset is accepted. Theme, language, app zoom (`app_zoom`) and EPUB reader settings are stored in SQLite and are unaffected.
- **MCP integrations keep working.** On first launch, the production build repoints Quill's Claude Code and Codex config entries at the bundled `quill-mcp` binary.
- **Same platforms as today:** macOS on Apple Silicon and Intel, and Windows x64.
- **A pinned engine.** Electron's version is pinned exactly; Chromium changes only when Quill bumps it, and that bump gets a smoke-tier run.
- **Tauri is removed in the same change.** There is no period of shipping two shells.

Out of scope:

- An in-app upgrade path from the Tauri updater to the Electron build.
- Native PDF rendering with PDFium. pdf.js moves to Chromium unchanged.
- New features or UI changes. There is nothing to design in Pencil: the app must look the same.
- A renderer CSP. Tauri runs with none today; adding one is a follow-up.
- Playwright end-to-end tests. They become possible under Electron and are a follow-up.
- Linux.
- Changes to the sync, storage or database formats.

## Implementation

Two missions on one branch, `feat/327-electron`:

1. **Electron app in development.** The Rust core out of Tauri, the napi module, the Electron main process and preload, the frontend platform layer, desktop integration and MCP, with Tauri deleted. `make dev` runs the full app in Electron.
2. **Ship it.** Signed and notarized macOS builds, the Windows installer, Electron's updater, the release workflow and the docs.

## Verification

- Mission 1 passes the smoke tier and the cases for the paths it moved, in the Electron development app.
- The PDF cases that cover #216, #52 and #153 behave the same as or better than in the 1.x app.
- After Jason installs 2.0 over 1.x on his Mac, the library, reading progress, highlights, bookmarks, vocabulary, chats, collections, settings, API keys and OAuth sign-ins are intact, MCP answers, and sync keeps working with his other device with no duplicate events and no re-copy of the library.
- A 2.0 pre-release updates itself to the next one through Electron's updater.
