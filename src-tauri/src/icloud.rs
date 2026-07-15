//! iCloud helpers — container-path resolution + file-presence checks.
//!
//! - **Path helper** (`icloud_data_dir`) resolves the ubiquity
//!   Documents directory using a deterministic path — no daemon query.
//! - **Eviction handling** (`is_file_downloaded`,
//!   `icloud_placeholder_path`, `has_icloud_placeholder`,
//!   `trigger_download_file`) for book and cover binaries that live in
//!   iCloud Documents and may be evicted.

use std::collections::HashSet;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{mpsc, Mutex};
use std::time::Duration;

#[cfg(target_os = "macos")]
use objc2_foundation::{NSFileManager, NSString};

#[cfg(target_os = "macos")]
const ICLOUD_CONTAINER_ID: &str = "iCloud.com.wycstudios.quill";

/// Returns the iCloud Documents directory using the deterministic path
/// `~/Library/Mobile Documents/<container>/Documents`. No daemon query.
///
/// Returns `None` if `$HOME` is unset (non-macOS always returns None).
/// Does NOT check whether the directory exists — callers that need an
/// existence gate should check `path.exists()` themselves.
#[cfg(target_os = "macos")]
pub fn icloud_data_dir() -> Option<PathBuf> {
    let home = std::env::var_os("HOME")?;
    let folder_name = ICLOUD_CONTAINER_ID.replace('.', "~");
    Some(
        PathBuf::from(home)
            .join("Library/Mobile Documents")
            .join(folder_name)
            .join("Documents"),
    )
}

#[cfg(not(target_os = "macos"))]
pub fn icloud_data_dir() -> Option<PathBuf> {
    None
}

/// Fast check for whether this Mac has iCloud set up. Looks for
/// `~/Library/Mobile Documents` — present on any Mac signed into
/// iCloud, absent otherwise. No daemon query.
#[cfg(target_os = "macos")]
pub fn is_icloud_available() -> bool {
    std::env::var_os("HOME")
        .map(|h| PathBuf::from(h).join("Library/Mobile Documents").is_dir())
        .unwrap_or(false)
}

#[cfg(not(target_os = "macos"))]
pub fn is_icloud_available() -> bool {
    false
}

const READ_PROBE_TIMEOUT: Duration = Duration::from_millis(300);

/// Paths with a probe worker still blocked inside `open`/`read`.
/// Checked before spawning: while the previous worker is stuck the path
/// is reported unavailable immediately, so repeated availability checks
/// (the reader polls every 2s; every library refresh probes each book)
/// hold at most one blocked OS thread per path instead of accumulating
/// one per call. The worker clears its entry when the read returns —
/// on any outcome — so probing resumes once the kernel gives up. Same
/// bound as `sync::replay`'s IN_FLIGHT; the stalled-backoff half of
/// that pattern isn't needed for a 1-byte probe, which is cheap to
/// retry once it actually returns.
static PROBES_IN_FLIGHT: Mutex<Option<HashSet<PathBuf>>> = Mutex::new(None);

/// Atomically mark `path` in-flight. Returns `false` if a probe worker
/// is already blocked on it.
fn try_mark_probe(path: &Path) -> bool {
    let mut guard = PROBES_IN_FLIGHT.lock().unwrap_or_else(|e| e.into_inner());
    guard
        .get_or_insert_with(HashSet::new)
        .insert(path.to_path_buf())
}

fn clear_probe(path: &Path) {
    let mut guard = PROBES_IN_FLIGHT.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(set) = guard.as_mut() {
        set.remove(path);
    }
}

#[cfg(test)]
fn probe_in_flight(path: &Path) -> bool {
    let guard = PROBES_IN_FLIGHT.lock().unwrap_or_else(|e| e.into_inner());
    guard.as_ref().is_some_and(|set| set.contains(path))
}

/// Check whether a file is locally available (not an iCloud placeholder)
/// and actually readable.
///
/// iCloud evicts files by replacing `foo.epub` with `.foo.epub.icloud`,
/// so a missing real file means "not available". But an unhealthy iCloud
/// container can also leave the directory entry in place while reads
/// block for a minute before failing ("Operation timed out"), so mere
/// existence isn't enough: probe the first byte on a worker thread with
/// a hard deadline. A probe that outlives the deadline is abandoned and
/// the file treated as not available; the path stays marked in-flight
/// until that worker's read returns, and further checks short-circuit
/// to "not available" instead of stacking more blocked threads.
pub fn is_file_downloaded(path: &Path) -> bool {
    if !path.exists() {
        return false;
    }
    if !try_mark_probe(path) {
        return false;
    }
    let (tx, rx) = mpsc::channel();
    let owned = path.to_path_buf();
    std::thread::spawn(move || {
        let readable = std::fs::File::open(&owned)
            .and_then(|mut f| f.read(&mut [0u8; 1]))
            .is_ok();
        clear_probe(&owned);
        let _ = tx.send(readable);
    });
    rx.recv_timeout(READ_PROBE_TIMEOUT).unwrap_or(false)
}

/// Returns the iCloud placeholder path for a given file.
/// e.g. `/dir/foo.epub` → `/dir/.foo.epub.icloud`
#[allow(dead_code)]
pub fn icloud_placeholder_path(path: &Path) -> Option<PathBuf> {
    let parent = path.parent()?;
    let name = path.file_name()?.to_str()?;
    Some(parent.join(format!(".{}.icloud", name)))
}

/// Check if a file has an iCloud placeholder (evicted by iCloud).
#[allow(dead_code)]
pub fn has_icloud_placeholder(path: &Path) -> bool {
    icloud_placeholder_path(path).is_some_and(|p| p.exists())
}

/// Trigger iCloud to download a specific file.
#[cfg(target_os = "macos")]
pub fn trigger_download_file(path: &Path) {
    use objc2_foundation::NSURL;
    let fm = NSFileManager::defaultManager();
    let path_str = NSString::from_str(&path.to_string_lossy());
    let url = NSURL::fileURLWithPath(&path_str);
    let _ = fm.startDownloadingUbiquitousItemAtURL_error(&url);
}

#[cfg(not(target_os = "macos"))]
pub fn trigger_download_file(_path: &Path) {}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    // --- is_file_downloaded ---

    #[test]
    fn test_is_file_downloaded_real_file_exists() {
        let dir = TempDir::new().unwrap();
        let file = dir.path().join("book.epub");
        fs::write(&file, "epub data").unwrap();
        assert!(is_file_downloaded(&file));
        assert!(!probe_in_flight(&file));
    }

    #[test]
    fn test_is_file_downloaded_missing_file() {
        let dir = TempDir::new().unwrap();
        let file = dir.path().join("book.epub");
        assert!(!is_file_downloaded(&file));
    }

    #[test]
    fn test_is_file_downloaded_placeholder_only() {
        let dir = TempDir::new().unwrap();
        // Real file doesn't exist, but placeholder does
        let placeholder = dir.path().join(".book.epub.icloud");
        fs::write(&placeholder, "placeholder").unwrap();
        let file = dir.path().join("book.epub");
        assert!(!is_file_downloaded(&file));
    }

    #[cfg(unix)]
    #[test]
    fn test_is_file_downloaded_unreadable_file() {
        use std::os::unix::fs::PermissionsExt;
        let dir = TempDir::new().unwrap();
        let file = dir.path().join("book.epub");
        fs::write(&file, "epub data").unwrap();
        fs::set_permissions(&file, fs::Permissions::from_mode(0o000)).unwrap();
        assert!(!is_file_downloaded(&file));
        // Worker failed fast and cleared its marker — probing can retry.
        assert!(!probe_in_flight(&file));
        fs::set_permissions(&file, fs::Permissions::from_mode(0o644)).unwrap();
    }

    /// A FIFO with no writer blocks `open()` forever — stands in for an
    /// iCloud read that hangs when sync is unhealthy. The probe must give
    /// up at its deadline instead of hanging the caller, and repeated
    /// checks of the same hanging path must short-circuit on the
    /// in-flight marker instead of stacking another blocked worker.
    #[cfg(unix)]
    #[test]
    fn test_is_file_downloaded_hanging_read_times_out_and_probes_once() {
        let dir = TempDir::new().unwrap();
        let fifo = dir.path().join("book.epub");
        let status = std::process::Command::new("mkfifo")
            .arg(&fifo)
            .status()
            .unwrap();
        assert!(status.success());

        let start = std::time::Instant::now();
        assert!(!is_file_downloaded(&fifo));
        assert!(start.elapsed() < Duration::from_secs(5));
        // Worker is still blocked on open(); marker must persist.
        assert!(probe_in_flight(&fifo));

        // Simulates the reader's 2s availability poll: repeat checks must
        // return immediately (no new worker waiting out a fresh deadline).
        let start = std::time::Instant::now();
        assert!(!is_file_downloaded(&fifo));
        assert!(!is_file_downloaded(&fifo));
        assert!(start.elapsed() < READ_PROBE_TIMEOUT);
        assert!(probe_in_flight(&fifo));
    }

    // --- icloud_data_dir ---

    #[cfg(target_os = "macos")]
    #[test]
    fn test_icloud_data_dir_returns_deterministic_path() {
        let tmp = TempDir::new().unwrap();
        let prev = std::env::var_os("HOME");
        std::env::set_var("HOME", tmp.path());
        let result = icloud_data_dir();
        if let Some(home) = prev {
            std::env::set_var("HOME", home);
        }
        let expected = tmp
            .path()
            .join("Library/Mobile Documents/iCloud~com~wycstudios~quill/Documents");
        assert_eq!(result, Some(expected));
    }

    // --- icloud_placeholder_path ---

    #[test]
    fn test_icloud_placeholder_path() {
        let path = Path::new("/data/books/my-book_abc12345.epub");
        let placeholder = icloud_placeholder_path(path).unwrap();
        assert_eq!(
            placeholder,
            PathBuf::from("/data/books/.my-book_abc12345.epub.icloud")
        );
    }

    // --- has_icloud_placeholder ---

    #[test]
    fn test_has_icloud_placeholder_true() {
        let dir = TempDir::new().unwrap();
        let placeholder = dir.path().join(".book.epub.icloud");
        fs::write(&placeholder, "placeholder").unwrap();
        let file = dir.path().join("book.epub");
        assert!(has_icloud_placeholder(&file));
    }

    #[test]
    fn test_has_icloud_placeholder_false() {
        let dir = TempDir::new().unwrap();
        let file = dir.path().join("book.epub");
        assert!(!has_icloud_placeholder(&file));
    }

}
