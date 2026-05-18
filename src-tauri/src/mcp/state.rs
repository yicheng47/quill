use crate::db::Db;

/// Shared state handed to every MCP request handler.
///
/// `Db` is already cheaply `Clone` (its inner `Connection` and
/// `data_dir` live behind `Arc<Mutex<…>>`), so we do NOT wrap it in
/// another `Arc`. See `db.rs:31-43`. Phase 2 will add `SyncWriter`,
/// `AppHandle`, and the four `Arc<AtomicBool>` write-tool toggles
/// described in `docs/impls/30-mcp-server.md`.
#[derive(Clone)]
#[allow(dead_code)]
pub struct McpState {
    pub db: Db,
}

impl McpState {
    pub fn new(db: Db) -> Self {
        Self { db }
    }
}
