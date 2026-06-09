# Quill — Architecture

> The architecture doc defines *how* Quill works — the runtime picture, domain model, sync protocol, AI integration, and the design decisions behind each. For feature specs and roadmap, see [`../features/`](../features/) and [`../roadmap/`](../roadmap/).

## 1. Overview

Quill is a local-first AI-powered ebook reader. It reads EPUBs and PDFs, provides AI-assisted lookup/chat/translation, and syncs across devices via iCloud. The app is a Tauri 2 binary: Rust backend, React 19 + TypeScript webview, SQLite (WAL mode) for all persistent state, and a per-device JSONL event log for sync.

### 1.1 Runtime picture

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ Tauri process (Quill desktop app)                                            │
│                                                                              │
│  ┌───────────────────────────────────────────────────────────────────────┐   │
│  │ React webview                                                         │   │
│  │                                                                       │   │
│  │  Home ── BookGrid / BookList (cursor-paginated)                       │   │
│  │  Reader ── Foliate.js (EPUB) / PDF.js (PDF)                           │   │
│  │  Settings Modal (8 tabs)                                              │   │
│  │  Popovers: LookupPopover, TranslationPopover, HighlightToolbar       │   │
│  │  Side panels: AI chat, bookmarks, highlights, vocab                  │   │
│  └────────────────────────────────┬──────────────────────────────────────┘   │
│                                   │ Tauri IPC (invoke + event emitter)       │
│                                   ▼                                          │
│  ┌────────────────────┐  ┌─────────────────┐  ┌──────────────────────────┐  │
│  │ commands/           │  │ ai/              │  │ sync/                    │  │
│  │  books, bookmarks,  │  │  anthropic       │  │  writer   (chokepoint)  │  │
│  │  collections, chats,│  │  openai_compat   │  │  log      (JSONL)       │  │
│  │  vocab, translation,│  │  oauth           │  │  replay   (LWW merge)   │  │
│  │  settings, ai,      │  │                  │  │  watcher  (notify)      │  │
│  │  sync, oauth, app   │  │                  │  │  snapshot               │  │
│  └────────┬───────────┘  └────────┬─────────┘  │  merge, peers, device   │  │
│           │                       │             └────────────┬─────────────┘  │
│           │                       │                          │                │
│           ▼                       ▼                          ▼                │
│  ┌─────────────────┐  ┌─────────────────────┐  ┌──────────────────────────┐  │
│  │ quill.db         │  │ AI provider API     │  │ iCloud ubiquity          │  │
│  │ (SQLite WAL,     │  │ (OpenAI, Anthropic, │  │ container                │  │
│  │  dual-conn)      │  │  Ollama, custom)    │  │                          │  │
│  ├─────────────────┤  └─────────────────────┘  │  books/   (EPUB/PDF)     │  │
│  │ secrets.db       │                           │  covers/  (.img blobs)   │  │
│  │ (credentials,    │                           │  logs/    (per-device    │  │
│  │  never synced)   │                           │           JSONL)         │  │
│  └─────────────────┘                            │  snapshots/              │  │
│                                                  └──────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────────────┘

Separate process (no Tauri runtime):
┌──────────────────────────┐
│ quill mcp                │  stdio binary, shares WAL SQLite
│  (MCP server for Claude  │  with the desktop app.
│   Code, Codex, etc.)     │  .mcp-notify sentinel for
└──────────────────────────┘  write-back coordination.
```

**Three distinct subsystems.** The commands layer is a thin Tauri IPC surface — each command reads/writes SQLite and returns. The AI layer streams LLM responses over per-request event channels. The sync layer is the interesting one: it sits alongside the commands as a mutation observer, capturing every write as an event and replaying peer events on the other end.

**What's not in the picture.** The webview knows nothing about sync. It calls `invoke("import_book")` or `invoke("save_bookmark")` like any local app. The SyncWriter intercepts those mutations at the Rust layer, transparently enqueuing events. The frontend never constructs, reads, or acknowledges sync events directly.

**The invariant this picture encodes.** `quill.db` is the single source of truth for the running app. The JSONL event logs are a replication transport, not a primary store. If you deleted every `.jsonl` file and every peer snapshot, the app would still work — it just wouldn't sync. This is the opposite of Runner's architecture (where the NDJSON *is* the primary store). The difference is intentional: a reading app needs fast indexed queries over 300+ books; an event log is the wrong shape for that.

## 2. Tech stack

| Layer | Choice | Why |
|---|---|---|
| Desktop shell | **Tauri 2** | Rust-native, small binary, WebKit2 webview. Ships `.dmg` + `.nsis`. |
| Backend | **Rust** | Owns SQLite, sync engine, AI streaming, EPUB/PDF parsing. One language for all backend concerns. |
| Frontend | **React 19 + TypeScript** | Familiar, fast, no SSR concerns inside Tauri. |
| Styling | **Tailwind CSS 4** | Utility-first; theme tokens via CSS variables. |
| EPUB rendering | **Foliate.js** (git submodule) | Best open-source EPUB renderer. Handles CFI positions, pagination, search, annotations. |
| PDF rendering | **PDF.js** | Standard. Loaded from CDN in the webview. |
| Persistence | **SQLite via `rusqlite`** (WAL mode, dual connections) | All app state — library, highlights, chats, settings, sync metadata. WAL gives concurrent readers + one writer without blocking. |
| Secrets | **Separate SQLite** (`secrets.db`) | API keys, OAuth tokens. Never synced, never exposed through bulk settings queries. |
| Sync transport | **Append-only JSONL per device** | Peer-to-peer via iCloud file sync. Each device writes its own log; peers replay each other's. |
| File watching | **`notify` crate** | Watches iCloud directory for peer log changes + `.mcp-notify` sentinel. |
| AI providers | **reqwest + streaming** | Direct HTTP to OpenAI, Anthropic, Ollama, or any OpenAI-compatible endpoint. Provider-agnostic. |
| MCP | **`rmcp` crate** | Model Context Protocol server for AI coding assistants. Stdio transport. |
| i18n | **i18next + react-i18next** | English + 简体中文. All UI strings externalized. |
| Icons | **lucide-react** | Consistent icon set across all UI surfaces. |
| Logging | **`tauri-plugin-log`** + panic hook | Rotated file logs (10MB × 3). Panic hook captures backtraces before the logger initializes. |
| Auto-update | **`tauri-plugin-updater`** | Signed updates from GitHub Releases with minisign verification. |

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
main.rs
  ├─ argv contains "mcp" → mcp_stdio_main()  (§7, separate process)
  └─ else → run()

run()
  1. Install panic hook (before logger, so early panics still get captured)
  2. Init tauri-plugin-log (file + stdout in debug)
  3. Build Tauri app with plugins: opener, dialog, fs, updater, process
  4. setup() callback:
     a. Resolve local_dir (~/.app-data/com.wycstudios.quill[-dev]/)
     b. Self-heal: if quill.db missing but .icloud_setting exists, clear stale marker
     c. Resolve ubiquity_dir (iCloud container) if sync enabled
     d. Load or create DeviceIdentity
     e. Resolve data_dir (iCloud if sync, else local)
     f. Db::init_split(local_dir, data_dir) → runs 13 migrations, returns needs_cover_backfill
     g. Create SyncWriter (queue-only if sync enabled)
     h. Init Secrets store, migrate legacy secrets
     i. Manage Tauri state: Db, Secrets, DeviceIdentity, SyncWriter, SyncState, LocalDir
     j. If sync enabled + iCloud reachable:
          spawn background thread → boot_sync_engine()
            → open EventLog, create ReplayEngine, spawn watcher
            → initial tick (replay peer events)
            → chained backfill: cover files → BLOBs, then BLOBs → .img files
     k. If non-sync + needs_cover_backfill:
          spawn background thread → db.backfill_cover_data()
  5. Frontend mounts → invoke("app_ready") → window.show()
```

**Why async boot.** The sync engine touches iCloud — network I/O that can take seconds. If this ran on the setup thread, the user would see a white screen. Instead, setup installs state and returns immediately; the sync engine boots in the background. The frontend shows the library from local SQLite while sync catches up.

**Self-healing.** The stale-marker check (step 4b) handles the edge case where a user deletes `quill.db` via Finder but leaves `.icloud_setting` intact. Without this, the app would try to boot sync without a database.

## 7. MCP server — *AI coding assistant integration*

`quill mcp` is a separate process that serves the Model Context Protocol over stdin/stdout. It gives AI coding assistants (Claude Code, Codex) read (and optionally write) access to the user's library.

**Why a separate process.** MCP clients expect a stdio binary they can spawn. Running inside the Tauri process would require exposing a socket, complicating the security model. A separate process shares the WAL-mode SQLite safely — concurrent readers are free, and the single-writer constraint is already handled by SQLite's locking.

**Write-back coordination.** When MCP write access is enabled, the subprocess mutates the database and touches `.mcp-notify` (a sentinel JSON file). The main app's filesystem watcher detects this and refreshes the UI. This avoids polling and keeps the two processes decoupled.

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

AI responses stream via Tauri event emitter, not command return values. Each request gets a unique channel ID:

```
Frontend: invoke("ai_lookup", { word, sentence, ... })
Backend:  → compose prompt with book context
          → POST to provider API with streaming
          → for each chunk: app.emit("ai-lookup-response", { id, chunk })
          → final: app.emit("ai-lookup-response", { id, done: true })
Frontend: listen("ai-lookup-response") → append chunks to UI
```

This pattern avoids holding the Tauri command channel open for the full response duration (which can be 10+ seconds). The frontend can render incrementally.

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
- **`/reader/:bookId`** — Reader. Rendered in a separate Tauri window. Foliate.js for EPUB, PDF.js for PDF.

### 9.2 State management

No global state library. Each domain has a custom hook that wraps Tauri `invoke` calls:

| Hook | Domain |
|---|---|
| `useBooks` | Library: fetch (cursor-paginated), import, delete, backfill covers |
| `useCollections` | Collections: CRUD, reorder, add/remove books |
| `useBookmarks` | Bookmarks: add/remove, navigate by CFI |
| `useChats` | Chat sessions: create/rename/delete, save messages |
| `useAiChat` | AI streaming: compose requests, handle event chunks |
| `useDictionary` | Vocab: add/remove, mastery tracking, review |
| `useSettings` | App + per-book settings: get/set, theme, language |
| `useUpdateChecker` | Auto-update: check GitHub releases, prompt install |

### 9.3 Reader integration

The Reader page embeds Foliate.js (EPUB) or PDF.js (PDF) in an iframe. Communication between React and the renderer uses `postMessage`:

- **React → renderer:** navigate to CFI, apply theme, set font/size/margins.
- **Renderer → React:** text selection (triggers lookup/translation popovers), page turn (triggers progress save), chapter change (updates TOC highlight).

Reader windows are independent Tauri windows. Closing the main window hides it on macOS (standard Mac convention); reader windows close normally. The main window reappears on dock icon click.

## 10. Build and release

### 10.1 CI pipeline

| Workflow | Trigger | Steps |
|---|---|---|
| `ci.yaml` | Pull request | TypeScript check, ESLint, `cargo clippy`, `cargo test --lib` |
| `release.yml` | `v*` tag push | Build macOS (aarch64 + x86_64) + Windows, code sign, notarize (macOS), create draft GitHub release |

### 10.2 Release process

1. Bump version in `package.json`, `tauri.conf.json`, `Cargo.toml`.
2. `cargo check` to sync `Cargo.lock`.
3. Commit, tag `v{version}`, push.
4. CI builds artifacts, signs, notarizes, uploads to draft release.
5. Edit release notes, publish.

The auto-updater polls `https://github.com/yicheng47/quill/releases/latest/download/latest.json` on each launch. Updates are minisign-verified before install.

### 10.3 Dev/prod isolation

Debug builds use `com.wycstudios.quill-dev` as the bundle identifier. This gives dev builds their own app-data directory, log directory, and iCloud container — a `pnpm tauri dev` session never touches production data.

## 11. Key dependencies

### Backend (`Cargo.toml`)

| Crate | Purpose |
|---|---|
| `tauri` 2 + plugins | Desktop shell, dialog, fs, updater, process, opener, log |
| `rusqlite` 0.31 (bundled) | SQLite with WAL mode |
| `tokio` | Async runtime (sync channels, timers, networking) |
| `reqwest` 0.12 | HTTP client for AI provider APIs (streaming) |
| `rmcp` 1.7 | MCP protocol server |
| `epub` 2 | EPUB metadata and content extraction |
| `lopdf` 0.40 | PDF metadata extraction (title, author, page count) |
| `notify` 6 | Filesystem watcher (iCloud logs + MCP sentinel) |
| `serde` / `serde_json` | Serialization for events, IPC, settings |
| `chrono` | Timestamps (with serde support) |
| `uuid` / `ulid` | Book IDs (UUID v4), event IDs (ULID for time-ordering) |
| `sha2` / `base64` | Content hashing, cover encoding |
| `objc2` / `objc2-foundation` | macOS-only: NSFileCoordinator for iCloud APIs |
| `gethostname` | Device name for sync peer metadata |
| `toml_edit` | Round-trip TOML editing (MCP config in `~/.codex/config.toml`) |

### Frontend (`package.json`)

| Package | Purpose |
|---|---|
| `react` 19 / `react-dom` | UI framework |
| `react-router-dom` 7 | Client-side routing (Home ↔ Reader) |
| `tailwindcss` 4 | Utility CSS |
| `@tauri-apps/api` 2 + plugins | Tauri IPC, dialog, fs, updater, process, opener |
| `i18next` + `react-i18next` | Internationalization (en, zh) |
| `lucide-react` | Icon library |
| `react-markdown` | Markdown rendering in AI chat responses |
| `vite` 7 | Build tool + dev server |
| `typescript` 5.8 | Type safety |

### Submodules

| Submodule | Path | Purpose |
|---|---|---|
| `foliate-js` | `public/foliate-js/` | EPUB rendering engine |
