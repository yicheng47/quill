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
struct ListAllHighlightsArgs {
    #[serde(default)]
    book_id: Option<String>,
    #[serde(default)]
    search: Option<String>,
    #[serde(default)]
    sort: Option<String>,
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
struct OptionalCollectionIdArgs {
    #[serde(default)]
    collection_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AddBooksToCollectionArgs {
    collection_id: String,
    book_ids: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AiChatArgs {
    #[serde(default)]
    chat_id: Option<String>,
    messages: Vec<ChatMessage>,
    #[serde(default)]
    book_title: Option<String>,
    #[serde(default)]
    book_author: Option<String>,
    #[serde(default)]
    current_chapter: Option<String>,
    #[serde(default)]
    request_id: Option<String>,
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
struct CheckVocabLemmaArgs {
    lemma: String,
    #[serde(default)]
    book_id: Option<String>,
    #[serde(default)]
    cfi: Option<String>,
    #[serde(default)]
    context_sentence: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoveVocabLemmaArgs {
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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CheckOllamaStatusArgs {
    #[serde(default)]
    base_url: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ListApiModelsArgs {
    provider: String,
    #[serde(default)]
    base_url: Option<String>,
    #[serde(default)]
    api_key: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AiCancelArgs {
    channel: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LookupDictionaryArgs {
    term: String,
    #[serde(default)]
    lang_hint: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ImportDictionaryArgs {
    path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateDictionariesConfigArgs {
    items: Vec<crate::dictionary::DictionaryConfigItem>,
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
        "get_book_counts" => |core, args| {
            let a: OptionalCollectionIdArgs = parse_args(args)?;
            run_blocking(core, move |c| commands::books::get_book_counts(c, a.collection_id))
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
        "list_all_highlights" => |core, args| {
            let a: ListAllHighlightsArgs = parse_args(args)?;
            run_blocking(core, move |c| {
                commands::bookmarks::list_all_highlights(c, a.book_id, a.search, a.sort)
            })
        },
        "get_highlight_counts" => |core, _args| {
            run_blocking(core, commands::bookmarks::get_highlight_counts)
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
        "list_book_collections" => |core, args| {
            let a: BookIdArgs = parse_args(args)?;
            run_blocking(core, move |c| {
                commands::collections::list_book_collections(c, a.book_id)
            })
        },
        "add_books_to_collection" => |core, args| {
            let a: AddBooksToCollectionArgs = parse_args(args)?;
            run_blocking(core, move |c| {
                commands::collections::add_books_to_collection(c, a.collection_id, a.book_ids)
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
        "check_vocab_lemma" => |core, args| {
            let a: CheckVocabLemmaArgs = parse_args(args)?;
            run_blocking(core, move |c| {
                commands::vocab::check_vocab_lemma(
                    c,
                    a.lemma,
                    a.book_id,
                    a.cfi,
                    a.context_sentence,
                )
            })
        },
        "remove_vocab_lemma" => |core, args| {
            let a: RemoveVocabLemmaArgs = parse_args(args)?;
            run_blocking(core, move |c| commands::vocab::remove_vocab_lemma(c, a.word))
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

        // Offline Dictionaries
        "lookup_dictionary" => |core, args| {
            let a: LookupDictionaryArgs = parse_args(args)?;
            run_blocking(core, move |c| {
                commands::dictionary::lookup_dictionary(c, a.term, a.lang_hint)
            })
        },
        "list_dictionaries" => |core, _args| {
            run_blocking(core, commands::dictionary::list_dictionaries)
        },
        "import_dictionary" => |core, args| {
            let a: ImportDictionaryArgs = parse_args(args)?;
            run_blocking(core, move |c| {
                commands::dictionary::import_dictionary(c, a.path)
            })
        },
        "update_dictionaries_config" => |core, args| {
            let a: UpdateDictionariesConfigArgs = parse_args(args)?;
            run_blocking(core, move |c| {
                commands::dictionary::update_dictionaries_config(c, a.items)
            })
        },
        "remove_dictionary" => |core, args| {
            let a: IdArgs = parse_args(args)?;
            run_blocking(core, move |c| {
                commands::dictionary::remove_dictionary(c, a.id)
            })
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
                    core,
                    a.chat_id,
                    a.messages,
                    a.book_title,
                    a.book_author,
                    a.current_chapter,
                    a.request_id,
                )
                .await
                .and_then(to_json)
            }
        },
        "ai_lookup" => |core, args| {
            let a: AiLookupArgs = parse_args(args)?;
            async move {
                commands::ai::ai_lookup(
                    core,
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
                    core,
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
                    core,
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
        "codex_status" => |core, _args| {
            async move {
                commands::ai::codex_status(&core)
                    .await
                    .and_then(to_json)
            }
        },
        "codex_login" => |core, _args| {
            async move {
                commands::ai::codex_login(&core)
                    .await
                    .and_then(to_json)
            }
        },
        "codex_login_cancel" => |core, _args| {
            async move {
                commands::ai::codex_login_cancel(&core)
                    .await
                    .and_then(to_json)
            }
        },
        "ai_cancel" => |core, args| {
            let a: AiCancelArgs = parse_args(args)?;
            async move {
                commands::ai::ai_cancel(&core, a.channel)
                    .await
                    .and_then(to_json)
            }
        },
        "list_api_models" => |core, args| {
            let a: ListApiModelsArgs = parse_args(args)?;
            async move {
                commands::ai::list_api_models(&core, a.provider, a.base_url, a.api_key)
                    .await
                    .and_then(to_json)
            }
        },
        "check_ollama_status" => |core, args| {
            let a: CheckOllamaStatusArgs = parse_args(args)?;
            async move {
                commands::ai::check_ollama_status(&core, a.base_url)
                    .await
                    .and_then(to_json)
            }
        },

        // Translation
        "ai_translate_passage" => |core, args| {
            let a: AiTranslatePassageArgs = parse_args(args)?;
            async move {
                commands::translation::ai_translate_passage(
                    core,
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
            dict_path: None,
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
        assert_eq!(counts, json!({"all": 0, "reading": 0, "finished": 0, "unread": 0}));

        let all_hls = dispatch(
            Arc::clone(&core),
            "list_all_highlights",
            r#"{"bookId":null,"search":null,"sort":"newest"}"#,
        )
        .await
        .expect("list_all_highlights");
        assert_eq!(all_hls, json!([]));

        let hl_counts = dispatch(Arc::clone(&core), "get_highlight_counts", "{}")
            .await
            .expect("get_highlight_counts");
        assert_eq!(hl_counts, json!({"total": 0, "book_count": 0, "books": []}));

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

        {
            let conn = core.db.conn.lock().unwrap();
            let now = chrono::Utc::now().timestamp_millis();
            for bid in ["b1", "b2"] {
                conn.execute(
                    "INSERT INTO books (id, title, author, file_path, format, status, progress, created_at, updated_at)
                     VALUES (?1, ?2, 'Author', 'books/test.epub', 'epub', 'reading', 10, ?3, ?3)",
                    rusqlite::params![bid, format!("Book {bid}"), now],
                ).unwrap();
            }
        }

        dispatch(
            Arc::clone(&core),
            "add_books_to_collection",
            &json!({"collectionId": coll_id, "bookIds": ["b1", "b2"]}).to_string(),
        )
        .await
        .expect("add_books_to_collection");

        let book_colls = dispatch(
            Arc::clone(&core),
            "list_book_collections",
            &json!({"bookId": "b1"}).to_string(),
        )
        .await
        .expect("list_book_collections");
        assert_eq!(book_colls, json!([coll_id]));

        let coll_counts = dispatch(
            Arc::clone(&core),
            "get_book_counts",
            &json!({"collectionId": coll_id}).to_string(),
        )
        .await
        .expect("get_book_counts scoped");
        assert_eq!(coll_counts, json!({"all": 2, "reading": 2, "finished": 0, "unread": 0}));

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

    #[tokio::test]
    async fn absent_and_blank_provider_return_ai_not_configured_while_explicit_ollama_resolves() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let (_dir, _host, core) = boot_test_core();

        let chat_args = json!({
            "messages": [{"role": "user", "content": "hi"}],
            "bookTitle": null,
            "bookAuthor": null,
            "currentChapter": null
        })
        .to_string();
        let lookup_args = json!({
            "word": "wit",
            "sentence": "Brevity is the soul of wit.",
            "bookTitle": null,
            "chapter": null,
            "requestId": "req-absent-1",
            "kind": null
        })
        .to_string();
        let explain_args = json!({
            "passage": "hello",
            "surrounding": null,
            "bookTitle": null,
            "chapter": null,
            "requestId": "req-absent-2"
        })
        .to_string();
        let title_args = json!({
            "userMessage": "读".repeat(67),
            "assistantMessage": "",
            "requestId": "req-absent-3"
        })
        .to_string();
        let translate_args = json!({
            "text": "hello",
            "context": null,
            "bookId": "b1",
            "targetLanguage": "zh",
            "requestId": "req-absent-4"
        })
        .to_string();

        // 1) Absent ai_provider returns AI_NOT_CONFIGURED on every AI command
        for (cmd, args) in [
            ("ai_chat", &chat_args),
            ("ai_lookup", &lookup_args),
            ("ai_explain", &explain_args),
            ("ai_generate_title", &title_args),
            ("ai_translate_passage", &translate_args),
        ] {
            let err = dispatch(Arc::clone(&core), cmd, args)
                .await
                .expect_err(&format!("{cmd} with absent ai_provider must error"));
            assert_eq!(err.to_string(), "AI_NOT_CONFIGURED", "{cmd}");
        }

        // 2) Whitespace ai_provider also returns AI_NOT_CONFIGURED
        dispatch(
            Arc::clone(&core),
            "set_setting",
            r#"{"key":"ai_provider","value":"   "}"#,
        )
        .await
        .expect("set blank provider");
        let blank_err = dispatch(Arc::clone(&core), "ai_chat", &chat_args)
            .await
            .expect_err("ai_chat with blank ai_provider must error");
        assert_eq!(blank_err.to_string(), "AI_NOT_CONFIGURED");

        // 3) Explicitly configured ollama still resolves and uses default llama3.2 model
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind mock ollama");
        let addr = listener.local_addr().unwrap();
        let (tx, rx) = tokio::sync::oneshot::channel::<String>();
        let server = tokio::spawn(async move {
            if let Ok((mut stream, _)) = listener.accept().await {
                let mut buf = [0u8; 4096];
                let n = stream.read(&mut buf).await.unwrap_or(0);
                let _ = tx.send(String::from_utf8_lossy(&buf[..n]).to_string());
                let body = "data: {\"choices\":[{\"delta\":{\"content\":\"ok\"}}]}\n\ndata: [DONE]\n\n";
                let resp = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    body.len(),
                    body
                );
                let _ = stream.write_all(resp.as_bytes()).await;
            }
        });

        dispatch(
            Arc::clone(&core),
            "set_settings_bulk",
            &json!({
                "settings": {
                    "ai_provider": "ollama",
                    "ai_base_url": format!("http://{addr}/v1"),
                    "ai_api_key": "sk-must-not-be-sent-to-ollama"
                }
            })
            .to_string(),
        )
        .await
        .expect("set explicit ollama");

        dispatch(Arc::clone(&core), "ai_chat", &chat_args)
            .await
            .expect("explicit ollama resolves");

        let captured = tokio::time::timeout(std::time::Duration::from_secs(3), rx)
            .await
            .expect("mock ollama received request")
            .expect("request channel");
        assert!(captured.starts_with("POST /v1/chat/completions HTTP/1.1"), "request was: {captured}");
        assert!(captured.contains("\"model\":\"llama3.2\""), "request was: {captured}");
        assert!(!captured.to_lowercase().contains("authorization:"), "ollama must not send bearer auth: {captured}");
        let _ = server.await;
    }

    #[tokio::test]
    async fn list_api_models_respects_empty_draft_for_custom_provider() {
        let (_dir, _host, core) = boot_test_core();
        dispatch(
            Arc::clone(&core),
            "set_settings_bulk",
            r#"{"settings":{"ai_provider":"openai","ai_base_url":"https://api.openai.com/v1"}}"#,
        )
        .await
        .expect("seed openai url");

        // Passing an empty baseUrl draft for custom must NOT fall back to the
        // previously saved OpenAI base URL.
        let err = dispatch(
            Arc::clone(&core),
            "list_api_models",
            r#"{"provider":"custom","baseUrl":"","apiKey":""}"#,
        )
        .await
        .expect_err("custom with empty draft URL must return AI_NOT_CONFIGURED");
        assert_eq!(err.to_string(), "AI_NOT_CONFIGURED");
    }

    #[tokio::test]
    async fn list_api_models_only_reuses_saved_key_for_saved_provider_and_origin() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let (_dir, _host, core) = boot_test_core();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let addr = listener.local_addr().expect("addr");
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<String>();

        let server = tokio::spawn(async move {
            for _ in 0..4 {
                let (mut stream, _) = listener.accept().await.expect("accept");
                let mut buf = vec![0u8; 4096];
                let n = stream.read(&mut buf).await.unwrap_or(0);
                let _ = tx.send(String::from_utf8_lossy(&buf[..n]).to_string());
                let body = r#"{"data":[{"id":"m1"}]}"#;
                let resp = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    body.len(),
                    body
                );
                let _ = stream.write_all(resp.as_bytes()).await;
            }
        });

        // Seed OpenAI pointing at the local server with a saved API key.
        dispatch(
            Arc::clone(&core),
            "set_settings_bulk",
            &json!({
                "settings": {
                    "ai_provider": "openai",
                    "ai_base_url": format!("http://{addr}/v1"),
                    "ai_api_key": "sk-saved-secret"
                }
            })
            .to_string(),
        )
        .await
        .expect("seed saved openai");

        // 1) Same saved provider + same origin with omitted draft apiKey -> reuses saved key.
        dispatch(
            Arc::clone(&core),
            "list_api_models",
            &json!({"provider": "openai", "baseUrl": format!("http://{addr}/v1")}).to_string(),
        )
        .await
        .expect("same provider+origin");
        let req1 = rx.recv().await.expect("req1").to_lowercase();
        assert!(req1.contains("authorization: bearer sk-saved-secret"), "expected saved key: {req1}");

        // 2) Different provider with omitted draft apiKey -> must NOT send saved key.
        dispatch(
            Arc::clone(&core),
            "list_api_models",
            &json!({"provider": "custom", "baseUrl": format!("http://{addr}/v1")}).to_string(),
        )
        .await
        .expect("different provider");
        let req2 = rx.recv().await.expect("req2").to_lowercase();
        assert!(!req2.contains("sk-saved-secret"), "leaked saved key to another provider: {req2}");

        // 3) Same provider, different saved origin (with a saved key for that origin),
        // omitted draft apiKey -> must NOT send saved key to the local server.
        dispatch(
            Arc::clone(&core),
            "set_settings_bulk",
            r#"{"settings":{"ai_provider":"openai","ai_base_url":"https://api.openai.com/v1","ai_api_key":"sk-saved-secret"}}"#,
        )
        .await
        .expect("repoint saved openai to another origin with its own key");
        dispatch(
            Arc::clone(&core),
            "list_api_models",
            &json!({"provider": "openai", "baseUrl": format!("http://{addr}/v1")}).to_string(),
        )
        .await
        .expect("different origin");
        let req3 = rx.recv().await.expect("req3").to_lowercase();
        assert!(!req3.contains("sk-saved-secret"), "leaked saved key to another origin: {req3}");

        // 4) Explicit draft apiKey authorizes the new destination.
        dispatch(
            Arc::clone(&core),
            "list_api_models",
            &json!({
                "provider": "custom",
                "baseUrl": format!("http://{addr}/v1"),
                "apiKey": "sk-explicit-draft"
            })
            .to_string(),
        )
        .await
        .expect("explicit draft key");
        let req4 = rx.recv().await.expect("req4").to_lowercase();
        assert!(req4.contains("authorization: bearer sk-explicit-draft"), "expected explicit draft key: {req4}");

        let _ = server.await;
    }

    #[tokio::test]
    async fn changing_api_origin_or_provider_clears_saved_key_while_same_origin_preserves_it() {
        let (_dir, _host, core) = boot_test_core();

        dispatch(
            Arc::clone(&core),
            "set_settings_bulk",
            r#"{"settings":{"ai_provider":"openai","ai_base_url":"https://api.openai.com/v1","ai_api_key":"sk-origin-a"}}"#,
        )
        .await
        .expect("seed openai key");
        assert_eq!(core.secrets.get("ai_api_key").as_deref(), Some("sk-origin-a"));

        // Same-origin path edit preserves the saved API key.
        dispatch(
            Arc::clone(&core),
            "set_setting",
            r#"{"key":"ai_base_url","value":"https://api.openai.com/v2"}"#,
        )
        .await
        .expect("same-origin path edit");
        assert_eq!(core.secrets.get("ai_api_key").as_deref(), Some("sk-origin-a"));

        // Cross-origin URL edit without an explicit new key clears the saved secret on disk.
        dispatch(
            Arc::clone(&core),
            "set_setting",
            r#"{"key":"ai_base_url","value":"https://evil.example/v1"}"#,
        )
        .await
        .expect("cross-origin edit");
        assert_eq!(core.secrets.get("ai_api_key"), None);

        // Setting a fresh key for the new origin persists cleanly.
        dispatch(
            Arc::clone(&core),
            "set_setting",
            r#"{"key":"ai_api_key","value":"sk-origin-b"}"#,
        )
        .await
        .expect("set fresh key");
        assert_eq!(core.secrets.get("ai_api_key").as_deref(), Some("sk-origin-b"));

        // Switching provider without a new key also clears the old key on disk.
        dispatch(
            Arc::clone(&core),
            "set_setting",
            r#"{"key":"ai_provider","value":"deepseek"}"#,
        )
        .await
        .expect("switch provider");
        assert_eq!(core.secrets.get("ai_api_key"), None);
    }

    #[tokio::test]
    async fn saving_nonempty_api_key_without_bindable_endpoint_errors_and_preserves_storage() {
        let (_dir, _host, core) = boot_test_core();

        // Seed a valid OpenAI key first.
        dispatch(
            Arc::clone(&core),
            "set_settings_bulk",
            r#"{"settings":{"ai_provider":"openai","ai_base_url":"https://api.openai.com/v1","ai_api_key":"sk-keep-me"}}"#,
        )
        .await
        .expect("seed openai");

        // Trying to bulk-save Custom with a blank URL and a non-empty key must fail
        // validation and roll back without clobbering existing settings or secret.
        let bulk_err = dispatch(
            Arc::clone(&core),
            "set_settings_bulk",
            r#"{"settings":{"ai_provider":"custom","ai_base_url":"","ai_api_key":"sk-custom-early"}}"#,
        )
        .await
        .expect_err("non-empty key without bindable URL must error");
        assert!(bulk_err.to_string().contains("base URL"), "{bulk_err}");
        assert_eq!(
            core.secrets
                .get_api_key_for_endpoint("openai", "https://api.openai.com/v1")
                .as_deref(),
            Some("sk-keep-me")
        );
        let saved_provider = dispatch(Arc::clone(&core), "get_setting", r#"{"key":"ai_provider"}"#)
            .await
            .expect("get provider");
        assert_eq!(saved_provider, json!("openai"));

        // Switch to Custom (blank URL -> clears old key cleanly), then try set_setting(ai_api_key).
        dispatch(
            Arc::clone(&core),
            "set_settings_bulk",
            r#"{"settings":{"ai_provider":"custom","ai_base_url":"","ai_api_key":""}}"#,
        )
        .await
        .expect("switch to custom");
        let single_err = dispatch(
            Arc::clone(&core),
            "set_setting",
            r#"{"key":"ai_api_key","value":"sk-custom-before-url"}"#,
        )
        .await
        .expect_err("single-key save without URL must error");
        assert!(single_err.to_string().contains("base URL"), "{single_err}");
        assert_eq!(core.secrets.get("ai_api_key"), None);
    }

    #[tokio::test]
    async fn mismatched_persisted_endpoint_and_secret_cannot_be_read_listed_or_dispatched() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let (_dir, _host, core) = boot_test_core();

        // Seed OpenAI + https://api.openai.com/v1 + sk-origin-a cleanly.
        dispatch(
            Arc::clone(&core),
            "set_settings_bulk",
            r#"{"settings":{"ai_auth_mode":"api_key","ai_provider":"openai","ai_base_url":"https://api.openai.com/v1","ai_api_key":"sk-origin-a","ai_model":"gpt-4o"}}"#,
        )
        .await
        .expect("seed openai");

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let addr = listener.local_addr().expect("addr");
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<String>();
        let server = tokio::spawn(async move {
            for _ in 0..2 {
                let (mut stream, _) = listener.accept().await.expect("accept");
                let mut buf = vec![0u8; 4096];
                let n = stream.read(&mut buf).await.unwrap_or(0);
                let req = String::from_utf8_lossy(&buf[..n]).to_string();
                let _ = tx.send(req.clone());
                let (content_type, body) = if req.starts_with("POST ") {
                    ("text/event-stream", "data: {\"choices\":[{\"delta\":{\"content\":\"ok\"}}]}\n\ndata: [DONE]\n\n")
                } else {
                    ("application/json", r#"{"data":[{"id":"m1"}]}"#)
                };
                let resp = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = stream.write_all(resp.as_bytes()).await;
            }
        });

        // Simulate an interrupted write / failed secret clear / synced settings change:
        // `quill.db` points at the local server while `secrets.db` still holds the old
        // key bound to `https://api.openai.com`.
        {
            let conn = core.db.conn.lock().unwrap();
            conn.execute(
                "UPDATE settings SET value = ?1 WHERE key = 'ai_base_url'",
                rusqlite::params![format!("http://{addr}/v1")],
            )
            .unwrap();
        }

        // 1) get_all_settings and get_setting must NOT return the mismatched key.
        let all = dispatch(Arc::clone(&core), "get_all_settings", "{}")
            .await
            .expect("get_all_settings");
        assert!(all.get("ai_api_key").is_none(), "mismatched key leaked via get_all_settings: {all}");
        let single = dispatch(Arc::clone(&core), "get_setting", r#"{"key":"ai_api_key"}"#)
            .await
            .expect("get_setting");
        assert!(single.is_null(), "mismatched key leaked via get_setting: {single}");

        // 2) list_api_models with omitted draft key must NOT send sk-origin-a.
        dispatch(
            Arc::clone(&core),
            "list_api_models",
            &json!({"provider": "openai", "baseUrl": format!("http://{addr}/v1")}).to_string(),
        )
        .await
        .expect("list_api_models");
        let list_req = rx.recv().await.expect("list req").to_lowercase();
        assert!(!list_req.contains("sk-origin-a"), "mismatched key leaked to /models: {list_req}");

        // 3) Keyed provider dispatch must fail closed with AI_NOT_CONFIGURED before sending.
        let err = dispatch(
            Arc::clone(&core),
            "ai_chat",
            r#"{"messages":[{"role":"user","content":"Hi"}],"requestId":"mismatch-req"}"#,
        )
        .await
        .expect_err("openai dispatch with mismatched binding must fail closed");
        assert_eq!(err.to_string(), "AI_NOT_CONFIGURED");

        // 4) Custom provider (optional key) with a mismatched binding must dispatch without
        //    any Authorization header rather than sending the mismatched secret.
        {
            let conn = core.db.conn.lock().unwrap();
            conn.execute(
                "UPDATE settings SET value = 'custom' WHERE key = 'ai_provider'",
                [],
            )
            .unwrap();
        }
        dispatch(
            Arc::clone(&core),
            "ai_chat",
            r#"{"messages":[{"role":"user","content":"Hi"}],"requestId":"mismatch-custom"}"#,
        )
        .await
        .expect("custom dispatch without key");
        let chat_req = rx.recv().await.expect("chat req").to_lowercase();
        assert!(!chat_req.contains("authorization:"), "custom dispatch leaked mismatched key: {chat_req}");
        assert!(!chat_req.contains("sk-origin-a"), "custom dispatch leaked secret: {chat_req}");

        let _ = server.await;
    }

    #[test]
    fn concurrent_settings_updates_never_expose_mismatched_key_and_endpoint() {
        use std::collections::HashMap;
        use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
        use std::sync::Barrier;

        let (_dir, _host, core) = boot_test_core();

        let seed = |provider: &str, url: &str, key: &str| {
            let mut m = HashMap::new();
            m.insert("ai_auth_mode".to_string(), "api_key".to_string());
            m.insert("ai_provider".to_string(), provider.to_string());
            m.insert("ai_base_url".to_string(), url.to_string());
            m.insert("ai_api_key".to_string(), key.to_string());
            m
        };
        crate::commands::settings::set_settings_bulk(
            &core,
            seed("openai", "https://origin-a.example/v1", "sk-key-a"),
        )
        .unwrap();

        let start = Arc::new(Barrier::new(3));
        let done = Arc::new(AtomicBool::new(false));
        let observed_with_key = Arc::new(AtomicUsize::new(0));
        let writer_core = Arc::clone(&core);
        let writer_done = Arc::clone(&done);
        let writer_start = Arc::clone(&start);
        let writer = std::thread::spawn(move || {
            writer_start.wait();
            for i in 0..80 {
                let batch = if i % 2 == 0 {
                    seed("anthropic", "https://origin-b.example", "sk-key-b")
                } else {
                    seed("openai", "https://origin-a.example/v1", "sk-key-a")
                };
                crate::commands::settings::set_settings_bulk(&writer_core, batch).unwrap();
            }
            writer_done.store(true, Ordering::SeqCst);
        });

        let mut readers = Vec::new();
        for _ in 0..2 {
            let reader_core = Arc::clone(&core);
            let reader_done = Arc::clone(&done);
            let reader_start = Arc::clone(&start);
            let reader_obs = Arc::clone(&observed_with_key);
            readers.push(std::thread::spawn(move || {
                reader_start.wait();
                loop {
                    let s = crate::commands::settings::get_all_settings(&reader_core).unwrap();
                    if let Some(key) = s.get("ai_api_key") {
                        reader_obs.fetch_add(1, Ordering::SeqCst);
                        let provider = s.get("ai_provider").map(String::as_str).unwrap_or("");
                        let url = s.get("ai_base_url").map(String::as_str).unwrap_or("");
                        match key.as_str() {
                            "sk-key-a" => {
                                assert_eq!(provider, "openai", "sk-key-a paired with {provider} {url}");
                                assert_eq!(url, "https://origin-a.example/v1");
                            }
                            "sk-key-b" => {
                                assert_eq!(provider, "anthropic", "sk-key-b paired with {provider} {url}");
                                assert_eq!(url, "https://origin-b.example");
                            }
                            other => panic!("unexpected key: {other}"),
                        }
                    }
                    if reader_done.load(Ordering::SeqCst) {
                        break;
                    }
                }
            }));
        }

        writer.join().unwrap();
        for r in readers {
            r.join().unwrap();
        }
        assert!(
            observed_with_key.load(Ordering::SeqCst) > 0,
            "readers must observe at least one credential-bearing snapshot"
        );
    }

    #[tokio::test]
    async fn ai_chat_routes_chunks_to_per_request_channel() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let (_dir, host, core) = boot_test_core();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let addr = listener.local_addr().expect("addr");
        let server = tokio::spawn(async move {
            if let Ok((mut stream, _)) = listener.accept().await {
                let mut buf = vec![0u8; 4096];
                let _ = stream.read(&mut buf).await;
                let body = "data: {\"choices\":[{\"delta\":{\"content\":\"Hello\"}}]}\n\ndata: [DONE]\n\n";
                let resp = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    body.len(),
                    body
                );
                let _ = stream.write_all(resp.as_bytes()).await;
            }
        });

        dispatch(
            Arc::clone(&core),
            "set_settings_bulk",
            &json!({
                "settings": {
                    "ai_provider": "ollama",
                    "ai_base_url": format!("http://{addr}/v1"),
                    "ai_model": "llama3.2"
                }
            })
            .to_string(),
        )
        .await
        .expect("seed ollama");

        dispatch(
            Arc::clone(&core),
            "ai_chat",
            &json!({
                "chatId": "c1",
                "requestId": "req-42",
                "messages": [{"role": "user", "content": "hi"}]
            })
            .to_string(),
        )
        .await
        .expect("ai_chat");

        for _ in 0..100 {
            let done = host
                .events
                .lock()
                .unwrap()
                .iter()
                .any(|(e, p)| e == "ai-stream-chunk-req-42" && p["done"] == true);
            if done {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }

        let events = host.events.lock().unwrap().clone();
        assert!(
            events.iter().any(|(e, p)| e == "ai-stream-chunk-req-42" && p["delta"] == "Hello"),
            "expected delta on per-request channel: {events:?}"
        );
        assert!(
            !events.iter().any(|(e, _)| e == "ai-stream-chunk"),
            "must not emit on shared ai-stream-chunk channel when requestId is set: {events:?}"
        );
        let _ = server.await;
    }

    #[tokio::test]
    async fn codex_connection_routes_every_call_to_codex() {
        let (dir, _host, core) = boot_test_core();
        let missing = dir.path().join("no-codex-here");
        dispatch(
            Arc::clone(&core),
            "set_settings_bulk",
            &json!({"settings": {"ai_auth_mode": "codex", "ai_codex_path": missing, "language": "en"}}).to_string(),
        )
        .await
        .expect("save codex connection");

        let calls = [
            ("ai_chat", json!({"chatId": "c1", "messages": [{"role": "user", "content": "hi"}]})),
            ("ai_lookup", json!({"word": "wit", "sentence": "s", "requestId": "r1"})),
            ("ai_explain", json!({"passage": "p", "requestId": "r2"})),
            ("ai_generate_title", json!({"userMessage": "hi", "assistantMessage": "", "requestId": "r3"})),
            ("ai_translate_passage", json!({"text": "hi", "bookId": "b", "targetLanguage": "zh", "requestId": "r4"})),
        ];
        for (cmd, args) in calls {
            let err = dispatch(Arc::clone(&core), cmd, &args.to_string())
                .await
                .expect_err(&format!("{cmd} with a missing codex must error"));
            assert_eq!(err.to_string(), "CODEX_NOT_INSTALLED", "{cmd}");
        }

        let status = dispatch(Arc::clone(&core), "codex_status", "{}").await.expect("codex_status");
        assert_eq!(status["state"], "not_installed");
        assert_eq!(status["min_version"], "0.170.0");
        dispatch(Arc::clone(&core), "ai_cancel", r#"{"channel":"ai-lookup-chunk-r1"}"#)
            .await
            .expect("cancelling an idle channel is a no-op");
    }

    #[test]
    fn command_table_has_no_duplicates_and_covers_frontend() {
        let core_set: BTreeSet<&str> = CORE_COMMAND_NAMES.iter().copied().collect();
        assert_eq!(
            core_set.len(),
            CORE_COMMAND_NAMES.len(),
            "duplicate entries in CORE_COMMAND_NAMES"
        );
        assert_eq!(CORE_COMMAND_NAMES.len(), 88);

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
