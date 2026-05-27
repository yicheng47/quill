# 251 — Cover Sync via iCloud Files

Issue: https://github.com/yicheng47/quill/issues/250
PR: https://github.com/yicheng47/quill/pull/251

## Problem

Covers stored as BLOBs in SQLite don't propagate to peers through the event log (too large per-event). They only travel via snapshot compaction, which is threshold-gated (2MB / 5000 events / 30 days). A newly imported book's cover may take days to reach a synced peer.

## Solution

Dual-storage: covers live as files in the iCloud `covers/` directory for sync transport, and as BLOBs in local SQLite for fast rendering. iCloud replicates the file natively; the replay tick picks up new peer cover files and writes them into the local DB.

```
Import → write covers/<id>.ext to shared_dir + cover_data BLOB locally
                    │
                    ▼
         iCloud replicates file to peer
                    │
                    ▼
Peer replay tick → scan covers/ for new files → read bytes → store in local cover_data BLOB
                    │
                    ▼
         Frontend renders from cover_data (never from file)
```

The frontend always renders from `cover_data` BLOB — no file I/O in the hot path. The `covers/` directory is a sync transport only.

## Directory Layout

```
<shared_dir>/            # ubiquity_dir (iCloud Documents)
  logs/                  # event logs + snapshots (existing)
  devices/               # peer manifests (existing)
  books/                 # book files (existing)
  covers/                # cover image files (NEW sync transport)
    <book_id>.img        # raw image bytes, .img extension (format-agnostic)
```

Use `.img` as a generic extension — the actual format (PNG/JPEG/etc.) is sniffed from magic bytes when encoding to data URI. This avoids needing to track MIME separately.

## Backend Changes

### 1. Cover file write on import/save

**Files:** `src-tauri/src/commands/books.rs`

When cover bytes are available (EPUB import, PDF commit, PDF backfill), write them to `<data_dir>/covers/<book_id>.img` in addition to storing in `cover_data` BLOB. **Only when sync is enabled** — local-only users don't need the file copy. The file write is best-effort — if it fails (disk full), the local BLOB still works.

A dedicated `cover-writer` thread processes file writes off the import path. Avoids spawning a thread per import and keeps iCloud I/O off the main thread.

**SyncWriter gets a channel sender:**

```rust
// In SyncWriter
cover_tx: Mutex<Option<mpsc::Sender<(PathBuf, Vec<u8>)>>>,
```

**Thread created once during `boot_sync_engine`:**

```rust
let (tx, rx) = mpsc::channel::<(PathBuf, Vec<u8>)>();
std::thread::Builder::new()
    .name("cover-writer".into())
    .spawn(move || {
        for (path, bytes) in rx {
            let _ = fs::create_dir_all(path.parent().unwrap());
            let _ = fs::write(&path, &bytes);
        }
    });
sync_writer.set_cover_tx(Some(tx));
```

**Helper on SyncWriter:**

```rust
impl SyncWriter {
    pub fn queue_cover_write(&self, db: &Db, book_id: &str, bytes: &[u8]) {
        if !self.should_queue() { return; }
        let Ok(data_dir) = db.data_dir.lock() else { return };
        let path = data_dir.join("covers").join(format!("{book_id}.img"));
        if let Some(tx) = self.cover_tx.lock().ok().and_then(|g| g.clone()) {
            let _ = tx.send((path, bytes.to_vec()));
        }
    }
}
```

Call sites just call `sync.queue_cover_write(db, &book_id, bytes)`:
- `do_insert_book` — after INSERT, if `cover_bytes.is_some()`
- `save_book_cover` — after UPDATE
- `commit_pdf_import` — after INSERT, if `cover_data.is_some()`

When sync is disabled, `cover_tx` is `None` — writes silently skipped. When sync is enabled, writes queue into the channel and the `cover-writer` thread drains them sequentially. The channel is unbounded (`mpsc::channel`) so the sender never blocks.

### 2. Ingest peer cover files during replay tick

**File:** `src-tauri/src/sync/replay.rs`

Add a new phase between the existing outbox flush and peer discovery (or after peer apply):

```rust
fn ingest_peer_covers(shared_dir: &Path, db: &Db) {
    let covers_dir = shared_dir.join("covers");
    // list all .img files
    // for each: parse book_id from filename
    // check if local cover_data IS NULL for that book_id
    // if so: read file bytes, UPDATE books SET cover_data = ? WHERE id = ?
}
```

This runs on every tick. It's cheap: one `read_dir` + one SELECT per new file. Files already ingested are skipped (`cover_data IS NOT NULL`). No timeout needed — cover files are small (50-500KB).

### 3. Snapshot changes

**File:** `src-tauri/src/sync/snapshot.rs`

Remove the cover_data overlay from `compact_own_log` — it's no longer needed since covers propagate via files. The snapshot still includes `cover_data` in `BookRow` for the initial bootstrap case (peer has no cover files yet but gets a full snapshot).

`upsert_book` keeps `COALESCE(excluded.cover_data, books.cover_data)` — still correct.

### 4. Delete cover file on book delete

**File:** `src-tauri/src/commands/books.rs`

In `do_delete_book`, after removing the book file, also remove the cover file:

```rust
let cover_file = db.resolve_path(&format!("covers/{id}.img"));
let _ = fs::remove_file(&cover_file);
```

### 5. Restore `covers/` directory creation

**File:** `src-tauri/src/db.rs`

Re-add `fs::create_dir_all(data_dir.join("covers"))` in `init_split` since covers are files again (for sync transport).

## Frontend Changes

None. The frontend already renders from `cover_data` BLOB via data URI. The file layer is invisible to it.

## Migration

No schema changes. The `cover_data` BLOB column (migration 013) stays. The background backfill from the previous commit handles upgrading users — it reads legacy `covers/<id>.png` files into the DB.

For the new `.img` files: they're written going forward on new imports. Existing covers in the DB don't need corresponding `.img` files unless a peer needs them — the snapshot carries `cover_data` for the bootstrap case.

## Verification

1. Import an EPUB with cover → `cover_data` BLOB set + `covers/<id>.img` written to data_dir
2. MCP imports a PDF → `backfillMissingCovers` fires → `save_book_cover` dual-writes BLOB + file
3. Sync enabled, two devices: import on A → cover file replicates via iCloud → B's next tick picks it up → B has cover in DB
4. Delete book → cover file removed
5. Fresh peer with snapshot only (no cover files yet) → gets cover via snapshot `cover_data`
6. `cargo test` passes
7. MCP `list_books` still uses lightweight query (no cover BLOB loading)
