# 220 — App logging (tauri-plugin-log + panic hook + Reveal logs)

> Tracking issue: [#220](https://github.com/yicheng47/quill/issues/220)

## Motivation

Quill desktop ships with zero app-side diagnostics.

- `src-tauri/src/main.rs` is `fn main() { quill_lib::run() }`. No log
  facade init, no panic hook, no `tauri-plugin-log`.
- There are no `eprintln!`s to fall back on either. Every backend
  error path either bubbles to the frontend via `AppResult` (which
  the UI may quietly swallow — see the `.catch(() => {})` patterns
  in `useDictionary.ts`, `LookupPopover.tsx`) or is silently dropped
  in spawned tasks (`tauri::async_runtime::spawn` in `commands/ai.rs`
  emits one error chunk to the per-request event channel and is
  done — if the listener already unmounted, the error vanishes).
- On macOS, when the app launches from Finder/Dock, stderr is
  silently dropped anyway. Even if we did add `eprintln!`s, users
  couldn't see them. The only post-crash artifact today is the
  OS-level CrashReporter `.ips` file under
  `~/Library/Logs/DiagnosticReports/`, which gives a stack at the
  crash site but no app context — what book was importing, what
  sync event was applying, which AI provider was streaming.
- Recent bugs underline the cost: #216 (PDF import hangs forever
  before the metadata-extraction timeout landed) was diagnosed only
  because a user could share a screen recording. #214 (vocab
  context regression) was caught by Jason on his own machine. Both
  would have triaged in seconds from a log file.

This is foundational infra, not a user-facing feature. It is a
prereq for confidently debugging:

- **Sync (#31, #206).** The event loop in `src-tauri/src/sync/`
  applies remote events through a long pipeline (handshake → fetch
  → snapshot/merge → outbox). When a user reports "my highlights
  didn't show up on the other device," we need to be able to ask
  for a log that tells us which step dropped them.
- **AI streaming (`commands/ai.rs`).** Provider auth flips, OAuth
  token expiry, partial chunks, network drops — none of these
  surface anywhere durable today.
- **PDF import (#216 follow-up).** The timeout shipped, but we
  still don't see *which* file or *which* stage of pdf.js hung.

Filing as P1 because the next "the app froze" report is currently
unrecoverable.

## Scope

### In scope (v1)

- **`tauri-plugin-log` integration.** Add the plugin, configure a
  file target. Path:
  - macOS: `~/Library/Logs/com.wycstudios.quill/quill.log`
  - Windows: `%LOCALAPPDATA%\com.wycstudios.quill\logs\quill.log`
  - Linux: `~/.local/share/com.wycstudios.quill/logs/quill.log`

  All three are the plugin's `LogDir` defaults for the bundle
  identifier already declared at `src-tauri/tauri.conf.json:5`
  (`"identifier": "com.wycstudios.quill"`). Rotation: ~10MB per
  file, keep last 3. Stdout target stays enabled in debug builds;
  disabled in release.
- **Adopt the `log::` facade at lifecycle and error sites.** Quill
  has no `eprintln!` legacy to sweep, so this is greenfield
  instrumentation, not conversion. Concrete sites:
  - `lib.rs::run` first line: startup banner —
    `log::info!("quill start v{version} os={os} arch={arch}
    data_dir={}", app_data_dir)`.
  - `commands/books.rs::import_book` — `info` at entry with the
    file path and detected format; `error` on failure with the
    classified error variant.
  - `commands/ai.rs::ai_lookup` / `ai_chat` — `info` at the spawn
    (provider, model, kind); `warn` on `AI_NOT_CONFIGURED`;
    `error` on provider failure (don't include the request body).
  - `sync/` event apply path — `info` at handshake (peer device,
    last-seen ts); `info` per batch (event count, elapsed);
    `warn` on conflict-resolution branches (`mark_session_*`
    -style outcomes); `error` on apply failure with event id.
  - `db.rs` migration runner — `info` per migration that runs
    (number + filename); `error` on failure.
  - `commands/vocab.rs::add_vocab_word` and the
    highlight/translation siblings — `debug` per write (low
    volume, but useful for sync triage). Off by default in
    release.

  The plugin's filter respects `RUST_LOG`, so devs can crank it up
  without rebuilding.
- **Panic hook that writes to the same log.** Register
  `std::panic::set_hook` *before* `tauri::Builder::default()`. The
  hook formats `panic_info` + `std::backtrace::Backtrace::force_capture()`
  into a single `log::error!` call so the panic body and the
  backtrace end up in the log file. Then chains to the default
  hook so the existing abort/unwind behavior is preserved —
  important because the macOS CrashReporter keys on the default
  stderr line.
- **"Reveal logs in Finder" menu item.** Under `Help`. Opens the
  log directory in Finder via `tauri-plugin-opener` (already a
  Quill dependency — `lookup-popover` uses it). Windows: "Show
  logs in Explorer". Same affordance Claude Desktop and VS Code
  surface — when a user files a bug, "click Help → Reveal Logs,
  drag the file in" is the entire ask.
- **Log dir path is discoverable in Settings too.** Add a
  `Reveal logs` row under Settings → General (or a new
  "Diagnostics" subsection if General is already crowded — see
  the row pattern in `GeneralSettings.tsx` per CLAUDE.md). Both
  routes call the same command.
- **Sensible startup banner.** The first line on every app start
  logs the version (from `tauri.conf.json`), the resolved
  `app_data_dir`, the OS / arch, and the schema version (currently
  12 after #214). Triage-from-log starts with these.

### Out of scope (deferred)

- **Remote crash reporting (Sentry, BugSnag, PostHog).** Local log
  is enough for the "ask the user to send it" flow at Quill's
  current scale. Wiring a remote sink raises privacy questions
  (log contents will include book filenames, AI request kinds,
  device identifiers) and isn't worth the complexity until we
  have hundreds of users. If we ever turn it on, it must be
  opt-in with a clear preview.
- **In-app log viewer.** Other apps (Linear, Slack) have a "view
  recent logs" panel. Useful but lots of UI for a rare need;
  v1 ships "Reveal in Finder" only.
- **Structured JSON envelope.** `tauri-plugin-log` supports custom
  formatters; v1 uses the plugin's default text format
  (`[YYYY-MM-DDThh:mm:ss][level][target] message`) which greps
  cleanly. Revisit if we ever wire a remote sink.
- **Per-book or per-sync-session log files.** One global file is
  the right unit for app-level logs. Per-entity logs are a
  database concern, not a logger concern.
- **Sanitization / scrubbing.** Logs will contain absolute paths
  (book filenames under `app_data_dir`, sync device ids). Not
  credentials — API keys live in `secrets.db` and never touch
  the log path. v1 logs paths verbatim; a scrubber pass can
  normalize them later if we ever ship logs somewhere users
  don't trust.
- **iOS app and any future CLI.** Different stack, different code
  path; orthogonal. Separate spec if needed.

### Key decisions

1. **`tauri-plugin-log`, not a hand-rolled writer.** Rotation,
   target multiplexing, level filtering, and the `RUST_LOG` env
   integration are already solved by the plugin. Tauri's docs
   treat it as the default. No reason to reinvent.
2. **Default level `Info` in release, `Debug` in debug builds.**
   `Info` produces a few lines per lifecycle event (start,
   import, sync apply, AI request) — enough to reconstruct user
   actions from a bug report, not enough to blow up disk. Devs
   can crank to `Debug` via `RUST_LOG=quill=debug`.
3. **Panic hook chains to the default, doesn't replace it.** The
   goal is `panic body → log file` BEFORE the existing abort path
   runs. Replacing the default hook outright would suppress the
   stderr line that the OS CrashReporter currently keys on; chain
   instead. (`backtrace::Backtrace::force_capture()` works even
   when `RUST_BACKTRACE` is unset — important because users
   almost never set that env var.)
4. **Help menu is the canonical surface.** "Reveal logs in
   Finder" in the Help menu matches every other macOS dev tool.
   Settings page row is the discoverability backup.
5. **Greenfield instrumentation, not legacy conversion.** Quill
   has no `eprintln!`s to sweep. The cost here is choosing the
   right N entry points to instrument, not a mechanical sweep.
   Land at the call sites named above; resist the urge to
   instrument every internal helper.
6. **No remote anything in v1.** Opt-in remote reporting is its
   own feature with its own privacy review. Don't slip it into
   this spec.

## Implementation phases

### Phase 1 — plugin + log facade

- Add to `src-tauri/Cargo.toml`:
  ```toml
  tauri-plugin-log = "2"
  log = "0.4"
  ```
- Init in `src-tauri/src/lib.rs::run`:
  ```rust
  tauri::Builder::default()
      .plugin(tauri_plugin_log::Builder::new()
          .targets([
              Target::new(TargetKind::LogDir { file_name: Some("quill".into()) }),
              #[cfg(debug_assertions)]
              Target::new(TargetKind::Stdout),
          ])
          .level(if cfg!(debug_assertions) {
              log::LevelFilter::Debug
          } else {
              log::LevelFilter::Info
          })
          .max_file_size(10 * 1024 * 1024)
          .rotation_strategy(RotationStrategy::KeepN(3))
          .build())
      // existing plugins (opener, dialog, updater, process)
  ```
- Confirm `LogDir` resolves to the OS-conventional path on each
  target platform with the bundle identifier from
  `tauri.conf.json:5`.

### Phase 2 — panic hook

- New `src-tauri/src/panic_hook.rs`:
  ```rust
  pub fn install() {
      let prev = std::panic::take_hook();
      std::panic::set_hook(Box::new(move |info| {
          let bt = std::backtrace::Backtrace::force_capture();
          log::error!("panic: {info}\n{bt}");
          prev(info);
      }));
  }
  ```
- Call `panic_hook::install()` as the first line of
  `quill_lib::run()` — *before* the Tauri builder, so even a
  panic during plugin init lands in the file (the file target
  initializes lazily on first write).

### Phase 3 — instrument lifecycle + error sites

Land `log::` macros at each site listed in the In Scope section.
Don't expand beyond that list in v1 — every additional site costs
either signal or disk.

- `lib.rs::run` startup banner
- `commands/books.rs::import_book` entry + error paths
- `commands/ai.rs::ai_lookup` and `ai_chat` spawn + provider error
- `sync/*` handshake, batch-apply, conflict-branch, apply-failure
- `db.rs` migration runner per-migration log
- `commands/vocab.rs`, `commands/highlights.rs`,
  `commands/translation.rs` write paths at `debug`

### Phase 4 — Reveal logs surface

- New `reveal_logs_dir` Tauri command in
  `src-tauri/src/commands/app.rs` (or wherever the app-shell
  commands sit — create the module if it doesn't exist).
  Resolves the log dir via `app.path().app_log_dir()` and opens
  it with `tauri-plugin-opener`. Returns `AppResult<()>`.
- Help menu entry in the Tauri menu config (macOS / Linux /
  Windows): "Reveal Logs in Finder" / "Show Logs in Explorer".
  Use the OS-aware label.
- Settings → General → Diagnostics row: a button that calls the
  same command. Match the row pattern in `GeneralSettings.tsx`
  per CLAUDE.md (73px-tall row, flex justify-between, 1px
  `black/10` divider). i18n key under `settings.diagnostics.*`.

### Phase 5 — verification

Manual smoke:
1. Fresh release build on macOS. Start from Finder. Confirm
   `~/Library/Logs/com.wycstudios.quill/quill.log` exists and
   contains the startup banner.
2. Import an EPUB. Confirm `info` lines for entry + completion.
3. Trigger a lookup with AI configured. Confirm `info` at spawn
   and a `kind` indication. Disable AI and retry; confirm a
   `warn` AI_NOT_CONFIGURED entry.
4. Force a sync error (e.g., tear the secrets DB midway). Confirm
   the relevant `error` line lands with the event id.
5. Force a panic (debug build, hidden `QUILL_PANIC_TEST=1` env
   that triggers a panicking thread 5s after start). Confirm the
   panic body + backtrace are in the log BEFORE the OS
   CrashReporter `.ips` writes. Both should exist.
6. Help → "Reveal Logs" opens the right directory.
   Settings → Diagnostics → "Reveal Logs" does the same.
7. Drop the rotation threshold temporarily and run long enough
   to roll over. Confirm three files survive: `quill.log` plus
   two rotated.
8. Windows smoke for one happy-path scenario (verify the
   `app_log_dir` path resolution + opener works).

Backend tests:
- Smoke test that `panic_hook::install` doesn't break the test
  harness (test threads panic intentionally — chain-to-default
  should be safe).
- Unit test that the resolved log dir matches the bundle
  identifier from `tauri.conf.json` (catches an identifier
  rename silently breaking the path).

## Verification

- [ ] `tauri-plugin-log` initialized with a file target at the
      OS-conventional log path on macOS, Windows, and Linux.
- [ ] Panic hook installed before the Tauri builder; panic bodies
      land in the log file with a backtrace, default hook still
      runs after.
- [ ] Startup banner logs version, OS, arch, `app_data_dir`,
      schema version.
- [ ] `log::` instrumentation lands at every entry-point named in
      Phase 3 (no scope creep beyond that list).
- [ ] Default level: `Info` in release, `Debug` in debug builds.
      `RUST_LOG` override respected.
- [ ] Help → "Reveal Logs in Finder" (macOS) / "Show Logs in
      Explorer" (Windows) opens the log directory.
- [ ] Settings → General → Diagnostics has a "Reveal Logs" row
      that does the same. All copy via i18n keys.
- [ ] Log file rotation works: ~10MB per file, last 3 kept.
- [ ] `cargo check && cargo test --lib` clean.
- [ ] `pnpm tsc --noEmit` clean.
- [ ] No schema changes, no sync event payload changes.
