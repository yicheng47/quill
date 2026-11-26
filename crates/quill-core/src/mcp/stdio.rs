use std::path::Path;

use crate::db::Db;
use crate::mcp::{self, McpState};
use crate::paths;

/// Entry point for the `quill-mcp` stdio binary (and legacy `quill mcp`).
/// Opens the local SQLite library and serves the MCP protocol over
/// stdin/stdout until the client disconnects.
///
/// When `mcp_write_enabled` is `"true"` in the settings table, the DB
/// is opened read-write so write tools can mutate the library. Otherwise
/// the DB stays read-only.
///
/// Runs outside any shell runtime — stderr is reserved for diagnostics so
/// it does not pollute the MCP wire on stdout.
pub fn mcp_stdio_main() {
    let local_dir = paths::resolve_app_data_dir(cfg!(debug_assertions));
    let db_path = local_dir.join("quill.db");

    if !db_path.exists() {
        eprintln!(
            "quill mcp: no library found at {} — launch the Quill app at least once to initialize it.",
            db_path.display()
        );
        std::process::exit(1);
    }

    let write_enabled = is_mcp_write_enabled(&db_path);

    let db = if write_enabled {
        match Db::open_readwrite(&db_path) {
            Ok(db) => db,
            Err(e) => {
                eprintln!("quill mcp: failed to open (rw) {}: {e}", db_path.display());
                std::process::exit(1);
            }
        }
    } else {
        match Db::open_readonly(&db_path) {
            Ok(db) => db,
            Err(e) => {
                eprintln!("quill mcp: failed to open {}: {e}", db_path.display());
                std::process::exit(1);
            }
        }
    };

    let state = McpState::new(db, write_enabled, Some(&local_dir));

    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio runtime");

    if let Err(e) = runtime.block_on(mcp::server::serve_stdio(state)) {
        eprintln!("quill mcp: serve error: {e}");
        std::process::exit(1);
    }
}

fn is_mcp_write_enabled(db_path: &Path) -> bool {
    let Ok(conn) = rusqlite::Connection::open_with_flags(
        db_path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    ) else {
        return false;
    };
    conn.query_row(
        "SELECT value FROM settings WHERE key = 'mcp_write_enabled'",
        [],
        |row| row.get::<_, String>(0),
    )
    .map(|v| v == "true")
    .unwrap_or(false)
}
