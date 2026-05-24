mod ai;
mod commands;
// `pub` so `tests/mcp_binary.rs` can call `Db::init` to seed a DB at
// the temp HOME path the binary will read from. Otherwise integration
// tests would need to hand-roll the full migration suite.
pub mod db;
mod epub;
mod error;
mod icloud;
mod mcp;
mod panic_hook;
mod secrets;
mod sync;

use std::path::{Path, PathBuf};
use std::sync::Arc;

use commands::sync::SyncState;
use db::Db;
use secrets::Secrets;
use sync::device::DeviceIdentity;
use sync::log::EventLog;
use sync::replay::ReplayEngine;
use sync::watcher::WatcherHandle;
use sync::writer::SyncWriter;
#[cfg(target_os = "macos")]
use tauri::Emitter;
use tauri::Manager;

/// The resolved local app data directory, accounting for dev-mode isolation.
pub struct LocalDir(pub PathBuf);

/// Resolve the plugin's level filter, honoring `RUST_LOG` over the cfg
/// default. Plain `LevelFilter` only — no `env_logger`-style
/// `target=level` syntax. The spec asks devs be able to "crank it up
/// without rebuilding," which a single global level satisfies; the
/// plugin's native `.level()` is the only filter point we wire.
///
/// Unparseable values (typos like `RUST_LOG=verbose`) fall back to the
/// default rather than killing plugin init.
fn resolve_log_level(default: log::LevelFilter) -> log::LevelFilter {
    std::env::var("RUST_LOG")
        .ok()
        .and_then(|s| s.trim().parse::<log::LevelFilter>().ok())
        .unwrap_or(default)
}

/// The bundle identifier this build should use for OS-scoped paths
/// (logs, app_data). Adds the `-dev` suffix in debug builds so a
/// `pnpm tauri dev` session doesn't pollute the production log dir or
/// app-data dir the released app uses. Mirrors the dev-suffix logic
/// already in the setup() callback for `app_data_dir`.
fn bundle_identifier_for_build() -> &'static str {
    if cfg!(debug_assertions) {
        "com.wycstudios.quill-dev"
    } else {
        "com.wycstudios.quill"
    }
}

/// Resolve the OS-conventional log directory for *this* build.
///
/// Single source of truth used by both plugin registration (the file
/// target) and the `reveal_logs` Tauri command, so they can never drift
/// apart. We construct the path from `HOME` / `LOCALAPPDATA` /
/// `XDG_DATA_HOME` directly (not `app.path().app_log_dir()`) because
/// `app_log_dir()` derives from `tauri.conf.json::identifier` with no
/// dev/prod suffix, and the plugin builder runs before an `AppHandle`
/// exists anyway.
///
/// Platform layout matches `tauri-plugin-log::TargetKind::LogDir`'s
/// documented defaults, with the identifier dev-suffixed in debug.
pub(crate) fn resolve_log_dir() -> PathBuf {
    let identifier = bundle_identifier_for_build();

    #[cfg(target_os = "macos")]
    {
        let home = std::env::var_os("HOME")
            .map(PathBuf::from)
            .expect("HOME env var");
        home.join("Library/Logs").join(identifier)
    }
    #[cfg(target_os = "windows")]
    {
        let base = std::env::var_os("LOCALAPPDATA")
            .map(PathBuf::from)
            .expect("LOCALAPPDATA env var");
        base.join(identifier).join("logs")
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let base = std::env::var_os("XDG_DATA_HOME")
            .map(PathBuf::from)
            .or_else(|| {
                std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".local/share"))
            })
            .expect("HOME or XDG_DATA_HOME env var");
        base.join(identifier).join("logs")
    }
}

/// Resolve the OS-conventional **app-data** directory for this build.
/// Mirrors what `tauri::path::app_data_dir()` would return for the
/// active bundle identifier (dev-suffixed in debug). Used by the
/// `quill mcp` stdio subcommand which runs outside the Tauri runtime
/// and has no `AppHandle` to ask.
///
/// Platform layout:
/// - macOS:   `$HOME/Library/Application Support/<identifier>`
/// - Windows: `%APPDATA%\<identifier>` (Roaming)
/// - Linux:   `$XDG_DATA_HOME/<identifier>` or `$HOME/.local/share/<identifier>`
pub(crate) fn resolve_app_data_dir() -> PathBuf {
    let identifier = bundle_identifier_for_build();

    #[cfg(target_os = "macos")]
    {
        let home = std::env::var_os("HOME")
            .map(PathBuf::from)
            .expect("HOME env var");
        home.join("Library/Application Support").join(identifier)
    }
    #[cfg(target_os = "windows")]
    {
        let base = std::env::var_os("APPDATA")
            .map(PathBuf::from)
            .expect("APPDATA env var");
        base.join(identifier)
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let base = std::env::var_os("XDG_DATA_HOME")
            .map(PathBuf::from)
            .or_else(|| {
                std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".local/share"))
            })
            .expect("HOME or XDG_DATA_HOME env var");
        base.join(identifier)
    }
}

/// Entry point for the `quill mcp` subcommand. Opens the SQLite
/// materialized view and serves the MCP protocol over stdin/stdout
/// until the client disconnects.
///
/// When `mcp_write_enabled` is `"true"` in the settings table, the DB
/// is opened read-write and a `SyncWriter` is constructed so write
/// tools can mutate the library. Otherwise the DB stays read-only.
///
/// Runs entirely outside the Tauri runtime — no plugins, no windows,
/// no event loop. Stderr is reserved for diagnostic messages so it
/// doesn't pollute the MCP wire on stdout.
pub fn mcp_stdio_main() {
    let local_dir = resolve_app_data_dir();
    let db_path = local_dir.join("quill.db");

    if !db_path.exists() {
        eprintln!(
            "quill mcp: no library found at {} — launch the Quill app at least once to initialize it.",
            db_path.display()
        );
        std::process::exit(1);
    }

    let write_enabled = is_mcp_write_enabled(&db_path);

    // Resolve the data_dir the same way the Tauri app does: if the
    // user has migrated to iCloud sync, blobs (books/, covers/) live
    // under the ubiquity container, not the local app-data dir.
    let data_dir = if sync::migration::is_migration_complete(&local_dir) {
        sync::migration::recorded_data_dir(&local_dir)
            .or_else(icloud::icloud_data_dir_deterministic)
            .unwrap_or_else(|| local_dir.clone())
    } else {
        local_dir.clone()
    };

    let (db, sync) = if write_enabled {
        let db = match Db::open_readwrite(&db_path) {
            Ok(mut db) => {
                db.set_data_dir(&data_dir);
                db
            }
            Err(e) => {
                eprintln!("quill mcp: failed to open (rw) {}: {e}", db_path.display());
                std::process::exit(1);
            }
        };
        let device = sync::device::DeviceIdentity::load_or_create(&local_dir)
            .expect("failed to load device identity");
        let sw = SyncWriter::new(device.device_uuid);
        sw.set_should_queue(true);
        (db, Some(sw))
    } else {
        let db = match Db::open_readonly(&db_path) {
            Ok(mut db) => {
                db.set_data_dir(&data_dir);
                db
            }
            Err(e) => {
                eprintln!("quill mcp: failed to open {}: {e}", db_path.display());
                std::process::exit(1);
            }
        };
        (db, None)
    };

    let state = mcp::McpState::new(db, sync);

    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio runtime");

    if let Err(e) = runtime.block_on(mcp::server::serve_stdio(state)) {
        eprintln!("quill mcp: serve error: {e}");
        std::process::exit(1);
    }
}

/// Check whether `mcp_write_enabled` is `"true"` in the settings table.
/// Opens a temporary read-only connection just for this check.
fn is_mcp_write_enabled(db_path: &Path) -> bool {
    let Ok(conn) = rusqlite::Connection::open_with_flags(
        db_path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    ) else {
        return false;
    };
    conn.query_row(
        "SELECT value FROM settings WHERE key = 'mcp_write_enabled'",
        [],
        |row| row.get::<_, String>(0),
    )
    .map(|v| v == "true")
    .unwrap_or(false)
}

/// Construct the per-device EventLog, wire it into `sync_writer`, build a
/// `ReplayEngine`, run one initial tick to converge with peer logs, and
/// spawn the fs watcher. Returns the engine + watcher handle so the
/// caller can store them in app state for the lifetime of the process.
///
/// Pulled out of `setup` so the launch flow stays readable. Errors
/// short-circuit and the caller falls back to "sync inactive this
/// session" (the local DB is still functional).
fn boot_sync_engine(
    shared_dir: PathBuf,
    device_uuid: &str,
    db: &Db,
    sync_writer: &SyncWriter,
) -> error::AppResult<(Option<Arc<ReplayEngine>>, Option<WatcherHandle>)> {
    let log_path = shared_dir
        .join("logs")
        .join(format!("{device_uuid}.jsonl"));
    // Coordinator on iCloud paths only — see `EventLog::open` doc.
    let log = Arc::new(EventLog::open(&log_path, device_uuid, true)?);
    sync_writer.set_log(Some(Arc::clone(&log)));

    let engine = Arc::new(ReplayEngine::new(
        shared_dir.clone(),
        device_uuid.to_string(),
        log,
    ));

    // Initial tick — drains any leftover outbox, applies peer snapshots
    // and log tails since last launch. Failure here is non-fatal; the
    // watcher's first event will retry.
    if let Err(e) = engine.tick(db) {
        log::warn!("sync: initial replay tick failed: {e}");
    }

    // If watcher spawn fails, roll back the writer so new writes fall
    // into queue-only mode instead of draining to a log with no engine
    // or watcher behind it. Without this, the caller drops `engine`
    // but the writer still has `Some(log)` — writes keep publishing
    // events that no process is replaying and no one is watching for.
    match sync::watcher::spawn(shared_dir, db.clone(), Arc::clone(&engine)) {
        Ok(watcher) => Ok((Some(engine), Some(watcher))),
        Err(e) => {
            sync_writer.set_log(None);
            Err(e)
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // First line on purpose: the file target initializes lazily on the first
    // `log::` call, so a panic during plugin init still lands in the log.
    panic_hook::install();

    let default_level = if cfg!(debug_assertions) {
        log::LevelFilter::Debug
    } else {
        log::LevelFilter::Info
    };
    let level = resolve_log_level(default_level);

    // Debug-only smoke trigger for the panic-hook pipeline. Reproduces
    // spec smoke #5: `QUILL_PANIC_TEST=1 cargo run` arms a panicking
    // thread 5s after launch so we can verify the hook chained, the
    // backtrace landed in the log file, and the OS CrashReporter still
    // fired. Gated on debug builds so it can't ship to users.
    #[cfg(debug_assertions)]
    if std::env::var("QUILL_PANIC_TEST").is_ok() {
        std::thread::spawn(|| {
            std::thread::sleep(std::time::Duration::from_secs(5));
            panic!("QUILL_PANIC_TEST: intentional panic for smoke testing the panic hook");
        });
    }

    let app = tauri::Builder::default()
        .plugin(
            tauri_plugin_log::Builder::new()
                .targets([
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Folder {
                        path: resolve_log_dir(),
                        file_name: Some("quill".into()),
                    }),
                    #[cfg(debug_assertions)]
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stdout),
                ])
                .level(level)
                .max_file_size(10 * 1024 * 1024)
                .rotation_strategy(tauri_plugin_log::RotationStrategy::KeepSome(3))
                .build(),
        )
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .menu(|handle| {
            // Start from the per-platform default menu so the standard
            // App / Edit / View / Window entries stay intact. Only the
            // Help submenu is augmented — the default Help on macOS is
            // effectively empty (the About entry lives in the app menu),
            // so we append a single "Reveal Logs" item there.
            //
            // Label is English at boot. Tauri's `.menu()` callback runs
            // before `.setup()`, so the user-language setting (in the
            // SQLite `settings` table) isn't readable yet. The i18n keys
            // (`menu.help.revealLogs`) exist in en.json/zh.json for the
            // Settings UI; menu localization would mean deferring menu
            // construction to setup() via `app.set_menu()`. Tracked as a
            // follow-up.  [[follow-up-220-menu-i18n]]
            let menu = tauri::menu::Menu::default(handle)?;
            let label = if cfg!(target_os = "macos") {
                "Reveal Logs in Finder"
            } else {
                "Show Logs in Explorer"
            };
            if let Some(help_kind) = menu.get(tauri::menu::HELP_SUBMENU_ID) {
                if let Some(help) = help_kind.as_submenu() {
                    let item = tauri::menu::MenuItem::with_id(
                        handle,
                        "reveal_logs",
                        label,
                        true,
                        None::<&str>,
                    )?;
                    help.append(&item)?;
                }
            }
            Ok(menu)
        })
        .on_menu_event(|app, event| {
            if event.id() == "reveal_logs" {
                if let Err(e) = commands::app::reveal_logs(app.clone()) {
                    log::warn!("menu: reveal_logs failed: {e}");
                }
            }
        })
        .on_window_event(|window, event| {
            // On macOS, closing the main window via the red button should hide
            // it, not quit the app — matches the standard Mac convention. The
            // user reopens it from the dock icon (RunEvent::Reopen below) or
            // by relaunching from Spotlight. cmd-Q still quits because that
            // path goes through applicationShouldTerminate, not CloseRequested.
            //
            // Reader windows are unaffected and close normally.
            #[cfg(target_os = "macos")]
            if window.label() == "main" {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
            #[cfg(not(target_os = "macos"))]
            {
                let _ = (window, event);
            }
        })
        .setup(|app| {
            let local_dir = {
                let base = app
                    .path()
                    .app_data_dir()
                    .expect("failed to resolve app data dir");
                if cfg!(debug_assertions) {
                    base.with_file_name("com.wycstudios.quill-dev")
                } else {
                    base
                }
            };
            std::fs::create_dir_all(&local_dir).expect("failed to create app data dir");

            // Resolve the iCloud Documents path from the deterministic
            // hardcoded location whenever **either** sync marker is on:
            //   - `.icloud_enabled` (legacy file-sync user, migration
            //     still pending)
            //   - `.migration_complete` (new-UI enabler, post-migration
            //     user, or legacy user who has migrated)
            //
            // Avoids `URLForUbiquityContainerIdentifier` on the main
            // thread (slow cold-start IPC to the iCloud daemon).
            //
            // We use the `_deterministic` variant — not `_fast` — so
            // migration is always at least *attempted* with a concrete
            // path, even when the iCloud container hasn't materialized
            // yet. `run_migration` itself detects the missing dir and
            // defers (without writing the marker) so the next launch
            // retries. Using `_fast` here would short-circuit migration
            // entirely on a cold-iCloud first launch, leaving the user
            // open to the data-loss path documented in PR #192's
            // first-launch-without-iCloud finding.
            //
            // Gating the legacy-marker path only here (the pre-PR #190
            // bug) meant new-UI enablers — who never get
            // `.icloud_enabled` written — came back next launch with
            // `ubiquity_dir = None` and therefore no engine boot, even
            // though their durable state said "sync on." Every write
            // after that stayed in `_pending_publish` indefinitely.
            let icloud_was_enabled = icloud::is_icloud_enabled(&local_dir);
            let ubiquity_dir =
                sync::migration::resolve_ubiquity_dir(&local_dir, icloud_was_enabled);

            // Per-install device UUID — stamped into every LWW write so
            // peer reconciliation stays deterministic on equal-millisecond
            // ties. Lives in `<local>/device.json`; never synced. Loaded
            // here because the migration routine below needs it.
            let device =
                DeviceIdentity::load_or_create(&local_dir).expect("failed to load device id");

            // Chunk 6 — one-shot migration from legacy file-sync to the
            // per-device event log. Runs only when the legacy marker is
            // present and the new `.migration_complete` marker isn't.
            // Failures are logged and retried on the next launch (the
            // marker is only written on success).
            if icloud_was_enabled && !sync::migration::is_migration_complete(&local_dir) {
                if let Some(ub) = &ubiquity_dir {
                    match sync::migration::run_migration(&local_dir, ub, &device.device_uuid) {
                        Ok(outcome) if outcome.deferred_for_download => log::info!(
                            "sync: migration deferred — ubiquity quill.db is iCloud-evicted. \
                             Download triggered; will retry on next launch."
                        ),
                        Ok(outcome) => log::info!(
                            "sync: migration complete: copied_db={} wrote_snapshot={} retired={} conflict_copies_discarded={}",
                            outcome.copied_db,
                            outcome.wrote_snapshot,
                            outcome.retired_files,
                            outcome.conflict_copies_discarded,
                        ),
                        Err(e) => log::error!(
                            "sync: migration failed (will retry next launch): {e}"
                        ),
                    }
                }
            }

            // Open the DB. Post-migration the SQLite file lives at
            // local_dir/quill.db, but books/ and covers/ stay in the
            // iCloud Documents container per spec — we keep `data_dir`
            // pointing at the ubiquity dir so `Db::resolve_path`
            // resolves binaries against the right place.
            //
            // Resolution chain (post-migration, in order):
            //   1. Path recorded in the marker at migration time. This
            //      is the source of truth — guarantees stability across
            //      launches, even if iCloud is signed out right now.
            //   2. Deterministic iCloud Documents path (no `is_dir`
            //      check). Backstop for legacy markers from the first
            //      Chunk 6 build that wrote an empty marker.
            //   3. Local dir as a last resort, with a loud log line.
            //      The user is offline AND on a non-macOS platform
            //      AND has a legacy empty marker — vanishingly rare,
            //      but we don't want to crash the app.
            //
            // Pre-migration and non-iCloud users get data_dir = local.
            let data_dir = if sync::migration::is_migration_complete(&local_dir) {
                sync::migration::recorded_data_dir(&local_dir)
                    .or_else(icloud::icloud_data_dir_deterministic)
                    .unwrap_or_else(|| {
                        log::warn!(
                            "sync: migration is complete but no stable data_dir is \
                             available; falling back to local. Newly-imported binaries \
                             may not be visible to peers."
                        );
                        local_dir.clone()
                    })
            } else {
                local_dir.clone()
            };
            let db = Db::init_split(&local_dir, &data_dir)
                .expect("failed to initialize database");

            log::info!(
                "quill start v{version} os={os} arch={arch} data_dir={data_dir} schema_v={schema}",
                version = env!("CARGO_PKG_VERSION"),
                os = std::env::consts::OS,
                arch = std::env::consts::ARCH,
                data_dir = local_dir.display(),
                schema = db.schema_version(),
            );

            // Self-healing: if migration is complete, retire any ubiquity
            // DB files that crept back (a legacy build temporarily
            // running on this iCloud account, file restore, etc.) and
            // reconcile any local binaries left over from a partial
            // `sync_enable` move. The reconcile is a no-op for the
            // common case (local/books empty post-enable); when a
            // previous enable wrote the marker but failed mid-move,
            // it drains the leftover files into iCloud so they're
            // resolvable through the now-active data_dir.
            if sync::migration::is_migration_complete(&local_dir) {
                if let Some(ub) = &ubiquity_dir {
                    let _ = sync::migration::retire_ubiquity_db(ub);
                    if let Err(e) =
                        sync::migration::reconcile_local_blobs_to_ubiquity(&local_dir, ub)
                    {
                        log::warn!("sync: blob reconcile failed (continuing): {e}");
                    }
                }
            }

            // Secrets DB always lives at the local app_data_dir (never syncs to iCloud)
            let secrets =
                Secrets::init(&local_dir).expect("failed to initialize secrets store");

            // One-time migration: move sensitive keys from settings to secrets
            secrets
                .migrate_from_settings(&db)
                .expect("failed to migrate secrets");

            let sync_writer = SyncWriter::new(device.device_uuid.clone());

            // If migration is complete, every write must persist into
            // `_pending_publish` regardless of whether the engine boots
            // this session. The post-commit flush only runs when the log
            // is open (set inside boot_sync_engine), so a queue-only
            // session accumulates events for the next launch's replay
            // tick to drain. Without this flag set, writes made while
            // iCloud is unreachable are silently dropped — peers never
            // see them. See `SyncWriter`'s module docstring for the
            // three-mode model.
            if sync::migration::is_migration_complete(&local_dir) {
                sync_writer.set_should_queue(true);
            }

            // Wire the replay engine + watcher when sync is on. "Sync on"
            // for Chunk 6 is detected via the migration-complete marker:
            // if we migrated (or a future install joined an already-
            // migrated iCloud), spin up the engine. Chunk 7's
            // `sync_enable` will replace this trigger with an explicit
            // user toggle.
            //
            // Important: deterministic vs existence-checked path. The
            // deterministic path is correct for blob resolution (so
            // `books/foo.epub` always resolves to the same place across
            // launches) and for migration source selection (so we can
            // defer a missing source instead of falling through). But
            // it's WRONG for booting EventLog + ReplayEngine: if the
            // iCloud container hasn't materialized yet (signed-out
            // account, daemon race), `EventLog::open` would create a
            // file at the deterministic path — physically located
            // outside any real ubiquity container — and the post-commit
            // outbox flush would drain `_pending_publish` rows into it.
            // Peers would never see those events but the rows would be
            // gone, breaking the publish-retry guarantee. So we re-gate
            // on `.exists()` here. If iCloud isn't actually present
            // this launch, sync stays inert and the outbox preserves
            // pending events for the next successful boot.
            let (replay_engine, watcher_handle) = match sync::migration::is_migration_complete(
                &local_dir,
            )
            .then(|| ubiquity_dir.clone().filter(|p| p.exists()))
            .flatten()
            {
                Some(ub) => match boot_sync_engine(ub, &device.device_uuid, &db, &sync_writer) {
                    Ok(pair) => {
                        log::info!("sync: engine booted (replay + watcher active)");
                        pair
                    }
                    Err(e) => {
                        log::error!("sync: failed to boot sync engine: {e}");
                        (None, None)
                    }
                },
                None => {
                    if sync::migration::is_migration_complete(&local_dir) {
                        log::warn!(
                            "sync: skipping engine boot — iCloud container not reachable \
                             this launch; outbox preserved for the next launch"
                        );
                    }
                    (None, None)
                }
            };

            // Watch the MCP sentinel file so the UI can refresh when an
            // MCP subprocess writes to the library. The sentinel is a
            // tiny JSON file (~80 bytes) that the MCP subprocess
            // overwrites after each write tool invocation.
            let mcp_notify_path = local_dir.join(".mcp-notify");
            let app_handle = app.handle().clone();
            mcp::notify::spawn_watcher(mcp_notify_path, app_handle);

            app.manage(LocalDir(local_dir));
            app.manage(db);
            app.manage(secrets);
            app.manage(device);
            app.manage(sync_writer);
            app.manage(SyncState::new(replay_engine, watcher_handle));

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // App lifecycle
            commands::app::app_ready,
            commands::app::reveal_logs,
            // Books
            commands::books::import_book,
            commands::books::stage_pdf_import,
            commands::books::commit_pdf_import,
            commands::books::cancel_pdf_import,
            commands::books::list_books,
            commands::books::get_book,
            commands::books::delete_book,
            commands::books::update_reading_progress,
            commands::books::mark_finished,
            commands::books::update_book_status,
            commands::books::update_book_pages,
            commands::books::check_book_available,
            commands::books::update_book_metadata,
            commands::books::save_book_cover,
            // Settings
            commands::settings::get_all_settings,
            commands::settings::get_setting,
            commands::settings::set_setting,
            commands::settings::set_settings_bulk,
            commands::settings::get_book_settings,
            commands::settings::set_book_settings_bulk,
            commands::settings::open_settings_on_main,
            // Bookmarks & Highlights
            commands::bookmarks::add_bookmark,
            commands::bookmarks::remove_bookmark,
            commands::bookmarks::list_bookmarks,
            commands::bookmarks::add_highlight,
            commands::bookmarks::remove_highlight,
            commands::bookmarks::list_highlights,
            commands::bookmarks::update_highlight_note,
            commands::bookmarks::update_highlight_color,
            // Collections
            commands::collections::list_collections,
            commands::collections::create_collection,
            commands::collections::rename_collection,
            commands::collections::delete_collection,
            commands::collections::reorder_collections,
            commands::collections::add_book_to_collection,
            commands::collections::remove_book_from_collection,
            commands::collections::list_books_in_collection,
            // AI
            commands::ai::ai_chat,
            commands::ai::ai_lookup,
            commands::ai::ai_generate_title,
            // OAuth
            commands::oauth::openai_oauth_login,
            commands::oauth::openai_oauth_status,
            commands::oauth::openai_oauth_logout,
            // Vocabulary
            commands::vocab::add_vocab_word,
            commands::vocab::remove_vocab_word,
            commands::vocab::list_vocab_words,
            commands::vocab::check_vocab_exists,
            commands::vocab::list_all_vocab_words,
            commands::vocab::update_vocab_mastery,
            commands::vocab::list_vocab_due_for_review,
            commands::vocab::get_vocab_stats,
            // Chats
            commands::chats::create_chat,
            commands::chats::list_chats,
            commands::chats::list_all_chats,
            commands::chats::get_chat,
            commands::chats::delete_chat,
            commands::chats::rename_chat,
            commands::chats::list_chat_messages,
            commands::chats::save_chat_message,
            // Translation
            commands::translation::ai_translate_passage,
            commands::translation::save_translation,
            commands::translation::remove_saved_translation,
            commands::translation::list_translations,
            // MCP client integrations
            commands::mcp::mcp_integration_status,
            commands::mcp::mcp_set_integration,
            commands::mcp::mcp_config_snippet,
            commands::mcp::mcp_set_write_access,
            // Sync (Chunk 7 — replaces the legacy icloud_* commands;
            // sync_compact added in Chunk 8).
            commands::sync::sync_status,
            commands::sync::sync_enable,
            commands::sync::sync_disable,
            commands::sync::sync_now,
            commands::sync::sync_compact,
            commands::sync::sync_revert_to_legacy,
            commands::sync::sync_remove_peer,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app_handle, event| match &event {
        #[cfg(target_os = "macos")]
        tauri::RunEvent::Opened { urls } => {
            // Files dropped on dock icon or opened via file association
            let paths: Vec<String> = urls
                .iter()
                .filter_map(|url| url.to_file_path().ok())
                .filter(|p: &PathBuf| {
                    let ext = p.extension().and_then(|e| e.to_str()).unwrap_or("");
                    ext.eq_ignore_ascii_case("epub") || ext.eq_ignore_ascii_case("pdf")
                })
                .filter_map(|p: PathBuf| p.to_str().map(String::from))
                .collect();
            if !paths.is_empty() {
                let _ = app_handle.emit("file-open", paths);
            }
        }
        // Dock icon click while the app is already running. If the main
        // (library) window is hidden — including when only reader windows are
        // visible — bring it back. The user explicitly asked for this so the
        // library is always one dock-click away.
        #[cfg(target_os = "macos")]
        tauri::RunEvent::Reopen { .. } => {
            if let Some(window) = app_handle.get_webview_window("main") {
                if !window.is_visible().unwrap_or(true) {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
        }
        // On non-macOS, closing the main window quits the app (close-all-windows
        // convention). On macOS the main window is hidden instead (handled above
        // in on_window_event), so this branch is a no-op there.
        #[cfg(not(target_os = "macos"))]
        tauri::RunEvent::WindowEvent {
            label,
            event: tauri::WindowEvent::Destroyed,
            ..
        } if label == "main" => {
            for (_, window) in app_handle.webview_windows() {
                let _ = window.close();
            }
        }
        _ => {}
    });
}

#[cfg(test)]
mod tests {
    use super::{resolve_log_dir, resolve_log_level};
    use log::LevelFilter;

    /// Regression guard: `tauri-plugin-log` resolves the file target's
    /// directory via the bundle identifier in `tauri.conf.json`. Renaming
    /// the identifier silently moves the log path on every platform and
    /// any user's existing log directory orphans. Pinning the expected
    /// value here forces a deliberate update of both this test and the
    /// migration story if the identifier ever needs to change.
    #[test]
    fn bundle_identifier_matches_log_path_assumption() {
        let conf = std::fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tauri.conf.json"
        ))
        .expect("read tauri.conf.json");
        let v: serde_json::Value =
            serde_json::from_str(&conf).expect("parse tauri.conf.json");
        let id = v["identifier"].as_str().expect("identifier field");
        assert_eq!(
            id, "com.wycstudios.quill",
            "bundle identifier changed — update log path docs and migration",
        );
    }

    /// `RUST_LOG` overrides win over the cfg-based default; unset or
    /// garbage falls back to the default. Single test that flips
    /// `RUST_LOG` between cases — env vars are process-global so we
    /// serialize the mutations within one test rather than relying on
    /// test isolation.
    #[test]
    fn resolve_log_level_honors_rust_log_env() {
        // Save whatever the caller's env had so the test harness isn't
        // poisoned for later tests in the same process.
        let saved = std::env::var("RUST_LOG").ok();

        // Unset → default.
        std::env::remove_var("RUST_LOG");
        assert_eq!(resolve_log_level(LevelFilter::Info), LevelFilter::Info);
        assert_eq!(resolve_log_level(LevelFilter::Warn), LevelFilter::Warn);

        // Valid value overrides the default.
        std::env::set_var("RUST_LOG", "warn");
        assert_eq!(resolve_log_level(LevelFilter::Info), LevelFilter::Warn);
        std::env::set_var("RUST_LOG", "trace");
        assert_eq!(resolve_log_level(LevelFilter::Info), LevelFilter::Trace);
        std::env::set_var("RUST_LOG", "off");
        assert_eq!(resolve_log_level(LevelFilter::Info), LevelFilter::Off);

        // Garbage falls back to default rather than killing init.
        std::env::set_var("RUST_LOG", "verbose");
        assert_eq!(resolve_log_level(LevelFilter::Info), LevelFilter::Info);

        // Whitespace tolerated.
        std::env::set_var("RUST_LOG", "  debug  ");
        assert_eq!(resolve_log_level(LevelFilter::Info), LevelFilter::Debug);

        // Restore.
        match saved {
            Some(v) => std::env::set_var("RUST_LOG", v),
            None => std::env::remove_var("RUST_LOG"),
        }
    }

    /// `pnpm tauri dev` and a packaged release build must not write to
    /// the same log file. The helper appends `-dev` to the bundle
    /// identifier under `cfg(debug_assertions)` so the two layouts are
    /// physically isolated. `cfg!(debug_assertions)` is fixed per-build,
    /// so only one branch is meaningfully exercised per `cargo test`
    /// invocation — but both branches compile, and the assertion picks
    /// the right expected value for the build being tested.
    #[test]
    fn resolve_log_dir_uses_dev_suffix_in_debug() {
        let dir = resolve_log_dir();
        let expected_id = if cfg!(debug_assertions) {
            "com.wycstudios.quill-dev"
        } else {
            "com.wycstudios.quill"
        };
        let dir_str = dir.to_string_lossy().to_string();
        assert!(
            dir_str.contains(expected_id),
            "log dir {dir_str} should contain {expected_id} for this build",
        );
        // Guard against the dev path accidentally landing under the
        // prod identifier (e.g. if someone changes the suffix logic).
        // In debug builds, the prod-only id must not appear in the
        // path UNLESS it's the substring of the dev id itself.
        if cfg!(debug_assertions) {
            let stripped = dir_str.replace("com.wycstudios.quill-dev", "");
            assert!(
                !stripped.contains("com.wycstudios.quill"),
                "debug build log dir {dir_str} leaks the prod identifier outside the -dev suffix",
            );
        }
    }
}
