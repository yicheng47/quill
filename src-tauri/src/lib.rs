mod ai;
mod commands;
mod db;
mod epub;
mod error;

use db::Db;
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
            app.manage(db);

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
            // Collections
            commands::collections::list_collections,
            commands::collections::create_collection,
            commands::collections::delete_collection,
            commands::collections::add_book_to_collection,
            commands::collections::remove_book_from_collection,
            commands::collections::list_books_in_collection,
            // AI
            commands::ai::ai_chat,
            commands::ai::ai_quick_explain,
            // OAuth
            commands::oauth::openai_oauth_login,
            commands::oauth::openai_oauth_status,
            commands::oauth::openai_oauth_logout,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
