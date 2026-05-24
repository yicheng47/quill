// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // `quill mcp` runs the MCP server over stdio for AI clients that
    // spawn it as a subprocess (Claude Code, Codex). Same binary, no
    // Tauri runtime — just opens the SQLite file read-only and speaks
    // MCP on stdin/stdout. Any other argv falls through to the normal
    // Tauri app launch.
    let mut args = std::env::args();
    let _exe = args.next();
    if args.next().as_deref() == Some("mcp") {
        quill_lib::mcp_stdio_main();
        return;
    }
    quill_lib::run()
}
