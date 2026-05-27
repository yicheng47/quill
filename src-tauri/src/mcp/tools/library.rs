//! Library tools: read (`list_books`, `get_book`, `get_collections`)
//! and write (`add_book`, `update_book`, `delete_book`).
//!
//! Read tools are pure projections over shared query helpers. File
//! paths returned stay relative (no `resolve_book_paths`) so the
//! response doesn't leak the user's home directory layout.
//!
//! Write tools are gated behind `McpState.sync` — they return a clear
//! error when write access is disabled.

use rmcp::ErrorData;
use rmcp::handler::server::wrapper::Parameters;
use rmcp::model::{CallToolResult, Content};
use rmcp::tool;
use rmcp::tool_router;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::commands::books;
use crate::commands::collections;
use crate::mcp::server::QuillMcpHandler;

#[derive(Debug, Deserialize, JsonSchema)]
pub struct ListBooksArgs {
    /// Optional filter: `"reading"`, `"finished"`, `"unread"`, `"all"`,
    /// or any genre string. Omit for the full library.
    #[serde(default)]
    pub filter: Option<String>,
    /// Optional case-insensitive substring search across title and
    /// author. Omit for no search.
    #[serde(default)]
    pub search: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct GetBookArgs {
    /// Book ID as returned by `list_books` (UUID).
    pub book_id: String,
}

/// MCP-facing projection of `books::Book`. Drops `available` (the
/// stdio subprocess can't compute iCloud eviction state) and
/// `cover_data` (multi-hundred-KB base64 BLOBs are too large for
/// MCP JSON responses — MCP clients that need covers should fetch
/// them via a dedicated tool in the future).
#[derive(Debug, Serialize)]
struct McpBook {
    id: String,
    title: String,
    author: String,
    description: Option<String>,
    file_path: String,
    format: String,
    genre: Option<String>,
    pages: Option<i32>,
    status: String,
    progress: i32,
    current_cfi: Option<String>,
    created_at: i64,
    updated_at: i64,
    has_cover: bool,
}

impl From<books::Book> for McpBook {
    fn from(b: books::Book) -> Self {
        let has_cover = b.cover_data.as_ref().is_some_and(|d| !d.is_empty());
        Self {
            id: b.id,
            title: b.title,
            author: b.author,
            description: b.description,
            file_path: b.file_path,
            format: b.format,
            genre: b.genre,
            pages: b.pages,
            status: b.status,
            progress: b.progress,
            current_cfi: b.current_cfi,
            created_at: b.created_at,
            updated_at: b.updated_at,
            has_cover,
        }
    }
}

#[tool_router(router = library_router, vis = "pub(crate)")]
impl QuillMcpHandler {
    #[tool(
        description = "List books in the local library. Optionally filter by status or genre and search title/author. Returns relative file paths (under the app data directory). Covers are stored as BLOBs in the DB — use `has_cover` to check availability."
    )]
    pub async fn list_books(
        &self,
        Parameters(ListBooksArgs { filter, search }): Parameters<ListBooksArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let raw = books::query_books_lite(
            &self.state.db,
            filter.as_deref(),
            search.as_deref(),
            1000,
        )
        .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;
        let books: Vec<McpBook> = raw.into_iter().map(McpBook::from).collect();
        Ok(CallToolResult::success(vec![Content::json(&books)?]))
    }

    #[tool(description = "Fetch a single book by its ID, including reading progress and current CFI.")]
    pub async fn get_book(
        &self,
        Parameters(GetBookArgs { book_id }): Parameters<GetBookArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let book: McpBook = books::query_book(&self.state.db, &book_id)
            .map_err(|e| ErrorData::internal_error(e.to_string(), None))?
            .into();
        Ok(CallToolResult::success(vec![Content::json(&book)?]))
    }

    #[tool(description = "List all collections in the library with per-collection book counts.")]
    pub async fn get_collections(&self) -> Result<CallToolResult, ErrorData> {
        let collections = collections::query_collections(&self.state.db)
            .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;
        Ok(CallToolResult::success(vec![Content::json(&collections)?]))
    }
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct AddBookArgs {
    /// Absolute path to an .epub or .pdf file on the local filesystem.
    pub file_path: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct UpdateBookArgs {
    /// Book ID (UUID).
    pub book_id: String,
    /// New title. Omit to leave unchanged.
    #[serde(default)]
    pub title: Option<String>,
    /// New author. Omit to leave unchanged.
    #[serde(default)]
    pub author: Option<String>,
    /// New genre. Omit to leave unchanged.
    #[serde(default)]
    pub genre: Option<String>,
    /// New status: "unread", "reading", or "finished". Omit to leave unchanged.
    #[serde(default)]
    pub status: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct DeleteBookArgs {
    /// Book ID (UUID). Permanently removes the book, its file, cover, and all associated data (highlights, bookmarks, chats, vocab).
    pub book_id: String,
}

pub(crate) fn require_sync(
    handler: &QuillMcpHandler,
) -> Result<&crate::sync::writer::SyncWriter, ErrorData> {
    let sync = handler
        .state
        .sync
        .as_ref()
        .map(|arc| arc.as_ref())
        .ok_or_else(|| {
            ErrorData::invalid_request(
                "Write access was not enabled when this MCP session started. \
                 Enable it in Quill → Settings → MCP → Allow write access, \
                 then restart the MCP client so a new session picks up the change.",
                None,
            )
        })?;

    // Re-check the setting from SQLite so toggling write access off in
    // the Quill UI takes effect immediately, without restarting the
    // MCP subprocess.
    let still_enabled = handler
        .state
        .db
        .conn
        .lock()
        .ok()
        .and_then(|conn| {
            conn.query_row(
                "SELECT value FROM settings WHERE key = 'mcp_write_enabled'",
                [],
                |row| row.get::<_, String>(0),
            )
            .ok()
        })
        .map(|v| v == "true")
        .unwrap_or(false);

    if !still_enabled {
        return Err(ErrorData::invalid_request(
            "Write access was revoked. Re-enable it in Quill → Settings → MCP → Allow write access.",
            None,
        ));
    }

    Ok(sync)
}

#[tool_router(router = library_write_router, vis = "pub(crate)")]
impl QuillMcpHandler {
    #[tool(
        description = "Import a book from a local file path (.epub or .pdf) into the library."
    )]
    pub async fn add_book(
        &self,
        Parameters(AddBookArgs { file_path }): Parameters<AddBookArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let sync = require_sync(self)?;
        let ext = file_path
            .rsplit('.')
            .next()
            .unwrap_or("")
            .to_lowercase();
        let book = match ext.as_str() {
            "epub" => books::do_import_epub(&file_path, &self.state.db, sync),
            "pdf" => books::do_import_pdf(&file_path, &self.state.db, sync),
            _ => {
                return Err(ErrorData::invalid_params(
                    format!("Unsupported format '.{ext}'. Only .epub and .pdf are supported."),
                    None,
                ))
            }
        }
        .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;
        self.state.notify("books", "created", &book.id);
        let mcp_book: McpBook = book.into();
        Ok(CallToolResult::success(vec![Content::json(&mcp_book)?]))
    }

    #[tool(
        description = "Update a book's metadata. Only specified fields are changed; omitted fields stay as-is."
    )]
    pub async fn update_book(
        &self,
        Parameters(UpdateBookArgs {
            book_id,
            title,
            author,
            genre,
            status,
        }): Parameters<UpdateBookArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let sync = require_sync(self)?;
        let book = books::do_update_book(
            &book_id,
            title.as_deref(),
            author.as_deref(),
            genre.as_deref(),
            status.as_deref(),
            &self.state.db,
            sync,
        )
        .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;
        self.state.notify("books", "updated", &book_id);
        let mcp_book: McpBook = book.into();
        Ok(CallToolResult::success(vec![Content::json(&mcp_book)?]))
    }

    #[tool(
        description = "Permanently delete a book and all its associated data (highlights, bookmarks, chats, vocab, translations). Also removes the book file and cover image from disk."
    )]
    pub async fn delete_book(
        &self,
        Parameters(DeleteBookArgs { book_id }): Parameters<DeleteBookArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let sync = require_sync(self)?;
        books::do_delete_book(&book_id, &self.state.db, sync)
            .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;
        self.state.notify("books", "deleted", &book_id);
        Ok(CallToolResult::success(vec![Content::text(format!(
            "Book {book_id} deleted."
        ))]))
    }
}
