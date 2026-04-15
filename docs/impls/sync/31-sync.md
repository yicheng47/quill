# Sync — Per-Device Event Log (Desktop)

**Issue:** [#185](https://github.com/yicheng47/quill/issues/185)
**Spec:** [31 — Sync](../../features/31-sync.md)
**Known Problems:** [31 — Sync Known Problems](31-sync-known-problems.md)
**Scope:** desktop only. iOS mirrors the same design and ships from `yicheng47/quill-ios` with its own impls doc once this one is proven. Event schema and merge rules below are the cross-platform contract.

## Context

Replace today's "SQLite file in iCloud ubiquity container" sync with a per-device append-only event log stored in the same iCloud ubiquity container (BYOC deferred to a later release — see v1 scope below). Local `quill.db` becomes a materialized view, rebuildable from merged peer logs. No backend, no CloudKit, no file-level conflicts.

This rewrites the write path. Every mutation becomes `SQL write + event append` in one transaction. Reads are unchanged — still pure SQLite.

**First shipping version (v1):**
- **iCloud-only.** The `<shared-folder>` is always the existing iCloud ubiquity container (`iCloud~com~wycstudios~quill/Documents`). No folder picker, no backend enum. BYOC (custom folder) is a later release, landing alongside the next cloud provider.
- **Same UX as today.** Settings shows a single "Sync with iCloud" Toggle — identical surface to the current `ICloudSettings.tsx`. Users shouldn't notice a UI-level change; the engine underneath is what's new.
- **No dual-write phase** — pre-1.0, so we migrate iCloud-on users directly on first launch. iCloud-off users are unaffected until they enable sync.

---

## Architecture

### File layout

```
<shared-folder>/                       # iCloud Documents container (v1); any user-chosen dir in a future release
  logs/
    <device-uuid>.jsonl                # append-only; this device writes only here
    <device-uuid>.snapshot.json        # latest compaction/migration snapshot
  books/<book-id>.{epub,pdf}           # unchanged
  covers/<book-id>.jpg                 # unchanged
  quill.db.migrated-<iso-ts>           # old DB, retired (post-migration only)
```

```
<app-data>/                            # purely local, never synced
  quill.db                             # materialized view
  device.json                          # {"device_uuid":"...","created_at":"..."}
```

### Event format

```jsonc
{"id":"01HV2X9KQRPTZC8F9EKH2MBAAT","ts":1776429296789,"device":"7b6f...","v":1,"type":"highlight.add","payload":{"id":"h1","book":"b1","cfi":"...","color":"yellow"}}
```

| Field | Type | Details |
|---|---|---|
| `id` | string, 26 chars | ULID — see below |
| `ts` | i64 (JSON number) | Unix time in **milliseconds** since epoch, UTC. Produced by `chrono::Utc::now().timestamp_millis()`. Fits comfortably in JS `number` — `Date.now()` returns exactly this shape; the JS safe-integer limit (2⁵³) holds another ~285,000 years of headroom over current unix millis (~1.78 × 10¹²). Aligns with the 48-bit millis embedded in the ULID. |
| `device` | string | UUIDv4 of the originating device, as 36-char hyphenated form (e.g. `7b6f4c3a-1e2d-4f5b-8a9c-0d1e2f3a4b5c`) |
| `v` | u32 | Event schema version. Starts at `1`. Bumped on any breaking payload change. |
| `type` | string | Dotted event type from the catalog — see spec §Event catalog & merge rules |
| `payload` | object | Type-specific body; structure determined by `type` |

Wire encoding: one event per line, UTF-8, no BOM, trailing `\n` after every line including the last. Pretty-printing is forbidden — each event must be exactly one line. Unknown fields on read are preserved via `#[serde(flatten)]` on an `extra: serde_json::Map<String, Value>` field, so a newer peer's additions survive a round trip through an older reader.

Total order across peers: sort ascending by the pair `(ts, device)`, where `device` is the UUID string (arbitrary but deterministic tiebreak). The `id` is NOT used for cross-device ordering — only for per-device watermarks. Because `ts` is an integer, the merge engine's LWW comparisons are native integer compares — no string-lex format traps.

### ULID format

```
01HV2X9KQRPTZC8F9EKH2MBAAT
└──┬───┘└────────┬────────┘
timestamp      randomness
 48 bits         80 bits
 10 chars        16 chars
```

- **128 bits total**, same space as a UUID.
- **Encoding:** Crockford Base32 — alphabet `0-9` and `A-Z` excluding `I`, `L`, `O`, `U` (visual-ambiguity-safe). Case-insensitive on parse; always emit **uppercase**.
- **First 10 chars (48 bits):** milliseconds since Unix epoch, big-endian. Gives ~10 889 years of range.
- **Last 16 chars (80 bits):** cryptographic random bytes.
- **Lexicographically sortable:** string-compare two ULIDs → chronological order. This is why the watermark resume (`last_event_id > ?` in SQL) works as a simple string comparison.
- **Monotonic within a process:** if two ULIDs are generated in the same millisecond, the random portion is treated as a 80-bit integer and **incremented by 1** instead of re-randomized, so `id` ordering within a device always matches append order. Handled automatically by the `ulid` crate's `MonotonicGenerator`.

**Generation (Rust):**

```rust
use ulid::Ulid;
let id = Ulid::new();              // non-monotonic — DO NOT use
let id = generator.generate()?;    // use MonotonicGenerator owned by EventLog
```

`EventLog` owns a `ulid::Generator` (the monotonic variant) behind the same `Mutex` as the file writer, so the generator's clock never goes backward relative to appends.

**Gotchas:**
- Keep ULIDs as strings everywhere — in JSONL, in `_replay_state.last_event_id`, in logs. Never encode the 128-bit raw form; it breaks grep and kills interop with iOS (which decodes via `Codable` string).
- Don't parse the timestamp out of an ID as a second source of truth — use the `ts` field. The embedded timestamp is a sort key, not data.
- Clock-skew resilience: if the system clock jumps backward, the monotonic generator keeps returning IDs strictly greater than the last emitted one (by incrementing randomness) until wall time catches up. No clamping needed.

### Replay state (local-only table)

```sql
CREATE TABLE _replay_state (
  peer_device        TEXT PRIMARY KEY,
  last_event_id      TEXT,              -- resume point in peer's tail (ULID string)
  last_snapshot_id   TEXT,              -- latest applied snapshot from peer (ULID string)
  updated_at         INTEGER NOT NULL   -- unix millis
);

CREATE TABLE _tombstones (
  entity TEXT NOT NULL,
  id     TEXT NOT NULL,
  ts     INTEGER NOT NULL,              -- unix millis
  PRIMARY KEY (entity, id)
);

CREATE TABLE _pending_publish (
  id         TEXT PRIMARY KEY,          -- local outbox row id (UUID)
  ts         INTEGER NOT NULL,          -- event timestamp to publish
  body_json  TEXT NOT NULL,             -- serialized EventBody JSON
  created_at INTEGER NOT NULL           -- unix millis
);
```

`_replay_state` and `_tombstones` ship in migration 010 (Chunk 2, already on the umbrella branch). `_pending_publish` ships in migration 011 alongside Chunk 4, bundled with the `updated_by_device` column addition — see "Schema normalization" above for the why-bundled rationale. Chunk 4 is where the outbox first gets consumed (`ReplayEngine::tick()` drains it); Chunk 5's `SyncWriter::with_tx` is where rows first get inserted into it.

Never appear in any event; never synced.

### Schema normalization — every synced table gets `created_at` + `updated_at` as `INTEGER` unix millis

LWW-backed tables also get `updated_by_device TEXT NOT NULL` so equal-millisecond
writes resolve deterministically by the tuple `(updated_at, updated_by_device)`.
This applies to:
- `books`
- `highlights`
- `collections`
- `collection_books`
- `vocab_words`
- `chats`

Before sync code lands, normalize every synced table to carry both `created_at` and `updated_at` as `INTEGER NOT NULL` storing unix time in **milliseconds**. Two changes in one migration:

1. **Shape uniformity.** Every synced table carries both columns. Append-only tables get `updated_at` too — it just equals `created_at` and never changes — so the merge engine can LWW-compare against a single column name on every table, no per-table special cases.
2. **Type change: TEXT → INTEGER millis.** LWW compares timestamps natively via integer order instead of string-lex order (which is brittle across RFC-3339 format variants — `to_rfc3339()` emits variable sub-second precision and `+00:00`, which string-compares incorrectly against `...Z` millis format). Int64 also aligns with the 48-bit millis embedded in every ULID, so the sync engine uses one time representation end-to-end.
3. **Deterministic same-ms tiebreak.** Every LWW-backed row stores the device UUID that last won the register, so merge helpers can compare `(event.ts, event.device)` against `(stored.updated_at, stored.updated_by_device)` rather than dropping equal-ms writes nondeterministically.

| Table | Today | After migration 009 | After migration 011 (LWW tiebreak) |
|---|---|---|---|
| `books`, `vocab_words`, `chats` | `created_at TEXT`, `updated_at TEXT` | `created_at INTEGER`, `updated_at INTEGER` | + `updated_by_device TEXT NOT NULL DEFAULT 'migration'` |
| `highlights`, `collections` | `created_at TEXT` only | `created_at INTEGER`, `updated_at INTEGER` | + `updated_by_device TEXT NOT NULL DEFAULT 'migration'` |
| `collection_books` | no timestamps | `created_at INTEGER`, `updated_at INTEGER` | + `updated_by_device TEXT NOT NULL DEFAULT 'migration'` |
| `bookmarks`, `chat_messages`, `translations` | `created_at TEXT` only | both columns as `INTEGER` | unchanged (append-only, not LWW-targeted) |
| `vocab_words.next_review_at` | `TEXT` | `INTEGER` (nullable — scheduled future instant) | unchanged |
| `settings`, `book_settings`, `schema_version`, `secrets` | local-only | skip — never synced | skip |

**Migration 009 mechanics (shipped).** SQLite can't retype a column in place, so 009 rebuilds each affected table inside a single transaction: `CREATE TABLE <x>_new` with the final schema → `INSERT ... SELECT` converting timestamps in SQL via `CAST(strftime('%s', ts) AS INTEGER) * 1000 + CAST(substr(strftime('%f', ts), -3) AS INTEGER)` → `DROP` old table → `RENAME` new table. Any failure rolls the entire transaction back, so the DB is either fully migrated or identical to pre-migration. `schema_version` advances only on successful commit, so a crash mid-flight re-runs cleanly on next launch. Pure SQL (`src-tauri/migrations/009_normalize_timestamps.sql`), not Rust-driven.

**Migration 011 — `updated_by_device` + `_pending_publish` (bundled).** Migration 009 shipped before Problem 2's resolution was adopted (see `31-sync-known-problems.md` §2), so it does not add `updated_by_device`. A follow-up migration 011 — landing alongside Chunk 4 — adds the column to the six LWW-backed tables via `ALTER TABLE ... ADD COLUMN updated_by_device TEXT NOT NULL DEFAULT 'migration'` and simultaneously creates the `_pending_publish` outbox (Problem 1's durable queue, originally slated for migration 010 before that migration shipped on the umbrella branch). Both changes are sync-infrastructure additions that the merge engine (Chunk 4) and `SyncWriter` (Chunk 5) depend on, so bundling them in one migration keeps the sync series coherent.

**Frontend contract change.** Every Tauri command that returned a timestamp as `string` now returns `number`. TypeScript types switch `created_at: string` → `created_at: number`. Components rendering timestamps use `new Date(millis)` / `toLocaleString()` (or a shared formatter util) in place of ISO string display. This is the only outward-visible change; the UI behavior is unchanged.

Chunk 1 below handles the 009 portion (already shipped via PR #186); 011 is scoped to Chunk 4.

---

## File checklist

**New:**
- `src-tauri/src/sync/mod.rs` — public module surface
- `src-tauri/src/sync/events.rs` — event types + serde
- `src-tauri/src/sync/log.rs` — append / read / coordinate
- `src-tauri/src/sync/writer.rs` — `SyncWriter` (SQL + event in one tx)
- `src-tauri/src/sync/merge.rs` — per-type merge rules → SQL apply
- `src-tauri/src/sync/replay.rs` — peer discovery + watermarked apply
- `src-tauri/src/sync/snapshot.rs` — snapshot read/write/compaction
- `src-tauri/src/sync/migration.rs` — one-shot migration from legacy file-sync
- `src-tauri/src/sync/watcher.rs` — fs-notify wrapper (macOS FSEvents, Linux inotify)
- `src-tauri/src/commands/sync.rs` — Tauri commands for settings UI
- `src-tauri/migrations/009_normalize_timestamps.sql` — pure-SQL migration 009 (schema normalization + TEXT→INTEGER millis conversion; see "Schema normalization" above). Shipped via PR #186.
- `src-tauri/migrations/010_replay_state.sql` — creates `_replay_state` and `_tombstones`. On the umbrella branch via Chunk 2.
- `src-tauri/migrations/011_lww_tiebreak_and_outbox.sql` — adds `updated_by_device` to the six LWW-backed tables and creates `_pending_publish`. Lands with Chunk 4.
- `src/components/settings/LibrarySyncSettings.tsx`

**Modified:**
- `src-tauri/src/lib.rs` — wire sync module, register commands, spawn watcher task
- `src-tauri/src/db.rs` — register migrations 009, 010, and 011; helpers to write local-only rows
- `src-tauri/src/commands/{bookmarks,books,collections,vocab,chats,translation,settings}.rs` — route every mutation through `SyncWriter`; in Chunk 1, additionally start writing `updated_at` on every INSERT/UPDATE to newly-normalized tables
- `src-tauri/src/icloud.rs` — deprecated; keep only the legacy migration entry point used by the one-shot migration routine
- `src/components/settings/ICloudSettings.tsx` → replaced by `LibrarySyncSettings.tsx`
- `src/i18n/en.json`, `src/i18n/zh.json` — new keys under `settings.librarySync`

**Removed (Phase D, not v1):**
- `src-tauri/src/icloud.rs` (legacy migrate/disable paths)
- old `ICloudSettings.tsx`

---

## Step 1 — Event schema

`src-tauri/src/sync/events.rs`:

```rust
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Event {
    pub id: String,          // ULID
    pub ts: i64,             // unix millis
    pub device: String,      // UUID
    pub v: u32,              // schema version
    #[serde(flatten)]
    pub body: EventBody,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(tag = "type", content = "payload", rename_all = "snake_case")]
pub enum EventBody {
    #[serde(rename = "book.import")]        BookImport(BookImport),
    #[serde(rename = "book.delete")]        BookDelete { id: String },
    #[serde(rename = "book.progress.set")]  BookProgressSet { book: String, progress: u8, cfi: Option<String> },
    #[serde(rename = "book.status.set")]    BookStatusSet { book: String, status: String },
    #[serde(rename = "book.metadata.set")]  BookMetadataSet { book: String, field: String, value: serde_json::Value },
    #[serde(rename = "highlight.add")]      HighlightAdd(Highlight),
    #[serde(rename = "highlight.delete")]   HighlightDelete { id: String },
    #[serde(rename = "highlight.color.set")] HighlightColorSet { id: String, color: String },
    #[serde(rename = "highlight.note.set")]  HighlightNoteSet { id: String, note: Option<String> },
    #[serde(rename = "bookmark.add")]       BookmarkAdd(Bookmark),
    #[serde(rename = "bookmark.delete")]    BookmarkDelete { id: String },
    #[serde(rename = "vocab.add")]          VocabAdd(VocabWord),
    #[serde(rename = "vocab.mastery.set")]  VocabMasterySet { id: String, mastery: String, next_review_at: Option<String> },
    #[serde(rename = "vocab.delete")]       VocabDelete { id: String },
    #[serde(rename = "translation.add")]    TranslationAdd(Translation),
    #[serde(rename = "translation.delete")] TranslationDelete { id: String },
    #[serde(rename = "collection.create")]  CollectionCreate { id: String, name: String, sort_order: i32 },
    #[serde(rename = "collection.rename")]  CollectionRename { id: String, name: String },
    #[serde(rename = "collection.reorder")] CollectionReorder { id: String, sort_order: i32 },
    #[serde(rename = "collection.delete")]  CollectionDelete { id: String },
    #[serde(rename = "collection.book.add")]    CollectionBookAdd { collection: String, book: String },
    #[serde(rename = "collection.book.remove")] CollectionBookRemove { collection: String, book: String },
    #[serde(rename = "chat.create")]        ChatCreate { id: String, book: String, title: String, model: Option<String> },
    #[serde(rename = "chat.rename")]        ChatRename { id: String, title: String },
    #[serde(rename = "chat.delete")]        ChatDelete { id: String },
    #[serde(rename = "chat.message.add")]   ChatMessageAdd(ChatMessage),
}
```

Payload structs mirror the existing DB row structs (`snake_case` throughout, so mostly zero-friction). ULIDs via the `ulid` crate.

**Cross-platform contract:** this JSON shape is identical on iOS (decoded via `Codable`). Any schema change bumps `v` and must be deserializable by both sides.

---

## Step 2 — EventLog

`src-tauri/src/sync/log.rs`:

```rust
pub struct EventLog {
    path: PathBuf,               // <shared>/logs/<device>.jsonl
    writer: Mutex<BufWriter<File>>,
    device_id: String,
}

impl EventLog {
    pub fn open(shared_dir: &Path, device_id: &str) -> AppResult<Self> { ... }

    /// Append one event — atomic at the line level.
    pub fn append(&self, body: EventBody, ts: DateTime<Utc>) -> AppResult<Event> { ... }

    /// Append many events atomically (single fsync).
    pub fn append_batch(&self, bodies: Vec<EventBody>, ts: DateTime<Utc>) -> AppResult<Vec<Event>> { ... }

    /// Stream all events in order.
    pub fn read_all(&self) -> AppResult<impl Iterator<Item = AppResult<Event>>> { ... }

    /// Stream events after a watermark.
    pub fn read_after(&self, event_id: &str) -> AppResult<impl Iterator<Item = AppResult<Event>>> { ... }
}
```

Write flow:
1. Serialize event to JSON, append `\n`.
2. `write_all` + `flush` on the buffered writer.
3. `File::sync_data()` (fsync) once per `append_batch` call.
4. macOS: coordinate via the `NSFileCoordinator` pattern already used in `icloud.rs` (wrap via `objc2`). Linux/Windows: plain `flock` is enough.

Torn-write recovery on read: if the last line doesn't parse or lacks a trailing `\n`, drop it and log a warning. Safe because atomic append means a torn line is always the last line.

---

## Step 3 — Write path instrumentation (`SyncWriter`)

Every mutation goes from

```rust
// before
db.execute("UPDATE books SET progress = ?, current_cfi = ?, updated_at = ? WHERE id = ?", ...)
```

to

```rust
// after — inside a transaction via SyncWriter
sync_writer.with_tx(|tx, events| {
    tx.execute("UPDATE books SET progress = ?, current_cfi = ?, updated_at = ? WHERE id = ?", ...)?;
    events.push(EventBody::BookProgressSet { book, progress, cfi });
    Ok(())
})?;
```

`SyncWriter::with_tx` opens a SQL transaction, runs the closure to collect events, writes those events into the local `_pending_publish` outbox inside the same transaction, **commits the transaction, then flushes `_pending_publish` into the device log** (single fsync). Order is deliberate: commit-then-append. The asymmetric failure modes:

- SQL commit fails → nothing in log, nothing for peers to ingest. Self-consistent; user sees the error and retries.
- SQL commit succeeds, log append fails → local row and `_pending_publish` rows are durable but no event published yet. This is recovered by retrying the outbox flush on the next launch/focus/manual sync tick. The inverted order ("append then commit") would produce the dual failure — event visible to peers without a local row — which is catastrophic because the origin device would have no principled way to reconstruct the missing SQL state.

If the process crashes after appending to the log but before deleting the `_pending_publish` rows, the next outbox flush may publish the same logical event twice with a fresh ULID. This is acceptable because the merge rules are idempotent: add/delete events key on stable entity ids, and LWW events carry the same `(ts, payload)` and therefore converge to the same state. Partial failures are rare; the design guarantees that when they happen we fail toward "peers lag the origin" rather than "origin lags peers."

**If sync is disabled** (user hasn't enabled it): the writer's `EventSink` is a no-op that discards events. Zero disk cost, uniform command signatures whether or not sync is on.

### Commands to instrument

| Command | Event |
|---|---|
| `insert_book` / `BookImporter.import` | `book.import` |
| `delete_book` | `book.delete` |
| `update_reading_progress` | `book.progress.set` |
| `update_book_status` | `book.status.set` |
| `update_book_metadata_*` | `book.metadata.set` (one per field changed) |
| `add_bookmark` | `bookmark.add` |
| `remove_bookmark` | `bookmark.delete` |
| `add_highlight` | `highlight.add` |
| `update_highlight_color` | `highlight.color.set` |
| `update_highlight_note` | `highlight.note.set` |
| `remove_highlight` | `highlight.delete` |
| `add_vocab_word` | `vocab.add` |
| `update_vocab_mastery` | `vocab.mastery.set` |
| `remove_vocab_word` | `vocab.delete` |
| `add_translation` | `translation.add` |
| `remove_translation` | `translation.delete` |
| `create_collection` | `collection.create` |
| `rename_collection` | `collection.rename` |
| `reorder_collections` | `collection.reorder` (one per id) |
| `delete_collection` | `collection.delete` |
| `add_book_to_collection` | `collection.book.add` |
| `remove_book_from_collection` | `collection.book.remove` |
| `create_chat` | `chat.create` |
| `rename_chat_title` | `chat.rename` |
| `delete_chat` | `chat.delete` |
| `add_chat_message` | `chat.message.add` |

**Never produce events (local-only):**
- Secrets (`secrets.db`) — API keys, OAuth tokens
- `settings` table — general preferences (barely used; theme/language already live in `localStorage`)
- `book_settings` table — per-book reader preferences (font size, reading mode, line height). These are UI preferences that differ per screen and belong on the device, not in the synced library. The table keeps its FK to `books` and its existing commands; it just isn't part of the sync contract.

**Debounce:** `book.progress.set` is called on every page turn. Before appending, coalesce within a 2-second trailing window per `book_id` — only the last call in the window actually appends. Implemented inside `SyncWriter` via a per-book deadline map.

---

## Step 4 — Merge engine

`src-tauri/src/sync/merge.rs`:

```rust
pub fn apply_event(tx: &Transaction, event: &Event) -> AppResult<()> {
    match &event.body {
        EventBody::BookImport(b) => {
            tx.execute(
                "INSERT OR IGNORE INTO books (id, title, author, file_path, cover_path, format, status, progress, created_at, updated_at) VALUES (?1, ?2, ...)",
                params![b.id, b.title, ..., event.ts, event.ts],
            )?;
        }
        EventBody::BookDelete { id } => {
            tx.execute("DELETE FROM books WHERE id = ?1", params![id])?;
            tx.execute("INSERT OR IGNORE INTO _tombstones (entity, id, ts) VALUES ('book', ?1, ?2)", params![id, event.ts])?;
        }
        EventBody::BookProgressSet { book, progress, cfi } => {
            let existing: Option<(i64, String)> = tx.query_row(
                "SELECT updated_at, updated_by_device FROM books WHERE id = ?1",
                params![book],
                |r| Ok((r.get(0)?, r.get(1)?)),
            ).optional()?;
            if existing.map_or(true, |(ts, dev)| (ts, dev) < (event.ts, event.device.clone())) {
                tx.execute(
                    "UPDATE books
                     SET progress = ?1, current_cfi = ?2, updated_at = ?3, updated_by_device = ?4
                     WHERE id = ?5",
                    params![progress, cfi, event.ts, event.device, book],
                )?;
            }
        }
        EventBody::HighlightAdd(h) => {
            let tombstoned: bool = tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM _tombstones WHERE entity = 'highlight' AND id = ?1)",
                params![h.id], |r| r.get(0),
            )?;
            if !tombstoned {
                tx.execute("INSERT OR IGNORE INTO highlights (...) VALUES (...)", params![...])?;
            }
        }
        EventBody::HighlightDelete { id } => {
            tx.execute("DELETE FROM highlights WHERE id = ?1", params![id])?;
            tx.execute("INSERT OR IGNORE INTO _tombstones (entity, id, ts) VALUES ('highlight', ?1, ?2)", params![id, event.ts])?;
        }
        // ... one arm per EventBody variant
    }
    Ok(())
}
```

### Determinism invariants

Applying the same events in any order must produce the same SQLite state. Enforced by:
1. Sorting by `(ts, device)` before apply.
2. `INSERT OR IGNORE` for add-events; `WHERE (updated_at, updated_by_device) < (event_ts, event_device)` for LWW-events.
3. Tombstone check **before** every add.

Property test: shuffle N events, apply, assert `SELECT * FROM <every table> ORDER BY id` is byte-identical across runs.

---

## Step 5 — Replay engine

```rust
pub struct ReplayEngine<'a> {
    db: &'a Db,
    shared_dir: PathBuf,
    self_device: String,
}

impl<'a> ReplayEngine<'a> {
    pub fn tick(&self) -> AppResult<ReplayReport> { ... }
}
```

`tick()`:
0. Drain local `_pending_publish`: append any unpublished outbox rows to the device log, then delete them on success. This is the publish-retry path for Step 3's `commit succeeds, append fails` case.
1. List `<shared>/logs/*.jsonl` and `*.snapshot.json`. **Include own files** — the local device is treated as a peer keyed by `self_device` in `_replay_state`. This is primarily for migration snapshot apply-back (Step 7) and for idempotent replay of already-published own-log events.
2. For each peer (including self):
   a. If `snapshot_id > last_snapshot_id` in `_replay_state`: apply peer snapshot (step 6).
   b. Iterate log events with `id > last_event_id`. Collect.
3. Merge all collected events across peers, sort by `(ts, device)`.
4. Open a single SQL transaction, call `merge::apply_event` for each, update `_replay_state` per peer.
5. Commit.

**Invariant:** `tick()` is always safe to call. Concurrent calls are serialized by a process-wide mutex. Own events that were already applied to local SQL (the common case) cost one `SELECT updated_at` each and then skip.

**Triggers:**
- On app launch (before UI).
- On window focus (`tauri::WindowEvent::Focused(true)`).
- On `watcher.rs` notification (debounced 250 ms).
- Manual "Sync now" button.

Skip trigger while a reader session is active (`ReaderState` in-flight). Flush on reader close.

---

## Step 6 — Snapshot & compaction

`src-tauri/src/sync/snapshot.rs`:

```jsonc
{
  "v": 1,
  "device": "A",
  "id": "01HF...",                    // ULID of the latest event included
  "generated_at": "2026-04-14T...",
  "truncated_before": "01HF...",      // null for migration snapshots
  "state": {
    "books":      {"b1": {...}},
    "highlights": {"h1": {...}},
    "bookmarks":  {...},
    "vocab":      {...},
    "translations": {...},
    "collections":  {...},
    "collection_books": {"col1:b1": {"ts":"...","live":true}, ...},
    "chats":    {...},
    "chat_messages": {...},
    "tombstones": {"highlights":["h3"], "books":[], ...}
  }
}
```

### Write (atomic)
1. Serialize.
2. `write` → `fsync` → `rename` to `<device>.snapshot.json`. Never rewrite in place.
3. Truncate own log tail after `truncated_before` (skip on migration — the log is already empty).

### Apply peer snapshot — flow

When `replay_engine.tick()` discovers that a peer's snapshot has changed:

```
1. Stat <shared>/logs/B.snapshot.json; if evicted, startDownloadingUbiquitousItem and wait.
2. Parse header of the snapshot (just `id` and metadata, not full `state`).
3. Load _replay_state[B]: { last_snapshot_id, last_event_id }.
4. Decide:
   a. snapshot.id == last_snapshot_id          → skip (already applied).
   b. snapshot.id <= last_event_id             → skip apply, but update
                                                 last_snapshot_id so we don't
                                                 re-parse next tick. We've
                                                 already seen every event this
                                                 snapshot covers individually.
   c. otherwise                                → apply (step 5).
5. Parse full state. Open one transaction on local quill.db:
     for tombstone in state.tombstones:
         DELETE FROM <table> WHERE id = ?;
         INSERT OR IGNORE INTO _tombstones (entity, id, ts) VALUES (?, ?, ?);
     for entity in state.<each_table>:
         if _tombstones has (entity, id) → skip  -- local tombstone wins
         else → apply via the same helper used by merge::apply_event for the
                matching event (INSERT OR IGNORE or LWW per field)
     UPDATE _replay_state
        SET last_snapshot_id = ?,
            last_event_id    = MAX(last_event_id, ?),   -- = snapshot.id
            updated_at       = ?
      WHERE peer_device = ?;
   COMMIT.
6. Proceed to read B's log tail (events with id > new last_event_id) and apply
   via merge::apply_event.
```

### Why this is safe

Applying a snapshot is idempotent because every merge rule is idempotent: `INSERT OR IGNORE` skips existing rows, LWW compares timestamps, tombstones block re-inserts. Applying the snapshot produces the same state as applying the individual events it summarizes. So step 4b's optimization is purely for performance — correctness does not depend on knowing whether A has already seen those events individually.

### Watermark rules (correctness-critical)

- `last_snapshot_id := snapshot.id` (monotonic — step 4a guards against regression).
- `last_event_id := MAX(last_event_id, snapshot.id)` — **never decrease**. If A had already replayed events beyond `snapshot.id` via the log tail, we keep the higher watermark.

### Edge cases handled by this flow

| Situation | Behavior |
|---|---|
| B's log tail doesn't exist yet (just compacted) | Tail read returns zero events; apply just the snapshot. |
| Snapshot references a book binary that hasn't downloaded yet | Snapshot applies the `books` row immediately; reader falls back to the existing iCloud-evicted placeholder UI until the binary arrives. |
| Multiple peers publish new snapshots in the same tick | Each handled in sequence within the same tick; order doesn't matter (merge is commutative for the operations that can appear). |
| A re-sees a stale snapshot (file timestamp changes but content is older) | Guarded by step 4a — `snapshot.id` can't decrease. |
| Local user has deleted an entity that appears live in the peer snapshot | Local `_tombstones` check in step 5 wins — the snapshot entry is skipped. |

### Triggers
- Own log `> 2 MB` OR `> 5000 events` OR monthly (once per 30-day wall clock).
- End of migration routine (see Step 7) — `truncated_before = null`.

---

## Step 7 — Migration routine

`sync/migration.rs`:

```rust
pub fn run_migration(
    old_db: Connection,                    // opened read-only on <ubiquity>/quill.db
    local_dir: &Path,
    ubiquity_dir: &Path,
    shared_dir: &Path,                     // = ubiquity_dir in the iCloud case
    device_id: &str,
) -> AppResult<()> {
    // 1. Build snapshot from old_db (merged with any conflict copies — see below)
    let snap = Snapshot::from_legacy_db(&old_db, device_id)?;

    // 2. Write snapshot + empty log
    snap.write_atomic(shared_dir.join("logs").join(format!("{device_id}.snapshot.json")))?;
    EventLog::create_empty(shared_dir.join("logs").join(format!("{device_id}.jsonl")))?;

    // 3. Copy ubiquity quill.db -> local quill.db (bit-exact starting point)
    fs::copy(ubiquity_dir.join("quill.db"), local_dir.join("quill.db"))?;

    // 4. Verify row counts match the primary source DB
    verify_counts(&old_db, &Connection::open(local_dir.join("quill.db"))?, &snap)?;

    // 5. Flip the flag (durable)
    write_flag(local_dir, "migration.complete", true)?;

    // 6. Rename ubiquity quill.db* (idempotent — safe to re-run)
    retire_ubiquity_db(ubiquity_dir)?;

    Ok(())
}
```

The caller in `lib.rs` always runs `replay_engine.tick()` after `run_migration` returns. Because Step 5's `tick()` now treats the local device as a peer, the snapshot written in step 2 is immediately applied back to local `quill.db`. This is how conflict-copy rows that don't exist in the primary source DB reach the migrating device — `Snapshot::apply_peer` uses `INSERT OR IGNORE` + LWW, so primary-copy rows stay put and extra rows from `quill (1).db`, `quill (2).db` are merged in. Without this step the migrating device would only see the primary DB's rows while peers see the full union. (See `31-sync-known-problems.md` §3.)

`Snapshot::from_legacy_db` reads every synced table, packs into snapshot format. Timestamps:
- Use the row's `updated_at` if present, else `created_at`, else `MIGRATION_TS` (`2000-01-01T00:00:00Z`).

`retire_ubiquity_db` globs `<ubiquity>/quill.db*` and renames each to `*.migrated-<iso-ts>`. Safe no-op when files are already gone (called on every launch for self-healing).

**Launch flow** in `src-tauri/src/lib.rs`:

```
on launch:
  read migration.complete from local settings
  if false and icloud_was_enabled:
      run_migration(...)
  if true:
      retire_ubiquity_db(...)         # idempotent cleanup
  open <local>/quill.db
  replay_engine.tick()
  boot UI
```

### Diverged multi-device / conflicted copies

`Snapshot::from_legacy_db` also scans for `quill (1).db`, `quill (2).db`. If found, show a one-time modal before migration completes: "Conflict copies detected. Merge all (recommended) / Pick one." Merge-all opens each DB and unions all rows into the single device snapshot; UUID dedup handles overlap.

---

## Step 8 — File watcher

`src-tauri/src/sync/watcher.rs` — wraps the `notify` crate. Watch `<shared>/logs/` recursively. On any change, debounce 250 ms, then call `replay_engine.tick()` on a tokio task.

Lifetime: spawned from `lib.rs::setup` if sync is enabled; cancelled on disable.

---

## Step 9 — Settings UI

**Component:** `src/components/settings/LibrarySyncSettings.tsx` (replaces `ICloudSettings.tsx`).

**Tauri commands** (`src-tauri/src/commands/sync.rs`):
- `sync_status() -> SyncStatus { enabled, shared_dir, device_uuid, peers: Vec<Peer>, last_replay_at, pending_events, last_error }`
- `sync_enable() -> AppResult<()>` — no args; always iCloud in v1. Same semantics as today's `icloud_enable`.
- `sync_disable() -> AppResult<()>` — keeps logs on disk, stops appending. Same semantics as today's `icloud_disable`.
- `sync_now() -> AppResult<ReplayReport>`
- `sync_revert_to_legacy() -> AppResult<()>` — grace-period rollback (30 days).

Keep `icloud_status`/`icloud_enable`/`icloud_disable` aliased to these during the transition so in-flight builds don't break; remove in cleanup.

**Sections:**
1. **Sync toggle** — a single 73px row with a Toggle labelled "Sync with iCloud" / subtitle "Store your library in iCloud Drive". Identical copy and layout to today's `ICloudSettings.tsx`. Loading/error/confirmation states mirror the existing component exactly — users shouldn't notice a UI change at this level.
2. **Migration banner** — conditional amber card when `migration.complete == false`, with title "Migration pending", body "Your library is still using the legacy iCloud file sync. Migrate now for record-level sync across devices.", and a "Migrate now" button. Hidden once complete; never appears on fresh installs.
3. **Peers** — expandable "Other devices" row. Each peer row: device icon, device name, last-seen timestamp (relative, e.g. "2 min ago"), pending-events count as a subtle pill. Read-only in v1.
4. **Actions** — compact cluster of secondary buttons: "Sync now" (icon + label) and "Compact log" (icon + label). Right-aligned destructive-style link "Revert to legacy sync" visible only during the 30-day grace window. Export backup deferred.
5. **Notes** — "API keys and tokens are stored locally and never synced." / "Avoid editing on multiple devices simultaneously for best results."

**Deferred to a future release** (alongside the next cloud provider):
- Segmented control (This device / iCloud Drive / Custom folder).
- Folder picker via `@tauri-apps/plugin-dialog`'s `open({ directory: true })`.
- `sync_enable(backend, path)` signature with a `backend` argument.
- "Export local backup" action.

---

## Step 10 — Phased rollout

Because we're shipping end-to-end in v1 (no dual-write):

1. Merge all code behind an unreleased branch.
2. Internal beta: Jason's own devices + a few testers. Verify round-trips: desktop ↔ desktop, new device bootstrap, migration from existing iCloud DB, conflict-copy merge.
3. Compatibility: install v1 on one Mac, keep previous version on another; confirm "revert to legacy sync" path works (reverse rename restores old DB).
4. Ship. Release notes call out migration: "Quill now uses a per-device event log to sync your library. On first launch we'll migrate your existing iCloud data."

Cross-device testing against iOS is blocked until quill-ios ships its mirror — can be done in parallel or staged later.

---

## Shipping chunks

Cross-cutting work — land as a sequence of narrow PRs, each independently reviewable and leaving the app in a working state. The user-facing switch doesn't flip until Chunk 7.

### Chunk 1 — Schema normalization (standalone refactor, no sync code) — SHIPPED (PR #186)

Shape + type normalization as a single commit. Landed separately from the sync work so the sync PR doesn't mix two concerns. Internally breaking (all Tauri commands that returned timestamps now return numbers) but no end-user behavior change.

**Backend:**
- `src-tauri/migrations/009_normalize_timestamps.sql` — pure SQL migration. Per-table rebuild inside one transaction: `CREATE TABLE <x>_new` with final INTEGER-timestamp schema → `INSERT ... SELECT` converting each TEXT timestamp via `CAST(strftime('%s', ts) AS INTEGER) * 1000 + CAST(substr(strftime('%f', ts), -3) AS INTEGER)` → `DROP` old → `RENAME`. Tables touched: `books`, `bookmarks`, `highlights`, `collections`, `collection_books` (adds both `created_at` and `updated_at`), `vocab_words` (incl. `next_review_at`), `chats`, `chat_messages`, `translations`. **Did not add `updated_by_device`** — deferred to migration 011 (Chunk 4).
- `src-tauri/src/db.rs` — registered migration 9 via `include_str!`; per-migration `schema_version` bump so a later failure doesn't force 9 to re-run; bumped the `assert_eq!(version, 8)` tests to 9.
- `src-tauri/src/commands/{books,bookmarks,collections,vocab,chats,translation}.rs` — every `created_at: String` / `updated_at: String` / `next_review_at: Option<String>` struct field became `i64` / `Option<i64>`. Every `chrono::Utc::now().to_rfc3339()` became `chrono::Utc::now().timestamp_millis()`. Every row mapper reads `INTEGER` instead of `TEXT`. Commands on tables that previously lacked `updated_at` (bookmarks add, highlights add/color/note, collections rename/reorder, collection_books add, chat_messages add, translations add) now set it. Writing `updated_by_device` is deferred to Chunk 4/5 when migration 011 adds the column.
- **Migration tests** (in `db.rs::tests`): seed a v8 DB with realistic RFC-3339 TEXT timestamps across every affected table → run migration → assert (a) each INTEGER equals `DateTime::parse_from_rfc3339(original).timestamp_millis()`; (b) `collection_books` backfilled with migration time; (c) row counts unchanged; (d) malformed-timestamp injection rolls back the whole transaction leaving the DB at v8.

**Frontend:**
- TypeScript types: every timestamp field becomes `number` (likely in `src/types/` or inline interfaces — grep to find them all).
- Display sites: every place that rendered the ISO string now formats via `new Date(millis).toLocaleString()` or a shared formatter. Affected components at minimum: book cards, chat list, vocab panel, translations panel, bookmarks list, highlights list. Find via grep on `created_at` / `updated_at` usage.

**Verification:**
- `cargo check` + `cargo test` pass; migration tests specifically green.
- Manual: copy a real v0.9.14 `quill.db` to a scratch dir, point a dev build at it, confirm the app opens and shows existing books/highlights/chats correctly with their real historical timestamps (rendered from the migrated INTEGER values).
- Verify timestamps render identically pre- and post-migration in the UI.

### Chunk 2 — Crates + sync module skeleton + `_replay_state`

- `src-tauri/Cargo.toml` — add `ulid = "1"` (feature `serde`), `notify = "6"`. `cargo check` to sync `Cargo.lock`.
- `src-tauri/migrations/010_replay_state.sql` — `_replay_state` and `_tombstones` tables. `_pending_publish` lands in migration 011 with Chunk 4.
- `src-tauri/src/db.rs` — register migration 10.
- `src-tauri/src/sync/mod.rs` — declare submodules as empty stubs so `cargo check` compiles.
- `src-tauri/src/lib.rs` — `mod sync;`.

**Verification:** `cargo check` passes. DB advances 9→10; `_replay_state` and `_tombstones` exist.

### Chunk 3 — Event schema + EventLog (pure code, no wiring)

- `src-tauri/src/sync/events.rs` — `Event` struct + `EventBody` enum per Step 1. `#[serde(flatten)] extra` for forward-compat.
- `src-tauri/src/sync/log.rs` — `EventLog::{open, append, append_batch, read_all, read_after}` per Step 2. Owns a monotonic `ulid::Generator` + `BufWriter<File>` behind one `Mutex`. macOS: `NSFileCoordinator` wrapper via `objc2` in a `#[cfg(target_os = "macos")]` block — net-new helper (current `icloud.rs` doesn't use it).
- `src-tauri/src/sync/device.rs` — `DeviceIdentity::load_or_create(&local_dir)` reads/writes `device.json` with `{ device_uuid, created_at }`. UUIDv4 via the existing `uuid` crate.

**Tests** (colocated `#[cfg(test)] mod tests`): round-trip every `EventBody` variant; append-then-read ordering; torn-write recovery (truncate last byte); unknown-field preservation.

**Verification:** `cargo test --lib sync::` green. Not wired to the rest of the app yet.

### Chunk 4 — Merge + replay + snapshot (pure) + migration 011

- `src-tauri/migrations/011_lww_tiebreak_and_outbox.sql` — `ALTER TABLE ... ADD COLUMN updated_by_device TEXT NOT NULL DEFAULT 'migration'` on `books`, `highlights`, `collections`, `collection_books`, `vocab_words`, `chats`. Plus `CREATE TABLE _pending_publish (...)`. Bundled because both additions are prerequisites for the merge engine (`updated_by_device` for LWW tiebreak) and `SyncWriter` (`_pending_publish` for the outbox); landing them together avoids a no-op migration number between them.
- `src-tauri/src/db.rs` — register migration 11; bump test asserts from 10 to 11.
- `src-tauri/src/sync/merge.rs` — `apply_event` match per `EventBody` variant (Step 4). Helpers: `lww_update_if_newer`, `is_tombstoned`, `insert_tombstone`. Every INSERT uses `OR IGNORE`; every LWW update compares `(existing.updated_at, existing.updated_by_device) < (event.ts, event.device)` in Rust (tuple compare); tombstone check precedes every add.
- `src-tauri/src/sync/replay.rs` — `ReplayEngine::tick()` per Step 5. Drains `_pending_publish`, then lists peer logs + snapshots **including own** (local device treated as a peer for migration apply-back and idempotent own-log replay), merges events sorted by `(ts, device)`, applies in one SQL tx. Process-wide `Mutex` serializes concurrent ticks.
- `src-tauri/src/sync/snapshot.rs` — `Snapshot::{from_log, write_atomic, apply_peer}` per Step 6. Apply follows the 6-step procedure exactly (stat → header parse → watermark compare → full parse → apply under tombstone guard → monotonic watermark update).

**Tests:** migration 011 seeds a v10 DB with LWW rows → applies migration → asserts `updated_by_device = 'migration'` on every row, `_pending_publish` exists and is empty; merge determinism property test (shuffled apply → byte-identical `SELECT *`); same-ms cross-device LWW tie resolves deterministically by device UUID; tombstone wins; LWW correctness; snapshot equivalence (events vs snapshot+tail yield identical state).

**Verification:** `cargo test` green. Still not wired to any command.

### Chunk 5 — SyncWriter + command instrumentation

- `src-tauri/src/sync/writer.rs` — `SyncWriter::with_tx<F>(f: F)` per Step 3. Opens SQL tx, passes `(tx, events: &mut Vec<EventBody>)` to closure, writes the events into `_pending_publish`, commits the tx, then flushes `_pending_publish` into the log (single fsync). Order is deliberate — see Step 3 for the failure-mode rationale. Disabled case: events vec dropped, tx commits normally. Progress-event debounce ring: per-book trailing 2-second window via `HashMap<book_id, Instant>`.
- `src-tauri/src/commands/books.rs` — route `import_book`, `commit_pdf_import`, `delete_book`, `update_reading_progress`, `update_book_status`, `mark_finished`, `update_book_metadata` through `SyncWriter`. Every LWW-table INSERT/UPDATE now also writes `updated_by_device = self_device_uuid` (migration 011 added the column; SyncWriter exposes the local device UUID to the closure).
- `src-tauri/src/commands/bookmarks.rs` — all 6 commands; highlight writes also set `updated_at` and `updated_by_device` (highlights is LWW-backed).
- `src-tauri/src/commands/collections.rs` — all 6 commands; `rename_collection`, `reorder_collections`, and `add_book_to_collection` write `updated_at` and `updated_by_device`.
- `src-tauri/src/commands/vocab.rs`, `chats.rs`, `translation.rs` — remaining events per the Step 3 table. vocab_words and chats are LWW-backed → set `updated_by_device`; chat_messages and translations are append-only → no tiebreak column.
- `src-tauri/src/commands/settings.rs` + `book_settings` path — explicitly no-op (local-only).
- `src-tauri/src/lib.rs` — construct `SyncWriter::new(db, Option<Arc<EventLog>>)` once in `setup`, store in Tauri state. Commands now take `State<SyncWriter>` instead of `State<Db>`.

**Tests:** for each command — sync off → no events; sync on → event content matches SQL write. Outbox retry: simulate `commit ok, append fails` and verify `_pending_publish` drains on the next flush. Progress debounce: 10 rapid calls within 2s → exactly 1 event appended.

**Verification:** existing frontend works unchanged with sync off. `cargo test` green. Manual: import a book with sync off, confirm no log file.

### Chunk 6 — Migration routine + replay wiring on launch

- `src-tauri/src/sync/migration.rs` — `run_migration(...)` per Step 7. Reuses `icloud::ensure_downloaded` and `icloud::icloud_data_dir_fast`. Writes `Snapshot::from_legacy_db(&old_db, device_id)` + empty log, copies ubiquity `quill.db` → local bit-exact, retires ubiquity DB via rename to `quill.db.migrated-<iso-ts>`. Conflict-copy merge for `quill (1).db`, `quill (2).db`.
- `src-tauri/src/sync/watcher.rs` — `notify` wrapper on `<shared>/logs/`. Debounce 250ms, call `replay_engine.tick()` on tokio task. Skip while a reader session is active (shared `AtomicBool` flag set from reader commands).
- `src-tauri/src/lib.rs` launch flow per Step 7:
  ```
  read migration.complete from local settings
  if icloud_was_enabled && !migration.complete:
      run_migration(...)
  else if migration.complete:
      retire_ubiquity_db(...)   # self-healing
  open <local>/quill.db          # always local post-migration
  replay_engine.tick()           # first drains _pending_publish, then
                                 # catches up from peer logs AND own log
                                 # (self-replay handles:
                                 #   (a) conflict-copy snapshot → local DB
                                 #   (b) idempotent apply of already-published
                                 #       own-log events)
  spawn watcher if sync enabled
  ```
- `src-tauri/src/commands/sync.rs` — `sync_now` command (manual tick).

**Tests:** migration idempotency; conflict-copy merge; fresh-install replay from existing peer log; no-op tick.

**Verification:** manual E2E on a dev iCloud account — copy a v0.9.x DB to ubiquity, launch v1 build, confirm migration completes, retired file appears, local DB row counts match source.

### Chunk 7 — Settings UI (swap `ICloudSettings` → `LibrarySyncSettings`)

- `src/components/settings/LibrarySyncSettings.tsx` — new, single Toggle + migration banner + peers + actions (see §Step 9 above).
- `src/components/SettingsModal.tsx` — swap import and section id (`icloud` → `librarySync`).
- `src/i18n/{en,zh}.json` — add `settings.librarySync.*` namespace mirroring existing `settings.icloud.*` copy. Keep old keys during the transition.
- `src-tauri/src/commands/sync.rs` — `sync_status`, `sync_enable`, `sync_disable`, `sync_revert_to_legacy`. Register in `generate_handler!`.

**Verification:** Tauri dev server, open Settings → Library & Sync, toggle iCloud off → on → verify `<icloud-container>/logs/<device-uuid>.jsonl` appears and grows with usage.

### Chunk 8 — Compaction

- Wire triggers in `snapshot.rs` per Step 6: own log > 2 MB **OR** > 5000 events **OR** monthly. Invoked at end of migration, from "Compact log" button, and after each launch's `replay_engine.tick()`.

**Verification:** compact round-trip on real usage data produces a snapshot + truncated log that replays to the same state.

### Chunk 9 — Cleanup (Phase D, post-ship, separate follow-up issue)

After v1 ships and stabilizes over 2 releases:
- Delete `src-tauri/src/icloud.rs` legacy paths.
- Delete `src-tauri/src/commands/icloud.rs`.
- Delete old `settings.icloud.*` i18n keys.
- Delete `src/components/settings/ICloudSettings.tsx` (unreferenced after Chunk 7).

Tracked separately; not part of #185.

---

## Verification

Unit/property tests:

- [ ] Event round-trip: serialize → deserialize yields identical struct for every `EventBody` variant.
- [ ] Append-then-read: `log.read_all` matches append order.
- [ ] Torn write: truncate last byte of a test log, `read_all` skips last line with warning and succeeds.
- [ ] Merge determinism: shuffled apply of the same event set yields byte-identical `SELECT *` on every table.
- [ ] Tombstone wins: apply `highlight.delete` then `highlight.add` (same id) → highlight is absent.
- [ ] LWW: two `book.progress.set` events; higher `ts` wins regardless of apply order.
- [ ] Migration snapshot equivalence: rows in old DB == rows in new local DB == entities in snapshot.state.
- [ ] Migration idempotency: run migration twice, second run is a no-op.
- [ ] Conflict-copy merge: old DB + `quill (1).db` with overlapping-but-divergent rows merge into a single superset.
- [ ] Compaction round-trip: events → snapshot → apply snapshot on a fresh DB yields same state as replaying the events directly.
- [ ] Crash during migration: kill process between each numbered step; verify next launch resumes cleanly.
- [ ] Crash during append: kill process between `write` and `fsync`; verify no corruption on next launch.

Manual / E2E:

- [ ] Two Macs; highlight on each; converge within 30 s of wake.
- [ ] Airplane-mode one Mac, edit on the other; reconnect, changes appear.
- [ ] Read past existing progress on A while B is open on older position; verify A doesn't clobber B's newer writes.
- [ ] Delete book on A, verify it disappears on B.
- [ ] Settings "Revert to legacy sync" restores old DB and sync path; re-migration runs cleanly.
- [ ] Secrets never appear in shared folder.
