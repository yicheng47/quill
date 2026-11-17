use rmcp::ErrorData;
use rmcp::handler::server::wrapper::Parameters;
use rmcp::model::{CallToolResult, Content};
use rmcp::tool;
use rmcp::tool_router;
use schemars::JsonSchema;
use serde::Deserialize;

use crate::commands::collections;
use crate::mcp::server::QuillMcpHandler;
use crate::mcp::tools::library::require_sync;

#[derive(Debug, Deserialize, JsonSchema)]
pub struct CreateCollectionArgs {
    /// Name for the new collection.
    pub name: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct RenameCollectionArgs {
    /// Collection ID (UUID).
    pub id: String,
    /// New name.
    pub name: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct DeleteCollectionArgs {
    /// Collection ID (UUID). Books in the collection are NOT deleted.
    pub id: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct CollectionBookArgs {
    /// Collection ID (UUID).
    pub collection_id: String,
    /// Book ID (UUID).
    pub book_id: String,
}

#[tool_router(router = collections_write_router, vis = "pub(crate)")]
impl QuillMcpHandler {
    #[tool(description = "Create a new collection.")]
    pub async fn create_collection(
        &self,
        Parameters(CreateCollectionArgs { name }): Parameters<CreateCollectionArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let sync = require_sync(self)?;
        let collection = collections::do_create_collection(&name, &self.state.db, sync)
            .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;
        self.state.notify("collections", "created", &collection.id);
        Ok(CallToolResult::success(vec![Content::json(&collection)?]))
    }

    #[tool(description = "Rename an existing collection.")]
    pub async fn rename_collection(
        &self,
        Parameters(RenameCollectionArgs { id, name }): Parameters<RenameCollectionArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let sync = require_sync(self)?;
        collections::do_rename_collection(&id, &name, &self.state.db, sync)
            .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;
        self.state.notify("collections", "updated", &id);
        Ok(CallToolResult::success(vec![Content::text(format!(
            "Collection {id} renamed to \"{name}\"."
        ))]))
    }

    #[tool(
        description = "Delete a collection. Books in the collection are NOT deleted — only the collection grouping is removed."
    )]
    pub async fn delete_collection(
        &self,
        Parameters(DeleteCollectionArgs { id }): Parameters<DeleteCollectionArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let sync = require_sync(self)?;
        collections::do_delete_collection(&id, &self.state.db, sync)
            .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;
        self.state.notify("collections", "deleted", &id);
        Ok(CallToolResult::success(vec![Content::text(format!(
            "Collection {id} deleted."
        ))]))
    }

    #[tool(description = "Add a book to a collection.")]
    pub async fn add_book_to_collection(
        &self,
        Parameters(CollectionBookArgs {
            collection_id,
            book_id,
        }): Parameters<CollectionBookArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let sync = require_sync(self)?;
        collections::do_add_book_to_collection(&collection_id, &book_id, &self.state.db, sync)
            .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;
        self.state.notify("collections", "updated", &collection_id);
        Ok(CallToolResult::success(vec![Content::text(format!(
            "Book {book_id} added to collection {collection_id}."
        ))]))
    }

    #[tool(description = "Remove a book from a collection. The book itself is NOT deleted.")]
    pub async fn remove_book_from_collection(
        &self,
        Parameters(CollectionBookArgs {
            collection_id,
            book_id,
        }): Parameters<CollectionBookArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let sync = require_sync(self)?;
        collections::do_remove_book_from_collection(
            &collection_id,
            &book_id,
            &self.state.db,
            sync,
        )
        .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;
        self.state.notify("collections", "updated", &collection_id);
        Ok(CallToolResult::success(vec![Content::text(format!(
            "Book {book_id} removed from collection {collection_id}."
        ))]))
    }
}
