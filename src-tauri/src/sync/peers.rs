//! Peer manifest — the tiny shared file that lets devices discover each
//! other by name.
//!
//! Each device publishes a single JSON file at
//! `<shared>/devices/<device-uuid>.json` with `{ device_uuid, name,
//! platform, app_version, last_seen }`. The file is rewritten atomically
//! (temp + rename) on every `replay_engine.tick()` so peers see fresh
//! `last_seen` heartbeats without any event traffic.
//!
//! Why a separate file (and not a sync event or snapshot field):
//! - Peer discovery has to work for a brand-new device that hasn't
//!   produced any events yet.
//! - `last_seen` updates on every tick — encoding it as an event would
//!   be pure noise; rewriting one small file is cheap.
//! - Decouples peer metadata from the event-log/snapshot lifecycle, so
//!   compaction can't accidentally drop it.
//!
//! No `NSFileCoordinator` wrap on macOS for v1 — the file is small and
//! a torn read just means a peer is skipped for one tick (250–2000 ms),
//! after which the next read picks up the fresh write. No correctness
//! loss. We can layer the coordinator on later if we ever observe
//! production read failures here.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};

/// Subdirectory under `<shared>/` where peer manifests live.
const DEVICES_SUBDIR: &str = "devices";

/// Returned by `list_peers` to power the settings UI's "Other devices"
/// section. Mirrors the JSON file shape on disk.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Peer {
    pub device_uuid: String,
    pub name: String,
    pub platform: String,
    pub app_version: String,
    /// Unix millis when the peer last successfully ran a sync tick.
    pub last_seen: i64,
}

/// Compile-time platform tag. Matches the strings iOS ships in its
/// own manifest (`"ios"`) so the settings UI can render a consistent
/// icon set across operating systems.
pub fn current_platform() -> &'static str {
    if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(target_os = "windows") {
        "windows"
    } else if cfg!(target_os = "linux") {
        "linux"
    } else {
        "unknown"
    }
}

/// Best-effort device name from the OS hostname, stripped of the common
/// `.local` / `.lan` suffixes mDNS hangs on Mac and Linux boxes. Falls
/// back to `"Quill"` if the OS reports an empty hostname (rare; mostly
/// hardened sandboxes).
pub fn device_name() -> String {
    let raw = gethostname::gethostname().to_string_lossy().into_owned();
    let trimmed = raw
        .strip_suffix(".local")
        .or_else(|| raw.strip_suffix(".lan"))
        .unwrap_or(&raw)
        .trim();
    if trimmed.is_empty() {
        "Quill".to_string()
    } else {
        trimmed.to_string()
    }
}

/// Path to this device's own manifest under `<shared>/devices/`. Public
/// so `sync_disable` / `sync_revert_to_legacy` can delete it directly.
pub fn manifest_path(shared_dir: &Path, device_uuid: &str) -> PathBuf {
    shared_dir
        .join(DEVICES_SUBDIR)
        .join(format!("{device_uuid}.json"))
}

/// Write (or overwrite) this device's manifest. Stamps `last_seen =
/// now_ms`. Atomic via temp + rename; missing parent dirs are created.
pub fn write_own_manifest(
    shared_dir: &Path,
    device_uuid: &str,
    name: &str,
    platform: &str,
    app_version: &str,
    now_ms: i64,
) -> AppResult<()> {
    let dir = shared_dir.join(DEVICES_SUBDIR);
    fs::create_dir_all(&dir)?;

    let peer = Peer {
        device_uuid: device_uuid.to_string(),
        name: name.to_string(),
        platform: platform.to_string(),
        app_version: app_version.to_string(),
        last_seen: now_ms,
    };

    let path = dir.join(format!("{device_uuid}.json"));
    let tmp = path.with_extension("json.tmp");
    let json = serde_json::to_vec_pretty(&peer)
        .map_err(|e| AppError::Other(format!("peer manifest encode: {e}")))?;
    fs::write(&tmp, &json)?;
    fs::rename(&tmp, &path)?;
    Ok(())
}

/// Delete this device's manifest from `<shared>/devices/`. Safe no-op
/// when the file is already gone. Used by `sync_revert_to_legacy` so
/// other peers stop seeing this device after a clean revert.
pub fn delete_own_manifest(shared_dir: &Path, device_uuid: &str) -> AppResult<()> {
    let path = manifest_path(shared_dir, device_uuid);
    match fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(AppError::Io(e)),
    }
}

/// List every peer manifest under `<shared>/devices/` excluding our own
/// UUID. Parse failures are logged and skipped — discovery degrades
/// gracefully rather than failing the whole status call.
///
/// Missing `<shared>/devices/` directory returns an empty vec — happens
/// on a fresh shared folder before any device has enabled sync.
pub fn list_peers(shared_dir: &Path, own_uuid: &str) -> AppResult<Vec<Peer>> {
    let dir = shared_dir.join(DEVICES_SUBDIR);
    let entries = match fs::read_dir(&dir) {
        Ok(e) => e,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(AppError::Io(e)),
    };

    let mut out = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("json") {
            continue;
        }
        let bytes = match fs::read(&path) {
            Ok(b) => b,
            Err(e) => {
                eprintln!(
                    "sync: skipping unreadable peer manifest {}: {e}",
                    path.display()
                );
                continue;
            }
        };
        let peer: Peer = match serde_json::from_slice(&bytes) {
            Ok(p) => p,
            Err(e) => {
                eprintln!(
                    "sync: skipping malformed peer manifest {}: {e}",
                    path.display()
                );
                continue;
            }
        };
        if peer.device_uuid == own_uuid {
            continue;
        }
        out.push(peer);
    }
    // Stable ordering for the UI: most-recently-seen first.
    out.sort_by(|a, b| b.last_seen.cmp(&a.last_seen));
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn write_then_list_skips_own_uuid() {
        let tmp = TempDir::new().unwrap();
        let shared = tmp.path();
        write_own_manifest(shared, "self", "Self Mac", "macos", "0.10.0", 1_000).unwrap();
        write_own_manifest(shared, "peer-A", "Mac A", "macos", "0.10.0", 2_000).unwrap();
        write_own_manifest(shared, "peer-B", "Mac B", "macos", "0.10.0", 3_000).unwrap();

        let peers = list_peers(shared, "self").unwrap();
        assert_eq!(peers.len(), 2);
        assert!(peers.iter().all(|p| p.device_uuid != "self"));
    }

    #[test]
    fn list_orders_by_last_seen_descending() {
        let tmp = TempDir::new().unwrap();
        let shared = tmp.path();
        write_own_manifest(shared, "old", "Old", "macos", "0.10.0", 1_000).unwrap();
        write_own_manifest(shared, "new", "New", "macos", "0.10.0", 9_000).unwrap();
        write_own_manifest(shared, "mid", "Mid", "macos", "0.10.0", 5_000).unwrap();

        let peers = list_peers(shared, "self").unwrap();
        assert_eq!(peers[0].device_uuid, "new");
        assert_eq!(peers[1].device_uuid, "mid");
        assert_eq!(peers[2].device_uuid, "old");
    }

    #[test]
    fn missing_devices_dir_returns_empty_list() {
        let tmp = TempDir::new().unwrap();
        let peers = list_peers(tmp.path(), "self").unwrap();
        assert!(peers.is_empty());
    }

    #[test]
    fn malformed_manifest_is_skipped_not_fatal() {
        let tmp = TempDir::new().unwrap();
        let shared = tmp.path();
        write_own_manifest(shared, "good", "Good", "macos", "0.10.0", 1_000).unwrap();

        let bad_path = shared.join(DEVICES_SUBDIR).join("bad.json");
        fs::write(&bad_path, b"{not valid json").unwrap();

        let peers = list_peers(shared, "self").unwrap();
        assert_eq!(peers.len(), 1);
        assert_eq!(peers[0].device_uuid, "good");
    }

    #[test]
    fn rewrite_overwrites_in_place_with_new_last_seen() {
        let tmp = TempDir::new().unwrap();
        let shared = tmp.path();
        write_own_manifest(shared, "me", "Me", "macos", "0.10.0", 1_000).unwrap();
        write_own_manifest(shared, "me", "Me", "macos", "0.10.0", 5_000).unwrap();

        let peers = list_peers(shared, "other").unwrap();
        assert_eq!(peers.len(), 1);
        assert_eq!(peers[0].last_seen, 5_000);
    }

    #[test]
    fn delete_own_manifest_removes_file_and_is_idempotent() {
        let tmp = TempDir::new().unwrap();
        let shared = tmp.path();
        write_own_manifest(shared, "me", "Me", "macos", "0.10.0", 1_000).unwrap();
        assert!(manifest_path(shared, "me").exists());

        delete_own_manifest(shared, "me").unwrap();
        assert!(!manifest_path(shared, "me").exists());

        // Re-deleting is a no-op.
        delete_own_manifest(shared, "me").unwrap();
    }

    #[test]
    fn device_name_strips_local_suffix() {
        // Can't mock gethostname without a wrapper layer; just sanity-check
        // the strip helper doesn't choke on the platform's real value.
        let n = device_name();
        assert!(!n.is_empty());
        assert!(!n.ends_with(".local"));
        assert!(!n.ends_with(".lan"));
    }

    #[test]
    fn current_platform_matches_compile_target() {
        let p = current_platform();
        if cfg!(target_os = "macos") {
            assert_eq!(p, "macos");
        } else if cfg!(target_os = "windows") {
            assert_eq!(p, "windows");
        } else if cfg!(target_os = "linux") {
            assert_eq!(p, "linux");
        }
    }

    #[test]
    fn non_json_files_in_devices_dir_are_ignored() {
        let tmp = TempDir::new().unwrap();
        let shared = tmp.path();
        write_own_manifest(shared, "me", "Me", "macos", "0.10.0", 1_000).unwrap();

        // A `.DS_Store` or stray temp file shouldn't break listing.
        fs::write(shared.join(DEVICES_SUBDIR).join(".DS_Store"), b"").unwrap();
        fs::write(shared.join(DEVICES_SUBDIR).join("scratch.txt"), b"hi").unwrap();

        let peers = list_peers(shared, "other").unwrap();
        assert_eq!(peers.len(), 1);
    }
}
