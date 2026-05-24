//! MCP client integration commands.
//!
//! Quill's MCP server runs as `quill mcp` over stdio (see
//! `src-tauri/src/mcp/server.rs`). For an AI client to use it, the
//! client needs an entry in its config file pointing at the Quill
//! binary. These commands write/remove that entry on the user's
//! behalf when they flip the per-client toggle in the settings UI,
//! and inspect the files so the UI can render the current state.
//!
//! Supported clients:
//!   - Claude Code CLI — `~/.claude.json` (JSON, top-level
//!     `mcpServers.quill`).
//!   - Codex CLI — `~/.codex/config.toml` (TOML, top-level
//!     `[mcp_servers.quill]`).
//!
//! Writes are non-destructive: we read the file, mutate just our
//! `quill` entry, and write it back. Other clients in the same file
//! (or other top-level config) are preserved. If a file is malformed,
//! the command errors out rather than overwriting it.
//!
//! The file-IO helpers are split into `_at(path, …)` variants that
//! take an explicit path; the public Tauri commands resolve `$HOME`
//! and delegate. Tests target the `_at` helpers so they can use a
//! TempDir without poisoning the developer's real config files.

use std::path::{Path, PathBuf};

use rusqlite::params;
use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::State;

use crate::db::Db;
use crate::error::{AppError, AppResult};

/// Snapshot returned to the settings UI. `binary_path` is the absolute
/// path of *this* Quill binary — `current_exe()` at runtime — so the
/// snippet always points at the build the user is actually running.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct McpIntegrationStatus {
    pub claude_code: bool,
    pub codex: bool,
    pub write_enabled: bool,
    pub binary_path: String,
}

/// Which client we're toggling. Kept as a string in the Tauri command
/// signature so the frontend doesn't need to know an enum mapping;
/// parsed into this enum internally.
enum Client {
    ClaudeCode,
    Codex,
}

impl Client {
    fn parse(s: &str) -> AppResult<Self> {
        match s {
            "claude_code" => Ok(Self::ClaudeCode),
            "codex" => Ok(Self::Codex),
            other => Err(AppError::Other(format!(
                "unknown MCP client: {other:?} (expected claude_code or codex)"
            ))),
        }
    }
}

fn current_binary_path() -> AppResult<PathBuf> {
    std::env::current_exe().map_err(|e| AppError::Other(format!("resolve current_exe: {e}")))
}

fn home_dir() -> AppResult<PathBuf> {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .ok_or_else(|| AppError::Other("HOME env var not set".to_string()))
}

// --- Claude Code (~/.claude.json) -----------------------------------

fn claude_code_path() -> AppResult<PathBuf> {
    Ok(home_dir()?.join(".claude.json"))
}

/// Inner: takes the explicit config path. Returns `true` iff
/// `mcpServers.quill` exists.
pub(crate) fn claude_code_is_enabled_at(path: &Path) -> AppResult<bool> {
    if !path.exists() {
        return Ok(false);
    }
    let raw = std::fs::read_to_string(path)
        .map_err(|e| AppError::Other(format!("read {}: {e}", path.display())))?;
    if raw.trim().is_empty() {
        return Ok(false);
    }
    let val: serde_json::Value = serde_json::from_str(&raw)
        .map_err(|e| AppError::Other(format!("parse {}: {e}", path.display())))?;
    Ok(val
        .get("mcpServers")
        .and_then(|m| m.get("quill"))
        .is_some())
}

/// Inner: takes the explicit config path. Sibling entries under
/// `mcpServers` and unrelated top-level keys are preserved.
pub(crate) fn claude_code_write_at(
    path: &Path,
    enabled: bool,
    binary_path: &str,
) -> AppResult<()> {
    let mut val: serde_json::Value = if path.exists() {
        let raw = std::fs::read_to_string(path)
            .map_err(|e| AppError::Other(format!("read {}: {e}", path.display())))?;
        if raw.trim().is_empty() {
            json!({})
        } else {
            serde_json::from_str(&raw)
                .map_err(|e| AppError::Other(format!("parse {}: {e}", path.display())))?
        }
    } else {
        json!({})
    };

    let obj = val.as_object_mut().ok_or_else(|| {
        AppError::Other(format!(
            "{} is not a JSON object at top level",
            path.display()
        ))
    })?;

    let servers = obj
        .entry("mcpServers")
        .or_insert_with(|| json!({}))
        .as_object_mut()
        .ok_or_else(|| {
            AppError::Other(format!(
                "{}::mcpServers is not a JSON object",
                path.display()
            ))
        })?;

    if enabled {
        servers.insert(
            "quill".to_string(),
            json!({ "command": binary_path, "args": ["mcp"] }),
        );
    } else {
        servers.remove("quill");
    }

    let mut out = serde_json::to_string_pretty(&val).map_err(|e| {
        AppError::Other(format!("serialize {}: {e}", path.display()))
    })?;
    out.push('\n');
    std::fs::write(path, out)
        .map_err(|e| AppError::Other(format!("write {}: {e}", path.display())))?;
    Ok(())
}

// --- Codex (~/.codex/config.toml) -----------------------------------

fn codex_path() -> AppResult<PathBuf> {
    Ok(home_dir()?.join(".codex").join("config.toml"))
}

pub(crate) fn codex_is_enabled_at(path: &Path) -> AppResult<bool> {
    if !path.exists() {
        return Ok(false);
    }
    let raw = std::fs::read_to_string(path)
        .map_err(|e| AppError::Other(format!("read {}: {e}", path.display())))?;
    let doc: toml_edit::DocumentMut = raw
        .parse()
        .map_err(|e| AppError::Other(format!("parse {}: {e}", path.display())))?;
    Ok(doc
        .get("mcp_servers")
        .and_then(|v| v.as_table())
        .and_then(|t| t.get("quill"))
        .is_some())
}

pub(crate) fn codex_write_at(
    path: &Path,
    enabled: bool,
    binary_path: &str,
) -> AppResult<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| AppError::Other(format!("mkdir {}: {e}", parent.display())))?;
    }

    let mut doc: toml_edit::DocumentMut = if path.exists() {
        let raw = std::fs::read_to_string(path)
            .map_err(|e| AppError::Other(format!("read {}: {e}", path.display())))?;
        raw.parse()
            .map_err(|e| AppError::Other(format!("parse {}: {e}", path.display())))?
    } else {
        toml_edit::DocumentMut::new()
    };

    if enabled {
        if !doc.contains_table("mcp_servers") {
            doc["mcp_servers"] = toml_edit::Item::Table(toml_edit::Table::new());
        }
        let servers = doc["mcp_servers"]
            .as_table_mut()
            .ok_or_else(|| AppError::Other("mcp_servers is not a table".to_string()))?;

        let mut entry = toml_edit::Table::new();
        entry["command"] = toml_edit::value(binary_path);
        let mut args = toml_edit::Array::new();
        args.push("mcp");
        entry["args"] = toml_edit::value(args);
        servers["quill"] = toml_edit::Item::Table(entry);
    } else if let Some(servers) = doc.get_mut("mcp_servers").and_then(|v| v.as_table_mut()) {
        servers.remove("quill");
        // Leave an empty `[mcp_servers]` table behind rather than
        // deleting it — preserves the user's section ordering if they
        // re-enable later.
    }

    std::fs::write(path, doc.to_string())
        .map_err(|e| AppError::Other(format!("write {}: {e}", path.display())))?;
    Ok(())
}

// --- Tauri commands -------------------------------------------------

#[tauri::command]
pub fn mcp_integration_status(db: State<'_, Db>) -> AppResult<McpIntegrationStatus> {
    let claude_code = claude_code_path()
        .and_then(|p| claude_code_is_enabled_at(&p))
        .unwrap_or(false);
    let codex = codex_path()
        .and_then(|p| codex_is_enabled_at(&p))
        .unwrap_or(false);
    let write_enabled = {
        let conn = db.conn.lock().map_err(|e| AppError::Other(e.to_string()))?;
        conn.query_row(
            "SELECT value FROM settings WHERE key = 'mcp_write_enabled'",
            [],
            |row| row.get::<_, String>(0),
        )
        .map(|v| v == "true")
        .unwrap_or(false)
    };
    Ok(McpIntegrationStatus {
        claude_code,
        codex,
        write_enabled,
        binary_path: current_binary_path()?.to_string_lossy().into_owned(),
    })
}

#[tauri::command]
pub fn mcp_set_integration(client: String, enabled: bool) -> AppResult<()> {
    let bin = current_binary_path()?.to_string_lossy().into_owned();
    match Client::parse(&client)? {
        Client::ClaudeCode => claude_code_write_at(&claude_code_path()?, enabled, &bin),
        Client::Codex => codex_write_at(&codex_path()?, enabled, &bin),
    }
}

#[tauri::command]
pub fn mcp_set_write_access(enabled: bool, db: State<'_, Db>) -> AppResult<()> {
    let conn = db.conn.lock().map_err(|e| AppError::Other(e.to_string()))?;
    conn.execute(
        "INSERT INTO settings (key, value) VALUES ('mcp_write_enabled', ?1)
         ON CONFLICT(key) DO UPDATE SET value = ?1",
        params![if enabled { "true" } else { "false" }],
    )?;
    Ok(())
}

#[tauri::command]
pub fn mcp_config_snippet() -> AppResult<String> {
    let bin = current_binary_path()?.to_string_lossy().into_owned();
    let snippet = json!({
        "mcpServers": {
            "quill": { "command": bin, "args": ["mcp"] }
        }
    });
    serde_json::to_string_pretty(&snippet)
        .map_err(|e| AppError::Other(format!("serialize snippet: {e}")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    // --- Claude Code -----------------------------------------------

    #[test]
    fn claude_code_status_false_when_file_missing() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join(".claude.json");
        assert!(!claude_code_is_enabled_at(&path).unwrap());
    }

    #[test]
    fn claude_code_status_false_when_empty_file() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join(".claude.json");
        std::fs::write(&path, "").unwrap();
        assert!(!claude_code_is_enabled_at(&path).unwrap());
    }

    #[test]
    fn claude_code_write_creates_file_with_just_quill_entry() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join(".claude.json");
        claude_code_write_at(&path, true, "/test/quill").unwrap();

        let v: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(v["mcpServers"]["quill"]["command"], json!("/test/quill"));
        assert_eq!(v["mcpServers"]["quill"]["args"], json!(["mcp"]));
        assert!(claude_code_is_enabled_at(&path).unwrap());
    }

    #[test]
    fn claude_code_write_preserves_other_servers_and_top_level_keys() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join(".claude.json");
        std::fs::write(
            &path,
            r#"{"mcpServers":{"github":{"command":"gh-mcp","args":[]}},"theme":"dark"}"#,
        )
        .unwrap();

        claude_code_write_at(&path, true, "/test/quill").unwrap();
        let after_enable: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(after_enable["mcpServers"]["quill"]["command"], json!("/test/quill"));
        assert_eq!(after_enable["mcpServers"]["github"]["command"], json!("gh-mcp"));
        assert_eq!(after_enable["theme"], json!("dark"));

        claude_code_write_at(&path, false, "/test/quill").unwrap();
        let after_disable: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert!(after_disable["mcpServers"].get("quill").is_none());
        assert_eq!(after_disable["mcpServers"]["github"]["command"], json!("gh-mcp"));
        assert_eq!(after_disable["theme"], json!("dark"));
        assert!(!claude_code_is_enabled_at(&path).unwrap());
    }

    #[test]
    fn claude_code_write_errors_on_malformed_json_without_overwriting() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join(".claude.json");
        std::fs::write(&path, "{ not valid json").unwrap();

        let err = claude_code_write_at(&path, true, "/test/quill").unwrap_err();
        assert!(err.to_string().contains("parse"));
        // File untouched.
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "{ not valid json");
    }

    // --- Codex ------------------------------------------------------

    #[test]
    fn codex_status_false_when_file_missing() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("config.toml");
        assert!(!codex_is_enabled_at(&path).unwrap());
    }

    #[test]
    fn codex_write_creates_dir_and_file_when_absent() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join(".codex").join("config.toml");
        codex_write_at(&path, true, "/test/quill").unwrap();

        assert!(path.exists());
        let doc: toml_edit::DocumentMut =
            std::fs::read_to_string(&path).unwrap().parse().unwrap();
        assert_eq!(
            doc["mcp_servers"]["quill"]["command"].as_str(),
            Some("/test/quill")
        );
        assert!(codex_is_enabled_at(&path).unwrap());
    }

    #[test]
    fn codex_write_preserves_other_tables_and_top_level_keys() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("config.toml");
        std::fs::write(
            &path,
            "model = \"gpt-5\"\n\n[mcp_servers.github]\ncommand = \"gh-mcp\"\nargs = []\n",
        )
        .unwrap();

        codex_write_at(&path, true, "/test/quill").unwrap();
        let after: toml_edit::DocumentMut =
            std::fs::read_to_string(&path).unwrap().parse().unwrap();
        assert_eq!(after["model"].as_str(), Some("gpt-5"));
        assert_eq!(after["mcp_servers"]["github"]["command"].as_str(), Some("gh-mcp"));
        assert_eq!(after["mcp_servers"]["quill"]["command"].as_str(), Some("/test/quill"));

        codex_write_at(&path, false, "/test/quill").unwrap();
        let after2: toml_edit::DocumentMut =
            std::fs::read_to_string(&path).unwrap().parse().unwrap();
        assert!(after2["mcp_servers"].get("quill").is_none());
        assert_eq!(after2["mcp_servers"]["github"]["command"].as_str(), Some("gh-mcp"));
        assert_eq!(after2["model"].as_str(), Some("gpt-5"));
    }

    #[test]
    fn codex_write_errors_on_malformed_toml_without_overwriting() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("config.toml");
        std::fs::write(&path, "[unclosed-table").unwrap();

        let err = codex_write_at(&path, true, "/test/quill").unwrap_err();
        assert!(err.to_string().contains("parse"));
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "[unclosed-table");
    }

    #[test]
    fn client_parse_rejects_unknown() {
        assert!(matches!(Client::parse("claude_code"), Ok(Client::ClaudeCode)));
        assert!(matches!(Client::parse("codex"), Ok(Client::Codex)));
        assert!(Client::parse("cursor").is_err());
    }
}
