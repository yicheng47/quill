mod commands;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use quill_core::commands::ai::ChatMessage;
use quill_core::commands::books::{Book, BookCounts, BookPage};
use quill_core::commands::bookmarks::{Bookmark, Highlight};
use quill_core::commands::chats::{Chat, ChatCounts, ChatMsg, ChatPage};
use quill_core::commands::collections::Collection;
use quill_core::commands::mcp::McpIntegrationStatus;
use quill_core::commands::sync::{SyncCompactResult, SyncNowResult, SyncStatus};
use quill_core::commands::vocab::{VocabStats, VocabWord};
use quill_core::error::{AppError, AppResult};
use quill_core::{boot, BootConfig, Core, ShellHost};
use tauri::{Emitter, Manager};
use tauri_plugin_opener::OpenerExt;

pub use quill_core::db;
pub use quill_core::mcp_stdio_main;

struct TauriHost {
    app: tauri::AppHandle,
}

impl ShellHost for TauriHost {
    fn emit(&self, event: &str, payload: serde_json::Value) {
        let _ = self.app.emit(event, payload);
    }

    fn emit_to(&self, window: &str, event: &str, payload: serde_json::Value) {
        let _ = self.app.emit_to(window, event, payload);
    }

    fn open_url(&self, url: &str) -> AppResult<()> {
        self.app
            .opener()
            .open_url(url, None::<&str>)
            .map_err(|e| AppError::Other(e.to_string()))
    }

    fn reveal_path(&self, path: &Path) -> AppResult<()> {
        self.app
            .opener()
            .open_path(path.to_string_lossy(), None::<&str>)
            .map_err(|e| AppError::Other(e.to_string()))
    }
}

type CoreState<'a> = tauri::State<'a, Arc<Core>>;

// ---------------------------------------------------------------------------
// Shell-local commands
// ---------------------------------------------------------------------------

#[tauri::command]
fn app_ready(window: tauri::WebviewWindow) -> AppResult<()> {
    window.show().map_err(|e| AppError::Other(e.to_string()))?;
    if window.label() == "main" {
        window
            .set_focus()
            .map_err(|e| AppError::Other(e.to_string()))?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Core-backed thin wrappers
// ---------------------------------------------------------------------------

#[tauri::command]
fn reveal_logs(core: CoreState<'_>) -> AppResult<()> {
    quill_core::commands::app::reveal_logs(&core)
}

#[tauri::command]
async fn import_book(core: CoreState<'_>, file_path: String) -> AppResult<Book> {
    let core = Arc::clone(&core);
    tauri::async_runtime::spawn_blocking(move || {
        quill_core::commands::books::import_book(&core, file_path)
    })
    .await
    .map_err(|e| AppError::Other(format!("import_book task failed: {e}")))?
}

#[tauri::command]
fn list_books(
    core: CoreState<'_>,
    filter: Option<String>,
    search: Option<String>,
    collection_id: Option<String>,
    cursor: Option<String>,
    limit: Option<usize>,
) -> AppResult<BookPage> {
    quill_core::commands::books::list_books(&core, filter, search, collection_id, cursor, limit)
}

#[tauri::command]
fn get_book(core: CoreState<'_>, id: String) -> AppResult<Book> {
    quill_core::commands::books::get_book(&core, id)
}

#[tauri::command]
fn get_book_counts(core: CoreState<'_>) -> AppResult<BookCounts> {
    quill_core::commands::books::get_book_counts(&core)
}

#[tauri::command]
fn delete_book(core: CoreState<'_>, id: String) -> AppResult<()> {
    quill_core::commands::books::delete_book(&core, id)
}

#[tauri::command]
fn update_reading_progress(
    core: CoreState<'_>,
    id: String,
    progress: i32,
    cfi: Option<String>,
) -> AppResult<()> {
    quill_core::commands::books::update_reading_progress(&core, id, progress, cfi)
}

#[tauri::command]
fn mark_finished(core: CoreState<'_>, id: String) -> AppResult<()> {
    quill_core::commands::books::mark_finished(&core, id)
}

#[tauri::command]
fn update_book_status(core: CoreState<'_>, id: String, status: String) -> AppResult<()> {
    quill_core::commands::books::update_book_status(&core, id, status)
}

#[tauri::command]
fn update_book_pages(core: CoreState<'_>, id: String, pages: i32) -> AppResult<()> {
    quill_core::commands::books::update_book_pages(&core, id, pages)
}

#[tauri::command]
fn check_book_available(core: CoreState<'_>, id: String) -> AppResult<bool> {
    quill_core::commands::books::check_book_available(&core, id)
}

#[tauri::command]
fn check_book_readable(core: CoreState<'_>, id: String) -> AppResult<bool> {
    quill_core::commands::books::check_book_readable(&core, id)
}

#[tauri::command]
fn update_book_metadata(
    core: CoreState<'_>,
    id: String,
    title: String,
    author: String,
) -> AppResult<()> {
    quill_core::commands::books::update_book_metadata(&core, id, title, author)
}

#[tauri::command]
fn get_all_settings(core: CoreState<'_>) -> AppResult<HashMap<String, String>> {
    quill_core::commands::settings::get_all_settings(&core)
}

#[tauri::command]
fn get_setting(core: CoreState<'_>, key: String) -> AppResult<Option<String>> {
    quill_core::commands::settings::get_setting(&core, key)
}

#[tauri::command]
fn set_setting(core: CoreState<'_>, key: String, value: String) -> AppResult<()> {
    quill_core::commands::settings::set_setting(&core, key, value)
}

#[tauri::command]
fn set_settings_bulk(core: CoreState<'_>, settings: HashMap<String, String>) -> AppResult<()> {
    quill_core::commands::settings::set_settings_bulk(&core, settings)
}

#[tauri::command]
fn get_book_settings(core: CoreState<'_>, book_id: String) -> AppResult<HashMap<String, String>> {
    quill_core::commands::settings::get_book_settings(&core, book_id)
}

#[tauri::command]
fn set_book_settings_bulk(
    core: CoreState<'_>,
    book_id: String,
    settings: HashMap<String, String>,
) -> AppResult<()> {
    quill_core::commands::settings::set_book_settings_bulk(&core, book_id, settings)
}

#[tauri::command]
fn open_settings_on_main(core: CoreState<'_>, section: String) -> AppResult<()> {
    quill_core::commands::settings::open_settings_on_main(&core, section)
}

#[tauri::command]
fn add_bookmark(
    core: CoreState<'_>,
    book_id: String,
    cfi: String,
    label: Option<String>,
) -> AppResult<Bookmark> {
    quill_core::commands::bookmarks::add_bookmark(&core, book_id, cfi, label)
}

#[tauri::command]
fn remove_bookmark(core: CoreState<'_>, id: String) -> AppResult<()> {
    quill_core::commands::bookmarks::remove_bookmark(&core, id)
}

#[tauri::command]
fn list_bookmarks(core: CoreState<'_>, book_id: String) -> AppResult<Vec<Bookmark>> {
    quill_core::commands::bookmarks::list_bookmarks(&core, book_id)
}

#[tauri::command]
fn add_highlight(
    core: CoreState<'_>,
    book_id: String,
    cfi_range: String,
    color: Option<String>,
    note: Option<String>,
    text_content: Option<String>,
) -> AppResult<Highlight> {
    quill_core::commands::bookmarks::add_highlight(&core, book_id, cfi_range, color, note, text_content)
}

#[tauri::command]
fn remove_highlight(core: CoreState<'_>, id: String) -> AppResult<()> {
    quill_core::commands::bookmarks::remove_highlight(&core, id)
}

#[tauri::command]
fn list_highlights(core: CoreState<'_>, book_id: String) -> AppResult<Vec<Highlight>> {
    quill_core::commands::bookmarks::list_highlights(&core, book_id)
}

#[tauri::command]
fn update_highlight_note(core: CoreState<'_>, id: String, note: String) -> AppResult<()> {
    quill_core::commands::bookmarks::update_highlight_note(&core, id, note)
}

#[tauri::command]
fn update_highlight_color(core: CoreState<'_>, id: String, color: String) -> AppResult<()> {
    quill_core::commands::bookmarks::update_highlight_color(&core, id, color)
}

#[tauri::command]
fn list_collections(core: CoreState<'_>) -> AppResult<Vec<Collection>> {
    quill_core::commands::collections::list_collections(&core)
}

#[tauri::command]
fn create_collection(core: CoreState<'_>, name: String) -> AppResult<Collection> {
    quill_core::commands::collections::create_collection(&core, name)
}

#[tauri::command]
fn rename_collection(core: CoreState<'_>, id: String, name: String) -> AppResult<()> {
    quill_core::commands::collections::rename_collection(&core, id, name)
}

#[tauri::command]
fn delete_collection(core: CoreState<'_>, id: String) -> AppResult<()> {
    quill_core::commands::collections::delete_collection(&core, id)
}

#[tauri::command]
fn reorder_collections(core: CoreState<'_>, ids: Vec<String>) -> AppResult<()> {
    quill_core::commands::collections::reorder_collections(&core, ids)
}

#[tauri::command]
fn add_book_to_collection(
    core: CoreState<'_>,
    collection_id: String,
    book_id: String,
) -> AppResult<()> {
    quill_core::commands::collections::add_book_to_collection(&core, collection_id, book_id)
}

#[tauri::command]
fn remove_book_from_collection(
    core: CoreState<'_>,
    collection_id: String,
    book_id: String,
) -> AppResult<()> {
    quill_core::commands::collections::remove_book_from_collection(&core, collection_id, book_id)
}

#[tauri::command]
fn list_books_in_collection(core: CoreState<'_>, collection_id: String) -> AppResult<Vec<String>> {
    quill_core::commands::collections::list_books_in_collection(&core, collection_id)
}

#[tauri::command]
async fn ai_chat(
    core: CoreState<'_>,
    messages: Vec<ChatMessage>,
    book_title: Option<String>,
    book_author: Option<String>,
    current_chapter: Option<String>,
) -> AppResult<()> {
    quill_core::commands::ai::ai_chat(&core, messages, book_title, book_author, current_chapter).await
}

#[tauri::command]
async fn ai_lookup(
    core: CoreState<'_>,
    word: String,
    sentence: String,
    book_title: Option<String>,
    chapter: Option<String>,
    request_id: String,
    kind: Option<String>,
) -> AppResult<()> {
    quill_core::commands::ai::ai_lookup(&core, word, sentence, book_title, chapter, request_id, kind)
        .await
}

#[tauri::command]
async fn ai_explain(
    core: CoreState<'_>,
    passage: String,
    surrounding: Option<String>,
    book_title: Option<String>,
    chapter: Option<String>,
    request_id: String,
) -> AppResult<()> {
    quill_core::commands::ai::ai_explain(&core, passage, surrounding, book_title, chapter, request_id)
        .await
}

#[tauri::command]
async fn ai_generate_title(
    core: CoreState<'_>,
    user_message: String,
    assistant_message: String,
    request_id: String,
) -> AppResult<()> {
    quill_core::commands::ai::ai_generate_title(&core, user_message, assistant_message, request_id)
        .await
}

#[tauri::command]
async fn list_codex_models(
    core: CoreState<'_>,
) -> AppResult<quill_core::ai::codex_models::CodexModelList> {
    quill_core::commands::ai::list_codex_models(&core).await
}

#[tauri::command]
async fn openai_oauth_login(
    core: CoreState<'_>,
) -> AppResult<quill_core::ai::oauth::OAuthStatus> {
    quill_core::commands::oauth::openai_oauth_login(&core).await
}

#[tauri::command]
async fn openai_oauth_status(
    core: CoreState<'_>,
) -> AppResult<quill_core::ai::oauth::OAuthStatus> {
    quill_core::commands::oauth::openai_oauth_status(&core).await
}

#[tauri::command]
async fn openai_oauth_logout(core: CoreState<'_>) -> AppResult<()> {
    quill_core::commands::oauth::openai_oauth_logout(&core).await
}

#[tauri::command]
fn add_vocab_word(
    core: CoreState<'_>,
    book_id: String,
    word: String,
    definition: String,
    context_sentence: Option<String>,
    context_explanation: Option<String>,
    cfi: Option<String>,
) -> AppResult<VocabWord> {
    quill_core::commands::vocab::add_vocab_word(
        &core,
        book_id,
        word,
        definition,
        context_sentence,
        context_explanation,
        cfi,
    )
}

#[tauri::command]
fn remove_vocab_word(core: CoreState<'_>, id: String) -> AppResult<()> {
    quill_core::commands::vocab::remove_vocab_word(&core, id)
}

#[tauri::command]
fn list_vocab_words(core: CoreState<'_>, book_id: String) -> AppResult<Vec<VocabWord>> {
    quill_core::commands::vocab::list_vocab_words(&core, book_id)
}

#[tauri::command]
fn check_vocab_exists(core: CoreState<'_>, book_id: String, word: String) -> AppResult<Option<String>> {
    quill_core::commands::vocab::check_vocab_exists(&core, book_id, word)
}

#[tauri::command]
fn list_all_vocab_words(core: CoreState<'_>) -> AppResult<Vec<VocabWord>> {
    quill_core::commands::vocab::list_all_vocab_words(&core)
}

#[tauri::command]
fn update_vocab_mastery(
    core: CoreState<'_>,
    id: String,
    mastery: String,
    next_review_at: Option<i64>,
) -> AppResult<()> {
    quill_core::commands::vocab::update_vocab_mastery(&core, id, mastery, next_review_at)
}

#[tauri::command]
fn list_vocab_due_for_review(core: CoreState<'_>) -> AppResult<Vec<VocabWord>> {
    quill_core::commands::vocab::list_vocab_due_for_review(&core)
}

#[tauri::command]
fn get_vocab_stats(core: CoreState<'_>) -> AppResult<VocabStats> {
    quill_core::commands::vocab::get_vocab_stats(&core)
}

#[tauri::command]
fn create_chat(
    core: CoreState<'_>,
    book_id: String,
    title: Option<String>,
    model: Option<String>,
) -> AppResult<Chat> {
    quill_core::commands::chats::create_chat(&core, book_id, title, model)
}

#[tauri::command]
fn list_chats(core: CoreState<'_>, book_id: String) -> AppResult<Vec<Chat>> {
    quill_core::commands::chats::list_chats(&core, book_id)
}

#[tauri::command]
fn list_all_chats(
    core: CoreState<'_>,
    search: Option<String>,
    book_id: Option<String>,
    cursor: Option<String>,
    limit: Option<usize>,
) -> AppResult<ChatPage> {
    quill_core::commands::chats::list_all_chats(&core, search, book_id, cursor, limit)
}

#[tauri::command]
fn get_chat_counts(core: CoreState<'_>) -> AppResult<ChatCounts> {
    quill_core::commands::chats::get_chat_counts(&core)
}

#[tauri::command]
fn get_chat(core: CoreState<'_>, chat_id: String) -> AppResult<Chat> {
    quill_core::commands::chats::get_chat(&core, chat_id)
}

#[tauri::command]
fn delete_chat(core: CoreState<'_>, chat_id: String) -> AppResult<()> {
    quill_core::commands::chats::delete_chat(&core, chat_id)
}

#[tauri::command]
fn rename_chat(core: CoreState<'_>, chat_id: String, title: String) -> AppResult<()> {
    quill_core::commands::chats::rename_chat(&core, chat_id, title)
}

#[tauri::command]
fn list_chat_messages(core: CoreState<'_>, chat_id: String) -> AppResult<Vec<ChatMsg>> {
    quill_core::commands::chats::list_chat_messages(&core, chat_id)
}

#[tauri::command]
fn save_chat_message(
    core: CoreState<'_>,
    chat_id: String,
    role: String,
    content: String,
    context: Option<String>,
    metadata: Option<String>,
) -> AppResult<ChatMsg> {
    quill_core::commands::chats::save_chat_message(&core, chat_id, role, content, context, metadata)
}

#[tauri::command]
async fn ai_translate_passage(
    core: CoreState<'_>,
    text: String,
    context: Option<String>,
    book_id: String,
    target_language: Option<String>,
    request_id: String,
) -> AppResult<()> {
    quill_core::commands::translation::ai_translate_passage(
        &core,
        text,
        context,
        book_id,
        target_language,
        request_id,
    )
    .await
}

#[tauri::command]
fn mcp_integration_status(core: CoreState<'_>) -> AppResult<McpIntegrationStatus> {
    quill_core::commands::mcp::mcp_integration_status(&core)
}

#[tauri::command]
fn mcp_set_integration(core: CoreState<'_>, client: String, enabled: bool) -> AppResult<()> {
    quill_core::commands::mcp::mcp_set_integration(&core, client, enabled)
}

#[tauri::command]
fn mcp_config_snippet(core: CoreState<'_>) -> AppResult<String> {
    quill_core::commands::mcp::mcp_config_snippet(&core)
}

#[tauri::command]
fn mcp_set_write_access(core: CoreState<'_>, enabled: bool) -> AppResult<()> {
    quill_core::commands::mcp::mcp_set_write_access(&core, enabled)
}

#[tauri::command]
async fn sync_status(core: CoreState<'_>) -> AppResult<SyncStatus> {
    quill_core::commands::sync::sync_status(&core).await
}

#[tauri::command]
fn sync_enable(core: CoreState<'_>) -> AppResult<()> {
    quill_core::commands::sync::sync_enable(&core)
}

#[tauri::command]
async fn sync_disable(core: CoreState<'_>) -> AppResult<()> {
    quill_core::commands::sync::sync_disable(&core).await
}

#[tauri::command]
fn sync_now(core: CoreState<'_>) -> AppResult<SyncNowResult> {
    quill_core::commands::sync::sync_now(&core)
}

#[tauri::command]
fn sync_cancel(core: CoreState<'_>) -> AppResult<()> {
    quill_core::commands::sync::sync_cancel(&core)
}

#[tauri::command]
fn sync_compact(core: CoreState<'_>) -> AppResult<SyncCompactResult> {
    quill_core::commands::sync::sync_compact(&core)
}

#[tauri::command]
async fn sync_rebuild(core: CoreState<'_>) -> AppResult<SyncNowResult> {
    quill_core::commands::sync::sync_rebuild(&core).await
}

#[tauri::command]
fn sync_remove_peer(core: CoreState<'_>, device_uuid: String) -> AppResult<()> {
    quill_core::commands::sync::sync_remove_peer(&core, device_uuid)
}

// ---------------------------------------------------------------------------
// Entrypoint
// ---------------------------------------------------------------------------

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let default_level = if cfg!(debug_assertions) {
        log::LevelFilter::Debug
    } else {
        log::LevelFilter::Info
    };
    let level = quill_core::logging::resolve_log_level(default_level);

    let app = tauri::Builder::default()
        .plugin(
            tauri_plugin_log::Builder::new()
                .targets([
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Folder {
                        path: quill_core::paths::resolve_log_dir(cfg!(debug_assertions)),
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

            let check = tauri::menu::MenuItem::with_id(
                handle,
                "check_for_updates",
                "Check for Updates…",
                true,
                None::<&str>,
            )?;
            #[cfg(target_os = "macos")]
            {
                if let Some(app_kind) = menu.items()?.first() {
                    if let Some(app_sub) = app_kind.as_submenu() {
                        app_sub.insert(&check, 1)?;
                    }
                }
            }
            #[cfg(not(target_os = "macos"))]
            {
                if let Some(help_kind) = menu.get(tauri::menu::HELP_SUBMENU_ID) {
                    if let Some(help) = help_kind.as_submenu() {
                        help.append(&check)?;
                    }
                }
            }
            Ok(menu)
        })
        .on_menu_event(|app, event| {
            if event.id() == "reveal_logs" {
                let core: CoreState<'_> = app.state();
                if let Err(e) = quill_core::commands::app::reveal_logs(&core) {
                    log::warn!("menu: reveal_logs failed: {e}");
                }
            } else if event.id() == "check_for_updates" {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.show();
                    let _ = w.set_focus();
                }
                let _ = app.emit("menu:check-for-updates", ());
            }
        })
        .on_window_event(|window, event| {
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
            let app_data_dir = app
                .path()
                .app_data_dir()
                .expect("failed to resolve app data dir");
            let app_data_base_dir = app_data_dir
                .parent()
                .expect("app data dir has parent")
                .to_path_buf();
            let is_dev = cfg!(debug_assertions);
            let config = BootConfig {
                app_data_base_dir,
                log_dir: quill_core::paths::resolve_log_dir(is_dev),
                is_dev,
                mcp_binary_path: std::env::current_exe().expect("current exe"),
                pdfium_path: None,
            };
            let host = Arc::new(TauriHost {
                app: app.handle().clone(),
            });
            let core = boot(config, host).expect("failed to boot quill core");
            app.manage(core);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // App lifecycle
            app_ready,
            reveal_logs,
            commands::window::window_set_titlebar_zoom,
            // Books
            import_book,
            list_books,
            get_book,
            get_book_counts,
            delete_book,
            update_reading_progress,
            mark_finished,
            update_book_status,
            update_book_pages,
            check_book_available,
            check_book_readable,
            update_book_metadata,
            // Settings
            get_all_settings,
            get_setting,
            set_setting,
            set_settings_bulk,
            get_book_settings,
            set_book_settings_bulk,
            open_settings_on_main,
            // Bookmarks & Highlights
            add_bookmark,
            remove_bookmark,
            list_bookmarks,
            add_highlight,
            remove_highlight,
            list_highlights,
            update_highlight_note,
            update_highlight_color,
            // Collections
            list_collections,
            create_collection,
            rename_collection,
            delete_collection,
            reorder_collections,
            add_book_to_collection,
            remove_book_from_collection,
            list_books_in_collection,
            // AI
            ai_chat,
            ai_lookup,
            ai_explain,
            ai_generate_title,
            list_codex_models,
            // OAuth
            openai_oauth_login,
            openai_oauth_status,
            openai_oauth_logout,
            // Vocabulary
            add_vocab_word,
            remove_vocab_word,
            list_vocab_words,
            check_vocab_exists,
            list_all_vocab_words,
            update_vocab_mastery,
            list_vocab_due_for_review,
            get_vocab_stats,
            // Chats
            create_chat,
            list_chats,
            list_all_chats,
            get_chat_counts,
            get_chat,
            delete_chat,
            rename_chat,
            list_chat_messages,
            save_chat_message,
            // Translation
            ai_translate_passage,
            // MCP client integrations
            mcp_integration_status,
            mcp_set_integration,
            mcp_config_snippet,
            mcp_set_write_access,
            // Sync
            sync_status,
            sync_enable,
            sync_disable,
            sync_now,
            sync_cancel,
            sync_compact,
            sync_rebuild,
            sync_remove_peer,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app_handle, event| match &event {
        #[cfg(target_os = "macos")]
        tauri::RunEvent::Opened { urls } => {
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
        #[cfg(target_os = "macos")]
        tauri::RunEvent::Reopen { .. } => {
            if let Some(window) = app_handle.get_webview_window("main") {
                if !window.is_visible().unwrap_or(true) {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
        }
        #[cfg(target_os = "macos")]
        tauri::RunEvent::WindowEvent {
            label,
            event: tauri::WindowEvent::Destroyed,
            ..
        } => {
            commands::window::uninstall_titlebar_resize_observer(label);
        }
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
