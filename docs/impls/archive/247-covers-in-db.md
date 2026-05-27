# 247 — Store Covers in SQLite

PR: https://github.com/yicheng47/quill/pull/248

## Problem

When iCloud sync is enabled, cover images resolve to iCloud paths. On a freshly synced device, all covers are evicted placeholders. The frontend tries to load them via Tauri's asset protocol, which blocks the main thread → app hangs ("not responding").

## Solution

Store cover image bytes directly in SQLite as a BLOB column. Covers are small (~50KB each, ~16MB total for 329 books). The frontend renders them as `data:image/...;base64,...` URLs. No iCloud paths, no file management, no eviction.

## Schema Change

Migration 013:

```sql
ALTER TABLE books ADD COLUMN cover_data BLOB;
```

Backfill on first launch: read existing cover files from disk, write bytes into the DB, set `cover_path = NULL`.

## Backend Changes

### `Book` struct

Add `cover_data: Option<String>` — base64-encoded image. Returned inline by `list_books` and `get_book`.

### `list_books` / `get_book`

SELECT includes `cover_data`. The base64 string is included in the JSON response. ~16MB for 329 books with covers — one IPC call, fast from local SQLite.

### `save_book_cover`

Write bytes to `cover_data` column instead of disk.

### Import (EPUB / PDF)

`extract_metadata` returns cover bytes instead of writing to `covers_dir`. Stored in DB during insert.

### Sync

- Snapshots include `cover_data` per book (full state dump)
- Events do NOT carry cover bytes — too large per-event. `book.import` events carry `cover_path` for backwards compat. Peers get covers via snapshot apply.

## Frontend Changes

### `Book` type

```typescript
interface Book {
  // ... existing fields
  cover_data: string | null;  // base64-encoded image
}
```

### `CoverImage` / `BookGrid` / `BookList`

Replace `convertFileSrc(book.cover_path)` with:

```typescript
const src = book.cover_data
  ? `data:image/png;base64,${book.cover_data}`
  : null;
```

## Migration

1. Migration 013 adds `cover_data BLOB` column
2. Backfill routine on startup reads existing cover files, writes bytes into DB
3. Cover files on disk are NOT deleted (iCloud peers may still reference them)

## Verification

- Fresh device syncs 329 books → app renders immediately, covers show from DB
- Import a book → cover stored in DB, shows instantly
- Existing library → migration backfills from disk → no visible change
- Snapshot sync includes cover_data → peer gets covers on snapshot apply
