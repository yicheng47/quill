-- Migration 010 — replay bookkeeping tables.
--
-- Two local-only tables that belong to the sync engine. They never appear in
-- the event log (events describe user-facing state; these tables describe how
-- far we've gotten applying other peers' events). Their rows are rebuilt by
-- `ReplayEngine::tick()` and `Snapshot::apply_peer`.
--
-- `_replay_state`: per-peer high-water marks. Keyed by device UUID. Each row
-- answers "how far into peer B's log / snapshots have we applied?" so the
-- next tick can resume without re-reading every event.
--
-- `_tombstones`: durable delete markers for entities whose rows have been
-- removed locally. Queried on every event apply (see `merge::apply_event`) so
-- a late-arriving `*.add` for a deleted id is suppressed rather than
-- resurrecting the row.
--
-- Both tables store `ts` / `updated_at` as INTEGER unix milliseconds, aligned
-- with migration 009.

CREATE TABLE _replay_state (
  peer_device      TEXT PRIMARY KEY,
  last_event_id    TEXT,
  last_snapshot_id TEXT,
  updated_at       INTEGER NOT NULL
);

CREATE TABLE _tombstones (
  entity TEXT NOT NULL,
  id     TEXT NOT NULL,
  ts     INTEGER NOT NULL,
  PRIMARY KEY (entity, id)
);
