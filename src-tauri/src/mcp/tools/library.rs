//! Library tools: `list_books`, `get_book`, `get_collections`.
//!
//! All three are pure projections over existing shared query helpers in
//! `commands::books` and `commands::collections`. File paths returned
//! here stay relative (no `resolve_book_paths` call) so the response
//! doesn't leak the user's home directory layout.

use rmcp::ErrorData;
use rmcp::handler::server::wrapper::Parameters;
use rmcp::model::{CallToolResult, Content};
use rmcp::tool;
use rmcp::tool_router;
use schemars::JsonSchema;
use serde::Deserialize;

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

#[tool_router(router = library_router, vis = "pub(crate)")]
impl QuillMcpHandler {
    #[tool(
        description = "List books in the local library. Optionally filter by status or genre and search title/author. Returns relative file/cover paths (under the app data directory)."
    )]
    pub async fn list_books(
        &self,
        Parameters(ListBooksArgs { filter, search }): Parameters<ListBooksArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let books = books::query_books(&self.state.db, filter.as_deref(), search.as_deref())
            .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;
        Ok(CallToolResult::success(vec![Content::json(&books)?]))
    }

    #[tool(description = "Fetch a single book by its ID, including reading progress and current CFI.")]
    pub async fn get_book(
        &self,
        Parameters(GetBookArgs { book_id }): Parameters<GetBookArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let book = books::query_book(&self.state.db, &book_id)
            .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;
        Ok(CallToolResult::success(vec![Content::json(&book)?]))
    }

    #[tool(description = "List all collections in the library with per-collection book counts.")]
    pub async fn get_collections(&self) -> Result<CallToolResult, ErrorData> {
        let collections = collections::query_collections(&self.state.db)
            .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;
        Ok(CallToolResult::success(vec![Content::json(&collections)?]))
    }
}
