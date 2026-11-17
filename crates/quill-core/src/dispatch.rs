use std::collections::HashMap;
use std::sync::Arc;

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};

use crate::commands;
use crate::commands::ai::ChatMessage;
use crate::error::{AppError, AppResult};
use crate::host::Core;

fn parse_args<T: DeserializeOwned>(args_json: &str) -> AppResult<T> {
    let trimmed = args_json.trim();
    let input = if trimmed.is_empty() || trimmed == "null" {
        "{}"
    } else {
        trimmed
    };
    serde_json::from_str(input)
        .map_err(|e| AppError::Other(format!("Invalid command arguments: {e}")))
}

fn to_json<T: Serialize>(value: T) -> AppResult<serde_json::Value> {
    serde_json::to_value(value).map_err(|e| AppError::Other(format!("Serialize output: {e}")))
}

async fn run_blocking<T, F>(core: Arc<Core>, f: F) -> AppResult<serde_json::Value>
where
    T: Serialize + Send + 'static,
    F: FnOnce(&Core) -> AppResult<T> + Send + 'static,
{
    let result = tokio::task::spawn_blocking(move || f(&core))
        .await
        .map_err(|e| AppError::Other(format!("Command task failed: {e}")))??;
    to_json(result)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct IdArgs {
    id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BookIdArgs {
    book_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ImportBookArgs {
    file_path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ListBooksArgs {
    #[serde(default)]
    filter: Option<String>,
    #[serde(default)]
    search: Option<String>,
    #[serde(default)]
    collection_id: Option<String>,
    #[serde(default)]
    cursor: Option<String>,
    #[serde(default)]
    limit: Option<usize>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateReadingProgressArgs {
    id: String,
    progress: i32,
    #[serde(default)]
    cfi: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateBookStatusArgs {
    id: String,
    status: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateBookPagesArgs {
    id: String,
    pages: i32,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateBookMetadataArgs {
    id: String,
    title: String,
    author: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GetSettingArgs {
    key: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SetSettingArgs {
    key: String,
    value: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SetSettingsBulkArgs {
    settings: HashMap<String, String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SetBookSettingsBulkArgs {
    book_id: String,
    settings: HashMap<String, String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct OpenSettingsOnMainArgs {
    section: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AddBookmarkArgs {
    book_id: String,
    cfi: String,
    #[serde(default)]
    label: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AddHighlightArgs {
    book_id: String,
    cfi_range: String,
    #[serde(default)]
    color: Option<String>,
    #[serde(default)]
    note: Option<String>,
    #[serde(default)]
    text_content: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateHighlightNoteArgs {
    id: String,
    note: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateHighlightColorArgs {
    id: String,
    color: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateCollectionArgs {
    name: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RenameCollectionArgs {
    id: String,
    name: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReorderCollectionsArgs {
    ids: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CollectionBookArgs {
    collection_id: String,
    book_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CollectionIdArgs {
    collection_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AiChatArgs {
    messages: Vec<ChatMessage>,
    #[serde(default)]
    book_title: Option<String>,
    #[serde(default)]
    book_author: Option<String>,
    #[serde(default)]
    current_chapter: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AiLookupArgs {
    word: String,
    sentence: String,
    #[serde(default)]
    book_title: Option<String>,
    #[serde(default)]
    chapter: Option<String>,
    request_id: String,
    #[serde(default)]
    kind: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AiExplainArgs {
    passage: String,
    #[serde(default)]
    surrounding: Option<String>,
    #[serde(default)]
    book_title: Option<String>,
    #[serde(default)]
    chapter: Option<String>,
    request_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AiGenerateTitleArgs {
    user_message: String,
    assistant_message: String,
    request_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AddVocabWordArgs {
    book_id: String,
    word: String,
    definition: String,
    #[serde(default)]
    context_sentence: Option<String>,
    #[serde(default)]
    context_explanation: Option<String>,
    #[serde(default)]
    cfi: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CheckVocabExistsArgs {
    book_id: String,
    word: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateVocabMasteryArgs {
    id: String,
    mastery: String,
    #[serde(default)]
    next_review_at: Option<i64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateChatArgs {
    book_id: String,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    model: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ListAllChatsArgs {
    #[serde(default)]
    search: Option<String>,
    #[serde(default)]
    book_id: Option<String>,
    #[serde(default)]
    cursor: Option<String>,
    #[serde(default)]
    limit: Option<usize>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChatIdArgs {
    chat_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RenameChatArgs {
    chat_id: String,
    title: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SaveChatMessageArgs {
    chat_id: String,
    role: String,
    content: String,
    #[serde(default)]
    context: Option<String>,
    #[serde(default)]
    metadata: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AiTranslatePassageArgs {
    text: String,
    #[serde(default)]
    context: Option<String>,
    book_id: String,
    #[serde(default)]
    target_language: Option<String>,
    request_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct McpSetIntegrationArgs {
    client: String,
    enabled: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct McpSetWriteAccessArgs {
    enabled: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SyncRemovePeerArgs {
    device_uuid: String,
}

macro_rules! command_table {
    (
        sync {
            $( $sync_name:literal => |$sync_core:ident, $sync_args:ident| $sync_body:expr, )*
        }
        async {
            $( $async_name:literal => |$async_core:ident, $async_args:ident| $async_body:expr, )*
        }
    ) => {
        pub const CORE_COMMAND_NAMES: &[&str] = &[
            $( $sync_name, )*
            $( $async_name, )*
        ];

        /// Dispatch a frontend command by name with a JSON object payload.
        ///
        /// Matches Tauri's camelCase JS argument convention and runs blocking
        /// database/file commands via `spawn_blocking`.
        pub async fn dispatch(
            core: Arc<Core>,
            command: &str,
            args_json: &str,
        ) -> AppResult<serde_json::Value> {
            match command {
                $(
                    $sync_name => {
                        let $sync_args = args_json;
                        let $sync_core = core;
                        $sync_body.await
                    }
                )*
                $(
                    $async_name => {
                        let $async_args = args_json;
                        let $async_core = core;
                        $async_body.await
                    }
                )*
                _ => Err(AppError::Other(format!("Unknown command: {command}"))),
            }
        }
    };
}

command_table! {
    sync {
        // App
        "reveal_logs" => |core, _args| {
            run_blocking(core, commands::app::reveal_logs)
        },

        // Books
        "import_book" => |core, args| {
            let a: ImportBookArgs = parse_args(args)?;
            run_blocking(core, move |c| commands::books::import_book(c, a.file_path))
        },
        "list_books" => |core, args| {
            let a: ListBooksArgs = parse_args(args)?;
            run_blocking(core, move |c| {
                commands::books::list_books(c, a.filter, a.search, a.collection_id, a.cursor, a.limit)
            })
        },
        "get_book" => |core, args| {
            let a: IdArgs = parse_args(args)?;
            run_blocking(core, move |c| commands::books::get_book(c, a.id))
        },
        "get_book_counts" => |core, _args| {
            run_blocking(core, commands::books::get_book_counts)
        },
        "delete_book" => |core, args| {
            let a: IdArgs = parse_args(args)?;
            run_blocking(core, move |c| commands::books::delete_book(c, a.id))
        },
        "update_reading_progress" => |core, args| {
            let a: UpdateReadingProgressArgs = parse_args(args)?;
            run_blocking(core, move |c| {
                commands::books::update_reading_progress(c, a.id, a.progress, a.cfi)
            })
        },
        "mark_finished" => |core, args| {
            let a: IdArgs = parse_args(args)?;
            run_blocking(core, move |c| commands::books::mark_finished(c, a.id))
        },
        "update_book_status" => |core, args| {
            let a: UpdateBookStatusArgs = parse_args(args)?;
            run_blocking(core, move |c| {
                commands::books::update_book_status(c, a.id, a.status)
            })
        },
        "update_book_pages" => |core, args| {
            let a: UpdateBookPagesArgs = parse_args(args)?;
            run_blocking(core, move |c| {
                commands::books::update_book_pages(c, a.id, a.pages)
            })
        },
        "check_book_available" => |core, args| {
            let a: IdArgs = parse_args(args)?;
            run_blocking(core, move |c| commands::books::check_book_available(c, a.id))
        },
        "check_book_readable" => |core, args| {
            let a: IdArgs = parse_args(args)?;
            run_blocking(core, move |c| commands::books::check_book_readable(c, a.id))
        },
        "update_book_metadata" => |core, args| {
            let a: UpdateBookMetadataArgs = parse_args(args)?;
            run_blocking(core, move |c| {
                commands::books::update_book_metadata(c, a.id, a.title, a.author)
            })
        },

        // Settings
        "get_all_settings" => |core, _args| {
            run_blocking(core, commands::settings::get_all_settings)
        },
        "get_setting" => |core, args| {
            let a: GetSettingArgs = parse_args(args)?;
            run_blocking(core, move |c| commands::settings::get_setting(c, a.key))
        },
        "set_setting" => |core, args| {
            let a: SetSettingArgs = parse_args(args)?;
            run_blocking(core, move |c| {
                commands::settings::set_setting(c, a.key, a.value)
            })
        },
        "set_settings_bulk" => |core, args| {
            let a: SetSettingsBulkArgs = parse_args(args)?;
            run_blocking(core, move |c| {
                commands::settings::set_settings_bulk(c, a.settings)
            })
        },
        "get_book_settings" => |core, args| {
            let a: BookIdArgs = parse_args(args)?;
            run_blocking(core, move |c| {
                commands::settings::get_book_settings(c, a.book_id)
            })
        },
        "set_book_settings_bulk" => |core, args| {
            let a: SetBookSettingsBulkArgs = parse_args(args)?;
            run_blocking(core, move |c| {
                commands::settings::set_book_settings_bulk(c, a.book_id, a.settings)
            })
        },
        "open_settings_on_main" => |core, args| {
            let a: OpenSettingsOnMainArgs = parse_args(args)?;
            run_blocking(core, move |c| {
                commands::settings::open_settings_on_main(c, a.section)
            })
        },

        // Bookmarks & Highlights
        "add_bookmark" => |core, args| {
            let a: AddBookmarkArgs = parse_args(args)?;
            run_blocking(core, move |c| {
                commands::bookmarks::add_bookmark(c, a.book_id, a.cfi, a.label)
            })
        },
        "remove_bookmark" => |core, args| {
            let a: IdArgs = parse_args(args)?;
            run_blocking(core, move |c| commands::bookmarks::remove_bookmark(c, a.id))
        },
        "list_bookmarks" => |core, args| {
            let a: BookIdArgs = parse_args(args)?;
            run_blocking(core, move |c| {
                commands::bookmarks::list_bookmarks(c, a.book_id)
            })
        },
        "add_highlight" => |core, args| {
            let a: AddHighlightArgs = parse_args(args)?;
            run_blocking(core, move |c| {
                commands::bookmarks::add_highlight(
                    c,
                    a.book_id,
                    a.cfi_range,
                    a.color,
                    a.note,
                    a.text_content,
                )
            })
        },
        "remove_highlight" => |core, args| {
            let a: IdArgs = parse_args(args)?;
            run_blocking(core, move |c| commands::bookmarks::remove_highlight(c, a.id))
        },
        "list_highlights" => |core, args| {
            let a: BookIdArgs = parse_args(args)?;
            run_blocking(core, move |c| {
                commands::bookmarks::list_highlights(c, a.book_id)
            })
        },
        "update_highlight_note" => |core, args| {
            let a: UpdateHighlightNoteArgs = parse_args(args)?;
            run_blocking(core, move |c| {
                commands::bookmarks::update_highlight_note(c, a.id, a.note)
            })
        },
        "update_highlight_color" => |core, args| {
            let a: UpdateHighlightColorArgs = parse_args(args)?;
            run_blocking(core, move |c| {
                commands::bookmarks::update_highlight_color(c, a.id, a.color)
            })
        },

        // Collections
        "list_collections" => |core, _args| {
            run_blocking(core, commands::collections::list_collections)
        },
        "create_collection" => |core, args| {
            let a: CreateCollectionArgs = parse_args(args)?;
            run_blocking(core, move |c| {
                commands::collections::create_collection(c, a.name)
            })
        },
        "rename_collection" => |core, args| {
            let a: RenameCollectionArgs = parse_args(args)?;
            run_blocking(core, move |c| {
                commands::collections::rename_collection(c, a.id, a.name)
            })
        },
        "delete_collection" => |core, args| {
            let a: IdArgs = parse_args(args)?;
            run_blocking(core, move |c| {
                commands::collections::delete_collection(c, a.id)
            })
        },
        "reorder_collections" => |core, args| {
            let a: ReorderCollectionsArgs = parse_args(args)?;
            run_blocking(core, move |c| {
                commands::collections::reorder_collections(c, a.ids)
            })
        },
        "add_book_to_collection" => |core, args| {
            let a: CollectionBookArgs = parse_args(args)?;
            run_blocking(core, move |c| {
                commands::collections::add_book_to_collection(c, a.collection_id, a.book_id)
            })
        },
        "remove_book_from_collection" => |core, args| {
            let a: CollectionBookArgs = parse_args(args)?;
            run_blocking(core, move |c| {
                commands::collections::remove_book_from_collection(c, a.collection_id, a.book_id)
            })
        },
        "list_books_in_collection" => |core, args| {
            let a: CollectionIdArgs = parse_args(args)?;
            run_blocking(core, move |c| {
                commands::collections::list_books_in_collection(c, a.collection_id)
            })
        },

        // Vocabulary
        "add_vocab_word" => |core, args| {
            let a: AddVocabWordArgs = parse_args(args)?;
            run_blocking(core, move |c| {
                commands::vocab::add_vocab_word(
                    c,
                    a.book_id,
                    a.word,
                    a.definition,
                    a.context_sentence,
                    a.context_explanation,
                    a.cfi,
                )
            })
        },
        "remove_vocab_word" => |core, args| {
            let a: IdArgs = parse_args(args)?;
            run_blocking(core, move |c| commands::vocab::remove_vocab_word(c, a.id))
        },
        "list_vocab_words" => |core, args| {
            let a: BookIdArgs = parse_args(args)?;
            run_blocking(core, move |c| commands::vocab::list_vocab_words(c, a.book_id))
        },
        "check_vocab_exists" => |core, args| {
            let a: CheckVocabExistsArgs = parse_args(args)?;
            run_blocking(core, move |c| {
                commands::vocab::check_vocab_exists(c, a.book_id, a.word)
            })
        },
        "list_all_vocab_words" => |core, _args| {
            run_blocking(core, commands::vocab::list_all_vocab_words)
        },
        "update_vocab_mastery" => |core, args| {
            let a: UpdateVocabMasteryArgs = parse_args(args)?;
            run_blocking(core, move |c| {
                commands::vocab::update_vocab_mastery(c, a.id, a.mastery, a.next_review_at)
            })
        },
        "list_vocab_due_for_review" => |core, _args| {
            run_blocking(core, commands::vocab::list_vocab_due_for_review)
        },
        "get_vocab_stats" => |core, _args| {
            run_blocking(core, commands::vocab::get_vocab_stats)
        },

        // Chats
        "create_chat" => |core, args| {
            let a: CreateChatArgs = parse_args(args)?;
            run_blocking(core, move |c| {
                commands::chats::create_chat(c, a.book_id, a.title, a.model)
            })
        },
        "list_chats" => |core, args| {
            let a: BookIdArgs = parse_args(args)?;
            run_blocking(core, move |c| commands::chats::list_chats(c, a.book_id))
        },
        "list_all_chats" => |core, args| {
            let a: ListAllChatsArgs = parse_args(args)?;
            run_blocking(core, move |c| {
                commands::chats::list_all_chats(c, a.search, a.book_id, a.cursor, a.limit)
            })
        },
        "get_chat_counts" => |core, _args| {
            run_blocking(core, commands::chats::get_chat_counts)
        },
        "get_chat" => |core, args| {
            let a: ChatIdArgs = parse_args(args)?;
            run_blocking(core, move |c| commands::chats::get_chat(c, a.chat_id))
        },
        "delete_chat" => |core, args| {
            let a: ChatIdArgs = parse_args(args)?;
            run_blocking(core, move |c| commands::chats::delete_chat(c, a.chat_id))
        },
        "rename_chat" => |core, args| {
            let a: RenameChatArgs = parse_args(args)?;
            run_blocking(core, move |c| {
                commands::chats::rename_chat(c, a.chat_id, a.title)
            })
        },
        "list_chat_messages" => |core, args| {
            let a: ChatIdArgs = parse_args(args)?;
            run_blocking(core, move |c| {
                commands::chats::list_chat_messages(c, a.chat_id)
            })
        },
        "save_chat_message" => |core, args| {
            let a: SaveChatMessageArgs = parse_args(args)?;
            run_blocking(core, move |c| {
                commands::chats::save_chat_message(
                    c,
                    a.chat_id,
                    a.role,
                    a.content,
                    a.context,
                    a.metadata,
                )
            })
        },

        // MCP integrations
        "mcp_integration_status" => |core, _args| {
            run_blocking(core, commands::mcp::mcp_integration_status)
        },
        "mcp_set_integration" => |core, args| {
            let a: McpSetIntegrationArgs = parse_args(args)?;
            run_blocking(core, move |c| {
                commands::mcp::mcp_set_integration(c, a.client, a.enabled)
            })
        },
        "mcp_config_snippet" => |core, _args| {
            run_blocking(core, commands::mcp::mcp_config_snippet)
        },
        "mcp_set_write_access" => |core, args| {
            let a: McpSetWriteAccessArgs = parse_args(args)?;
            run_blocking(core, move |c| {
                commands::mcp::mcp_set_write_access(c, a.enabled)
            })
        },

        // Sync (synchronous commands)
        "sync_enable" => |core, _args| {
            run_blocking(core, commands::sync::sync_enable)
        },
        "sync_now" => |core, _args| {
            run_blocking(core, commands::sync::sync_now)
        },
        "sync_cancel" => |core, _args| {
            run_blocking(core, commands::sync::sync_cancel)
        },
        "sync_compact" => |core, _args| {
            run_blocking(core, commands::sync::sync_compact)
        },
        "sync_remove_peer" => |core, args| {
            let a: SyncRemovePeerArgs = parse_args(args)?;
            run_blocking(core, move |c| {
                commands::sync::sync_remove_peer(c, a.device_uuid)
            })
        },
    }
    async {
        // AI
        "ai_chat" => |core, args| {
            let a: AiChatArgs = parse_args(args)?;
            async move {
                commands::ai::ai_chat(
                    &core,
                    a.messages,
                    a.book_title,
                    a.book_author,
                    a.current_chapter,
                )
                .await
                .and_then(to_json)
            }
        },
        "ai_lookup" => |core, args| {
            let a: AiLookupArgs = parse_args(args)?;
            async move {
                commands::ai::ai_lookup(
                    &core,
                    a.word,
                    a.sentence,
                    a.book_title,
                    a.chapter,
                    a.request_id,
                    a.kind,
                )
                .await
                .and_then(to_json)
            }
        },
        "ai_explain" => |core, args| {
            let a: AiExplainArgs = parse_args(args)?;
            async move {
                commands::ai::ai_explain(
                    &core,
                    a.passage,
                    a.surrounding,
                    a.book_title,
                    a.chapter,
                    a.request_id,
                )
                .await
                .and_then(to_json)
            }
        },
        "ai_generate_title" => |core, args| {
            let a: AiGenerateTitleArgs = parse_args(args)?;
            async move {
                commands::ai::ai_generate_title(
                    &core,
                    a.user_message,
                    a.assistant_message,
                    a.request_id,
                )
                .await
                .and_then(to_json)
            }
        },
        "list_codex_models" => |core, _args| {
            async move {
                commands::ai::list_codex_models(&core)
                    .await
                    .and_then(to_json)
            }
        },

        // OAuth
        "openai_oauth_login" => |core, _args| {
            async move {
                commands::oauth::openai_oauth_login(&core)
                    .await
                    .and_then(to_json)
            }
        },
        "openai_oauth_status" => |core, _args| {
            async move {
                commands::oauth::openai_oauth_status(&core)
                    .await
                    .and_then(to_json)
            }
        },
        "openai_oauth_logout" => |core, _args| {
            async move {
                commands::oauth::openai_oauth_logout(&core)
                    .await
                    .and_then(to_json)
            }
        },

        // Translation
        "ai_translate_passage" => |core, args| {
            let a: AiTranslatePassageArgs = parse_args(args)?;
            async move {
                commands::translation::ai_translate_passage(
                    &core,
                    a.text,
                    a.context,
                    a.book_id,
                    a.target_language,
                    a.request_id,
                )
                .await
                .and_then(to_json)
            }
        },

        // Sync (async commands)
        "sync_status" => |core, _args| {
            async move {
                commands::sync::sync_status(&core)
                    .await
                    .and_then(to_json)
            }
        },
        "sync_disable" => |core, _args| {
            async move {
                commands::sync::sync_disable(&core)
                    .await
                    .and_then(to_json)
            }
        },
        "sync_rebuild" => |core, _args| {
            async move {
                commands::sync::sync_rebuild(&core)
                    .await
                    .and_then(to_json)
            }
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::host::{boot, BootConfig, ShellHost};
    use serde_json::json;
    use std::collections::BTreeSet;
    use std::path::{Path, PathBuf};
    use std::sync::Mutex;
    use tempfile::TempDir;

    #[derive(Default)]
    struct MockHost {
        events: Mutex<Vec<(String, serde_json::Value)>>,
        directed_events: Mutex<Vec<(String, String, serde_json::Value)>>,
        revealed_paths: Mutex<Vec<PathBuf>>,
        opened_urls: Mutex<Vec<String>>,
    }

    impl ShellHost for MockHost {
        fn emit(&self, event: &str, payload: serde_json::Value) {
            self.events
                .lock()
                .unwrap()
                .push((event.to_string(), payload));
        }

        fn emit_to(&self, window: &str, event: &str, payload: serde_json::Value) {
            self.directed_events.lock().unwrap().push((
                window.to_string(),
                event.to_string(),
                payload,
            ));
        }

        fn open_url(&self, url: &str) -> AppResult<()> {
            self.opened_urls.lock().unwrap().push(url.to_string());
            Ok(())
        }

        fn reveal_path(&self, path: &Path) -> AppResult<()> {
            self.revealed_paths.lock().unwrap().push(path.to_path_buf());
            Ok(())
        }
    }

    fn boot_test_core() -> (TempDir, Arc<MockHost>, Arc<Core>) {
        let dir = TempDir::new().expect("tempdir");
        let host = Arc::new(MockHost::default());
        let config = BootConfig {
            app_data_base_dir: dir.path().join("appdata"),
            log_dir: dir.path().join("logs"),
            is_dev: true,
            mcp_binary_path: dir.path().join("quill-mcp"),
            pdfium_path: None,
        };
        let core = boot(config, host.clone()).expect("boot core");
        (dir, host, core)
    }

    #[tokio::test]
    async fn dispatch_unknown_command_errors() {
        let (_dir, _host, core) = boot_test_core();
        let err = dispatch(core, "no_such_command", "{}")
            .await
            .expect_err("unknown command should fail");
        assert!(
            err.to_string().contains("Unknown command: no_such_command"),
            "unexpected error: {err}"
        );
    }

    #[tokio::test]
    async fn golden_camel_case_args_and_serde_outputs() {
        let (_dir, host, core) = boot_test_core();

        // Null/empty args work for zero-arg commands.
        let initial_settings = dispatch(Arc::clone(&core), "get_all_settings", "null")
            .await
            .expect("get_all_settings");
        assert!(initial_settings.is_object());

        // Set & retrieve settings in camelCase.
        dispatch(
            Arc::clone(&core),
            "set_settings_bulk",
            r#"{"settings":{"theme":"dark","ai_provider":"openai"}}"#,
        )
        .await
        .expect("set_settings_bulk");

        let theme = dispatch(
            Arc::clone(&core),
            "get_setting",
            r#"{"key":"theme"}"#,
        )
        .await
        .expect("get_setting");
        assert_eq!(theme, json!("dark"));

        // Book listing returns expected snake_case fields matching BookPage.
        let page = dispatch(
            Arc::clone(&core),
            "list_books",
            r#"{"filter":"all","limit":10}"#,
        )
        .await
        .expect("list_books");
        assert_eq!(page["books"], json!([]));
        assert_eq!(page["total"], json!(0));
        assert!(page.get("next_cursor").is_some());

        let counts = dispatch(Arc::clone(&core), "get_book_counts", "{}")
            .await
            .expect("get_book_counts");
        assert_eq!(counts, json!({"all": 0, "reading": 0, "finished": 0}));

        // Collections + bookmarks + vocab + chats round-trip with camelCase inputs.
        let collection = dispatch(
            Arc::clone(&core),
            "create_collection",
            r#"{"name":"Sci-Fi"}"#,
        )
        .await
        .expect("create_collection");
        let coll_id = collection["id"].as_str().expect("collection id").to_string();
        assert_eq!(collection["name"], json!("Sci-Fi"));

        dispatch(
            Arc::clone(&core),
            "reorder_collections",
            &json!({"ids": [coll_id]}).to_string(),
        )
        .await
        .expect("reorder_collections");

        let snippet = dispatch(Arc::clone(&core), "mcp_config_snippet", "")
            .await
            .expect("mcp_config_snippet");
        let snippet_str = snippet.as_str().expect("snippet string");
        assert!(snippet_str.contains("\"quill\""));

        // Host callbacks carry exact events/paths.
        dispatch(
            Arc::clone(&core),
            "open_settings_on_main",
            r#"{"section":"ai"}"#,
        )
        .await
        .expect("open_settings_on_main");
        let directed = host.directed_events.lock().unwrap();
        assert_eq!(directed.len(), 1);
        assert_eq!(directed[0], ("main".into(), "open-settings".into(), json!("ai")));
        drop(directed);

        dispatch(Arc::clone(&core), "reveal_logs", "{}")
            .await
            .expect("reveal_logs");
        assert_eq!(host.revealed_paths.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn golden_error_shapes_preserved() {
        let (_dir, _host, core) = boot_test_core();

        dispatch(
            Arc::clone(&core),
            "set_setting",
            r#"{"key":"ai_provider","value":"openai"}"#,
        )
        .await
        .expect("set ai_provider");

        let ai_err = dispatch(
            Arc::clone(&core),
            "ai_explain",
            &json!({
                "passage": "hello",
                "surrounding": null,
                "bookTitle": "Book",
                "chapter": "1",
                "requestId": "req-1"
            })
            .to_string(),
        )
        .await
        .expect_err("ai_explain without config should error");
        assert!(
            ai_err.to_string().contains("AI_NOT_CONFIGURED"),
            "expected AI_NOT_CONFIGURED in: {ai_err}"
        );

        let tr_ai_err = dispatch(
            Arc::clone(&core),
            "ai_translate_passage",
            &json!({
                "text": "hello",
                "context": null,
                "bookId": "b1",
                "targetLanguage": null,
                "requestId": "req-2"
            })
            .to_string(),
        )
        .await
        .expect_err("ai_translate_passage without key should error");
        assert!(
            tr_ai_err.to_string().contains("AI_NOT_CONFIGURED"),
            "expected AI_NOT_CONFIGURED in: {tr_ai_err}"
        );

        dispatch(
            Arc::clone(&core),
            "set_setting",
            r#"{"key":"language","value":""}"#,
        )
        .await
        .expect("set empty language");

        let tr_lang_err = dispatch(
            Arc::clone(&core),
            "ai_translate_passage",
            &json!({
                "text": "hello",
                "context": null,
                "bookId": "b1",
                "targetLanguage": null,
                "requestId": "req-3"
            })
            .to_string(),
        )
        .await
        .expect_err("ai_translate_passage without configured language should error");
        assert!(
            tr_lang_err
                .to_string()
                .contains("TRANSLATION_LANGUAGE_NOT_CONFIGURED"),
            "expected TRANSLATION_LANGUAGE_NOT_CONFIGURED in: {tr_lang_err}"
        );
    }

    #[test]
    fn command_table_has_no_duplicates_and_covers_frontend() {
        let core_set: BTreeSet<&str> = CORE_COMMAND_NAMES.iter().copied().collect();
        assert_eq!(
            core_set.len(),
            CORE_COMMAND_NAMES.len(),
            "duplicate entries in CORE_COMMAND_NAMES"
        );
        assert_eq!(CORE_COMMAND_NAMES.len(), 74);

        let workspace_root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .and_then(|p| p.parent())
            .expect("workspace root");

        // Scan frontend src/ (excluding unit tests and dead SettingsPage.tsx) for command names.
        fn collect_ts_files(dir: &Path, out: &mut Vec<PathBuf>) {
            for entry in std::fs::read_dir(dir).expect("read_dir src") {
                let path = entry.expect("dir entry").path();
                if path.is_dir() {
                    collect_ts_files(&path, out);
                } else if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                    let is_code = (name.ends_with(".ts") || name.ends_with(".tsx"))
                        && !name.contains(".test.")
                        && name != "SettingsPage.tsx";
                    if is_code {
                        out.push(path);
                    }
                }
            }
        }

        let mut files = Vec::new();
        collect_ts_files(&workspace_root.join("src"), &mut files);

        let mut invoked = BTreeSet::new();
        for file in files {
            let content = std::fs::read_to_string(&file).expect("read frontend file");
            for marker in ["invoke<", "invoke("] {
                let mut pos = 0;
                while let Some(idx) = content[pos..].find(marker) {
                    let after = &content[pos + idx + marker.len()..];
                    pos += idx + marker.len();
                    if let Some(paren) = after.find('(') {
                        let candidate = if marker == "invoke(" {
                            after.trim_start()
                        } else {
                            // Make sure `<...>` closes before `(` on the same call
                            after[paren + 1..].trim_start()
                        };
                        if let Some(first_quote) = candidate.chars().next().filter(|&c| c == '"' || c == '\'') {
                            if let Some(end_q) = candidate[1..].find(first_quote) {
                                let cmd = &candidate[1..1 + end_q];
                                if !cmd.is_empty() && !cmd.contains(':') {
                                    invoked.insert(cmd.to_string());
                                }
                            }
                        }
                    }
                }
            }
        }

        for cmd in &invoked {
            assert!(
                core_set.contains(cmd.as_str()),
                "frontend invokes unknown command `{cmd}` missing from CORE_COMMAND_NAMES"
            );
        }
        assert!(
            invoked.len() >= 60,
            "expected >= 60 invoked commands in src/, found only {}",
            invoked.len()
        );
    }
}
