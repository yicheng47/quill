mod ai;
mod commands;
mod db;
mod epub;
mod error;
mod icloud;
mod secrets;
mod sync;

use std::path::PathBuf;

use db::Db;
use secrets::Secrets;
#[cfg(target_os = "macos")]
use tauri::Emitter;
use tauri::Manager;

/// The resolved local app data directory, accounting for dev-mode isolation.
pub struct LocalDir(pub PathBuf);

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

            // If iCloud sync is enabled, resolve the iCloud Documents path from
            // the deterministic hardcoded location. This avoids calling
            // `URLForUbiquityContainerIdentifier` on the main thread, which
            // queries the iCloud daemon and is the slowest call on cold start
            // (often >1s, sometimes several seconds after sleep/reboot).
            //
            // The actual `URLForUbiquityContainerIdentifier` call still has to
            // happen at some point to register the container with the iCloud
            // daemon and trigger sync — we do that in a background thread
            // below, after setup has unblocked.
            let data_dir = if icloud::is_icloud_enabled(&local_dir) {
                icloud::icloud_data_dir_fast().unwrap_or_else(|| local_dir.clone())
            } else {
                local_dir.clone()
            };

            let db = Db::init(&data_dir).expect("failed to initialize database");

            // Secrets DB always lives at the local app_data_dir (never syncs to iCloud)
            let secrets =
                Secrets::init(&local_dir).expect("failed to initialize secrets store");

            // One-time migration: move sensitive keys from settings to secrets
            secrets
                .migrate_from_settings(&db)
                .expect("failed to migrate secrets");

            app.manage(LocalDir(local_dir));
            app.manage(db);
            app.manage(secrets);

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
            // iCloud
            commands::icloud::icloud_status,
            commands::icloud::icloud_enable,
            commands::icloud::icloud_disable,
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
