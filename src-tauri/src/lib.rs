mod ai;
mod commands;
mod db;
mod epub;
mod error;
mod icloud;
mod mcp;
mod secrets;
mod sync;

use std::path::PathBuf;
use std::sync::Arc;

use commands::sync::SyncState;
use db::Db;
use mcp::{McpServer, McpState};
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
        eprintln!("sync: initial replay tick failed: {e}");
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
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
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
                        Ok(outcome) if outcome.deferred_for_download => eprintln!(
                            "sync: migration deferred — ubiquity quill.db is iCloud-evicted. \
                             Download triggered; will retry on next launch."
                        ),
                        Ok(outcome) => eprintln!(
                            "sync: migration complete: copied_db={} wrote_snapshot={} retired={} conflict_copies_discarded={}",
                            outcome.copied_db,
                            outcome.wrote_snapshot,
                            outcome.retired_files,
                            outcome.conflict_copies_discarded,
                        ),
                        Err(e) => eprintln!(
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
                        eprintln!(
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
                        eprintln!("sync: blob reconcile failed (continuing): {e}");
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
                    Ok(pair) => pair,
                    Err(e) => {
                        eprintln!("sync: failed to boot sync engine: {e}");
                        (None, None)
                    }
                },
                None => {
                    if sync::migration::is_migration_complete(&local_dir) {
                        eprintln!(
                            "sync: skipping engine boot — iCloud container not reachable \
                             this launch; outbox preserved for the next launch"
                        );
                    }
                    (None, None)
                }
            };

            // Take a `Db` clone for the MCP server BEFORE handing the
            // original to `app.manage`. `Db` is already cheap-clone via
            // `Arc<Mutex<…>>` internals, so no `Arc<Db>` wrapper is
            // needed here. See `db.rs:31-43` and the hard-constraint
            // note in `docs/impls/30-mcp-server.md`.
            let mcp_state = McpState::new(db.clone());

            app.manage(LocalDir(local_dir));
            app.manage(db);
            app.manage(secrets);
            app.manage(device);
            app.manage(sync_writer);
            // Engine + watcher live behind a single `SyncState` so the
            // `sync_enable` / `sync_disable` commands can swap them at
            // runtime. Watcher is held inside the same struct via a
            // `Mutex<Option<WatcherHandle>>` — its `Drop` impl signals
            // the watcher thread to stop and joins it on disable /
            // shutdown.
            app.manage(SyncState::new(replay_engine, watcher_handle));

            // MCP server (Phase 1 — handshake only, no tools). Boot on
            // the default port; settings UI gating arrives in Phase 4.
            // Bind failure is logged but does not fail `setup()`; the
            // rest of the app is fully usable without MCP.
            let mcp_server = McpServer::new();
            {
                let mcp_server_for_boot = &mcp_server;
                let state_for_boot = mcp_state.clone();
                tauri::async_runtime::block_on(async move {
                    match mcp_server_for_boot
                        .start(state_for_boot, mcp::server::DEFAULT_PORT)
                        .await
                    {
                        Ok(port) => {
                            eprintln!("mcp: server listening on http://127.0.0.1:{port}/mcp");
                        }
                        Err(e) => {
                            eprintln!("mcp: failed to start server: {e}");
                        }
                    }
                });
            }
            app.manage(mcp_server);

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // App lifecycle
            commands::app::app_ready,
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
        // Drain the MCP server cleanly on quit so its TCP port is
        // released before the next launch (otherwise a fresh `start`
        // races with the kernel's TIME_WAIT). Best-effort: any error
        // is logged inside `stop`.
        tauri::RunEvent::ExitRequested { .. } => {
            if let Some(server) = app_handle.try_state::<McpServer>() {
                tauri::async_runtime::block_on(server.stop());
            }
        }
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
