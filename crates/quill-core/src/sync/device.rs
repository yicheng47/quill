//! Stable device identifier — persisted once per install in the local app
//! data dir. The UUID is the per-device log filename (`logs/<uuid>.jsonl`)
//! and the `device` field on every emitted event.

use std::fs;
use std::path::{Path, PathBuf};

use chrono::Utc;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::error::{AppError, AppResult};

const DEVICE_FILE: &str = "device.json";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DeviceIdentity {
    pub device_uuid: String,
    /// Unix millis when this identity was first created on this install.
    pub created_at: i64,
}

impl DeviceIdentity {
    /// Read `device.json` if it exists; otherwise mint a fresh identity and
    /// persist it atomically. Always returns the same identity for the life
    /// of an install — only deleting the file regenerates it (which effectively
    /// makes the machine a new peer as far as sync is concerned).
    pub fn load_or_create(local_dir: &Path) -> AppResult<Self> {
        let path = local_dir.join(DEVICE_FILE);
        if path.exists() {
            let bytes = fs::read(&path)?;
            let id: DeviceIdentity = serde_json::from_slice(&bytes)
                .map_err(|e| AppError::Other(format!("device.json parse: {e}")))?;
            return Ok(id);
        }

        let id = DeviceIdentity {
            device_uuid: Uuid::new_v4().to_string(),
            created_at: Utc::now().timestamp_millis(),
        };
        write_atomic(&path, &id)?;
        Ok(id)
    }

    pub fn path(local_dir: &Path) -> PathBuf {
        local_dir.join(DEVICE_FILE)
    }
}

fn write_atomic(path: &Path, id: &DeviceIdentity) -> AppResult<()> {
    let tmp = path.with_extension("json.tmp");
    let json = serde_json::to_vec_pretty(id)
        .map_err(|e| AppError::Other(format!("device.json encode: {e}")))?;
    fs::write(&tmp, &json)?;
    fs::rename(&tmp, path)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn mints_on_first_call() {
        let dir = TempDir::new().unwrap();
        let id = DeviceIdentity::load_or_create(dir.path()).unwrap();
        assert_eq!(id.device_uuid.len(), 36, "UUIDv4 has 36 chars");
        assert!(id.created_at > 0);
        assert!(DeviceIdentity::path(dir.path()).exists());
    }

    #[test]
    fn stable_across_calls() {
        let dir = TempDir::new().unwrap();
        let a = DeviceIdentity::load_or_create(dir.path()).unwrap();
        let b = DeviceIdentity::load_or_create(dir.path()).unwrap();
        assert_eq!(a, b);
    }

    #[test]
    fn survives_raw_file_read() {
        // What's on disk must parse back identically.
        let dir = TempDir::new().unwrap();
        let a = DeviceIdentity::load_or_create(dir.path()).unwrap();
        let raw = std::fs::read(DeviceIdentity::path(dir.path())).unwrap();
        let parsed: DeviceIdentity = serde_json::from_slice(&raw).unwrap();
        assert_eq!(a, parsed);
    }

    #[test]
    fn regenerates_if_file_deleted() {
        let dir = TempDir::new().unwrap();
        let a = DeviceIdentity::load_or_create(dir.path()).unwrap();
        std::fs::remove_file(DeviceIdentity::path(dir.path())).unwrap();
        let b = DeviceIdentity::load_or_create(dir.path()).unwrap();
        assert_ne!(a.device_uuid, b.device_uuid);
    }
}
