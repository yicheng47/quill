# 370 M1 — Remove iCloud Sync and Legacy Event-Log Engine

**Starting point.** Part of #370 (clean slate before Quill Cloud). Work in `/Users/jason/repos/yicheng47/quill/.worktrees/refactor-remove-icloud-sync` on branch `refactor/remove-icloud-sync`, based on `origin/main` `7c6a588`. Read [AGENTS.md](../../../AGENTS.md) first. Ignore sibling worktrees (`.worktrees/feat-370-quill-cloud-sync` holds uncommitted `#370` drafts).

**Problem and outcome.** Quill Cloud (#370) will use a server-ordered entity-sync protocol instead of the legacy iCloud event-log engine. The current ~11.8K LOC sync stack (per-device JSONL logs, peer discovery, snapshots/compaction, LWW replay, iCloud file coordination, dual `data_dir` relocation, macOS iCloud entitlements/provisioning profile, and iCloud UI) was built solely around iCloud's folder constraints. Remove it cleanly so Quill returns to a simple local-first SQLite core.

**Read first.**

- Rust: `crates/quill-core/src/{host,db,dispatch,icloud}.rs`, `crates/quill-core/src/sync/mod.rs`, `crates/quill-core/src/commands/{sync,books,bookmarks,chats,collections,vocab,translation}.rs`, `crates/quill-core/src/mcp/{stdio,state,tools/library}.rs`, `crates/quill-node/src/lib.rs`, `crates/quill-core/Cargo.toml`.
- Frontend: `src/components/settings/{SettingsView,SettingsNav,types,LibrarySyncSettings}.tsx`, `src/components/{HomeView,TopBar,BookList,ReaderCloudState}.tsx`, `src/pages/{Home,Reader}.tsx`, `src/i18n/{en,zh}.json`.
- Packaging & CI: `build/entitlements.mac.plist`, `electron-builder.ts`, `electron/packaging/artifacts.ts`, `.github/workflows/{nightly,release}.yml`.
- Docs: `docs/arch/overview.md`, `docs/privacy.md`, `docs/tests/regression/README.md`, `AGENTS.md`.

## Deliverables

1. **Rust core (`crates/quill-core`, `crates/quill-node`, `crates/quill-mcp`):**
   - Remove `icloud.rs`, `commands/sync.rs`, and `sync/{events,log,merge,migration,peers,replay,snapshot,watcher,writer}.rs`. Keep `DeviceIdentity` (`device.rs`, loaded at boot from `.device-identity`) for Quill Cloud.
   - Remove `SyncWriter`, `SyncState`, sync boot/replay/watcher threads, `.icloud_setting`, and dual `local_dir`/`data_dir` iCloud splitting from `host.rs`, `db.rs`, `dispatch.rs`, `mcp/{stdio,state}.rs`, and `crates/quill-node/src/lib.rs` (drop the iCloud media root).
   - Simplify all mutating commands (`books`, `bookmarks`, `chats`, `collections`, `vocab`, `translation`, `mcp/tools/library.rs`) to plain SQLite transactions on `Db` without `EventBody` or `_pending_publish`. Compute `book.available` via `abs_path.exists()`. Remove obsolete `sync_*` / `get_sync_status` / `download_book` command routes.
   - Leave shipped migrations `001`–`014` untouched (existing local `quill.db` files stay valid; unused sync tables/columns sit inert). Keep dual-connection WAL `Db` and `secrets.db` isolation intact.
   - Remove unused macOS crates (`objc2`, `objc2-foundation`, `block2`, and `gethostname` if unused) from `crates/quill-core/Cargo.toml` and update `Cargo.lock`. Keep `ulid` (`ai/codex`) and `notify` (`.mcp-notify`).
2. **Frontend & i18n:**
   - Delete `LibrarySyncSettings.tsx` + test. Remove `"librarySync"` from `SettingsSection`, `normalizeSettingsSection` (fall back to `"general"`), `SettingsNav`, and `SettingsView`, leaving 9 tabs on macOS and Windows.
   - Remove the TopBar sync-progress chip (`sync-progress` / `sync-initial-tick-done`), Home empty-state iCloud CTA, iCloud hydration/download paths in `Home.tsx`, `BookList.tsx`, and `Reader.tsx`, and `ReaderCloudState.tsx` + test. Keep a clean generic error screen in `Reader.tsx` for missing/unreadable local book files.
   - Drop dead iCloud/sync keys from `en.json` and `zh.json` in sync; update affected tests (`SettingsView`, `MainViews`, `TopBarUpdate`, `LibraryCollections`, `ReaderMaterial`, `HomeNavigate`, `Reader`).
3. **macOS signing, packaging & CI:**
   - Strip `com.apple.application-identifier`, `com.apple.developer.team-identifier`, and all `icloud-*` / `ubiquity-*` keys from `build/entitlements.mac.plist` (keep `allow-jit` and `allow-unsigned-executable-memory`).
   - Remove `PROVISIONING_PROFILE_PATH` / `provisioningProfile` wiring from `electron-builder.ts` and `electron/packaging/artifacts.ts`.
   - Update `.github/workflows/{nightly,release}.yml`: remove `PROVISIONING_PROFILE` secret checks/decoding/cleanup, remove positive grep assertions for `icloud-container-identifiers` and `application-identifier` on `Quill.app` (keep codesign/spctl/stapler/TeamIdentifier checks and assert neither app nor helpers carry iCloud entitlements), and drop the iCloud note from nightly release notes.
4. **Docs:** Update `docs/arch/overview.md`, `docs/privacy.md`, `AGENTS.md`, and `docs/tests/regression/README.md` (retire `SYN-01`–`SYN-04`: iCloud sync removed ahead of #370).

**Non-goals:** No Quill Cloud implementation, no iCloud copy-back path, no edits to migrations `001`–`014`, no `public/foliate-js` or sibling-worktree changes.

## Validation and Handoffs

- **Automated (`coder`):** `make typecheck`, `make lint`, `npm test`, `cargo check --workspace`, `cargo test --workspace`, `cargo clippy --workspace -- -D warnings`, unpacked pack check (`CSC_IDENTITY_AUTO_DISCOVERY=false QUILL_PACK_ALLOW_DEBUG=1 npx electron-builder --mac --dir --publish never && node scripts/validate-pack.mjs`), and grep check confirming no stray iCloud/legacy-sync code remains across `crates/`, `src/`, `electron/`, `build/`, `.github/`. Hand clean diff to `reviewer` before pushing.
- **Review (`reviewer`):** Audit data-safety core (`db.rs`, `host.rs`, de-wired mutating commands, MCP write path) and macOS entitlements/workflows. Name live checks in clean review; apply `reviewed` on final PR head.
- **Live checks (`qa`, macOS `make dev` on `com.wycstudios.quill-dev`, never touching installed Quill):**
  - `APP-01` & `SET-04`: clean boot with zero sync errors in `quill.log`; empty Home omits iCloud CTA; Settings has 9 tabs with no Library Sync, every tab opens/saves, EN ↔ 中文 clean.
  - `LIB-01`, `LIB-06`, `LIB-07`, `LIB-08`, `LIB-09`: import `01-plain-frankenstein.epub`, status menu, collection CRUD + add/remove book, edit title/author persisting across restart, delete book staying removed.
  - `RDR-01`, `RDR-06`, `RDR-07`: open EPUB, turn pages persisting across reopen, highlight CRUD, bookmark CRUD.
  - `VOC-01` & `AI-04`: verify de-wired vocab/chat writes (tiny prompt if AI provider is configured; otherwise note prerequisite honestly).
  - Back up and restore `~/Library/Application Support/com.wycstudios.quill-dev` if mutated. Check port 1430 before launch. Record run in `docs/tests/runs/370-m1-remove-icloud-sync-mac.md` with screenshots outside the repo.

## Authorization

`neon trio`, approved by Jason on 2026-11-26. Authorized to commit on `refactor/remove-icloud-sync` (folding this brief into an implementation commit and folding review/QA fixes into the commits they correct), push, open a PR against `main` (`Part of #370`) with `core-review`, `risk-high`, `needs-live-test` (removed by `qa` after required checks pass) and `reviewed` (added by `reviewer` on the final head), drive CI green on macOS and Windows, and stop. Jason merges.
