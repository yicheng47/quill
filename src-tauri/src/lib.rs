mod ai;
mod commands;
mod db;
mod epub;
mod error;
mod secrets;

use db::Db;
use secrets::Secrets;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .setup(|app| {
            let app_data_dir = app
                .path()
                .app_data_dir()
                .expect("failed to resolve app data dir");

            let db = Db::init(&app_data_dir).expect("failed to initialize database");

            // Secrets DB always lives at the local app_data_dir (never syncs to iCloud)
            let secrets =
                Secrets::init(&app_data_dir).expect("failed to initialize secrets store");

            // One-time migration: move sensitive keys from settings to secrets
            secrets
                .migrate_from_settings(&db)
                .expect("failed to migrate secrets");

            app.manage(db);
            app.manage(secrets);

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // Books
            commands::books::import_book,
            commands::books::list_books,
            commands::books::get_book,
            commands::books::delete_book,
            commands::books::update_reading_progress,
            commands::books::mark_finished,
            commands::books::update_book_pages,
            // Settings
            commands::settings::get_all_settings,
            commands::settings::get_setting,
            commands::settings::set_setting,
            commands::settings::set_settings_bulk,
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
            commands::collections::delete_collection,
            commands::collections::add_book_to_collection,
            commands::collections::remove_book_from_collection,
            commands::collections::list_books_in_collection,
            // AI
            commands::ai::ai_chat,
            commands::ai::ai_lookup,
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
