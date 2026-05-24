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
pub struct GetHighlightsArgs {
    /// Book ID to fetch highlights for.
    pub book_id: String,
}

#[tool_router(router = highlights_router, vis = "pub(crate)")]
impl QuillMcpHandler {
    #[tool(
        description = "List all highlights for a book, including the highlighted text content, color, and any attached note."
    )]
    pub async fn get_highlights(
        &self,
        Parameters(GetHighlightsArgs { book_id }): Parameters<GetHighlightsArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let highlights = bookmarks::query_highlights(&self.state.db, &book_id)
            .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;
        Ok(CallToolResult::success(vec![Content::json(&highlights)?]))
    }
}
