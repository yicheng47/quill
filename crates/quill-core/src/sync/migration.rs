//! Sync settings file — read/write/remove `.icloud_setting` which
//! controls whether the event-log sync engine boots at launch.
//!
//! Written by `sync_enable`, removed by `sync_disable`. JSON format
//! for future extensibility.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};

const SYNC_SETTINGS_FILE: &str = ".icloud_setting";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncSettings {
    pub enabled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data_dir: Option<String>,
}

pub fn sync_settings_path(local_dir: &Path) -> PathBuf {
    local_dir.join(SYNC_SETTINGS_FILE)
}

pub fn is_sync_enabled(local_dir: &Path) -> bool {
    read_sync_settings(local_dir)
        .map(|s| s.enabled)
        .unwrap_or(false)
}

pub fn read_sync_settings(local_dir: &Path) -> Option<SyncSettings> {
    let bytes = fs::read(sync_settings_path(local_dir)).ok()?;
    serde_json::from_slice(&bytes).ok()
}

pub fn recorded_data_dir(local_dir: &Path) -> Option<PathBuf> {
    let settings = read_sync_settings(local_dir)?;
    let dir = settings.data_dir?;
    if dir.is_empty() {
        return None;
    }
    Some(PathBuf::from(dir))
}

pub fn write_sync_settings(local_dir: &Path, data_dir: Option<&Path>) -> AppResult<()> {
    let settings = SyncSettings {
        enabled: true,
        data_dir: data_dir.map(|p| p.to_string_lossy().into_owned()),
    };
    let bytes = serde_json::to_vec_pretty(&settings)
        .map_err(|e| AppError::Other(format!("serialize sync settings: {e}")))?;
    fs::write(sync_settings_path(local_dir), bytes)?;
    Ok(())
}

pub fn remove_sync_settings(local_dir: &Path) -> AppResult<()> {
    let path = sync_settings_path(local_dir);
    match fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(AppError::Io(e)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn not_enabled_by_default() {
        let local = TempDir::new().unwrap();
        assert!(!is_sync_enabled(local.path()));
        assert_eq!(recorded_data_dir(local.path()), None);
    }

    #[test]
    fn write_then_read_round_trips() {
        let local = TempDir::new().unwrap();
        let data_dir = Path::new("/tmp/some/icloud/path");
        write_sync_settings(local.path(), Some(data_dir)).unwrap();
        assert!(is_sync_enabled(local.path()));
        assert_eq!(recorded_data_dir(local.path()).as_deref(), Some(data_dir));
    }

    #[test]
    fn remove_clears_settings() {
        let local = TempDir::new().unwrap();
        write_sync_settings(local.path(), Some(Path::new("/tmp"))).unwrap();
        assert!(is_sync_enabled(local.path()));
        remove_sync_settings(local.path()).unwrap();
        assert!(!is_sync_enabled(local.path()));
    }

    #[test]
    fn none_data_dir_still_enabled() {
        let local = TempDir::new().unwrap();
        write_sync_settings(local.path(), None).unwrap();
        assert!(is_sync_enabled(local.path()));
        assert_eq!(recorded_data_dir(local.path()), None);
    }
}
