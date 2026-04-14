# 31 — Sync

**Issue:** [#185](https://github.com/yicheng47/quill/issues/185)
**Status:** Planned
**Milestone:** Cross-Platform Sync
**Supersedes:** [16 — Universal Cloud Sync](../archive/features/16-universal-cloud-sync.md), [28 — CloudKit Sync](../archive/features/28-cloudkit-sync.md)

## Motivation

Quill currently "syncs" by placing the SQLite database file inside an iCloud ubiquity container and letting iCloud Drive replicate the file. This is fundamentally broken for multi-device use:

- **Last-writer-wins at the file level.** Two devices writing concurrently produces `quill (1).db` conflict copies or silent data loss.
- **Journal file races.** WAL/`-shm` files can sync out of order. We run DELETE journal mode to mitigate, losing write performance.
- **No mid-session change detection.** The iOS app only calls `DatabaseService.refresh()` on scene-active transitions; desktop edits arriving while the reader is open are invisible until the app is backgrounded and resumed.
- **Binary file eviction races.** iCloud materializes `quill.db` on demand; the DB may be opened against a stale cached copy before the newer version downloads.

Two prior plans attempted to address this:

- **Spec 16** proposed BYOC (any user-chosen synced folder) — right vision (cloud-provider-agnostic, no backend) but wrong mechanism (still whole-file sync of SQLite).
- **Spec 28** proposed CloudKit — right mechanism (record-level sync) but wrong scope (Apple-only; Tauri desktop can't call CloudKit natively; CloudKit Web Services re-introduces a backend dependency).

This spec unifies both directions:

> **Sync a per-device append-only event log through any shared folder the user picks. SQLite becomes a local derived view, rebuildable from the logs.**

No backend, no server, no Apple lock-in. Works on iCloud Drive, Dropbox, OneDrive, Google Drive, Syncthing, a rclone mount, an SMB share — anything that eventually replicates files between devices.

## Design

### Core model

- Each device writes only to **its own log file** (`logs/<device-uuid>.jsonl`). No two devices ever modify the same file ⇒ the cloud provider never has to merge.
- Events are **small, append-only, schema-versioned JSONL**.
- Each device maintains a **purely local** `quill.db` as a materialized view of the merged logs. The DB file is never synced.
- Replay is a **pure deterministic function**: `(list of peer logs) → SQLite state`. All devices converge.
- Binary assets (EPUBs, PDFs, covers) continue to live as regular files in the shared folder, referenced by relative path from the log events.

### File layout (inside the user-chosen shared folder)

```
<shared-folder>/
  logs/
    <device-uuid>.jsonl              # append-only, this device writes only here
    <device-uuid>.snapshot.json      # compaction output (see below)
  books/
    <book-id>.epub|pdf               # binary files, shared across devices
  covers/
    <book-id>.jpg
```

Local-only (each device's app data directory):

```
<app-data>/
  quill.db                           # materialized view, never synced
  device.json                        # {"device_uuid": "..."}
```

### Event schema

```jsonl
{"id":"01HF...","ts":"2026-04-14T12:34:56.789Z","device":"A","v":1,"type":"highlight.add","payload":{...}}
```

- `id` — ULID, monotonic within a device
- `ts` — ISO-8601 UTC
- `device` — UUID of the originating device
- `v` — event schema version (for forward compat)
- `type` — dotted event type (see catalog below)
- `payload` — type-specific body

Total order across devices: `(ts, device)` tiebreak. Within a device, `id` order is sufficient.

### Event catalog & merge rules

| Event type | Merge rule | Notes |
|---|---|---|
| `book.import` | dedup by id | Payload carries `file`, `cover` relative paths |
| `book.delete` | tombstone; delete wins | Cascades in the view; originating device removes binary |
| `book.progress.set` | LWW per `book_id` by `ts` | Monotonic in practice |
| `book.status.set` | LWW per `book_id` by `ts` | |
| `book.metadata.set` | LWW per `(book_id, field)` by `ts` | title/author/etc. edits |
| `bookmark.add` | UUID-keyed, dedup on id | |
| `bookmark.delete` | tombstone | |
| `highlight.add` | UUID-keyed, dedup on id | |
| `highlight.color.set` | LWW per `(id, field)` | |
| `highlight.note.set` | LWW per `(id, field)` | |
| `highlight.delete` | tombstone | |
| `vocab.add` | UUID-keyed; natural dedup on `(book, word)` | |
| `vocab.mastery.set` | LWW per `(id, field)` | Take higher mastery, earlier review date |
| `vocab.delete` | tombstone | |
| `translation.add` | UUID-keyed; natural dedup on `(book, source_text, target_lang)` | |
| `translation.delete` | tombstone | |
| `collection.create` | UUID-keyed | |
| `collection.rename` | LWW per `(id, field)` | |
| `collection.reorder` | LWW per `id` on `sort_order` | |
| `collection.delete` | tombstone | |
| `collection.book.add` | LWW per `(collection_id, book_id)` | Add/remove pair is a register |
| `collection.book.remove` | LWW per `(collection_id, book_id)` | |
| `chat.create` | UUID-keyed | |
| `chat.rename` | LWW per `(id, field)` | |
| `chat.delete` | tombstone; cascades messages in view | |
| `chat.message.add` | UUID-keyed, append-only | |

**Never synced (per-device / local-only):**
- **Secrets** — API keys, OAuth tokens; continue to live in `secrets.db`, same as today.
- **General settings** — theme, language, sidebar width already live in `localStorage`; the rarely-used SQLite `settings` table is also treated as per-device from now on.
- **Per-book settings** — `book_settings` table (font size, reading mode, line spacing). These are UI preferences that belong to the screen you're reading on, not the library. A 14" laptop and a 6" phone want different values — syncing them creates friction, not value.

### Binary files and event ordering

Files and events are independently replicated, so we rely on eventual consistency rather than atomicity:

**Write path (on the originating device):**
1. Write binary file to `books/<id>.epub` (the shared folder's sync daemon begins upload).
2. Write cover to `covers/<id>.jpg`.
3. Append `book.import` event to own log.

The event references the file by relative path. Peers replaying the event insert the DB row immediately — if the binary hasn't finished downloading on the peer yet, the reader falls back to the same "downloading" placeholder UI we already need for evicted iCloud files.

**Delete path:**
1. Append `book.delete` event to own log.
2. Originating device removes local files.

Peers processing the tombstone remove their local DB row and clean up their cached copy of the file. Late-arriving `book.import` events for the same ID are ignored (tombstone wins).

### Replay and per-peer watermarks

Each device maintains a local-only table:

```sql
CREATE TABLE _replay_state (
  peer_device TEXT PRIMARY KEY,
  last_event_id TEXT,          -- resume point in that peer's tail
  last_snapshot_id TEXT        -- latest applied snapshot from that peer
);
```

Replay loop:

1. List `logs/*.jsonl` in the shared folder.
2. For each peer log, trigger download if evicted (`startDownloadingUbiquitousItem` / equivalent).
3. For each peer:
   - If their snapshot is newer than our last applied one: discard cached peer state, apply snapshot.
   - Read events after `last_event_id`, merge into the global event stream.
4. Apply merged events to SQLite in total order. Update watermarks.

This is purely incremental after the first run. Desktop and iOS share the same replay logic (port once in Rust, once in Swift, or share via a common schema).

### Compaction (designed in from day one)

Each device can compact **only its own log** — no coordination needed. The snapshot captures the cumulative effect of that device's contributions:

```json
{
  "v": 1,
  "device": "A",
  "truncated_before": "01HF...",
  "state": {
    "highlights": {"h1": {...}},
    "tombstones": {"highlights": ["h3"]},
    "progress": {"b1": {"progress": 42, "cfi": "...", "ts": "..."}},
    ...
  }
}
```

Triggers: log size > 2 MB, OR event count > 5 000, OR monthly on launch. Conservative.

Protocol:
1. Read own log in full (plus prior snapshot if any).
2. Collapse into a new snapshot by applying merge rules to own events only.
3. Write `<device-uuid>.snapshot.json.tmp` via a file coordinator, rename atomically.
4. Truncate `<device-uuid>.jsonl` to only events after `truncated_before`.

Peers need no special logic beyond "if snapshot `last_snapshot_id` advanced, replace our cached view of that peer's contribution." Because merge is deterministic, applying snapshot + tail is equivalent to replaying the full original log.

### Why this works on file-level cloud drives

- **Per-device files eliminate write conflicts.** Sync providers only ever see single-writer files.
- **Append-only JSONL syncs fast.** Most events are <300 bytes; cloud providers transmit only deltas.
- **Binary assets already work.** They're regular files, per-book-id.
- **Offline is trivial.** Each device buffers writes in its own log; on reconnect the shared folder replicates normally.
- **New device bootstrap is just replay.** Point a fresh install at the shared folder; it reads all peer logs and rebuilds `quill.db`.
- **Recovery is trivial.** Lose the local DB? Rebuild from logs. The logs are the source of truth.

### Settings & UI

Replace both the current iCloud settings section and the planned-but-never-shipped BYOC UI with a single "Library & Sync" section.

- Radio: **Local only** / **iCloud Drive** (Apple platforms) / **Custom folder** (all platforms)
- Folder picker for custom
- Per-peer "last seen" list (shows other devices that have written to the shared folder)
- "Sync status": last replay, pending events in own log, file coordinator state
- Legacy migration prompt (detect old file-synced `quill.db`, import its rows as a one-time `book.import` / `highlight.add` / ... batch from a synthetic "migration" device log)

### Device identity & ID generation

- Each install generates a UUIDv4 on first launch, stored in `<app-data>/device.json`. Never synced.
- All entity IDs are UUIDv4 (Quill already does this). No autoincrement PKs anywhere.
- A human-readable device label (`"Jason's iPhone"`) is optional, stored only in the snapshot metadata for display purposes.

## Migration from current file-sync

The fundamental challenge: the new system needs a *history* of operations, but the current system only stores *state*. Migration synthesizes a starting-point event log from each device's current `quill.db`.

### Synthesize, don't guess

Each device's migration path runs once, locally:

1. Generate a device UUID; create the device log.
2. Read the local `quill.db` in full (whatever state it's in — iCloud-synced or not).
3. Emit synthetic events for every row: `book.import`, `highlight.add`, `vocab.add`, `bookmark.add`, `collection.create`, `collection.book.add`, `chat.create`, `chat.message.add`, etc.
4. For each event, use the row's existing `created_at` / `updated_at` for `ts`. Rows without timestamps get a fixed pre-epoch migration timestamp (e.g., `2000-01-01T00:00:00Z`) so any real event trumps them.
5. Tag migration events with `"source":"migration"` for debuggability.
6. Set `migration.complete = true` in local-only settings (idempotent guard).

UUID entity IDs mean two devices migrating independently dedup cleanly on `book.id`, `highlight.id`, etc. LWW fields resolve by `(ts, device_uuid)` as usual.

### Phased rollout

**Phase A — Dual-write (zero behavior change, ship broadly)**
- Every SQLite write also appends to the device log.
- File-sync remains the source of truth; logs are written but not read.
- Ship behind a feature flag. Let logs accumulate for a release or two. Gives us real-world event volume data before flipping.

**Phase B — Opt-in migration (power users)**
- "Try new sync (beta)" toggle in settings.
- On enable: synthesize migration events from current DB, start reading peer logs + replaying, move `quill.db` out of the ubiquity container to local app data.
- Old `quill.db` stays in the ubiquity container as a **read-only backup**.

**Phase C — Default on (new installs + gradual rollout)**
- New installs use log-based sync from day one (no migration needed).
- Existing users auto-upgrade on next launch with a one-time explainer dialog.

**Phase D — Remove legacy**
- Two stable releases after Phase C, delete file-sync code paths and the legacy `quill.db` backup.

### Multi-device migration

Two scenarios when a user already runs multiple devices on file-sync:

- **Consistent devices.** Both `quill.db`s have the same rows. Both migrate independently. Merge collapses duplicates by UUID. Zero data loss, zero extra work.
- **Diverged devices** (the reason we're doing this). Device A has highlights 1–5; device B has 1–4 + 6 because its sixth didn't sync yet. Both migrate: highlights 1–4 dedup, 5 comes from A, 6 comes from B. **Both arrive in the final merged state.** The log-based approach recovers data the file-sync lost.

### Conflicted-copy recovery

Before migration, detect `quill (N).db` siblings in the ubiquity container. Offer a one-time UI:

- **Merge both** (recommended) — emit migration events from both files; merge rules collapse duplicates.
- **Pick one** — user chooses which `.db` to migrate from; the other is archived locally.

Before migration, users had no way to recover from a conflict copy. After migration, they do — a user-visible feature, not just an implementation detail.

### Binary file migration

- **Shared folder == old ubiquity container:** `books/` and `covers/` are already in place. No copy needed.
- **Switching to a different shared folder (BYOC path):** copy `books/` and `covers/` on the migrating device. Events reference relative paths that resolve in the new folder. Peer devices with existing local copies detect matching paths and skip re-download.

### Rollback

For the first ~4 weeks after a device migrates:
- Old `quill.db` in ubiquity is preserved, read-only.
- Settings shows a "Revert to legacy sync" button.
- Revert: flip `sync_backend` back to `"legacy"`, resume reading/writing the old file. Event logs remain on disk — not deleted, so a future re-migration picks up where we left off.

After the grace period: revert button disappears, legacy DB is archived locally for export, ubiquity copy is cleaned up.

### Idempotency & re-migration

- `migration.complete` gates the one-time action per device.
- Reinstalling the app generates a new device UUID and re-emits migration events from current local state. Merge collapses duplicates with peers; worst case is slightly inflated log size (compaction handles it).
- No "resumable" migration — it's atomic at the transaction level (all events appended or none).

## Out of scope

- True real-time sync (push notifications). Replay runs on app launch, foreground, and on a `NSMetadataQuery` / `FileSystemWatcher` trigger — that's real enough for a reading app.
- End-to-end encryption beyond what the cloud provider offers.
- Shared libraries between users (multi-user). Single-user, multi-device only.
- Android / Windows apps — design supports them; shipping them is a separate project.
- Full-text embeddings, AI chat context — device-local, not synced.

## Implementation Phases

### Phase 0 — Stop the bleeding (1–2 days)

Short-term fixes to the current file-sync so it at least fails gracefully until the log-based system is ready. Discard after Phase 3 lands.

- iOS: call `startDownloadingUbiquitousItem` + `waitForDownload` before `DatabaseService.refresh()` on foreground (`QuillApp.swift:47-55`).
- iOS: guard refresh from running while a `ReaderView` is active, to avoid snapshot-under-read.
- Desktop: debounce `book.progress.set` writes (2 s trailing) to cut file churn.

### Phase 1 — Event log infrastructure

1. Define event schema as a shared types crate / package (`crates/quill-sync-events`).
2. `EventLog` append API (Rust + Swift) with file coordination, atomic rename for rotation, resilient to torn writes.
3. Generate `device.json` on first launch; migrate existing users into a device identity.
4. Add `_replay_state` to local schema.

### Phase 2 — Dual-write (logs + SQLite)

- Add log append call alongside every existing DB write. Ship behind a feature flag; existing file-sync remains the source of truth.
- Verify logs accumulate correctly in dev, no perf regressions.
- This phase is zero-risk — logs are written but not yet read.

### Phase 3 — Replay + flip the source of truth

1. Implement replay: peer discovery, download, watermarked apply.
2. Implement the migration path described in **Migration from current file-sync** below.
3. Ship as opt-in beta (Phase B of migration rollout). Keep old file-sync code paths live.
4. Settings UI updated to show peers, sync state, and the "Revert to legacy sync" button.

### Phase 4 — Compaction

1. Implement snapshot generation (own log → `state`).
2. Implement snapshot consumption (peer snapshot → cached peer state).
3. Wire up triggers (size / count / cadence).
4. Verify replay equivalence: `events` vs `snapshot + tail` produce identical SQLite state (property test).

### Phase 5 — BYOC (any shared folder)

1. Add "Custom folder" option to settings.
2. Folder picker + Tauri `dialog` integration.
3. Migration between backends (local → iCloud → custom folder).
4. iOS: iCloud-only (sandboxing); desktop: any folder.

## Open Questions

- **How to bound the "total order" in practice?** Using `(ts, device)` assumes approximately-synced clocks. NTP drift of seconds is fine because merge rules are commutative for almost everything (monotonic progress, tombstones, UUID-keyed inserts). The only LWW cases that could flip with bad clocks are `*.rename` / `highlight.color.set` — acceptable.
- **Log rotation during a write?** Use a write-ahead temp file and atomic rename at event-batch boundaries so a crash mid-append can't corrupt the JSONL.
- **Two simultaneous opens of Quill on one device?** Shouldn't happen (single-instance), but if it does, both could race on the device's own log. Simple file lock on the device log is enough.
- **Legacy users with a corrupted conflicted-copy DB?** Migration step should detect `quill (1).db` siblings and offer a "pick which wins" UI before emitting migration events.
- **How big do logs get in practice?** Back-of-envelope for a heavy user: 1 000 highlights × ~400 B + 10 000 progress events × ~200 B ≈ 2.4 MB before compaction. Well within "fine."

## Verification

- [ ] Two desktops + one iOS device; create highlights on each; all three converge to identical sets.
- [ ] Disable network on device B, make edits on A; reconnect B — edits replay correctly.
- [ ] Bootstrap a fresh install from an existing shared folder; library appears.
- [ ] Delete local `quill.db`; rebuild on next launch matches pre-delete state.
- [ ] Snapshot + tail replay produces same state as full replay (property test).
- [ ] Book binary appears on peer devices; reader shows "downloading" placeholder while file lands.
- [ ] No conflict files (`quill (1).db`, `<uuid> (1).jsonl`) ever created under normal operation.
- [ ] Legacy migration: user on file-synced `quill.db` migrates without data loss.
- [ ] Switch shared folder from iCloud → Dropbox — library follows, logs continue in the new folder.
- [ ] Secrets (`secrets.db`) never appear in the shared folder.
- [ ] Reading on device A does not clobber newer progress from device B when both were active.
