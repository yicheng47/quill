use rmcp::ErrorData;
use rmcp::handler::server::wrapper::Parameters;
use rmcp::model::{CallToolResult, Content};
use rmcp::tool;
use rmcp::tool_router;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::commands::chats;
use crate::mcp::server::QuillMcpHandler;

#[derive(Debug, Deserialize, JsonSchema)]
pub struct GetChatHistoryArgs {
    /// Book ID. Required — chats are always scoped to a book.
    pub book_id: String,
    /// Optional chat ID. When provided, only that chat's messages are
    /// included; otherwise every chat for the book is returned (each
    /// with its message list).
    #[serde(default)]
    pub chat_id: Option<String>,
}

/// One chat with its full message list. Returned as a list (even for
/// single-chat queries) so the response shape is stable regardless of
/// `chat_id` presence.
#[derive(Debug, Serialize)]
struct ChatWithMessages {
    #[serde(flatten)]
    chat: chats::Chat,
    messages: Vec<chats::ChatMsg>,
}

#[tool_router(router = chats_router, vis = "pub(crate)")]
impl QuillMcpHandler {
    #[tool(
        description = "Fetch chat history for a book. Returns an array of chats; each chat carries its full ordered message list. Optionally narrow to one chat by `chat_id`."
    )]
    pub async fn get_chat_history(
        &self,
        Parameters(GetChatHistoryArgs { book_id, chat_id }): Parameters<GetChatHistoryArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let chats_list = chats::query_chats(&self.state.db, &book_id)
            .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;
        let filtered: Vec<chats::Chat> = match chat_id.as_deref() {
            Some(target) => chats_list.into_iter().filter(|c| c.id == target).collect(),
            None => chats_list,
        };

        let mut out: Vec<ChatWithMessages> = Vec::with_capacity(filtered.len());
        for chat in filtered {
            let messages = chats::query_chat_messages(&self.state.db, &chat.id)
                .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;
            out.push(ChatWithMessages { chat, messages });
        }

        Ok(CallToolResult::success(vec![Content::json(&out)?]))
    }
}
