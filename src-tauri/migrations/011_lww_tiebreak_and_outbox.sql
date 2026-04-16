-- Migration 011 — LWW tiebreak column + outbox table.
--
-- Two sync-engine prerequisites land together:
--
-- 1. `updated_by_device TEXT NOT NULL DEFAULT 'migration'` on every LWW-backed
--    table. The merge engine's tuple compare is
--      `(stored.updated_at, stored.updated_by_device) < (event.ts, event.device)`,
--    so without this column equal-millisecond writes from two devices would
--    resolve nondeterministically. The default `'migration'` is a sentinel that
--    sorts before any real device UUID hex string (UUIDv4s start with 0-9/a-f),
--    which matches the intent: pre-sync rows lose any same-ms tie to a real
--    sync write.
--
-- 2. `_pending_publish` outbox. Step 3 of `docs/impls/sync/31-sync.md` writes
--    pending events into this table inside the SQL transaction, then flushes
--    them to the device log after commit. If the post-commit append fails, the
--    next `ReplayEngine::tick()` drains the outbox. This bounds partial-failure
--    outcomes to "peers lag the origin," never the reverse — see
--    `31-sync-known-problems.md` §1.
--
-- Bundled because both additions are prerequisites for Chunk 4's merge engine
-- and Chunk 5's `SyncWriter`. Splitting them across two migration numbers
-- would put a no-op step in the sync series for no benefit.

-- ---------------------------------------------------------------------------
-- 1. updated_by_device — six LWW-backed tables.
-- ---------------------------------------------------------------------------
ALTER TABLE books            ADD COLUMN updated_by_device TEXT NOT NULL DEFAULT 'migration';
ALTER TABLE highlights       ADD COLUMN updated_by_device TEXT NOT NULL DEFAULT 'migration';
ALTER TABLE collections      ADD COLUMN updated_by_device TEXT NOT NULL DEFAULT 'migration';
ALTER TABLE collection_books ADD COLUMN updated_by_device TEXT NOT NULL DEFAULT 'migration';
ALTER TABLE vocab_words      ADD COLUMN updated_by_device TEXT NOT NULL DEFAULT 'migration';
ALTER TABLE chats            ADD COLUMN updated_by_device TEXT NOT NULL DEFAULT 'migration';

-- ---------------------------------------------------------------------------
-- 2. _pending_publish outbox.
-- ---------------------------------------------------------------------------
CREATE TABLE _pending_publish (
  id         TEXT PRIMARY KEY,             -- local outbox row id (UUIDv4)
  ts         INTEGER NOT NULL,              -- event timestamp to publish (unix ms)
  body_json  TEXT NOT NULL,                 -- serialized EventBody JSON
  created_at INTEGER NOT NULL               -- unix millis when enqueued
);
