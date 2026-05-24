//! End-to-end integration test for the `quill mcp` subcommand.
//!
//! Spawns the actual built binary as a subprocess, drives the MCP
//! handshake + a couple of tool calls over stdin/stdout, and asserts
//! the responses. Verifies the wire-level pieces the in-process
//! handler unit tests (`mcp/server.rs::tests`) can't cover:
//!
//!   - `main.rs` argv dispatch (`quill mcp` → `mcp_stdio_main`)
//!   - `resolve_app_data_dir()` actually finds the DB on disk
//!   - `Db::open_readonly` works against a WAL DB the test seeded
//!   - rmcp's stdio framing produces line-delimited JSON-RPC
//!
//! Runs only in debug builds because the binary path resolution
//! assumes `target/debug/quill` — and only on macOS, since
//! `resolve_app_data_dir` uses platform-specific layout that's
//! tedious to fake in CI for the other targets.

#![cfg(all(debug_assertions, target_os = "macos"))]

use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::Duration;

use rusqlite::params;
use tempfile::TempDir;

/// Locate `target/debug/quill`. `current_exe()` for a `cargo test`
/// integration test points at the test binary under
/// `target/debug/deps/`; we walk up to `target/debug/` and append the
/// binary name.
fn quill_binary() -> PathBuf {
    let exe = std::env::current_exe().expect("current_exe");
    let mut dir = exe.parent().expect("deps dir").to_path_buf();
    if dir.ends_with("deps") {
        dir.pop();
    }
    dir.join("quill")
}

/// Seed a fully-migrated DB at the path `mcp_stdio_main` expects,
/// given a fake `$HOME`. macOS-only path layout.
fn seed_db(home: &std::path::Path) -> rusqlite::Connection {
    // Mirrors `bundle_identifier_for_build()` for debug builds.
    let identifier = "com.wycstudios.quill-dev";
    let app_data = home.join("Library/Application Support").join(identifier);
    std::fs::create_dir_all(&app_data).expect("mkdir app_data");

    // Db::init runs all migrations + sets WAL mode + creates the file.
    let _db = quill_lib::db::Db::init(&app_data).expect("init db");

    // Reopen with a plain rusqlite connection to seed a row the test
    // can assert on. Reusing Db here would force public exposure of
    // its conn field; a fresh connection is simpler.
    let conn = rusqlite::Connection::open(app_data.join("quill.db")).expect("reopen");
    let now: i64 = 1_700_000_000_000;
    conn.execute(
        "INSERT INTO collections (id, name, sort_order, created_at, updated_at)
         VALUES ('c1','Integration Test Collection',0,?1,?1)",
        params![now],
    )
    .expect("seed row");
    conn
}

/// Read the next line from a BufReader. The `_timeout` arg is a
/// placeholder for a future per-line deadline if we ever need it;
/// today `child.wait()` provides the test's overall watchdog and
/// `cargo test` will kill the harness after its own timeout.
fn read_line_with_timeout(
    reader: &mut BufReader<std::process::ChildStdout>,
    _timeout: Duration,
) -> String {
    let mut line = String::new();
    match reader.read_line(&mut line) {
        Ok(0) => panic!("EOF before line"),
        Ok(_) => line,
        Err(e) => panic!("read_line: {e}"),
    }
}

#[test]
fn quill_mcp_initialize_lists_tools_and_calls_get_collections() {
    let home = TempDir::new().unwrap();
    let _seeded = seed_db(home.path());

    let binary = quill_binary();
    assert!(
        binary.exists(),
        "quill binary not built at {} — `cargo build` first",
        binary.display()
    );

    let mut child = Command::new(&binary)
        .arg("mcp")
        .env("HOME", home.path())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn quill mcp");

    let mut stdin = child.stdin.take().expect("stdin");
    let mut reader = BufReader::new(child.stdout.take().expect("stdout"));

    // Drive the MCP session.
    writeln!(
        stdin,
        r#"{{"jsonrpc":"2.0","id":1,"method":"initialize","params":{{"protocolVersion":"2024-11-05","capabilities":{{}},"clientInfo":{{"name":"integration-test","version":"0"}}}}}}"#
    )
    .unwrap();
    writeln!(
        stdin,
        r#"{{"jsonrpc":"2.0","method":"notifications/initialized","params":{{}}}}"#
    )
    .unwrap();
    writeln!(
        stdin,
        r#"{{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{{}}}}"#
    )
    .unwrap();
    writeln!(
        stdin,
        r#"{{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{{"name":"get_collections","arguments":{{}}}}}}"#
    )
    .unwrap();
    drop(stdin); // EOF — let serve_stdio's `waiting()` resolve.

    let timeout = Duration::from_secs(10);

    let init_line = read_line_with_timeout(&mut reader, timeout);
    let init_resp: serde_json::Value =
        serde_json::from_str(&init_line).expect("parse initialize response");
    assert_eq!(init_resp["id"], serde_json::json!(1));
    assert_eq!(init_resp["result"]["serverInfo"]["name"], "quill");
    assert!(init_resp["result"]["capabilities"]["tools"].is_object());

    let list_line = read_line_with_timeout(&mut reader, timeout);
    let list_resp: serde_json::Value =
        serde_json::from_str(&list_line).expect("parse tools/list response");
    let tools = list_resp["result"]["tools"].as_array().expect("tools array");
    let names: std::collections::BTreeSet<&str> = tools
        .iter()
        .map(|t| t["name"].as_str().expect("tool name"))
        .collect();
    let expected: std::collections::BTreeSet<&str> = [
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
    .copied()
    .collect();
    assert_eq!(names, expected, "tool registry diverged from spec");

    let call_line = read_line_with_timeout(&mut reader, timeout);
    let call_resp: serde_json::Value =
        serde_json::from_str(&call_line).expect("parse tools/call response");
    assert_eq!(call_resp["id"], serde_json::json!(3));
    let body = call_resp["result"]["content"][0]["text"]
        .as_str()
        .expect("text content");
    let payload: serde_json::Value =
        serde_json::from_str(body).expect("parse collections payload");
    assert_eq!(payload[0]["name"], "Integration Test Collection");

    let status = child.wait().expect("wait child");
    assert!(status.success(), "quill mcp exited with {status:?}");
}

#[test]
fn quill_mcp_errors_clearly_when_db_missing() {
    let home = TempDir::new().unwrap();
    // No seed — quill.db absent under fake $HOME.

    let binary = quill_binary();
    assert!(binary.exists(), "quill binary not built at {}", binary.display());

    let out = Command::new(&binary)
        .arg("mcp")
        .env("HOME", home.path())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .expect("run quill mcp");

    assert!(!out.status.success(), "should exit non-zero when DB is missing");
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(
        stderr.contains("no library found"),
        "expected user-facing error on stderr, got: {stderr}"
    );
    assert!(
        out.stdout.is_empty(),
        "stdout must stay clean (it's the MCP wire); got: {}",
        String::from_utf8_lossy(&out.stdout)
    );
}
