#![cfg(all(debug_assertions, target_os = "macos"))]

use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Command, Stdio};

use rusqlite::params;
use tempfile::TempDir;

fn mcp_binary() -> PathBuf {
    PathBuf::from(env!("CARGO_BIN_EXE_quill-mcp"))
}

fn seed_db(home: &std::path::Path) -> rusqlite::Connection {
    let app_data = quill_core::paths::macos_app_data_dir(home, true);
    std::fs::create_dir_all(&app_data).expect("mkdir app_data");

    let _db = quill_core::db::Db::init(&app_data).expect("init db");

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

fn read_line(reader: &mut BufReader<std::process::ChildStdout>) -> String {
    let mut line = String::new();
    match reader.read_line(&mut line) {
        Ok(0) => panic!("EOF before line"),
        Ok(_) => line,
        Err(e) => panic!("read_line: {e}"),
    }
}

fn run_mcp_session(args: &[&str]) {
    let home = TempDir::new().unwrap();
    let _seeded = seed_db(home.path());

    let binary = mcp_binary();
    assert!(binary.exists(), "quill-mcp binary not built at {}", binary.display());

    let mut child = Command::new(&binary)
        .args(args)
        .env("HOME", home.path())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn quill-mcp");

    let mut stdin = child.stdin.take().expect("stdin");
    let mut reader = BufReader::new(child.stdout.take().expect("stdout"));

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
    drop(stdin);

    let init_line = read_line(&mut reader);
    let init_resp: serde_json::Value =
        serde_json::from_str(&init_line).expect("parse initialize response");
    assert_eq!(init_resp["id"], serde_json::json!(1));
    assert_eq!(init_resp["result"]["serverInfo"]["name"], "quill");
    assert!(init_resp["result"]["capabilities"]["tools"].is_object());

    let list_line = read_line(&mut reader);
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
        "get_chat_history",
        "add_book",
        "update_book",
        "delete_book",
        "create_collection",
        "rename_collection",
        "delete_collection",
        "add_book_to_collection",
        "remove_book_from_collection",
    ]
    .iter()
    .copied()
    .collect();
    assert_eq!(names, expected, "tool registry diverged from spec");

    let call_line = read_line(&mut reader);
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
    assert!(status.success(), "quill-mcp exited with {status:?}");
}

#[test]
fn quill_mcp_initialize_lists_tools_and_calls_get_collections() {
    run_mcp_session(&["mcp"]);
}

#[test]
fn quill_mcp_accepts_no_subcommand_argument() {
    run_mcp_session(&[]);
}

#[test]
fn quill_mcp_errors_clearly_when_db_missing() {
    let home = TempDir::new().unwrap();
    let binary = mcp_binary();
    assert!(binary.exists(), "quill-mcp binary not built at {}", binary.display());

    let out = Command::new(&binary)
        .arg("mcp")
        .env("HOME", home.path())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .expect("run quill-mcp");

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
