use rmcp::ErrorData;
use rmcp::handler::server::wrapper::Parameters;
use rmcp::model::{CallToolResult, Content};
use rmcp::tool;
use rmcp::tool_router;
use schemars::JsonSchema;
use serde::Deserialize;

use crate::commands::vocab;
use crate::mcp::server::QuillMcpHandler;

#[derive(Debug, Deserialize, JsonSchema)]
pub struct GetVocabWordsArgs {
    /// Book ID to scope to.
    pub book_id: String,
}

#[tool_router(router = vocab_router, vis = "pub(crate)")]
impl QuillMcpHandler {
    #[tool(
        description = "List vocabulary words saved for a book, including mastery state and SRS review timing."
    )]
    pub async fn get_vocab_words(
        &self,
        Parameters(GetVocabWordsArgs { book_id }): Parameters<GetVocabWordsArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let words = vocab::query_vocab_words(&self.state.db, &book_id)
            .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;
        Ok(CallToolResult::success(vec![Content::json(&words)?]))
    }

    #[tool(
        description = "Return aggregate vocabulary counts: total, new, learning, mastered, and due_for_review across all books."
    )]
    pub async fn get_vocab_stats(&self) -> Result<CallToolResult, ErrorData> {
        let stats = vocab::query_vocab_stats(&self.state.db)
            .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;
        Ok(CallToolResult::success(vec![Content::json(&stats)?]))
    }
}
