# 300 - Rebuild Library from iCloud

GitHub issue: https://github.com/yicheng47/quill/issues/300

## Motivation

There is no way to recover a sync that has gone wrong. `sync_now` runs a single watermark-gated tick — it re-applies nothing it has already seen, so once local state has diverged from the shared folder there is no path back. [#298](https://github.com/yicheng47/quill/issues/298) is the case that surfaced this: a fresh Mac finished its initial replay with 359 books and zero covers, and stayed that way across four relaunches, because `ingest_peer_covers` gave up silently and the watermarks said there was nothing left to do. The only remedies available were toggling sync off and on, or reinstalling.

**Rebuild from iCloud** gives users a self-serve escape hatch: discard the local materialized view of synced data and reconstruct it from the peer snapshots and event logs already sitting in the shared folder. It is a one-way pull — nothing in iCloud is deleted or rewritten — which makes it safe to reach for whenever the library looks wrong.

## Scope

In scope:

- A `sync_rebuild` backend command that publishes local state, wipes the synced tables and every replay watermark, then replays the shared folder from scratch.
- **Publish before wipe.** The command flushes `_pending_publish` into the device's own log and publishes a bootstrap snapshot *before* deleting anything, so local rows that had not yet reached the shared folder are durable in it first. This is what makes the rebuild lossless in the normal case.
- **Wipe scope — synced tables only:** `books`, `highlights`, `bookmarks`, `vocab_words`, `translations`, `collections`, `collection_books`, `chats`, `chat_messages`, plus every row in `_replay_state`.
- **Preserved:** `settings`, `book_settings`, `schema_version`, `secrets.db`, `_tombstones`, and the `books/` and `covers/` binaries on disk. Tombstones survive so locally-deleted books do not resurrect during the replay.
- **Cover re-ingest.** Wiping `books` drops the `cover_data` BLOBs, so the replay's cover ingest re-runs from the `.img` files in the shared folder — the direct repair for #298's end state.
- **Rebuild marker** persisted outside the wiped tables, so a rebuild interrupted by a quit or crash resumes on next launch instead of leaving a half-populated library.
- **Progress and cancel** reuse the existing `sync-progress` / `sync-initial-tick-done` events and `sync_cancel`. A cancelled rebuild leaves the marker set and resumes later.
- **Settings entry point:** a danger-styled row in the Library Sync section with a single confirm dialog, disabled in queue-only mode the same way Sync now and Compact are.
- All new strings in `en.json` / `zh.json`.

Out of scope:

- Deleting, rewriting, or re-uploading anything in the iCloud shared folder. The rebuild only reads from it.
- Re-downloading book binaries. They already live in the shared folder and eviction is handled by the existing on-demand download path.
- Selective rebuild (covers only, a single book, a single peer).
- Reset All App Data — that is [276 — Reset All App Data](276-reset-all-data.md), a fully destructive local wipe with a different confirmation bar.

## Known risk

Anything written locally while sync was enabled that never made it into the device's own log is lost. Phases 1's publish-first ordering closes the ordinary version of this gap (`_pending_publish` drain plus a bootstrap snapshot), but a row that was never queued at all cannot be recovered. The confirm dialog says so plainly rather than promising the operation is free.

## Implementation Phases

1. `sync_rebuild` backend command in `src-tauri/src/commands/sync.rs`.
   - Refuse when the engine is not running this session, matching `sync_now` / `sync_compact`.
   - Order: `flush_outbox` → `publish_bootstrap_snapshot` → set rebuild marker → one write tx that clears the synced tables and `_replay_state` → full `tick_with_progress` → clear marker → emit `sync-initial-tick-done`.
   - Unit tests: publish happens before the wipe; local-only tables and `_tombstones` survive; watermarks are cleared; a rebuild over an already-healthy library is a no-op in its end state (same row counts, same content).

2. Rebuild marker + resume-on-launch.
   - Marker lives outside the wiped tables so it survives the wipe and a crash.
   - On launch, a set marker makes the boot path run the rebuild's replay half before the normal initial tick.
   - Unit tests: a rebuild interrupted after the wipe converges on the next launch; the marker clears exactly once.

3. Settings UI.
   - Danger-styled row in `LibrarySyncSettings.tsx`, below the Sync now / Compact actions row, following the section's existing row pattern.
   - Single confirm dialog: what will happen, that iCloud is not modified, and the unpublished-local-writes caveat. Cancel is the default action.
   - Disabled with the existing `paused` tooltip when the engine is not running.

4. Progress, cancel, and i18n.
   - Wire the rebuild through the existing sidebar progress chip and the Cancel affordance that `sync_now` already uses.
   - All strings localized in English and Chinese.

## Verification

- Rebuild on a healthy multi-device library ends with the same books, collections, highlights, vocabulary, and chats it started with, and every cover populated.
- Rebuild on a library in #298's end state (books present, `cover_data` NULL) fills in every cover.
- `settings`, `book_settings`, and `secrets.db` are byte-identical before and after; API keys and reading preferences survive.
- A book deleted locally before the rebuild stays deleted afterwards.
- Quitting mid-rebuild and relaunching converges to a complete library with no manual action.
- Cancelling a rebuild leaves the app usable and the rebuild resumable.
- Nothing under the iCloud shared folder is deleted or modified except the device's own log and snapshot.
- The action is disabled with the paused tooltip when sync is in queue-only mode.
- Dialog and row strings are localized in English and Chinese.
