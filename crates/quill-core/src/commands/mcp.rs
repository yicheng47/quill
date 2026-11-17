//! MCP client integration commands.
//!
//! Quill's MCP server runs via the standalone `quill-mcp` binary over stdio
//! (see `crates/quill-core/src/mcp/server.rs`). For an AI client to use it, the
//! client needs an entry in its config file pointing at the Quill MCP
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

use crate::error::{AppError, AppResult};
use crate::host::Core;

/// Snapshot returned to the settings UI. `binary_path` is the absolute
/// path of the `quill-mcp` binary supplied via `BootConfig`.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct McpIntegrationStatus {
    pub claude_code: bool,
    pub codex: bool,
    pub write_enabled: bool,
    pub binary_path: String,
}

/// Which client we're toggling. Kept as a string in the command
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

fn home_dir() -> AppResult<PathBuf> {
    #[cfg(windows)]
    let home = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE"));
    #[cfg(not(windows))]
    let home = std::env::var_os("HOME");

    home.map(PathBuf::from)
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

// --- Packaged boot repair -------------------------------------------

fn normalize_slash_path(raw: &str) -> String {
    raw.trim().replace('\\', "/")
}

fn is_cargo_target_path(norm_lower: &str) -> bool {
    norm_lower.contains("/target/debug/")
        || norm_lower.contains("/target/release/")
        || norm_lower.contains("/target/aarch64-apple-darwin/")
        || norm_lower.contains("/target/x86_64-apple-darwin/")
        || norm_lower.contains("/target/x86_64-pc-windows-msvc/")
}

/// Returns true only when `existing_cmd` points at a legacy packaged Quill
/// binary (e.g. `Quill.app/...` on macOS or an installed `quill.exe` /
/// `Quill\resources\quill-mcp.exe` on Windows) that differs from the
/// running packaged `current_binary_path`. Dev cargo targets and foreign
/// executables return false so user customizations are never overwritten.
pub(crate) fn is_legacy_packaged_quill_command(
    existing_cmd: &str,
    current_binary_path: &str,
) -> bool {
    let existing_norm = normalize_slash_path(existing_cmd);
    let current_norm = normalize_slash_path(current_binary_path);
    if existing_norm.is_empty() {
        return false;
    }

    let existing_lower = existing_norm.to_ascii_lowercase();
    let current_lower = current_norm.to_ascii_lowercase();
    if existing_norm == current_norm
        || ((existing_lower.ends_with(".exe") || current_lower.ends_with(".exe"))
            && existing_lower == current_lower)
    {
        return false;
    }

    if is_cargo_target_path(&existing_lower) {
        return false;
    }

    if existing_lower.contains("/quill.app/") || existing_lower.starts_with("quill.app/") {
        return true;
    }

    existing_lower.ends_with("/quill.exe")
        || existing_lower == "quill.exe"
        || existing_lower.ends_with("/quill/resources/quill-mcp.exe")
}

pub(crate) fn claude_code_repair_at(path: &Path, binary_path: &str) -> AppResult<bool> {
    if !path.exists() {
        return Ok(false);
    }
    let raw = std::fs::read_to_string(path)
        .map_err(|e| AppError::Other(format!("read {}: {e}", path.display())))?;
    if raw.trim().is_empty() {
        return Ok(false);
    }
    let mut val: serde_json::Value = serde_json::from_str(&raw)
        .map_err(|e| AppError::Other(format!("parse {}: {e}", path.display())))?;

    let Some(quill) = val
        .get_mut("mcpServers")
        .and_then(|m| m.as_object_mut())
        .and_then(|s| s.get_mut("quill"))
        .and_then(|q| q.as_object_mut())
    else {
        return Ok(false);
    };

    let Some(existing_cmd) = quill.get("command").and_then(|c| c.as_str()) else {
        return Ok(false);
    };
    if !is_legacy_packaged_quill_command(existing_cmd, binary_path) {
        return Ok(false);
    }

    quill.insert("command".to_string(), json!(binary_path));
    quill.insert("args".to_string(), json!(["mcp"]));

    let mut out = serde_json::to_string_pretty(&val)
        .map_err(|e| AppError::Other(format!("serialize {}: {e}", path.display())))?;
    out.push('\n');
    std::fs::write(path, out)
        .map_err(|e| AppError::Other(format!("write {}: {e}", path.display())))?;
    Ok(true)
}

pub(crate) fn codex_repair_at(path: &Path, binary_path: &str) -> AppResult<bool> {
    if !path.exists() {
        return Ok(false);
    }
    let raw = std::fs::read_to_string(path)
        .map_err(|e| AppError::Other(format!("read {}: {e}", path.display())))?;
    if raw.trim().is_empty() {
        return Ok(false);
    }
    let mut doc: toml_edit::DocumentMut = raw
        .parse()
        .map_err(|e| AppError::Other(format!("parse {}: {e}", path.display())))?;

    let Some(quill) = doc
        .get_mut("mcp_servers")
        .and_then(|v| v.as_table_like_mut())
        .and_then(|t| t.get_mut("quill"))
        .and_then(|q| q.as_table_like_mut())
    else {
        return Ok(false);
    };

    let Some(existing_cmd) = quill.get("command").and_then(|c| c.as_str()) else {
        return Ok(false);
    };
    if !is_legacy_packaged_quill_command(existing_cmd, binary_path) {
        return Ok(false);
    }

    quill.insert("command", toml_edit::value(binary_path));
    let mut args = toml_edit::Array::new();
    args.push("mcp");
    quill.insert("args", toml_edit::value(args));

    std::fs::write(path, doc.to_string())
        .map_err(|e| AppError::Other(format!("write {}: {e}", path.display())))?;
    Ok(true)
}

pub(crate) fn repair_legacy_mcp_configs_with_paths(
    is_dev: bool,
    binary_path: &str,
    claude_path: Option<&Path>,
    codex_path: Option<&Path>,
) {
    if is_dev {
        return;
    }

    if let Some(path) = claude_path {
        match claude_code_repair_at(path, binary_path) {
            Ok(true) => log::info!("mcp: repaired legacy Claude Code config at {}", path.display()),
            Ok(false) => {}
            Err(e) => log::warn!(
                "mcp: skipped Claude Code config repair at {}: {e}",
                path.display()
            ),
        }
    }

    if let Some(path) = codex_path {
        match codex_repair_at(path, binary_path) {
            Ok(true) => log::info!("mcp: repaired legacy Codex config at {}", path.display()),
            Ok(false) => {}
            Err(e) => log::warn!(
                "mcp: skipped Codex config repair at {}: {e}",
                path.display()
            ),
        }
    }
}

/// Inspect `~/.claude.json` and `~/.codex/config.toml` on packaged boot and
/// rewrite legacy packaged Quill entries to the active `quill-mcp` binary.
pub(crate) fn repair_legacy_mcp_configs(is_dev: bool, mcp_binary_path: &Path) {
    if is_dev {
        return;
    }
    let binary = mcp_binary_path.to_string_lossy().into_owned();
    let claude = claude_code_path().ok();
    let codex = codex_path().ok();
    repair_legacy_mcp_configs_with_paths(is_dev, &binary, claude.as_deref(), codex.as_deref());
}

// --- Commands -------------------------------------------------------

pub fn mcp_integration_status(core: &Core) -> AppResult<McpIntegrationStatus> {
    let claude_code = claude_code_path()
        .and_then(|p| claude_code_is_enabled_at(&p))
        .unwrap_or(false);
    let codex = codex_path()
        .and_then(|p| codex_is_enabled_at(&p))
        .unwrap_or(false);
    let write_enabled = {
        let conn = core.db.reader();
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
        binary_path: core.mcp_binary_path.to_string_lossy().into_owned(),
    })
}

pub fn mcp_set_integration(core: &Core, client: String, enabled: bool) -> AppResult<()> {
    let bin = core.mcp_binary_path.to_string_lossy().into_owned();
    match Client::parse(&client)? {
        Client::ClaudeCode => claude_code_write_at(&claude_code_path()?, enabled, &bin),
        Client::Codex => codex_write_at(&codex_path()?, enabled, &bin),
    }
}

pub fn mcp_set_write_access(core: &Core, enabled: bool) -> AppResult<()> {
    let conn = core
        .db
        .conn
        .lock()
        .map_err(|e| AppError::Other(e.to_string()))?;
    conn.execute(
        "INSERT INTO settings (key, value) VALUES ('mcp_write_enabled', ?1)
         ON CONFLICT(key) DO UPDATE SET value = ?1",
        params![if enabled { "true" } else { "false" }],
    )?;
    Ok(())
}

pub fn mcp_config_snippet(core: &Core) -> AppResult<String> {
    let bin = core.mcp_binary_path.to_string_lossy().into_owned();
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

    // --- Boot repair ------------------------------------------------

    #[test]
    fn repair_rewrites_legacy_macos_entries_and_preserves_siblings() {
        let dir = TempDir::new().unwrap();
        let claude = dir.path().join(".claude.json");
        let codex = dir.path().join("config.toml");
        let new_bin = "/Applications/Quill.app/Contents/Resources/quill-mcp";

        std::fs::write(
            &claude,
            r#"{
  "theme": "dark",
  "mcpServers": {
    "github": { "command": "gh-mcp", "args": [] },
    "quill": { "command": "/Applications/Quill.app/Contents/MacOS/quill", "args": ["mcp"], "env": { "FOO": "1" } }
  }
}
"#,
        )
        .unwrap();
        std::fs::write(
            &codex,
            "model = \"gpt-5\"\n\n[mcp_servers.github]\ncommand = \"gh-mcp\"\nargs = []\n\n[mcp_servers.quill]\ncommand = \"/Users/alice/Applications/Quill.app/Contents/MacOS/quill\"\nargs = [\"mcp\"]\n",
        )
        .unwrap();

        repair_legacy_mcp_configs_with_paths(false, new_bin, Some(&claude), Some(&codex));

        let c_val: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&claude).unwrap()).unwrap();
        assert_eq!(c_val["theme"], json!("dark"));
        assert_eq!(c_val["mcpServers"]["github"]["command"], json!("gh-mcp"));
        assert_eq!(c_val["mcpServers"]["quill"]["command"], json!(new_bin));
        assert_eq!(c_val["mcpServers"]["quill"]["args"], json!(["mcp"]));
        assert_eq!(c_val["mcpServers"]["quill"]["env"]["FOO"], json!("1"));

        let t_doc: toml_edit::DocumentMut =
            std::fs::read_to_string(&codex).unwrap().parse().unwrap();
        assert_eq!(t_doc["model"].as_str(), Some("gpt-5"));
        assert_eq!(t_doc["mcp_servers"]["github"]["command"].as_str(), Some("gh-mcp"));
        assert_eq!(t_doc["mcp_servers"]["quill"]["command"].as_str(), Some(new_bin));
        assert_eq!(
            t_doc["mcp_servers"]["quill"]["args"]
                .as_array()
                .unwrap()
                .get(0)
                .and_then(|v| v.as_str()),
            Some("mcp")
        );
    }

    #[test]
    fn repair_rewrites_legacy_windows_entries() {
        let dir = TempDir::new().unwrap();
        let claude = dir.path().join(".claude.json");
        let codex = dir.path().join("config.toml");
        let new_bin = r"C:\Users\alice\AppData\Local\Programs\Quill\resources\quill-mcp.exe";

        std::fs::write(
            &claude,
            r#"{"mcpServers":{"quill":{"command":"C:\\Users\\alice\\AppData\\Local\\Quill\\quill.exe","args":["mcp"]}}}"#,
        )
        .unwrap();
        std::fs::write(
            &codex,
            "[mcp_servers.quill]\ncommand = 'C:\\Program Files\\Quill\\Quill.exe'\nargs = []\n",
        )
        .unwrap();

        repair_legacy_mcp_configs_with_paths(false, new_bin, Some(&claude), Some(&codex));

        let c_val: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&claude).unwrap()).unwrap();
        assert_eq!(c_val["mcpServers"]["quill"]["command"], json!(new_bin));
        assert_eq!(c_val["mcpServers"]["quill"]["args"], json!(["mcp"]));

        let t_doc: toml_edit::DocumentMut =
            std::fs::read_to_string(&codex).unwrap().parse().unwrap();
        assert_eq!(t_doc["mcp_servers"]["quill"]["command"].as_str(), Some(new_bin));
        assert_eq!(
            t_doc["mcp_servers"]["quill"]["args"]
                .as_array()
                .unwrap()
                .get(0)
                .and_then(|v| v.as_str()),
            Some("mcp")
        );
    }

    #[test]
    fn repair_leaves_absent_entries_untouched() {
        let dir = TempDir::new().unwrap();
        let missing_claude = dir.path().join("missing.claude.json");
        let missing_codex = dir.path().join("missing.toml");
        let no_entry_claude = dir.path().join("no-entry.claude.json");
        let no_entry_codex = dir.path().join("no-entry.toml");

        let claude_orig = "{\"theme\":\"light\"}\n";
        let codex_orig = "model = \"gpt-5\"\n";
        std::fs::write(&no_entry_claude, claude_orig).unwrap();
        std::fs::write(&no_entry_codex, codex_orig).unwrap();

        let new_bin = "/Applications/Quill.app/Contents/Resources/quill-mcp";
        repair_legacy_mcp_configs_with_paths(
            false,
            new_bin,
            Some(&missing_claude),
            Some(&missing_codex),
        );
        repair_legacy_mcp_configs_with_paths(
            false,
            new_bin,
            Some(&no_entry_claude),
            Some(&no_entry_codex),
        );

        assert!(!missing_claude.exists());
        assert!(!missing_codex.exists());
        assert_eq!(std::fs::read_to_string(&no_entry_claude).unwrap(), claude_orig);
        assert_eq!(std::fs::read_to_string(&no_entry_codex).unwrap(), codex_orig);
    }

    #[test]
    fn repair_leaves_current_and_foreign_entries_untouched() {
        let dir = TempDir::new().unwrap();
        let claude = dir.path().join(".claude.json");
        let codex = dir.path().join("config.toml");
        let new_bin = "/Applications/Quill.app/Contents/Resources/quill-mcp";

        let claude_current = format!(
            "{{\"mcpServers\":{{\"quill\":{{\"command\":\"{new_bin}\",\"args\":[\"mcp\"]}}}}}}  \n"
        );
        let codex_foreign =
            "# user comment preserved\n[mcp_servers.quill]\ncommand = \"/usr/local/bin/custom-quill-mcp\"\nargs = [\"--flag\"]\n";
        std::fs::write(&claude, &claude_current).unwrap();
        std::fs::write(&codex, codex_foreign).unwrap();

        repair_legacy_mcp_configs_with_paths(false, new_bin, Some(&claude), Some(&codex));
        assert_eq!(std::fs::read_to_string(&claude).unwrap(), claude_current);
        assert_eq!(std::fs::read_to_string(&codex).unwrap(), codex_foreign);

        // Also check foreign dev target and non-Quill app paths on Claude, and current Windows case-insensitivity on Codex.
        let claude_foreign_dev = "{\"mcpServers\":{\"quill\":{\"command\":\"/Users/dev/quill/target/debug/quill-mcp\",\"args\":[\"mcp\"]}}}\n";
        let claude_foreign_app = "{\"mcpServers\":{\"quill\":{\"command\":\"/Applications/Other.app/Contents/MacOS/quill\",\"args\":[\"mcp\"]}}}\n";
        let codex_win_current = "# keep comment\n[mcp_servers.quill]\ncommand = \"c:\\\\users\\\\alice\\\\appdata\\\\local\\\\programs\\\\quill\\\\resources\\\\quill-mcp.exe\"\nargs = [\"mcp\"]\n";

        std::fs::write(&claude, claude_foreign_dev).unwrap();
        repair_legacy_mcp_configs_with_paths(false, new_bin, Some(&claude), None);
        assert_eq!(std::fs::read_to_string(&claude).unwrap(), claude_foreign_dev);

        std::fs::write(&claude, claude_foreign_app).unwrap();
        repair_legacy_mcp_configs_with_paths(false, new_bin, Some(&claude), None);
        assert_eq!(std::fs::read_to_string(&claude).unwrap(), claude_foreign_app);

        std::fs::write(&codex, codex_win_current).unwrap();
        repair_legacy_mcp_configs_with_paths(
            false,
            r"C:\Users\alice\AppData\Local\Programs\Quill\resources\quill-mcp.exe",
            None,
            Some(&codex),
        );
        assert_eq!(std::fs::read_to_string(&codex).unwrap(), codex_win_current);
    }

    #[test]
    fn repair_leaves_malformed_configs_untouched() {
        let dir = TempDir::new().unwrap();
        let claude = dir.path().join(".claude.json");
        let codex = dir.path().join("config.toml");
        let new_bin = "/Applications/Quill.app/Contents/Resources/quill-mcp";

        std::fs::write(&claude, "{ malformed json").unwrap();
        std::fs::write(&codex, "[mcp_servers.quill").unwrap();

        assert!(claude_code_repair_at(&claude, new_bin).is_err());
        assert!(codex_repair_at(&codex, new_bin).is_err());
        repair_legacy_mcp_configs_with_paths(false, new_bin, Some(&claude), Some(&codex));

        assert_eq!(std::fs::read_to_string(&claude).unwrap(), "{ malformed json");
        assert_eq!(std::fs::read_to_string(&codex).unwrap(), "[mcp_servers.quill");
    }

    #[test]
    fn repair_skips_when_is_dev_is_true() {
        let dir = TempDir::new().unwrap();
        let claude = dir.path().join(".claude.json");
        let codex = dir.path().join("config.toml");

        let claude_orig = r#"{"mcpServers":{"quill":{"command":"/Applications/Quill.app/Contents/MacOS/quill","args":["mcp"]}}}"#;
        let codex_orig = "[mcp_servers.quill]\ncommand = \"/Applications/Quill.app/Contents/MacOS/quill\"\nargs = [\"mcp\"]\n";
        std::fs::write(&claude, claude_orig).unwrap();
        std::fs::write(&codex, codex_orig).unwrap();

        repair_legacy_mcp_configs_with_paths(
            true,
            "/Users/dev/quill/target/debug/quill-mcp",
            Some(&claude),
            Some(&codex),
        );

        assert_eq!(std::fs::read_to_string(&claude).unwrap(), claude_orig);
        assert_eq!(std::fs::read_to_string(&codex).unwrap(), codex_orig);
    }
}
