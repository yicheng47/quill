# 300 — Rebuild Library from iCloud — Implementation Plan

Spec: [`docs/features/300-rebuild-from-icloud.md`](../features/300-rebuild-from-icloud.md). No Figma prompts — the UI reuses the existing settings-row and confirm-dialog patterns in `LibrarySyncSettings.tsx`.

## Touchpoints

| File | Change |
|------|--------|
| `src-tauri/src/sync/replay.rs` | `with_tick_lock()` helper; `ReplayReport.cancelled` captured under the tick mutex |
| `src-tauri/src/commands/sync.rs` | `sync_rebuild` command + marker helpers + wipe tx + `run_rebuild` / `run_rebuild_replay` + unit tests |
| `src-tauri/src/lib.rs` | resume-on-launch in `boot_sync_engine`'s initial-tick thread (+ same check in `sync_enable`'s tick thread); register command |
| `src/components/settings/LibrarySyncSettings.tsx` | danger row + confirm dialog |
| `src/i18n/en.json`, `src/i18n/zh.json` | rebuild strings |

## Command flow (`sync_rebuild`)

Async command, work on `spawn_blocking` (same pattern as `sync_status` / `sync_disable`'s copy phase). Refuses with the same error as `sync_now` / `sync_compact` when `engine_snapshot()` is `None` — this covers queue-only mode, where the UI also disables the row with the `paused` tooltip.

Core sequence (`run_rebuild`, shared with tests). **Marker-aware:** when the rebuild marker is already set, a prior rebuild's publish is durable in the shared folder and the local DB may be wiped or partial — re-running the publish half would overwrite the only complete recovery snapshot with that partial state, so every entry point (command retry, boot resume, `sync_enable` resume) skips straight to step 4.

1. **Pre-wipe fold tick** — `engine.tick_with_progress(db, app_handle)`. A full tick rather than a bare `flush_outbox`: it drains the outbox as its Phase 0 *and* applies any own events not yet replayed locally (still queued, or flushed to the own log by the background worker but never ticked). That materializes `_tombstones` rows for recent deletes before the snapshot is generated — absence from a snapshot does not encode deletion, and the snapshot's watermark would otherwise mask the delete event while an older peer `*.add` resurrects the row. If the user cancels during this tick, the rebuild aborts before any destructive step.
2. Bootstrap publish via `replay::publish_with_own_state_settled` — holds the outbox seal (`FLUSH_OUTBOX_MUTEX`) while it drains the outbox, re-applies every event still present in the own log, and then runs `publish_bootstrap_snapshot` (existing helper from `sync_enable`; captures every synced row currently in the DB plus `_tombstones`). Re-applying the full log (idempotent, compaction-bounded) rather than the tail above the self watermark closes two gaps at once: the TOCTOU window where a delete commits and the flush worker appends it between the fold tick and the snapshot minting, and watermark holes — a normal tick skips events that fail to apply while a later success still max-bumps the watermark, so the watermark is not proof of application. Events queued during the seal are safe: their ULIDs end up newer than the snapshot id, so the replay applies them normally. The re-apply fails closed: an own event that errors aborts the whole sealed publish — skipping it and publishing anyway would mint a snapshot whose id masks the unapplied event.
   After the publish, a second cancel gate runs before the marker commits us to the wipe. User cancellation is tracked by the engine's monotonic cancel generation: `sync_cancel` bumps it, the rebuild captures the value once it holds `REBUILD_MUTEX`, and any increment observed at a gate means this operation was cancelled. The tick-scoped flag is reset at every tick start (laundering a cancel landing during the publish), and a resettable boolean could be cleared by a second queued rebuild request — the never-reset generation has neither flaw, and cancels from before the capture are naturally stale. Both pre-marker gates abort with nothing wiped and no marker set.
   The whole state machine (marker check → publish half → wipe + replay) is single-flight under a process-wide `REBUILD_MUTEX`, shared with both resume entry points — two concurrent rebuilds could otherwise both pass the marker check and the slower one would publish the wiped DB over the only complete recovery snapshot.
3. `set_rebuild_marker(db)` — `settings` KV row (`sync_rebuild_pending = true`). The `settings` table is local-only, preserved by the wipe, and lives in `quill.db` — survives crash and quit, never syncs to peers.
4. `run_rebuild_replay(engine, db, app_handle)`:
   - `engine.cancel()` — ask any in-flight watcher tick to wind down so the wipe isn't stuck behind a long replay.
   - **Wipe tx** under `replay::with_tick_lock` (holds `TICK_MUTEX` so no tick can interleave between its per-event transactions and our deletes — without the lock, a concurrent tick's watermark bump after our wipe would strand rows): one write transaction deleting all rows from `chat_messages`, `chats`, `collection_books`, `collections`, `vocab_words`, `bookmarks`, `highlights`, `books`, `_replay_state`. Child tables before parents; missing core tables are hard errors. **Spec deviation:** the spec lists `translations` as a ninth wiped table, but it is preserved instead — snapshots don't carry it and its events are merge no-ops since #263, so wiping it would be unrecoverable deletion, and it's already dropped on dev DBs stamped by a since-deleted migration 14 (the smoke test failed on exactly that). The spec should be updated from nine tables to eight. The write connection runs with `PRAGMA foreign_keys=OFF` (`db.rs` `init_split`; merge relies on explicit cascades), so `DELETE FROM books` cannot cascade into the preserved `book_settings`.
   - `engine.tick_with_progress(db, app_handle)` — full replay: watermarks are gone, so every peer snapshot and log (including our own) re-applies; `ingest_peer_covers` refills `cover_data` from `covers/*.img`; `sync-progress` work-unit events drive the existing sidebar chip (#302).
   - Marker decision via `settle_rebuild_marker(db, &report)`: cleared only when the tick returned `Ok` **and** `report.cancelled` is false. The verdict is read from the tick's own report — captured while the tick still held `TICK_MUTEX` — never from the engine-global flag: the own-log/snapshot writes queue a watcher tick that resets that flag the moment our tick releases the mutex, which would let a cancelled rebuild clear its marker and lose the resume. A cancelled or failed replay leaves the marker set.
5. Emit `sync-initial-tick-done` (even on replay error — mirrors `sync_now`), return `SyncNowResult`.

Nothing in the sequence writes to the shared folder beyond the device's own log append (flush), own snapshot (publish), own manifest heartbeat, and possibly own-log compaction inside the tick — all pre-existing own-file writes. Peer files are only read.

## Marker + resume state machine

Marker = `settings['sync_rebuild_pending'] = 'true'`. Semantics: "a rebuild was requested and its wipe + full replay has not completed."

Resume hook: in `boot_sync_engine`'s `sync-initial-tick` thread (and `sync_enable`'s tick thread, so an in-session disable/enable can't strand the marker), check `rebuild_marker_set(db)` first. If set, run `run_rebuild_replay` (wipe again, then the tick that is already there) instead of the bare tick; the marker clears on the first complete un-cancelled replay.

Crash/cancel matrix:

- **Crash after fold/publish, before marker** — nothing local changed; the published log/snapshot are idempotent surplus. User re-triggers (no marker → full sequence again).
- **Retry while marked** (command click, boot, or `sync_enable`) — publish half skipped entirely; `sync_enable`'s own bootstrap publish is likewise gated (`publish_bootstrap_snapshot_unless_rebuild_pending`), so a cancel → disable → re-enable cycle can't snapshot the partial DB over the recovery snapshot.
- **Crash between marker and wipe** — resume re-runs the wipe, then replays. The pre-crash publish is already durable in the shared folder; local writes made in between are in `_pending_publish` (preserved by the wipe) or the own log, and flow back via tick Phase 0 + replay.
- **Crash mid-replay (after wipe)** — watermarks advanced per-event in the same tx as each apply, so even a plain tick would resume correctly; the resume path re-wipes first, which merely discards partial progress and replays from scratch. Converges either way; the re-wipe keeps the marker's meaning simple (one path, no "how far did we get" bookkeeping).
- **Cancel (user)** — `sync_cancel` flips the tick flag and bumps the cancel generation. Before the marker is set (during the fold tick or the publish): clean abort, nothing wiped, no marker. After the marker: the tick breaks between events (`report.cancelled`), and even a cancel the tick-start reset would launder is caught by the post-replay generation compare — either way the marker is retained → resume on next launch. The app stays usable in the meantime (partially populated library, same as any interrupted initial sync).
- **Marker clears exactly once** — only the thread whose complete replay finished un-cancelled deletes the KV row; a second boot sees no marker and ticks normally.

## Closed edge: deletes not yet replayed at rebuild time

A local delete only gains a `_tombstones` row when its *event* is applied by a tick; a delete still queued in `_pending_publish` (or flushed to the own log but never replayed) has none. Publishing the bootstrap snapshot after a bare `flush_outbox` would mint a snapshot id newer than the delete event, advance the self watermark past it during replay, and let an older peer `*.add` resurrect the row — violating the spec's "a locally deleted book stays deleted." The pre-wipe fold tick (step 1 above) closes this: unapplied own events are folded into the DB — landing their tombstones — before the snapshot is generated. Cost: one extra tick, cheap in watermark-current states and worth it in all of them.

## UI

`LibrarySyncSettings.tsx`, inside the `syncOn` block, below the actions row: a 73px danger row (title + muted description left, a solid danger button right — a real button, matching the confirm dialog's destructive CTA, not a link-styled text action) separated by the standard 1px divider. Disabled with the existing `paused` tooltip when `!engineRunning`, and while `busy`. Confirm dialog mirrors the remove-device dialog: what happens, iCloud not modified, unpublished-local-writes caveat; Cancel is the default (autofocused) action, the destructive button is danger-styled. On confirm → `invoke("sync_rebuild")`; progress + cancel ride the existing `sync-progress` chip and Cancel-sync affordance for free. The rebuild emits two back-to-back progress streams (fold tick, then replay); `Home.tsx` resets its monotonic percent clamp whenever a stream begins (`applied === 0`), so the second phase visibly advances instead of pinning at the first phase's 100%.

i18n keys (`settings.librarySync.*` in `en.json` + `zh.json`): `rebuild`, `rebuildSub`, `rebuildCta`, `rebuildConfirmTitle`, `rebuildConfirmMsg`, `rebuildConfirmCta`.

## Tests (`commands/sync.rs`)

Fixture mirrors `replay.rs`'s `Env` (in-memory `Db` via `run_migrations_on`, temp shared dir, own `EventLog`, `ReplayEngine`).

1. **Publish before wipe** — a book queued in `_pending_publish` and a book inserted by raw SQL (never queued) both exist after `run_rebuild`; the own log contains the flushed event; the own snapshot file exists; the outbox is empty.
2. **Local-only tables + tombstones survive** — `settings`, `book_settings` rows intact after rebuild; a book imported from a peer, then locally deleted (SQL delete + queued `book.delete`, tick to land the tombstone — the real `do_delete_book` flow) stays deleted after rebuild even though the peer log still carries its `book.import`.
3. **Watermarks cleared** — `wipe_synced_tables` empties `_replay_state` (and the eight synced tables) while leaving `settings`, `book_settings`, `_tombstones`, `_pending_publish`, and the legacy `translations` untouched.
4. **Healthy library converges** — peer events + own rows, tick, record row counts + spot content; rebuild; identical counts + content, cover blob re-ingested from `covers/*.img`.
5. **Interrupted rebuild resumes** — run fold + publish + marker + wipe, stop (simulated crash before replay); simulate next launch: marker is set → `run_rebuild_replay` converges and clears the marker; a second resume check finds no marker.
6. **Retry doesn't republish partial state** — local-only book, rebuild interrupted after the wipe, retry through `run_rebuild`: the marker short-circuits the publish half and the book is restored from the pre-wipe snapshot.
7. **`sync_enable` publish gated on the marker** — with the marker set and the DB wiped, `publish_bootstrap_snapshot_unless_rebuild_pending` leaves the pre-wipe snapshot untouched; the resume then restores from it.
8. **Deletes without a prior tick stay deleted** — one delete still in the outbox, one already in the own log but never replayed; `run_rebuild` lands both tombstones via the fold tick and neither book resurrects.
9. **Cancel verdict is per-invocation** — a cancel landing mid-tick sets `report.cancelled` even though a follow-up tick resets the engine flag (large-log seam with a bounded, fail-fast wait, in `replay.rs`); `settle_rebuild_marker` keeps the marker on a cancelled report and clears it on a completed one.
10. **Sealed publish folds raced-in own events** — a delete already in the own log (unapplied) and one still in the outbox both have tombstones by the time the publish closure runs (`replay.rs`).
11. **Single-flight** — two concurrent `run_rebuild` callers serialize; both books survive and the published snapshot is never a wiped/partial DB.
12. **Stale cancels are ignored** — a cancel from before the rebuild request doesn't abort it.
13. **Cancel after the final gate retains the marker** — a generation bump after the pre-marker gates forces the cancelled verdict even though the replay tick completes; the marker survives and the next resume clears it.
14. **Sealed publish fails closed** — an own event that errors on apply aborts `publish_with_own_state_settled` before the publish closure runs (`replay.rs`).
15. **Watermark holes abort the rebuild** — a failing own event followed by a successful one leaves the self watermark past the hole after the pre-tick; `run_rebuild` still errors before any snapshot, marker, or wipe because the seal re-applies the full own log.

The pre-marker gates' two inputs are pinned separately — a cancelled fold tick (`pre.cancelled`, test 9's mid-tick capture) and a generation change after the capture (tests 12-13); the gates themselves are single conditionals over those inputs, so there is no additional in-flight thread-race test.

## Checks

`cargo test` + `cargo clippy` in `src-tauri`; `pnpm build` (tsc + vite) for the frontend.
