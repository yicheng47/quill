# Quill — Architecture

> The architecture doc defines *how* Quill works — the runtime picture, domain model, sync protocol, AI integration, and the design decisions behind each. For feature specs and roadmap, see [`../features/`](../features/) and [`../roadmap/`](../roadmap/).

## 1. Overview

Quill is a local-first AI-powered ebook reader. It reads EPUBs and PDFs, provides AI-assisted lookup/chat/translation, and syncs across devices via iCloud. The desktop app pairs an Electron 45 shell (main/preload/renderer) with a shared Rust core loaded through the `quill-node` N-API addon (`crates/quill-core` + `crates/quill-node`), React 19 + TypeScript UI, SQLite (WAL mode) for persistent state, and a per-device JSONL event log for sync.

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
│  │  Settings Modal (8 tabs)                                              │   │
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
│  │  ┌──────────────────┐  ┌───────────────┐  ┌────────────────────────┐  │   │
│  │  │ commands/        │  │ ai/           │  │ sync/                  │  │   │
│  │  │  books,bookmarks,│  │  anthropic    │  │  writer   (chokepoint) │  │   │
│  │  │  collections,    │  │  openai_compat│  │  log      (JSONL)      │  │   │
│  │  │  chats,vocab,    │  │  oauth        │  │  replay   (LWW merge)  │  │   │
│  │  │  translation,    │  └───────┬───────┘  │  watcher  (notify)     │  │   │
│  │  │  settings,ai,    │          │          │  snapshot, merge,      │  │   │
│  │  │  sync,oauth,mcp  │          │          │  peers, device         │  │   │
│  │  └────────┬─────────┘          │          └───────────┬────────────┘  │   │
│  └───────────┼────────────────────┼──────────────────────┼───────────────┘   │
│              │                    │                      │                   │
│              ▼                    ▼                      ▼                   │
│     ┌─────────────────┐  ┌──────────────────┐  ┌────────────────────────┐    │
│     │ quill.db        │  │ AI provider API  │  │ iCloud ubiquity        │    │
│     │ (SQLite WAL,    │  │ (OpenAI,         │  │ container              │    │
│     │  dual-conn)     │  │  Anthropic,      │  │                        │    │
│     ├─────────────────┤  │  Ollama, custom) │  │ books/   (EPUB/PDF)    │    │
│     │ secrets.db      │  └──────────────────┘  │ covers/  (.img blobs)  │    │
│     │ (credentials,   │                        │ logs/    (per-device   │    │
│     │  never synced)  │                        │           JSONL)       │    │
│     └─────────────────┘                        │ snapshots/             │    │
│                                                └────────────────────────┘    │
└──────────────────────────────────────────────────────────────────────────────┘

Separate process (standalone binary in Contents/Resources/quill-mcp):
┌──────────────────────────┐
│ quill-mcp mcp            │  stdio binary built on quill-core,
│  (MCP server for Claude  │  sharing WAL SQLite with the desktop app.
│   Code, Codex, etc.)     │  .mcp-notify sentinel for write-back.
└──────────────────────────┘
```

**Three distinct subsystems.** The commands layer (`quill-core::dispatch`) handles typed command dispatch from Electron main — each command reads/writes SQLite and returns. The AI layer streams LLM responses over per-request IPC event channels forwarded through `ShellHost` callbacks. The sync layer is the interesting one: it sits alongside the commands as a mutation observer, capturing every write as an event and replaying peer events on the other end.

**What's not in the picture.** The renderer knows nothing about sync. Through `src/platform/`, it calls commands such as `"import_book"` or `"save_bookmark"` like any local app. The SyncWriter intercepts those mutations at the Rust layer, transparently enqueuing events. The frontend never constructs, reads, or acknowledges sync events directly.

**The invariant this picture encodes.** `quill.db` is the single source of truth for the running app. The JSONL event logs are a replication transport, not a primary store. If you deleted every `.jsonl` file and every peer snapshot, the app would still work — it just wouldn't sync. This is the opposite of Runner's architecture (where the NDJSON *is* the primary store). The difference is intentional: a reading app needs fast indexed queries over 300+ books; an event log is the wrong shape for that.

## 2. Tech stack

| Layer | Choice | Why |
|---|---|---|
| Desktop shell | **Electron 45** (`electron-vite`, `electron-builder`) | Cross-platform desktop shell; ships signed/notarized macOS `.dmg` + `.zip` (`arm64`/`x64`) and Windows `x64` NSIS installer. |
| Native bridge | **`quill-node`** (`napi` 3) | In-process N-API `.node` addon exposing async command dispatch, media root authorization, and event streaming from Rust into Electron main. |
| Backend | **Rust** (`quill-core`, `quill-mcp`) | Owns SQLite, sync engine, AI streaming, MCP server, EPUB/PDF metadata extraction, and PDFium cover rendering. |
| Frontend | **React 19 + TypeScript** | Fast SPA bundled cleanly inside Electron's renderer (`quill-app://`). |
| Styling | **Tailwind CSS 4** | Utility-first; theme tokens via CSS variables. |
| EPUB rendering | **Foliate.js** (git submodule) | Best open-source EPUB renderer. Handles CFI positions, pagination, search, annotations. |
| PDF rendering | **PDF.js** + **`pdfium-render`** | PDF.js renders reader pages in the iframe; PDFium renders cover thumbnails in `quill-core`. |
| Persistence | **SQLite via `rusqlite`** (WAL mode, dual connections) | All app state — library, highlights, chats, settings, sync metadata. WAL gives concurrent readers + one writer without blocking. |
| Secrets | **Separate SQLite** (`secrets.db`) | API keys, OAuth tokens. Never synced, never exposed through bulk settings queries. |
| Sync transport | **Append-only JSONL per device** | Peer-to-peer via iCloud file sync. Each device writes its own log; peers replay each other's. |
| File watching | **`notify` crate** | Watches iCloud directory for peer log changes + `.mcp-notify` sentinel. |
| AI providers | **reqwest + streaming** | Direct HTTP to OpenAI, Anthropic, Ollama, or any OpenAI-compatible endpoint. Provider-agnostic. |
| MCP | **`rmcp` crate** | Model Context Protocol server for AI coding assistants (`quill-mcp` stdio binary). |
| i18n | **i18next + react-i18next** | English + 简体中文. All UI strings externalized. |
| Icons | **lucide-react** | Consistent icon set across all UI surfaces. |
| Logging | **`fern` + `log`** (`quill-core`) + panic hook | Rotated file logs (`quill.log`, 10 MB × 3). Panic hook captures backtraces before logger teardown. |
| Auto-update | **`electron-updater`** | GitHub Releases (`latest-mac.yml` / `latest.yml`) with channel routing (`releases/latest`, prerelease `-rc.`, and `nightly`). |

**Platform targets.** macOS (Apple Silicon + x64) primary. Windows (x64, NSIS installer) secondary. iCloud sync is macOS-only; on other platforms the app works fully but without cross-device sync.

## 3. Domain model

Quill's domain is a personal reading library. The objects are simpler than Runner's — there's no config-vs-runtime split because reading is inherently stateful (you're always mid-book).

### 3.1 Relationship diagram

```
┌─ Library ──────────────────────────────────────────────────────────────────┐
│                                                                            │
│   Book ──────────────── file (EPUB or PDF, stored in data_dir/books/)     │
│    │                     cover_data (BLOB in SQLite + .img in iCloud)     │
│    │                                                                       │
│    ├── Bookmarks[]       (CFI position + label)                           │
│    ├── Highlights[]      (CFI range + color + note + text_content)        │
│    ├── Chats[]           (per-book AI conversation threads)               │
│    │    └── ChatMessages[]  (role + content, persisted)                   │
│    └── progress / status / current_cfi  (reading state)                   │
│                                                                            │
│   Collection ─── CollectionBooks (M:N junction) ─── Book                  │
│    (named group with sort_order)                                           │
│                                                                            │
│   VocabWord              (word + definition + context + mastery_level,    │
│    (optionally linked     spaced-repetition tracking)                     │
│     to a book)                                                             │
│                                                                            │
│   Settings               (key-value pairs: theme, language, AI config,    │
│                            per-book reader prefs via `book:{id}:{key}`)   │
│                                                                            │
└────────────────────────────────────────────────────────────────────────────┘

┌─ Sync metadata (internal, prefixed with underscore) ───────────────────────┐
│                                                                             │
│   _pending_publish       outbox: events awaiting flush to device log       │
│   _replay_state          per-peer watermarks (last replayed ULID)          │
│   _tombstones            deletion markers (entity_id + entity_type)        │
│   DeviceIdentity         UUID + name, persisted at .device-identity file   │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Book is the central entity.** Almost everything hangs off a book — bookmarks, highlights, and chats. The exceptions are vocab words (which may reference a book but exist independently) and collections (which group books without owning them).

### 3.2 Book — *one imported ebook*

An EPUB or PDF file imported into the library. Carries metadata (title, author, description, pages, genre), reading state (status, progress percentage, current CFI position), and a cover image stored as a BLOB in SQLite.

Two identifying fields:
- **`id`** — UUID, assigned at import. Stable across sync.
- **`file_path`** — relative path under `data_dir/books/`. The file may be evicted by iCloud (replaced with a `.icloud` placeholder); `available` is computed at query time.

Cover storage is dual: `cover_data` BLOB in SQLite for fast rendering (the frontend receives a `data:image/…;base64,…` URI), plus a `covers/{book_id}.img` file in iCloud for sync transport. The BLOB is authoritative; the `.img` file is a transport artifact.

### 3.3 Collection — *a named group of books*

Flat list (no nesting). Each collection has a `sort_order` for drag-and-drop reordering in the sidebar. Books can belong to multiple collections. The junction table `collection_books` is the M:N link.

### 3.4 Chat — *an AI conversation thread anchored to a book*

Multiple chats per book. Each chat has a title and a list of messages (role: user/assistant, content). Chat messages retain the highlighted passage that triggered them as context. The AI provider sees the full message history on each turn.

### 3.5 Settings — *key-value configuration store*

All settings live in a single `settings` table (`key TEXT PRIMARY KEY, value TEXT`). App-wide settings use bare keys (`theme`, `language`, `ai_provider`). Per-book settings use the convention `book:{id}:{key}` (e.g., `book:abc-123:font_size`).

Sensitive settings (API keys, OAuth tokens) live in `secrets.db`, not the main settings table. The `get_all_settings` command never returns secret values.

## 4. Storage — *two databases, two directories*

### 4.1 Directory layout

```
~/.app-data/com.wycstudios.quill/       (local_dir — always local, never synced)
├── quill.db                             materialized view of all app state
├── quill.db-wal                         WAL journal
├── secrets.db                           API keys, OAuth tokens
├── .device-identity                     this device's UUID + name
├── .icloud_setting                      marker: sync is enabled (contains data_dir path)
└── .mcp-notify                          sentinel JSON for MCP write-back

When sync is DISABLED, blobs also live here:
├── books/                               EPUB/PDF files
└── covers/                              cover images

When sync is ENABLED, blobs move to iCloud:
~/Library/Mobile Documents/iCloud~com~wycstudios~quill/Documents/   (data_dir)
├── books/                               EPUB/PDF files (iCloud-synced)
├── covers/                              cover .img files (iCloud-synced)
├── logs/                                per-device JSONL event logs
│   ├── {device-a-uuid}.jsonl
│   └── {device-b-uuid}.jsonl
├── snapshots/                           compacted state snapshots
└── manifest.jsonl                       peer metadata (name, platform, version)
```

**Why two directories.** `quill.db` must never be synced via iCloud file sync — SQLite and file-level sync are incompatible (WAL corruption, partial writes, lock conflicts). The solution: keep the database local, sync the event logs, and let each device build its own materialized view from the shared logs.

### 4.2 Dual-connection SQLite

`Db` holds two connections to the same database file:
- **Write connection** — used by all mutation commands. One at a time (SQLite's built-in serialization).
- **Read-only connection** — used by queries that don't need the latest write. WAL mode lets reads proceed concurrently with writes without blocking.

The `Db::init_split(local_dir, data_dir)` constructor separates the database location (always `local_dir/quill.db`) from the blob storage location (`data_dir`, which may be iCloud). This split is the key architectural decision that makes sync possible.

### 4.3 Secrets store

`secrets.db` is a separate SQLite file with a single `secrets` table. It exists because:
- Secrets must never appear in sync logs (event payloads would expose them to iCloud).
- The `get_all_settings` bulk query must not accidentally return API keys.
- Legacy migration: early versions stored secrets in the main settings table; on first launch, the app moves them to `secrets.db` and deletes the originals.

## 5. Sync architecture — *event-sourced, peer-to-peer*

Quill syncs across devices without a server. Each device writes its mutations to a local JSONL event log in the iCloud ubiquity container; iCloud syncs those files to other devices; each device replays peer logs into its local database.

### 5.1 The sync loop

```
Device A                              iCloud                              Device B
─────────                             ──────                              ─────────

User imports a book
  → commands::books::import_book()
    → SyncWriter.with_tx(|conn| {
        INSERT INTO books ...;        // DB mutation
        INSERT INTO _pending_publish  // enqueue event
      })
    → SyncWriter.flush()
      → APPEND logs/device-a.jsonl    ──── iCloud file sync ────→  logs/device-a.jsonl
                                                                   │
                                                                   ▼
                                                          notify watcher fires
                                                            → ReplayEngine.tick()
                                                              → read device-a.jsonl
                                                                from watermark
                                                              → for each event:
                                                                LWW merge into DB
                                                              → update watermark
```

**SyncWriter is the single chokepoint.** Every mutation in the app — import, delete, bookmark, highlight, progress update, settings change — goes through `SyncWriter.with_tx()`. This method takes a closure, runs it in a SQLite transaction, and simultaneously enqueues the corresponding sync event in `_pending_publish`. The transaction ensures the DB write and the event enqueue are atomic.

**Why not write directly to the JSONL?** Two reasons: (1) iCloud may be temporarily unreachable, so the outbox (`_pending_publish`) buffers events until flush succeeds; (2) the two-phase approach lets us batch multiple events into a single JSONL append for efficiency.

### 5.2 Event schema

Each event in the JSONL log is one line:

```jsonc
{
  "id":          "01HG3K...",              // ULID, monotonic per device
  "device_uuid": "abc-123",
  "device_name": "Jason's MacBook Pro",
  "ts_ms":       1716825600000,            // millisecond timestamp
  "body": {
    "BookImport": {                        // discriminant tag
      "id": "book-uuid",
      "title": "...",
      "author": "...",
      // ... full book metadata
    }
  }
}
```

The `body` field is a Rust enum (`EventBody`) serialized as an externally-tagged JSON object. Event types include: `BookImport`, `BookUpdate`, `BookDelete`, `BookmarkAdd`, `BookmarkRemove`, `HighlightAdd`, `HighlightRemove`, `HighlightUpdate`, `CollectionCreate`, `CollectionRename`, `CollectionDelete`, `CollectionAddBook`, `CollectionRemoveBook`, `VocabAdd`, `VocabRemove`, `SettingsUpdate`.

### 5.3 LWW merge — *last-write-wins conflict resolution*

When replaying a peer event, the merge logic compares timestamps:

1. Look up the entity in the local DB.
2. If the local `updated_at` is newer than the event's `ts_ms`, skip (local wins).
3. If the event's `ts_ms` is newer, apply the change (peer wins).
4. Tie-break: if timestamps are equal, the lexicographically greater `device_uuid` wins. Deterministic, no coordination needed.

**Why LWW.** For a personal reading app, last-write-wins is the right tradeoff. Conflicts are rare (one user, multiple devices, usually not editing the same book simultaneously). When they happen, the most recent action is almost always the intended one. More sophisticated CRDTs would add complexity without meaningful benefit.

**Progress throttling.** Page turns fire rapidly. Without throttling, a single reading session would generate hundreds of events. SyncWriter coalesces progress updates: at most one progress event per book per 2-second window. Semantic transitions (`mark_finished`, `mark_reading`) bypass the throttle because they carry intent, not just a percentage.

### 5.4 Cover sync — *dual storage*

Covers posed a unique challenge: they're binary blobs (10KB–500KB each) that don't fit well in JSONL event payloads. The solution is dual storage:

- **`cover_data` BLOB in SQLite** — the authoritative copy. Used for rendering (converted to `data:image/…;base64,…` URIs). Fast to query, no file I/O.
- **`covers/{book_id}.img` in iCloud** — the transport copy. A dedicated cover-writer background thread writes these files asynchronously when sync is enabled.

On the receiving end, `ingest_peer_covers()` reads `.img` files from the iCloud covers directory and writes them into the local database as BLOBs. The three-phase pattern prevents lock contention: (1) read-only query for candidates, (2) file I/O with no DB lock held, (3) brief write lock per cover.

Snapshots exclude `cover_data` to keep them small (metadata only). Covers sync exclusively via `.img` files.

### 5.5 Snapshots and log compaction

Over time, per-device logs grow. Snapshots provide a checkpoint:

1. **`sync_compact`** dumps the current DB state as a snapshot (all books, collections, highlights, etc. minus cover BLOBs).
2. The snapshot replaces the device's JSONL log — peers can bootstrap from the snapshot instead of replaying the full history.
3. Old log entries before the snapshot watermark can be pruned.

### 5.6 SyncWriter modes

SyncWriter has three modes, reflecting the app's lifecycle:

| Mode | Behavior | When |
|---|---|---|
| **Disabled** | Mutations hit SQLite only. No events enqueued. | Sync not enabled. |
| **Queue-only** | Events enqueued in `_pending_publish` but not flushed to JSONL. | Sync enabled, but engine still booting (background thread). |
| **Enabled** | Events enqueued and flushed to the device's JSONL log. | Sync fully booted. |

The queue-only mode prevents the app from blocking on iCloud I/O during launch. The user can interact immediately; events buffer locally and flush once the sync engine finishes its initial tick.

### 5.7 Watcher and replay

`sync::watcher::spawn()` uses the `notify` crate to watch the iCloud `logs/` directory. When a peer's JSONL file changes, it triggers `ReplayEngine::tick()`, which reads new events from that peer (using the stored watermark in `_replay_state`) and applies them via LWW merge.

The watcher also handles:
- **iCloud placeholders** — `.icloud` files that indicate the real file is evicted. The watcher calls `trigger_download_file` to request iCloud download and skips to the next tick.
- **Peer discovery** — new `.jsonl` files in the logs directory mean a new device has joined.

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
     d. Self-heal: if `quill.db` missing but `.icloud_setting` exists, clear stale marker
     e. Resolve ubiquity_dir (iCloud container) if sync enabled
     f. Load or create DeviceIdentity
     g. Resolve data_dir (iCloud if sync, else local)
     h. `Db::init_split(local_dir, data_dir)` → runs migrations, returns `needs_cover_backfill`
     i. Init `Secrets` store, migrate legacy secrets
     j. Create `SyncWriter`, spawn `.mcp-notify` watcher
     k. If `!is_dev` (packaged boot): repair legacy packaged MCP entries in `~/.claude.json` and `~/.codex/config.toml`
     l. If sync enabled + iCloud reachable:
          spawn `sync-boot` background thread → `boot_sync_engine()`
            → open EventLog, create ReplayEngine, spawn watcher
            → initial tick + chained backfill (cover files → BLOBs → .img files)
        else if non-sync + `needs_cover_backfill`:
          spawn `cover-backfill` thread → `db.backfill_cover_data()`
  5. Wire `QuillUpdaterService`, register protocols + IPC handlers, install menu, create main window
  6. Frontend mounts → calls `app_ready` → replays queued `file-open` paths and shows window
```

**Why async boot.** The sync engine touches iCloud — network I/O that can take seconds. If this ran on the main thread during startup, the user would see a blank window. Instead, `host::boot()` initializes SQLite and spawns `sync-boot` in the background so the main window renders immediately from local SQLite while sync catches up.

**Self-healing.** The stale-marker check (step 4d) handles the edge case where a user deletes `quill.db` via Finder but leaves `.icloud_setting` intact. Without this, the app would try to boot sync without a database.

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
| `notify` 6 | Filesystem watcher (iCloud logs + `.mcp-notify` sentinel) |
| `serde` / `serde_json` | Serialization for events, IPC, settings |
| `chrono` | Timestamps (with serde support) |
| `uuid` / `ulid` | Book IDs (UUID v4), event IDs (ULID for time-ordering) |
| `sha2` / `base64` | Content hashing, cover encoding |
| `objc2` / `objc2-foundation` | macOS-only: `NSFileCoordinator` / `NSFileManager` for iCloud APIs |
| `gethostname` | Device name for sync peer metadata |
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
