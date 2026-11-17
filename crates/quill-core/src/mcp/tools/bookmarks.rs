use rmcp::ErrorData;
use rmcp::handler::server::wrapper::Parameters;
use rmcp::model::{CallToolResult, Content};
use rmcp::tool;
use rmcp::tool_router;
use schemars::JsonSchema;
use serde::Deserialize;

use crate::commands::bookmarks;
use crate::mcp::server::QuillMcpHandler;

#[derive(Debug, Deserialize, JsonSchema)]
pub struct GetBookmarksArgs {
    /// Book ID to fetch bookmarks for.
    pub book_id: String,
}

#[tool_router(router = bookmarks_router, vis = "pub(crate)")]
impl QuillMcpHandler {
    #[tool(description = "List all bookmarks for a book, ordered by creation time (newest first).")]
    pub async fn get_bookmarks(
        &self,
        Parameters(GetBookmarksArgs { book_id }): Parameters<GetBookmarksArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let bookmarks = bookmarks::query_bookmarks(&self.state.db, &book_id)
            .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;
        Ok(CallToolResult::success(vec![Content::json(&bookmarks)?]))
    }
}
