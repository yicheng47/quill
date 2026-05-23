use rmcp::ErrorData;
use rmcp::handler::server::wrapper::Parameters;
use rmcp::model::{CallToolResult, Content};
use rmcp::tool;
use rmcp::tool_router;
use schemars::JsonSchema;
use serde::Deserialize;

use crate::commands::translation;
use crate::mcp::server::QuillMcpHandler;

#[derive(Debug, Default, Deserialize, JsonSchema)]
pub struct GetTranslationsArgs {
    /// Optional book ID. Omit to return saved translations across the
    /// entire library (newest first).
    #[serde(default)]
    pub book_id: Option<String>,
}

#[tool_router(router = translations_router, vis = "pub(crate)")]
impl QuillMcpHandler {
    #[tool(
        description = "List saved translations (source + translated text + target language + CFI location). Optionally scope to a single book."
    )]
    pub async fn get_translations(
        &self,
        Parameters(GetTranslationsArgs { book_id }): Parameters<GetTranslationsArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let translations =
            translation::query_translations(&self.state.db, book_id.as_deref())
                .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;
        Ok(CallToolResult::success(vec![Content::json(&translations)?]))
    }
}
