# 31 — Sync Known Problems

Companion notes for [31 — Sync (per-device event log)](31-sync.md).

These are design gaps identified during plan review. Each now carries a
resolution decision.

## 1. SyncWriter failure asymmetry needs a repair path

`SyncWriter::with_tx` currently assumes a rare partial failure is acceptable:
append succeeds, commit fails, or vice versa. That is not a consensus problem,
but it is still a correctness problem because `ReplayEngine::tick()` skips this
device's own log. If an event is durable in the shared log but absent from the
origin device's SQLite commit, peers can ingest it while the origin device has
no built-in way to converge later.

Required plan change:
- replay self logs as a local crash-recovery path, or
- persist locally-pending events and only publish/advance once both the event
  append and SQL commit have completed.

Preferred choice: a local outbox plus publish retry.

### Resolution (accepted, folded into 31-sync.md)

Adopted a two-part fix:

1. **Use a local outbox (`_pending_publish`) plus commit-then-append**
   (Step 3 / Chunk 5). `SyncWriter::with_tx` writes SQL changes and
   serialized `EventBody` rows into `_pending_publish` inside the same SQL
   transaction, commits, then flushes the outbox to the device log. That
   bounds partial-failure outcomes so peers can only lag the origin, never
   run ahead of it — the opposite order would produce an event visible to
   peers with no corresponding local row, which is unrecoverable.
2. **Have `ReplayEngine::tick()` drain `_pending_publish` before replay**
   (Step 5 / Chunk 4), and still include the local device as a peer for
   migration snapshot apply-back and idempotent own-log replay. Unpublished
   events now live in the outbox, not in the log, so replay is no longer
   responsible for discovering them.

The pure self-log-replay alternative was rejected because it cannot recover
the `commit succeeded, append never happened` case unless some separate
local durable marker already exists.

## 2. LWW rows need a stored tiebreak, not just `updated_at`

The original plan sorted events globally by `(ts, device)` but only compared
`existing.updated_at < event.ts` in most merge examples. That lost determinism
when two devices wrote the same field in the same millisecond: the later event
in `(ts, device)` order would be ignored because `updated_at == event.ts`.

Required plan change:
- for every LWW register, persist both the winning timestamp and the winning
  device UUID (or an equivalent tiebreak field),
- compare `(event.ts, event.device)` against `(stored_updated_at, stored_device)`
  in merge helpers,
- keep plain `updated_at` as the user-facing timestamp, but do not rely on it
  alone for replay correctness.

### Resolution (accepted, folded into 31-sync.md)

Fix now by adding `updated_by_device TEXT NOT NULL` to every LWW-backed row:

- `books`
- `highlights`
- `collections`
- `collection_books`
- `vocab_words`
- `chats`

Merge helpers compare `(event.ts, event.device)` against
`(stored.updated_at, stored.updated_by_device)`, and local writes update both
columns together. Migration 009 backfills legacy rows with a deterministic
sentinel such as `'migration'`.

This removes the same-millisecond determinism hole without changing the
high-level model. The extra plumbing is acceptable for a core sync feature,
and much cheaper than carrying a known split-brain caveat in the merge
contract indefinitely.

## 3. Conflict-copy migration must update the migrating device's local view

The migration flow says conflict copies such as `quill (1).db` can be merged
into one synthesized snapshot, but the plan also copies one source DB
bit-exact into local `quill.db` and skips own snapshot/log replay afterward.
That means peers may see the merged superset while the migrating device still
boots from only the copied primary DB.

Required plan change:
- after synthesizing the merged migration snapshot, rebuild local `quill.db`
  from that merged state instead of copying a single source DB verbatim, or
- allow the migrating device to apply its own migration snapshot/log once so
  local state matches what peers will later replay.

Without this, conflicted-copy migration is not self-consistent on the device
that performs it.

### Resolution (accepted, folded into 31-sync.md)

Falls out of Problem 1's fix: the launch-time `replay_engine.tick()` (Step
5 / Chunk 6) now treats the local device as a peer, so the migration
snapshot written under `logs/<self>.snapshot.json` is applied back to the
migrating device's `quill.db` on the very next tick. `Snapshot::apply_peer`
uses `INSERT OR IGNORE` + LWW, so rows present in the primary source DB
(copied bit-exact at step 3 of `run_migration`) stay put, and extra rows
from `quill (1).db`, `quill (2).db` merged into the snapshot land on local
DB the same way they land on peers.

The primary-DB bit-exact copy in `run_migration` step 3 is kept — it's a
cheap starting point that preserves any row that might exist in the legacy
DB but not in the event schema (future-proofing against columns the sync
layer doesn't model). The self-replay then fills in the conflict-copy
delta.

No standalone plan change required beyond Problem 1's fix; 31-sync.md
Step 7 now explicitly calls out the self-replay step.
