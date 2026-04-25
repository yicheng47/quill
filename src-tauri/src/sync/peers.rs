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
use uuid::Uuid;

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

/// Remove a peer device from the shared folder: deletes its log,
/// snapshot, and finally its manifest. Used by the settings UI's
/// per-device trash button to clean up orphaned entries (uninstalled
/// apps, prior installs after a reinstall).
///
/// Refuses to touch the caller's own UUID — early return, not an
/// error. Mirrors iOS's `Peers.deletePeer` guard so a stale UUID can't
/// accidentally wipe local state.
///
/// **UUID validation.** `device_uuid` is rejected unless it parses as
/// a real UUID. The shared folder is writable by every peer, so a
/// malformed or hostile manifest could otherwise inject path
/// components like `..` and steer this destructive command outside
/// the `<shared>/devices/` and `<shared>/logs/` namespace. Strict
/// parsing eliminates that whole class of input.
///
/// **Deletion order.** Log first, then snapshot, then manifest. Peer
/// discovery (`list_peers`) keys off the manifest, so as long as the
/// manifest still exists the user can retry from the UI after a
/// partial failure on the log/snapshot writes. Deleting the manifest
/// last means a mid-call I/O error never strands log/snapshot orphans
/// that the UI can no longer surface.
///
/// Idempotent: missing files are not an error. Any other I/O failure
/// stops at the first error and propagates — the UI surfaces it and
/// the user can retry.
pub fn delete_peer(shared_dir: &Path, device_uuid: &str, own_uuid: &str) -> AppResult<()> {
    if device_uuid == own_uuid {
        return Ok(());
    }
    if Uuid::parse_str(device_uuid).is_err() {
        return Err(AppError::Other(format!(
            "refusing to delete peer: {device_uuid:?} is not a valid UUID"
        )));
    }
    let log = shared_dir
        .join("logs")
        .join(format!("{device_uuid}.jsonl"));
    let snapshot = shared_dir
        .join("logs")
        .join(format!("{device_uuid}.snapshot.json"));
    let manifest = manifest_path(shared_dir, device_uuid);

    for path in [&log, &snapshot, &manifest] {
        match fs::remove_file(path) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(AppError::Io(e)),
        }
    }
    Ok(())
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
    out.sort_by_key(|p| std::cmp::Reverse(p.last_seen));
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

    /// Helper: drop a fake event log + snapshot for a given peer so
    /// `delete_peer` tests can assert cleanup of all three artifacts.
    fn seed_peer_log_and_snapshot(shared: &Path, uuid: &str) {
        let logs = shared.join("logs");
        fs::create_dir_all(&logs).unwrap();
        fs::write(logs.join(format!("{uuid}.jsonl")), b"{}\n").unwrap();
        fs::write(logs.join(format!("{uuid}.snapshot.json")), b"{}").unwrap();
    }

    // Real UUIDs for delete_peer tests — input is now validated as a
    // genuine UUID, so the older string keys ("peer-A", "self") would
    // be rejected by the path-traversal guard.
    const PEER_A: &str = "11111111-1111-4111-8111-111111111111";
    const PEER_B: &str = "22222222-2222-4222-8222-222222222222";
    const SELF: &str = "00000000-0000-4000-8000-000000000000";

    #[test]
    fn delete_peer_removes_manifest_log_and_snapshot() {
        let tmp = TempDir::new().unwrap();
        let shared = tmp.path();
        write_own_manifest(shared, PEER_A, "Mac A", "macos", "1.0.0", 1_000).unwrap();
        seed_peer_log_and_snapshot(shared, PEER_A);

        delete_peer(shared, PEER_A, SELF).unwrap();

        assert!(!manifest_path(shared, PEER_A).exists());
        assert!(!shared.join(format!("logs/{PEER_A}.jsonl")).exists());
        assert!(!shared.join(format!("logs/{PEER_A}.snapshot.json")).exists());
    }

    #[test]
    fn delete_peer_is_idempotent_on_missing_files() {
        let tmp = TempDir::new().unwrap();
        let shared = tmp.path();
        // No files exist yet — must not error.
        delete_peer(shared, PEER_A, SELF).unwrap();

        // Partial state: only a manifest exists.
        write_own_manifest(shared, PEER_A, "Ghost", "macos", "1.0.0", 1_000).unwrap();
        delete_peer(shared, PEER_A, SELF).unwrap();
        assert!(!manifest_path(shared, PEER_A).exists());

        // Re-deleting after everything is gone is still a no-op.
        delete_peer(shared, PEER_A, SELF).unwrap();
    }

    #[test]
    fn delete_peer_refuses_self_uuid() {
        let tmp = TempDir::new().unwrap();
        let shared = tmp.path();
        write_own_manifest(shared, SELF, "Self", "macos", "1.0.0", 1_000).unwrap();
        seed_peer_log_and_snapshot(shared, SELF);

        delete_peer(shared, SELF, SELF).unwrap();

        // All three self artifacts must remain — guard refuses the call.
        assert!(manifest_path(shared, SELF).exists());
        assert!(shared.join(format!("logs/{SELF}.jsonl")).exists());
        assert!(shared.join(format!("logs/{SELF}.snapshot.json")).exists());
    }

    #[test]
    fn list_peers_excludes_uuid_after_delete_peer() {
        let tmp = TempDir::new().unwrap();
        let shared = tmp.path();
        write_own_manifest(shared, PEER_A, "Mac A", "macos", "1.0.0", 2_000).unwrap();
        write_own_manifest(shared, PEER_B, "Mac B", "macos", "1.0.0", 3_000).unwrap();

        delete_peer(shared, PEER_A, SELF).unwrap();

        let peers = list_peers(shared, SELF).unwrap();
        assert_eq!(peers.len(), 1);
        assert_eq!(peers[0].device_uuid, PEER_B);
    }

    /// Path-traversal guard: a manifest under attacker control could
    /// claim `device_uuid = "../../etc/passwd"` (or similar). The
    /// command must refuse before constructing any paths so a
    /// malformed shared folder cannot steer file deletion outside
    /// `<shared>/devices/` and `<shared>/logs/`.
    #[test]
    fn delete_peer_rejects_path_traversal_input() {
        let tmp = TempDir::new().unwrap();
        let shared = tmp.path().join("shared");
        let outside = tmp.path().join("victim.txt");
        fs::create_dir_all(&shared).unwrap();
        fs::write(&outside, b"keep me").unwrap();

        // Whatever the attacker puts in `device_uuid`, the call must
        // error and the outside file must remain. Try several shapes.
        for evil in [
            "../victim",
            "../../etc/passwd",
            "..\\windows",
            "valid-looking-but-not-a-uuid",
            "",
        ] {
            let result = delete_peer(&shared, evil, SELF);
            assert!(
                result.is_err(),
                "delete_peer must reject non-UUID input {evil:?}",
            );
        }
        assert!(outside.exists(), "outside file must be untouched");
    }

    /// Deletion order: log + snapshot first, manifest last. This means
    /// a partial-failure mid-call leaves the manifest behind so the
    /// peer still appears in `list_peers` and the user can retry the
    /// trash button. The opposite order would orphan log/snapshot
    /// files no UI surface can target.
    ///
    /// We simulate "mid-call failure" by manually deleting only the
    /// log + snapshot, leaving the manifest, then verifying the peer
    /// is still listed and a follow-up `delete_peer` finishes the job.
    #[test]
    fn delete_peer_order_lets_user_retry_after_partial_failure() {
        let tmp = TempDir::new().unwrap();
        let shared = tmp.path();
        write_own_manifest(shared, PEER_A, "Mac A", "macos", "1.0.0", 1_000).unwrap();
        seed_peer_log_and_snapshot(shared, PEER_A);

        // Simulate a successful first attempt that took out log +
        // snapshot but somehow failed (or was interrupted) before the
        // manifest delete: peer must still be discoverable.
        fs::remove_file(shared.join(format!("logs/{PEER_A}.jsonl"))).unwrap();
        fs::remove_file(shared.join(format!("logs/{PEER_A}.snapshot.json"))).unwrap();
        let peers = list_peers(shared, SELF).unwrap();
        assert_eq!(
            peers.len(),
            1,
            "manifest must outlive the log/snapshot so the UI can retry",
        );

        // Retry from the UI completes cleanup.
        delete_peer(shared, PEER_A, SELF).unwrap();
        assert!(list_peers(shared, SELF).unwrap().is_empty());
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
