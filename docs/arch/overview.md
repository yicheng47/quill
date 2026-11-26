# Quill — Architecture

> The architecture doc defines *how* Quill works — the runtime picture, domain model, storage layout, AI integration, and the design decisions behind each. For feature specs and roadmap, see [`../features/`](../features/) and [`../roadmap/`](../roadmap/).

## 1. Overview

Quill is a local-first AI-powered ebook reader. It reads EPUBs and PDFs, provides AI-assisted lookup/chat/translation, and stores all library data locally in SQLite and on-disk book files. The desktop app pairs an Electron 45 shell (main/preload/renderer) with a shared Rust core loaded through the `quill-node` N-API addon (`crates/quill-core` + `crates/quill-node`), React 19 + TypeScript UI, and SQLite (WAL mode) for persistent state.

### 1.1 Runtime picture

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ Electron main process + React renderer (Quill desktop app)                   │
│                                                                              │
│  ┌───────────────────────────────────────────────────────────────────────┐   │
│  │ React renderer (src/ + src/platform/electron.ts)                      │   │
│  │                                                                       │   │
│  │  Home ── BookGrid / BookList (cursor-paginated)                       │   │
│  │  Reader ── Foliate.js (EPUB) / PDF.js (PDF)                           │   │
│  │  Settings View (9 tabs)                                               │   │
│  │  Popovers: LookupPopover, TranslationPopover, HighlightToolbar        │   │
│  │  Side panels: AI chat, bookmarks, highlights, vocab                   │   │
│  └────────────────────────────────┬──────────────────────────────────────┘   │
│                                   │ preload contextBridge + Electron IPC     │
│                                   ▼                                          │
│  ┌───────────────────────────────────────────────────────────────────────┐   │
│  │ Electron main (electron/main/) + quill-node (N-API) → quill-core      │   │
│  │                                                                       │   │
│  │  QuillUpdaterService (electron-updater)  |  protocols (quill-app/file)│   │
│  │                                                                       │   │
│  │  ┌──────────────────────────────┐  ┌───────────────────────────────┐  │   │
│  │  │ commands/                    │  │ ai/                           │  │   │
│  │  │  books, bookmarks, chats,    │  │  anthropic, openai_compat,    │  │   │
│  │  │  collections, vocab,         │  │  codex                        │  │   │
│  │  │  translation, settings,      │  └──────────────┬────────────────┘  │   │
│  │  │  dictionary, ai, mcp, app    │                 │                   │   │
│  │  └──────────────┬───────────────┘                 │                   │   │
│  └─────────────────┼─────────────────────────────────┼───────────────────┘   │
│                    │                                 │                       │
│                    ▼                                 ▼                       │
│     ┌─────────────────────────────┐      ┌──────────────────────────┐        │
│     │ Local app_data_dir          │      │ AI provider API / Codex  │        │
│     │  quill.db (SQLite WAL)      │      │  (OpenAI, Anthropic,     │        │
│     │  secrets.db (credentials)   │      │   Ollama, custom, Codex) │        │
│     │  device.json                │      └──────────────────────────┘        │
│     │  books/ (EPUB/PDF)          │                                          │
│     │  covers/ (legacy covers)    │                                          │
│     └─────────────────────────────┘                                          │
└──────────────────────────────────────────────────────────────────────────────┘

Separate process (standalone binary in Contents/Resources/quill-mcp):
┌──────────────────────────┐
│ quill-mcp mcp            │  stdio binary built on quill-core,
│  (MCP server for Claude  │  sharing WAL SQLite with the desktop app.
│   Code, Codex, etc.)     │  .mcp-notify sentinel for write-back.
└──────────────────────────┘
```

**Two primary runtime subsystems.** The commands layer (`quill-core::dispatch`) handles typed command dispatch from Electron main — each command runs plain SQLite queries or transactions (`Db::with_tx`) and returns. The AI layer streams LLM responses over per-request IPC event channels forwarded through `ShellHost` callbacks.

**The invariant this picture encodes.** `quill.db` is the single source of truth for the running app. Everything reads and writes directly against the local SQLite database and local `books/` directory under `app_data_dir`.

## 2. Tech stack

| Layer | Choice | Why |
|---|---|---|
| Desktop shell | **Electron 45** (`electron-vite`, `electron-builder`) | Cross-platform desktop shell; ships signed/notarized macOS `.dmg` + `.zip` (`arm64`/`x64`) and Windows `x64` NSIS installer. |
| Native bridge | **`quill-node`** (`napi` 3) | In-process N-API `.node` addon exposing async command dispatch, media root authorization, and event streaming from Rust into Electron main. |
| Backend | **Rust** (`quill-core`, `quill-mcp`) | Owns SQLite, AI streaming, MCP server, offline dictionaries, EPUB/PDF metadata extraction, and PDFium cover rendering. |
| Frontend | **React 19 + TypeScript** | Fast SPA bundled cleanly inside Electron's renderer (`quill-app://`). |
| Styling | **Tailwind CSS 4** | Utility-first; theme tokens via CSS variables. |
| EPUB rendering | **Foliate.js** (git submodule) | Best open-source EPUB renderer. Handles CFI positions, pagination, search, annotations. |
| PDF rendering | **PDF.js** + **`pdfium-render`** | PDF.js renders reader pages in the iframe; PDFium renders cover thumbnails in `quill-core`. |
| Persistence | **SQLite via `rusqlite`** (WAL mode, dual connections) | All app state — library, highlights, chats, vocab, settings. WAL gives concurrent readers + one writer without blocking. |
| Secrets | **Separate SQLite** (`secrets.db`) | API keys, kept local and never exposed through bulk settings queries without endpoint-binding checks. |
| File watching | **`notify` crate** | Watches the local `.mcp-notify` sentinel for external MCP write-back. |
| AI providers | **reqwest + streaming / Codex** | Direct HTTP to OpenAI, Anthropic, Ollama, or any OpenAI-compatible endpoint, plus local Codex CLI integration. |
| MCP | **`rmcp` crate** | Model Context Protocol server for AI coding assistants (`quill-mcp` stdio binary). |
| i18n | **i18next + react-i18next** | English + 简体中文. All UI strings externalized. |
| Icons | **lucide-react** | Consistent icon set across all UI surfaces. |
| Logging | **`fern` + `log`** (`quill-core`) + panic hook | Rotated file logs (`quill.log`, 10 MB × 3). Panic hook captures backtraces before logger teardown. |
| Auto-update | **`electron-updater`** | GitHub Releases (`latest-mac.yml` / `latest.yml`) with channel routing (`releases/latest`, prerelease `-rc.`, and `nightly`). |

**Platform targets.** macOS (Apple Silicon + x64) primary. Windows (x64, NSIS installer) secondary. Both platforms share the same local-first storage and settings tabs.

## 3. Domain model

Quill's domain is a personal reading library. The objects are simpler than Runner's — there's no config-vs-runtime split because reading is inherently stateful (you're always mid-book).

### 3.1 Relationship diagram

```
┌─ Library ──────────────────────────────────────────────────────────────────┐
│                                                                            │
│   Book ──────────────── file (EPUB or PDF, stored in data_dir/books/)      │
│    │                     cover_data (BLOB in SQLite)                       │
│    │                                                                       │
│    ├── Bookmarks[]       (CFI position + label)                            │
│    ├── Highlights[]      (CFI range + color + note + text_content)         │
│    ├── Chats[]           (per-book AI conversation threads)                │
│    │    └── ChatMessages[]  (role + content, persisted)                    │
│    └── progress / status / current_cfi  (reading state)                    │
│                                                                            │
│   Collection ─── CollectionBooks (M:N junction) ─── Book                   │
│    (named group with sort_order)                                           │
│                                                                            │
│   VocabWord              (word + definition + context + mastery_level,     │
│    (optionally linked     spaced-repetition tracking)                      │
│     to a book)                                                             │
│                                                                            │
│   Settings               (key-value pairs: theme, language, AI config;     │
│                            Reader prefs stored per-book in localStorage)   │
│                                                                            │
└────────────────────────────────────────────────────────────────────────────┘

┌─ Device & inert legacy schema tables ──────────────────────────────────────┐
│                                                                            │
│   DeviceIdentity         UUID persisted at `device.json` (kept for #370)   │
│   _pending_publish       inert legacy table from migration 011             │
│   _replay_state          inert legacy table from migration 010             │
│   _tombstones            inert legacy table from migration 010             │
│                                                                            │
└────────────────────────────────────────────────────────────────────────────┘
```

**Book is the central entity.** Almost everything hangs off a book — bookmarks, highlights, and chats. The exceptions are vocab words (which may reference a book but exist independently) and collections (which group books without owning them).

### 3.2 Book — *one imported ebook*

An EPUB or PDF file imported into the library. Carries metadata (title, author, description, pages, genre), reading state (status, progress percentage, current CFI position), and a cover image stored as a BLOB in SQLite (`cover_data`, served to the frontend as a `data:image/…;base64,…` URI).

Two identifying fields:
- **`id`** — UUID, assigned at import.
- **`file_path`** — relative path under `data_dir/books/`, resolved to an absolute path when returned to the desktop frontend. `available` is computed at query time via `abs_path.exists()`.

### 3.3 Collection — *a named group of books*

Flat list (no nesting). Each collection has a `sort_order` for drag-and-drop reordering in the sidebar. Books can belong to multiple collections. The junction table `collection_books` is the M:N link.

### 3.4 Chat — *an AI conversation thread anchored to a book*

Multiple chats per book. Each chat has a title and a list of messages (role: user/assistant, content). Chat messages retain the highlighted passage that triggered them as context. The AI provider sees the full message history on each turn.

### 3.5 Settings — *key-value configuration store*

App-wide settings live in a single `settings` table (`key TEXT PRIMARY KEY, value TEXT`). Reader persists per-book typography, theme, and PDF zoom preferences in browser `localStorage` (`reader-settings-<bookId>`, `reader-zoom-<bookId>`); the `book_settings` SQLite table remains in the schema for compatibility.

Sensitive settings (API keys) live in `secrets.db`, not the main settings table. `get_all_settings` only returns `ai_api_key` when its persisted endpoint binding matches the configured provider and base URL.

## 4. Storage — *two databases, one local directory*

### 4.1 Directory layout

```
<app_data_base_dir>/com.wycstudios.quill/   (local_dir — always local)
├── quill.db                                SQLite database (WAL mode)
├── quill.db-wal                            WAL journal
├── secrets.db                              API keys (local-only)
├── device.json                             Stable device UUID (retained for #370)
├── .mcp-notify                             Sentinel JSON for MCP write-back
├── books/                                  EPUB/PDF files
├── covers/                                 Legacy on-disk covers (backfilled into cover_data)
├── dictionaries/                           Imported offline dictionaries
└── codex-workspace/                        Local Codex runtime workspace
```

### 4.2 Dual-connection SQLite

`Db` holds two connections to `local_dir/quill.db`:
- **Write connection** — used by mutation commands (transactional mutations via `Db::with_tx`, which uses `BEGIN IMMEDIATE`, plus direct write-connection statements for single-statement updates). One writer at a time (SQLite's built-in serialization).
- **Read-only connection** — used by query commands (`Db::reader()`). WAL mode lets concurrent readers proceed alongside the writer without blocking.

`Db::init_with_backfill(app_data_dir)` creates `books/` and `covers/`, opens `quill.db` in WAL mode, applies shipped migrations `001`–`014`, migrates legacy absolute paths to relative paths, and reports whether `cover_data` backfill is needed.

### 4.3 Secrets store

`secrets.db` is a separate SQLite file with a single `secrets` table. Keeping secrets separate ensures credentials stay isolated from general library data and prevents accidental exposure through bulk queries or future sync. Early versions stored API keys in the main `settings` table; on startup, `Secrets::migrate_from_settings` moves them into `secrets.db` and deletes the originals.

## 5. Sync status — *clean slate ahead of Quill Cloud (#370)*

The legacy iCloud Drive event-log engine (per-device JSONL logs, snapshots, LWW replay, iCloud file coordination, dual `data_dir` splitting, macOS iCloud entitlements, and iCloud Sync settings UI) was removed in `#370` M1 to prepare for Quill Cloud's server-ordered entity-sync protocol.

**Upgrade note for iCloud-synced Macs.** In older Mac builds with iCloud Sync in Settings (such as `v1.3.4` and pre-`#370` M1 nightlies), enabling sync relocated `books/` and `covers/` out of local app data into the iCloud container, whereas local-only desktop builds from `#370` M1 onward open only `local_dir` and intentionally have no automatic copy-back path. Before installing a local-only desktop build on a Mac where iCloud Sync is enabled, turn off sync in the older sync-capable version, wait for the local copy to finish, and verify that a book opens.

Two compatibility pieces remain intentionally untouched:
- **`DeviceIdentity`** (`crates/quill-core/src/sync/device.rs`, stored at `device.json`) continues to load or initialize on boot so installs preserve a stable device UUID across the transition.
- **Shipped migrations `001`–`014`** remain unmodified so existing local `quill.db` files stay valid; the legacy `_replay_state`, `_tombstones`, `_pending_publish` tables and `updated_by_device` columns remain inert until superseded.

## 6. Boot sequence

```
electron/main/index.ts
  1. Set Chromium `userData` to `appData/com.wycstudios.quill-chromium[-dev]`
     so Chromium state stays outside Quill's core data directory
  2. Register custom protocols (`quill-app://`, `quill-file://`) as privileged
  3. Acquire single-instance lock (forwarding `open-file` / second-instance args)
  4. app.whenReady() → bootQuillCore() loads `quill-node/index.node` and calls quill_core::host::boot():
     a. Install panic hook + init `fern` rotating logger (`<log_dir>/quill.log`)
     b. Configure PDFium path (`pdfium::set_configured_path`) if resolved
     c. Resolve local_dir (`<app_data_base_dir>/com.wycstudios.quill[-dev]/`)
     d. Load or create DeviceIdentity (`device.json`)
     e. `Db::init_with_backfill(&local_dir)` → runs migrations 001–014, returns `needs_cover_backfill`
     f. If `needs_cover_backfill`: spawn `cover-backfill` thread → `db.backfill_cover_data()`
     g. Init `Secrets` store, migrate legacy secrets, run AI startup migration
     h. Spawn `.mcp-notify` watcher
     i. If `!is_dev` (packaged boot): repair legacy packaged MCP entries in `~/.claude.json` and `~/.codex/config.toml`
     j. Initialize `Codex` runtime and `DictionaryManager`
  5. Wire `QuillUpdaterService`, register protocols + IPC handlers, install menu, create main window
  6. Frontend mounts → calls `app_ready` → replays queued `file-open` paths and shows window
```

## 7. MCP server — *AI coding assistant integration*

`quill-mcp mcp` (invoked from the standalone `quill-mcp` binary bundled alongside app resources, or `target/debug/quill-mcp` in dev) serves the Model Context Protocol over stdin/stdout. It gives AI coding assistants (Claude Code, Codex) read (and optionally write) access to the user's library.

**Why a separate binary.** MCP clients expect a stdio binary they can spawn directly without launching Electron. `crates/quill-mcp` builds cleanly against `quill-core` and shares WAL-mode SQLite safely — concurrent readers are free, and the single-writer constraint is handled by SQLite locking. On packaged app boot (`!is_dev`), Quill inspects `~/.claude.json` (`mcpServers.quill`) and `~/.codex/config.toml` (`[mcp_servers.quill]`) and upgrades only existing legacy packaged Quill paths (e.g., `Quill.app/...`) to the new `quill-mcp` binary path while leaving absent, up-to-date, and third-party entries untouched.

**Write-back coordination.** When MCP write access is enabled, `quill-mcp` mutates the database and touches `.mcp-notify` (a sentinel JSON file). The main app's filesystem watcher detects this and notifies the renderer to refresh. This avoids polling and keeps the two processes decoupled.

**Tools exposed:** library (list/search/import books), chats (list/create), vocab (add/remove/list), highlights (list), and collections (list/add/remove books).

## 8. AI integration — *provider-agnostic streaming*

### 8.1 Provider abstraction

Quill supports multiple AI providers through a common streaming interface:

| Provider | Module | Auth |
|---|---|---|
| OpenAI | `ai::openai_compat` | API key or OAuth |
| Anthropic | `ai::anthropic` | API key |
| Ollama | `ai::openai_compat` | None (local) |
| Custom (OpenAI-compatible) | `ai::openai_compat` | API key |

The `openai_compat` module handles any endpoint that speaks the OpenAI chat completions API. Ollama and custom providers use this path with a different `base_url`.

### 8.2 Streaming via event channels

AI responses stream via per-request IPC event channels forwarded through `ShellHost`, not command return values. Each request gets a unique channel ID:

```
Frontend: invoke("ai_lookup", { word, sentence, ... }) → preload → Electron IPC → quill-node
Backend:  → compose prompt with book context
          → POST to provider API with streaming
          → for each chunk: host.emit("ai-lookup-response", { id, chunk })
          → final: host.emit("ai-lookup-response", { id, done: true })
Frontend: listen("ai-lookup-response") → append chunks to UI
```

This pattern avoids holding the request/response IPC promise open for long LLM streams (which can run 10+ seconds) and lets the renderer update incrementally.

### 8.3 AI features

| Feature | Entry point | Behavior |
|---|---|---|
| **Lookup** | Select text → popover | Streamed definition with book context (title, author, surrounding passage). |
| **Chat** | Side panel | Multi-turn per book. Full history sent on each turn. Persisted in `chats`/`chat_messages`. |
| **Translation** | Select text → popover | Passage-level streaming translation. Results are ephemeral; copy what you need from the popover. |

All AI features respect the user's configured language. The system prompt adapts: if the user's language is Chinese, explanations come back in Chinese.

## 9. Frontend architecture

### 9.1 Routing

Two routes, both top-level:
- **`/`** — Home (library). BookGrid or BookList view, sidebar with collections, chats, and saved items such as Vocab, plus search + filter and drag-drop import.
- **`/reader/:bookId`** — Reader. Rendered in a separate Electron `BrowserWindow`. Foliate.js for EPUB, PDF.js for PDF.

### 9.2 State management

No global state library. Each domain has a custom hook backed by `src/platform/` command and event adapters:

| Hook | Domain |
|---|---|
| `useBooks` | Library: fetch (cursor-paginated), import, delete, backfill covers |
| `useCollections` | Collections: CRUD, reorder, add/remove books |
| `useBookmarks` | Bookmarks: add/remove, navigate by CFI |
| `useChats` | Chat sessions: create/rename/delete, save messages |
| `useAiChat` | AI streaming: compose requests, handle event chunks |
| `useDictionary` | Vocab: add/remove, mastery tracking, review |
| `useSettings` | App + per-book settings: get/set, theme, language |
| `useUpdateChecker` | Auto-update: check GitHub releases via `electron-updater`, stream progress, prompt install |

### 9.3 Reader integration

The Reader page embeds Foliate.js (EPUB) or PDF.js (PDF) in an iframe. Communication between React and the renderer uses `postMessage`:

- **React → renderer:** navigate to CFI, apply theme, set font/size/margins.
- **Renderer → React:** text selection (triggers lookup/translation popovers), page turn (triggers progress save), chapter change (updates TOC highlight).

Reader windows are independent Electron windows. Closing the main window hides it on macOS (standard Mac convention); reader windows close normally. The main window reappears on dock icon click (recreating it if previously closed).

## 10. Build and release

### 10.1 CI pipeline

| Workflow | Trigger | Steps |
|---|---|---|
| `ci.yaml` | Pull request | Build `quill-node` + smoke test, typecheck (`src/` + `electron/`), ESLint, Vitest, `electron-vite build`, `cargo clippy`, `cargo test --workspace`, unpacked `electron-builder --dir` layout/arch checks |
| `release.yml` | `v*` tag push | Build macOS (`arm64` + `x64`, signed + notarized) and Windows (`x64` unsigned NSIS), merge `latest-mac.yml`, create draft release (`prerelease: true` when tag contains `-`) |
| `nightly-on-merge.yml` | Merge commits to `main` (non-doc changes) | Dispatch `nightly.yml` with `platform: all` |
| `nightly.yml` | Merge dispatch or manual dispatch (`all` / `both` / `macos` / `windows`) | Stamp `X.Y.Z-nightly.<YYYYMMDDHHMM>`, build/sign/notarize macOS + Windows, update rolling `nightly` tag/prerelease, verify public feeds before pruning to latest 2 stamps per platform/arch |

### 10.2 Release process

1. Bump version in `package.json` and `Cargo.toml` (`[workspace.package]`).
2. `cargo check --workspace` to sync `Cargo.lock`, and `npm install --package-lock-only --ignore-scripts` to sync `package-lock.json`.
3. Commit, tag `v{version}`, push.
4. `release.yml` builds signed/notarized macOS DMGs + updater zips (`arm64` and `x64`), merges `latest-mac.yml`, builds Windows NSIS + `latest.yml`, and uploads them to a draft release.
5. Edit release notes and publish the draft.

`QuillUpdaterService` configures `electron-updater` based on the running `app.getVersion()`: nightly builds (`-nightly.`) check the rolling `https://github.com/yicheng47/quill/releases/download/nightly` feed; prerelease builds (`-rc.`) read GitHub Releases with `allowPrerelease = true`; stable builds read `releases/latest` (`allowPrerelease = false`). Both stable and nightly builds share `com.wycstudios.quill`.

### 10.3 Dev/prod isolation

When `!app.isPackaged` (`make dev`), `bootQuillCore` passes `isDev = true` to `quill-core`, pointing local data, logs, and Chromium `userData` at `com.wycstudios.quill-dev` / `com.wycstudios.quill-chromium-dev`, refusing release `quill-mcp` fallbacks, skipping MCP config auto-repair, and returning `null` from update checks. Packaged builds run with `isDev = false` against `com.wycstudios.quill`; any local packaged smoke test must isolate `HOME`.

## 11. Key dependencies

### Backend (`Cargo.toml` workspace)

| Crate | Purpose |
|---|---|
| `napi` 3 / `napi-derive` 3 | N-API bindings in `crates/quill-node` bridging async Rust work to Electron main |
| `rusqlite` 0.31 (bundled) | SQLite with WAL mode |
| `tokio` | Async runtime (sync channels, timers, networking, N-API async tasks) |
| `reqwest` 0.12 | HTTP client for AI provider APIs (streaming) |
| `rmcp` 1.7 | MCP protocol server (`crates/quill-mcp` stdio binary) |
| `epub` 2 | EPUB metadata and content extraction |
| `pdfium-render` 0.9 | PDF cover thumbnail rendering (dynamic `libpdfium` bundled into app resources) |
| `lopdf` 0.40 | PDF test fixtures (`dev-dependencies`) |
| `fern` 0.7 / `log` 0.4 | Rotating file logs (10 MB × 3) |
| `notify` 6 | Filesystem watcher (`.mcp-notify` sentinel) |
| `serde` / `serde_json` | Serialization for IPC, settings, and AI payloads |
| `chrono` | Timestamps (with serde support) |
| `uuid` / `ulid` | Entity IDs (UUID v4) and unique temporary probe paths (`ai/codex/discovery.rs`, ULID) |
| `sha2` / `base64` | Content hashing, cover encoding |
| `toml_edit` | Round-trip TOML editing (MCP config in `~/.codex/config.toml`) |

### Desktop & Frontend (`package.json`)

| Package | Purpose |
|---|---|
| `electron` 45 / `electron-vite` 6 / `electron-builder` 26 | Desktop shell, Vite-based main/preload/renderer bundling, macOS/Windows packaging |
| `electron-updater` 6 | GitHub Releases auto-updater (`latest-mac.yml`, `latest.yml`) |
| `react` 19 / `react-dom` 19 | UI framework |
| `react-router-dom` 7 | Client-side routing (Home ↔ Reader) |
| `tailwindcss` 4 | Utility CSS |
| `i18next` + `react-i18next` | Internationalization (en, zh) |
| `lucide-react` | Icon library |
| `react-markdown` / `remark-gfm` | Markdown rendering in AI chat responses |
| `vite` 7 / `vitest` 4 | Build tool, dev server, unit tests |
| `typescript` 5.8 | Type safety (`src/` + `electron/`) |

### Submodules

| Submodule | Path | Purpose |
|---|---|---|
| `foliate-js` | `public/foliate-js/` | EPUB rendering engine |
