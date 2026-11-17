use std::path::Path;

use crate::db::Db;
use crate::mcp::{self, McpState};
use crate::sync::device::DeviceIdentity;
use crate::sync::writer::SyncWriter;
use crate::{icloud, paths, sync};

/// Entry point for the `quill-mcp` stdio binary (and legacy `quill mcp`).
/// Opens the SQLite materialized view and serves the MCP protocol over
/// stdin/stdout until the client disconnects.
///
/// When `mcp_write_enabled` is `"true"` in the settings table, the DB
/// is opened read-write and a `SyncWriter` is constructed so write
/// tools can mutate the library. Otherwise the DB stays read-only.
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

    // Resolve data_dir the same way the app does: if the user has migrated
    // to iCloud sync, blobs (books/, covers/) live under the ubiquity
    // container, not the local app-data dir.
    let data_dir = if sync::migration::is_sync_enabled(&local_dir) {
        sync::migration::recorded_data_dir(&local_dir)
            .or_else(icloud::icloud_data_dir)
            .unwrap_or_else(|| local_dir.clone())
    } else {
        local_dir.clone()
    };

    let (db, sync) = if write_enabled {
        let db = match Db::open_readwrite(&db_path) {
            Ok(mut db) => {
                db.set_data_dir(&data_dir);
                db
            }
            Err(e) => {
                eprintln!("quill mcp: failed to open (rw) {}: {e}", db_path.display());
                std::process::exit(1);
            }
        };
        let device = DeviceIdentity::load_or_create(&local_dir)
            .expect("failed to load device identity");
        let sw = SyncWriter::new(device.device_uuid);
        if sync::migration::is_sync_enabled(&local_dir) {
            sw.set_should_queue(true);
            sw.spawn_cover_writer();
        }
        (db, Some(sw))
    } else {
        let db = match Db::open_readonly(&db_path) {
            Ok(mut db) => {
                db.set_data_dir(&data_dir);
                db
            }
            Err(e) => {
                eprintln!("quill mcp: failed to open {}: {e}", db_path.display());
                std::process::exit(1);
            }
        };
        (db, None)
    };

    let state = McpState::new(db, sync, Some(&local_dir));

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
