//! MCP server handler + stdio entry point.
//!
//! This file owns:
//!   - `QuillMcpHandler` — the per-process MCP service. Carries
//!     `McpState` so tool methods (defined across `mcp/tools/*.rs` via
//!     `#[tool_router]` impl blocks) can read the DB.
//!   - `tool_router()` — aggregator merging every per-file router.
//!   - `ServerHandler` impl (annotated `#[tool_handler]`) which
//!     auto-generates `call_tool` / `list_tools` against the merged
//!     router.
//!   - `serve_stdio()` — drives the handler over `(stdin, stdout)` for
//!     the `quill mcp` subcommand. The Tauri app does NOT run an MCP
//!     server in-process; AI clients (Claude Code, Codex) launch this
//!     subprocess themselves.

use rmcp::handler::server::ServerHandler;
use rmcp::handler::server::router::tool::ToolRouter;
use rmcp::model::{Implementation, ProtocolVersion, ServerCapabilities, ServerInfo};
use rmcp::transport::io::stdio;
use rmcp::{ServiceExt, tool_handler};

use super::state::McpState;

#[derive(Clone)]
pub(crate) struct QuillMcpHandler {
    pub(crate) state: McpState,
}

impl QuillMcpHandler {
    pub(crate) fn new(state: McpState) -> Self {
        Self { state }
    }

    /// Aggregator merging every per-file router into one. The
    /// `#[tool_handler]` macro on the `ServerHandler` impl below invokes
    /// this on every `call_tool` / `list_tools`, so keep it cheap —
    /// only fixed `with_route` inserts, no I/O.
    ///
    /// New tool files must add a `r.merge(Self::<name>_router());` line
    /// here AND register themselves in `tools/mod.rs`'s forbidden-
    /// surfaces audit comment.
    pub(crate) fn tool_router() -> ToolRouter<Self> {
        let mut r = ToolRouter::new();
        r.merge(Self::library_router());
        r.merge(Self::highlights_router());
        r.merge(Self::bookmarks_router());
        r.merge(Self::vocab_router());
        r.merge(Self::translations_router());
        r.merge(Self::chats_router());
        r
    }
}

#[tool_handler]
impl ServerHandler for QuillMcpHandler {
    fn get_info(&self) -> ServerInfo {
        // `ServerInfo` and `Implementation` are both `#[non_exhaustive]`.
        // Use the public constructors / builder methods rather than
        // struct literals.
        let implementation =
            Implementation::new("quill", env!("CARGO_PKG_VERSION"));
        let capabilities = ServerCapabilities::builder().enable_tools().build();
        ServerInfo::new(capabilities)
            .with_protocol_version(ProtocolVersion::LATEST)
            .with_server_info(implementation)
            .with_instructions(
                "Quill MCP server. Read-only access to the local library, \
                 highlights, bookmarks, vocabulary, translations, and chat \
                 history. Write tools land in v1.1 behind opt-in per-tool \
                 toggles.",
            )
    }
}

/// Drive the handler over `(stdin, stdout)` until the client closes the
/// pipe (or sends a shutdown notification). Returns when the session
/// ends; the binary's `main` should exit afterward.
///
/// Called from `mcp_stdio_main()` in `lib.rs`; not used by the Tauri
/// app side.
pub(crate) async fn serve_stdio(state: McpState) -> Result<(), Box<dyn std::error::Error>> {
    let handler = QuillMcpHandler::new(state);
    let server = handler.serve(stdio()).await?;
    // `waiting` resolves when the peer disconnects or sends shutdown.
    let _quit_reason = server.waiting().await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    //! Unit tests for the `QuillMcpHandler` surface. We exercise tool
    //! methods directly against a seeded in-memory-on-disk SQLite via
    //! `Db::init` on a `TempDir`, asserting on the JSON payload each
    //! tool returns. The transport itself (stdin/stdout, rmcp's
    //! framing) is verified separately by the binary integration test
    //! in `tests/mcp_binary.rs`.
    use super::*;
    use crate::db::Db;
    use rmcp::handler::server::wrapper::Parameters;
    use rusqlite::params;
    use tempfile::TempDir;

    fn seeded() -> (TempDir, McpState) {
        let dir = TempDir::new().unwrap();
        let db = Db::init(dir.path()).unwrap();
        {
            let conn = db.conn.lock().unwrap();
            // One book + one collection + one bookmark + one highlight
            // + one vocab word + one chat + one message + one
            // translation. Enough breadth to verify each tool returns
            // the expected row shape.
            let now: i64 = 1_700_000_000_000;
            conn.execute(
                "INSERT INTO books (id, title, author, file_path, status, progress, created_at, updated_at)
                 VALUES ('b1','Test Title','Test Author','books/test.epub','reading',42,?1,?1)",
                params![now],
            ).unwrap();
            conn.execute(
                "INSERT INTO collections (id, name, sort_order, created_at, updated_at)
                 VALUES ('c1','Favorites',0,?1,?1)",
                params![now],
            ).unwrap();
            conn.execute(
                "INSERT INTO bookmarks (id, book_id, cfi, label, created_at, updated_at)
                 VALUES ('bm1','b1','epubcfi(/6/2!/4)','Ch1',?1,?1)",
                params![now],
            ).unwrap();
            conn.execute(
                "INSERT INTO highlights (id, book_id, cfi_range, color, note, text_content, created_at, updated_at)
                 VALUES ('h1','b1','epubcfi(/6/4!/2,/4)','yellow','my note','quoted passage',?1,?1)",
                params![now],
            ).unwrap();
            conn.execute(
                "INSERT INTO vocab_words (id, book_id, word, definition, context_sentence, cfi, mastery, review_count, next_review_at, created_at, updated_at)
                 VALUES ('v1','b1','ostensibly','outwardly appearing as such','He was ostensibly happy.','epubcfi(/6/4!/8)','learning',0,NULL,?1,?1)",
                params![now],
            ).unwrap();
            conn.execute(
                "INSERT INTO chats (id, book_id, title, model, pinned, metadata, created_at, updated_at)
                 VALUES ('ch1','b1','First chat','gpt-test',0,NULL,?1,?1)",
                params![now],
            ).unwrap();
            conn.execute(
                "INSERT INTO chat_messages (id, chat_id, role, content, context, metadata, created_at, updated_at)
                 VALUES ('m1','ch1','user','hello',NULL,NULL,?1,?1)",
                params![now],
            ).unwrap();
            conn.execute(
                "INSERT INTO translations (id, book_id, source_text, translated_text, target_language, cfi, created_at, updated_at)
                 VALUES ('t1','b1','hola','hello','en','epubcfi(/6/2!/2)',?1,?1)",
                params![now],
            ).unwrap();
        }
        (dir, McpState::new(db))
    }

    fn text_of(result: rmcp::model::CallToolResult) -> String {
        assert_eq!(result.is_error, Some(false), "tool returned is_error=true");
        let first = result
            .content
            .into_iter()
            .next()
            .expect("tool returned no content");
        match first.raw {
            rmcp::model::RawContent::Text(t) => t.text,
            other => panic!("expected text content, got {other:?}"),
        }
    }

    #[test]
    fn tool_router_registers_all_nine_tools() {
        let router = QuillMcpHandler::tool_router();
        let names: std::collections::BTreeSet<_> =
            router.list_all().into_iter().map(|t| t.name.to_string()).collect();
        let expected: std::collections::BTreeSet<_> = [
            "list_books",
            "get_book",
            "get_collections",
            "get_highlights",
            "get_bookmarks",
            "get_vocab_words",
            "get_vocab_stats",
            "get_translations",
            "get_chat_history",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        assert_eq!(names, expected, "tool registry diverged from spec");
    }

    #[tokio::test]
    async fn get_info_advertises_tools_capability() {
        let (_dir, state) = seeded();
        let handler = QuillMcpHandler::new(state);
        let info = handler.get_info();
        assert!(info.capabilities.tools.is_some(), "tools capability missing");
        assert_eq!(info.server_info.name, "quill");
    }

    #[tokio::test]
    async fn list_books_returns_seeded_book_without_available_field() {
        let (_dir, state) = seeded();
        let handler = QuillMcpHandler::new(state);
        let args = crate::mcp::tools::library::ListBooksArgs {
            filter: None,
            search: None,
        };
        let result = handler.list_books(Parameters(args)).await.unwrap();
        let body = text_of(result);
        let arr: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert_eq!(arr[0]["id"], serde_json::json!("b1"));
        assert_eq!(arr[0]["title"], serde_json::json!("Test Title"));
        assert_eq!(arr[0]["file_path"], serde_json::json!("books/test.epub"));
        assert!(
            arr[0].get("available").is_none(),
            "MCP response must not include `available` — see McpBook DTO"
        );
    }

    #[tokio::test]
    async fn get_book_returns_relative_paths_only() {
        let (_dir, state) = seeded();
        let handler = QuillMcpHandler::new(state);
        let args = crate::mcp::tools::library::GetBookArgs {
            book_id: "b1".to_string(),
        };
        let body = text_of(handler.get_book(Parameters(args)).await.unwrap());
        let v: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert_eq!(v["file_path"], serde_json::json!("books/test.epub"));
        assert!(
            !v["file_path"].as_str().unwrap().starts_with('/'),
            "file_path must be relative — leaks home dir layout if absolute"
        );
    }

    #[tokio::test]
    async fn get_collections_returns_book_count() {
        let (_dir, state) = seeded();
        let handler = QuillMcpHandler::new(state);
        let body = text_of(handler.get_collections().await.unwrap());
        let arr: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert_eq!(arr[0]["name"], serde_json::json!("Favorites"));
        assert_eq!(arr[0]["book_count"], serde_json::json!(0));
    }

    #[tokio::test]
    async fn get_highlights_includes_text_content() {
        let (_dir, state) = seeded();
        let handler = QuillMcpHandler::new(state);
        let args = crate::mcp::tools::highlights::GetHighlightsArgs {
            book_id: "b1".to_string(),
        };
        let body = text_of(handler.get_highlights(Parameters(args)).await.unwrap());
        let arr: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert_eq!(arr[0]["text_content"], serde_json::json!("quoted passage"));
        assert_eq!(arr[0]["note"], serde_json::json!("my note"));
    }

    #[tokio::test]
    async fn get_bookmarks_returns_label() {
        let (_dir, state) = seeded();
        let handler = QuillMcpHandler::new(state);
        let args = crate::mcp::tools::bookmarks::GetBookmarksArgs {
            book_id: "b1".to_string(),
        };
        let body = text_of(handler.get_bookmarks(Parameters(args)).await.unwrap());
        let arr: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert_eq!(arr[0]["label"], serde_json::json!("Ch1"));
    }

    #[tokio::test]
    async fn get_vocab_words_and_stats_align() {
        let (_dir, state) = seeded();
        let handler = QuillMcpHandler::new(state);
        let words_body = text_of(
            handler
                .get_vocab_words(Parameters(crate::mcp::tools::vocab::GetVocabWordsArgs {
                    book_id: "b1".to_string(),
                }))
                .await
                .unwrap(),
        );
        let words: serde_json::Value = serde_json::from_str(&words_body).unwrap();
        assert_eq!(words[0]["word"], serde_json::json!("ostensibly"));
        assert_eq!(words[0]["mastery"], serde_json::json!("learning"));

        let stats_body = text_of(handler.get_vocab_stats().await.unwrap());
        let stats: serde_json::Value = serde_json::from_str(&stats_body).unwrap();
        assert_eq!(stats["total"], serde_json::json!(1));
        assert_eq!(stats["learning_count"], serde_json::json!(1));
    }

    #[tokio::test]
    async fn get_translations_returns_seeded_row() {
        let (_dir, state) = seeded();
        let handler = QuillMcpHandler::new(state);
        let args = crate::mcp::tools::translations::GetTranslationsArgs { book_id: None };
        let body = text_of(handler.get_translations(Parameters(args)).await.unwrap());
        let arr: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert_eq!(arr[0]["source_text"], serde_json::json!("hola"));
        assert_eq!(arr[0]["target_language"], serde_json::json!("en"));
    }

    #[tokio::test]
    async fn get_chat_history_bundles_messages() {
        let (_dir, state) = seeded();
        let handler = QuillMcpHandler::new(state);
        let args = crate::mcp::tools::chats::GetChatHistoryArgs {
            book_id: "b1".to_string(),
            chat_id: None,
        };
        let body = text_of(handler.get_chat_history(Parameters(args)).await.unwrap());
        let arr: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert_eq!(arr[0]["title"], serde_json::json!("First chat"));
        assert_eq!(arr[0]["messages"][0]["content"], serde_json::json!("hello"));
    }
}
