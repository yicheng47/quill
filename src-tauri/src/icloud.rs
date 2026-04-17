use std::fs;
use std::path::{Path, PathBuf};

use rusqlite::Connection;

use crate::db::Db;
use crate::error::{AppError, AppResult};

#[cfg(target_os = "macos")]
use objc2_foundation::{NSFileManager, NSString};

#[cfg(target_os = "macos")]
const ICLOUD_CONTAINER_ID: &str = "iCloud.com.wycstudios.quill";
const MARKER_FILE: &str = ".icloud_enabled";

/// Get the iCloud ubiquity container URL for this app.
/// Returns `None` if iCloud is unavailable (not signed in, no entitlement).
#[cfg(target_os = "macos")]
pub fn get_icloud_container_url() -> Option<PathBuf> {
    let fm = NSFileManager::defaultManager();
    let container_id = NSString::from_str(ICLOUD_CONTAINER_ID);
    let url = fm.URLForUbiquityContainerIdentifier(Some(&container_id))?;
    let path = url.path()?;
    Some(PathBuf::from(path.to_string()))
}

#[cfg(not(target_os = "macos"))]
pub fn get_icloud_container_url() -> Option<PathBuf> {
    None
}

/// Returns the iCloud Documents directory (container/Documents/).
pub fn icloud_data_dir() -> Option<PathBuf> {
    get_icloud_container_url().map(|p| p.join("Documents"))
}

/// Returns the iCloud Documents directory using a hardcoded path derived from
/// the container identifier — does NOT call `URLForUbiquityContainerIdentifier`,
/// which is the slowest call on cold start (queries the iCloud daemon).
///
/// The path layout is deterministic: `~/Library/Mobile Documents/<container>/Documents`,
/// where `<container>` is the identifier with dots replaced by tildes.
///
/// Returns `None` if `$HOME` is unset or the directory doesn't exist on disk
/// (e.g. user signed out of iCloud since enabling sync). Callers should fall
/// back to the local directory in that case.
///
/// Sync engine callers prefer `icloud_data_dir_deterministic` so blob path
/// resolution stays stable across launches even when the container hasn't
/// materialized yet — `_fast` is kept for the legacy `icloud::*` flows that
/// genuinely need the existence check (Chunk 9 cleanup will delete both
/// once the file-sync code is gone).
#[cfg(target_os = "macos")]
#[allow(dead_code)] // used by tests + legacy flows; cleanup tracked in Chunk 9
pub fn icloud_data_dir_fast() -> Option<PathBuf> {
    let home = std::env::var_os("HOME")?;
    let folder_name = ICLOUD_CONTAINER_ID.replace('.', "~");
    let path = PathBuf::from(home)
        .join("Library/Mobile Documents")
        .join(folder_name)
        .join("Documents");
    if path.is_dir() {
        Some(path)
    } else {
        None
    }
}

#[cfg(not(target_os = "macos"))]
pub fn icloud_data_dir_fast() -> Option<PathBuf> {
    None
}

/// Like `icloud_data_dir_fast` but returns the deterministic path
/// **without** checking that it currently exists on disk. Used by the
/// post-migration data_dir resolver so blob path resolution stays
/// stable across launches even when the iCloud daemon hasn't yet
/// materialized the container (cold boot, sleep wake, signed-out
/// account). If the path doesn't exist at runtime, downstream IO will
/// fail with a clear error — much better than silently flipping
/// data_dir between local and ubiquity launch-to-launch (which would
/// orphan blobs imported during the unavailable window).
#[cfg(target_os = "macos")]
pub fn icloud_data_dir_deterministic() -> Option<PathBuf> {
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
pub fn icloud_data_dir_deterministic() -> Option<PathBuf> {
    None
}

/// Check if iCloud sync is enabled by looking for the marker file in the local app dir.
pub fn is_icloud_enabled(local_dir: &Path) -> bool {
    local_dir.join(MARKER_FILE).exists()
}

/// Migrate from local storage to iCloud.
///
/// If iCloud already has a `quill.db` (second device joining), opens the existing iCloud DB.
/// Otherwise (first device), moves local files to iCloud.
pub fn migrate_to_icloud(db: &Db, local_dir: &Path, icloud_dir: &Path) -> AppResult<()> {
    fs::create_dir_all(icloud_dir.join("books"))?;
    fs::create_dir_all(icloud_dir.join("covers"))?;

    let icloud_db_path = icloud_dir.join("quill.db");

    if icloud_db_path.exists() {
        // Second device joining — close local connection, will open iCloud DB below
        let mut conn = db.conn.lock().map_err(|e| AppError::Other(e.to_string()))?;
        *conn = Connection::open_in_memory()?;
    } else {
        // First device — close DB, move files to iCloud
        {
            let mut conn = db.conn.lock().map_err(|e| AppError::Other(e.to_string()))?;
            *conn = Connection::open_in_memory()?;
        }

        move_dir_contents(&local_dir.join("books"), &icloud_dir.join("books"))?;
        move_dir_contents(&local_dir.join("covers"), &icloud_dir.join("covers"))?;

        let local_db_path = local_dir.join("quill.db");
        if local_db_path.exists() {
            fs::rename(&local_db_path, &icloud_db_path)?;
        }

        let _ = fs::remove_file(local_dir.join("quill.db-wal"));
        let _ = fs::remove_file(local_dir.join("quill.db-shm"));
    }

    // Open new connection at iCloud path
    let new_conn = Connection::open(&icloud_db_path)?;
    new_conn.execute_batch("PRAGMA journal_mode=DELETE; PRAGMA foreign_keys=ON;")?;

    {
        let mut conn = db.conn.lock().map_err(|e| AppError::Other(e.to_string()))?;
        *conn = new_conn;
    }
    {
        let mut data_dir = db.data_dir.lock().map_err(|e| AppError::Other(e.to_string()))?;
        *data_dir = icloud_dir.to_path_buf();
    }

    fs::write(local_dir.join(MARKER_FILE), "")?;

    Ok(())
}

/// Migrate from iCloud back to local storage.
///
/// Copies (not moves) files from iCloud to local, then switches the DB connection.
pub fn migrate_from_icloud(db: &Db, local_dir: &Path, icloud_dir: &Path) -> AppResult<()> {
    fs::create_dir_all(local_dir.join("books"))?;
    fs::create_dir_all(local_dir.join("covers"))?;

    {
        let mut conn = db.conn.lock().map_err(|e| AppError::Other(e.to_string()))?;
        *conn = Connection::open_in_memory()?;
    }

    copy_dir_contents(&icloud_dir.join("books"), &local_dir.join("books"))?;
    copy_dir_contents(&icloud_dir.join("covers"), &local_dir.join("covers"))?;

    let icloud_db_path = icloud_dir.join("quill.db");
    let local_db_path = local_dir.join("quill.db");
    if icloud_db_path.exists() {
        fs::copy(&icloud_db_path, &local_db_path)?;
    }

    let new_conn = Connection::open(&local_db_path)?;
    new_conn.execute_batch("PRAGMA journal_mode=DELETE; PRAGMA foreign_keys=ON;")?;

    {
        let mut conn = db.conn.lock().map_err(|e| AppError::Other(e.to_string()))?;
        *conn = new_conn;
    }
    {
        let mut data_dir = db.data_dir.lock().map_err(|e| AppError::Other(e.to_string()))?;
        *data_dir = local_dir.to_path_buf();
    }

    let _ = fs::remove_file(local_dir.join(MARKER_FILE));

    Ok(())
}

/// Flush the WAL to the main database file for safe iCloud sync.
/// Trigger iCloud to download evicted files. Best-effort — errors are logged but don't block.
#[cfg(target_os = "macos")]
pub fn ensure_downloaded(icloud_dir: &Path) -> AppResult<()> {
    use objc2_foundation::NSURL;
    let fm = NSFileManager::defaultManager();
    for name in &["quill.db", "books", "covers"] {
        let path = icloud_dir.join(name);
        let path_str = NSString::from_str(&path.to_string_lossy());
        let url = NSURL::fileURLWithPath(&path_str);
        if let Err(e) = fm.startDownloadingUbiquitousItemAtURL_error(&url) {
            eprintln!("iCloud: failed to trigger download for {}: {}", name, e);
        }
    }
    Ok(())
}

#[cfg(not(target_os = "macos"))]
pub fn ensure_downloaded(_icloud_dir: &Path) -> AppResult<()> {
    Ok(())
}

/// Check whether a file is locally available (not an iCloud placeholder).
///
/// iCloud evicts files by replacing `foo.epub` with `.foo.epub.icloud`.
/// Returns `true` if the real file exists on disk.
pub fn is_file_downloaded(path: &Path) -> bool {
    if path.exists() {
        return true;
    }
    // If the real file doesn't exist, it might be an iCloud placeholder — either way, not available.
    false
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

/// Move all files from src directory to dst directory.
fn move_dir_contents(src: &Path, dst: &Path) -> AppResult<()> {
    if !src.exists() {
        return Ok(());
    }
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let dest_path = dst.join(entry.file_name());
        fs::rename(entry.path(), &dest_path)?;
    }
    Ok(())
}

/// Copy all files from src directory to dst directory.
fn copy_dir_contents(src: &Path, dst: &Path) -> AppResult<()> {
    if !src.exists() {
        return Ok(());
    }
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let dest_path = dst.join(entry.file_name());
        fs::copy(entry.path(), &dest_path)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    /// Create a Db backed by a real SQLite file in the given directory.
    fn create_test_db(dir: &Path) -> Db {
        Db::init(dir).unwrap()
    }

    // --- is_file_downloaded ---

    #[test]
    fn test_is_file_downloaded_real_file_exists() {
        let dir = TempDir::new().unwrap();
        let file = dir.path().join("book.epub");
        fs::write(&file, "epub data").unwrap();
        assert!(is_file_downloaded(&file));
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

    // --- icloud_data_dir_fast / deterministic ---

    /// `icloud_data_dir_deterministic` returns the path even when the
    /// directory doesn't exist. Critical for the post-migration
    /// data_dir resolver: blob path resolution must stay stable across
    /// launches even when iCloud is signed out / not reachable, so we
    /// can't gate the path on `is_dir`.
    #[cfg(target_os = "macos")]
    #[test]
    fn test_icloud_data_dir_deterministic_returns_path_without_existence_check() {
        let tmp = TempDir::new().unwrap();
        // Set HOME to a directory that does NOT contain Library/Mobile
        // Documents/... — `icloud_data_dir_fast` would return None,
        // but the deterministic variant must still hand back the
        // computed path.
        let prev = std::env::var_os("HOME");
        std::env::set_var("HOME", tmp.path());
        let fast = icloud_data_dir_fast();
        let deterministic = icloud_data_dir_deterministic();
        if let Some(home) = prev {
            std::env::set_var("HOME", home);
        }

        assert_eq!(fast, None, "fast variant requires the dir to exist");
        let expected = tmp
            .path()
            .join("Library/Mobile Documents/iCloud~com~wycstudios~quill/Documents");
        assert_eq!(deterministic, Some(expected));
    }

    #[test]
    fn test_icloud_data_dir_fast_path_format() {
        // The fast path should be derived from $HOME + the container ID with
        // dots replaced by tildes. We can't assert it returns Some without an
        // actual iCloud directory present, but we CAN verify the derivation
        // matches what the system NSFileManager API would produce by checking
        // a temporary $HOME with a stub directory.
        let tmp = TempDir::new().unwrap();
        let stub = tmp
            .path()
            .join("Library/Mobile Documents/iCloud~com~wycstudios~quill/Documents");
        fs::create_dir_all(&stub).unwrap();

        // SAFETY: tests run single-threaded by default for this crate's
        // env-mutating tests; we restore HOME after the assertion.
        let prev = std::env::var_os("HOME");
        std::env::set_var("HOME", tmp.path());
        let resolved = icloud_data_dir_fast();
        if let Some(home) = prev {
            std::env::set_var("HOME", home);
        }

        assert_eq!(resolved, Some(stub));
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

    // --- is_icloud_enabled ---

    #[test]
    fn test_is_icloud_enabled_false_by_default() {
        let dir = TempDir::new().unwrap();
        assert!(!is_icloud_enabled(dir.path()));
    }

    #[test]
    fn test_is_icloud_enabled_true_with_marker() {
        let dir = TempDir::new().unwrap();
        fs::write(dir.path().join(".icloud_enabled"), "").unwrap();
        assert!(is_icloud_enabled(dir.path()));
    }

    // --- move_dir_contents ---

    #[test]
    fn test_move_dir_contents() {
        let src = TempDir::new().unwrap();
        let dst = TempDir::new().unwrap();

        fs::write(src.path().join("a.txt"), "aaa").unwrap();
        fs::write(src.path().join("b.txt"), "bbb").unwrap();

        move_dir_contents(src.path(), dst.path()).unwrap();

        assert!(dst.path().join("a.txt").exists());
        assert!(dst.path().join("b.txt").exists());
        assert!(!src.path().join("a.txt").exists());
        assert!(!src.path().join("b.txt").exists());
    }

    #[test]
    fn test_move_dir_contents_nonexistent_src() {
        let dst = TempDir::new().unwrap();
        let src = dst.path().join("nonexistent");
        move_dir_contents(&src, dst.path()).unwrap();
    }

    // --- copy_dir_contents ---

    #[test]
    fn test_copy_dir_contents() {
        let src = TempDir::new().unwrap();
        let dst = TempDir::new().unwrap();

        fs::write(src.path().join("a.txt"), "aaa").unwrap();
        fs::write(src.path().join("b.txt"), "bbb").unwrap();

        copy_dir_contents(src.path(), dst.path()).unwrap();

        assert!(dst.path().join("a.txt").exists());
        assert!(dst.path().join("b.txt").exists());
        // Source files still present
        assert!(src.path().join("a.txt").exists());
        assert!(src.path().join("b.txt").exists());
    }

    #[test]
    fn test_copy_dir_contents_nonexistent_src() {
        let dst = TempDir::new().unwrap();
        let src = dst.path().join("nonexistent");
        copy_dir_contents(&src, dst.path()).unwrap();
    }

    // --- migrate_to_icloud (first device) ---

    #[test]
    fn test_migrate_to_icloud_first_device() {
        let local = TempDir::new().unwrap();
        let icloud = TempDir::new().unwrap();

        let db = create_test_db(local.path());

        // Seed test data
        fs::write(local.path().join("books/test.epub"), "epub data").unwrap();
        fs::write(local.path().join("covers/test.jpg"), "cover data").unwrap();
        {
            let conn = db.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO settings (key, value) VALUES ('k', 'v')",
                [],
            )
            .unwrap();
        }

        migrate_to_icloud(&db, local.path(), icloud.path()).unwrap();

        // Files moved to iCloud
        assert!(icloud.path().join("books/test.epub").exists());
        assert!(icloud.path().join("covers/test.jpg").exists());
        assert!(icloud.path().join("quill.db").exists());

        // Files gone from local
        assert!(!local.path().join("books/test.epub").exists());
        assert!(!local.path().join("covers/test.jpg").exists());
        assert!(!local.path().join("quill.db").exists());

        // Marker written
        assert!(is_icloud_enabled(local.path()));

        // DB connection works at new location
        {
            let conn = db.conn.lock().unwrap();
            let val: String = conn
                .query_row("SELECT value FROM settings WHERE key = 'k'", [], |r| {
                    r.get(0)
                })
                .unwrap();
            assert_eq!(val, "v");
        }

        // data_dir updated
        assert_eq!(
            *db.data_dir.lock().unwrap(),
            icloud.path().to_path_buf()
        );
    }

    // --- migrate_to_icloud (second device — iCloud already has data) ---

    #[test]
    fn test_migrate_to_icloud_second_device() {
        let local = TempDir::new().unwrap();
        let icloud = TempDir::new().unwrap();

        let db = create_test_db(local.path());

        // Simulate existing iCloud data from another device
        fs::create_dir_all(icloud.path().join("books")).unwrap();
        fs::create_dir_all(icloud.path().join("covers")).unwrap();
        fs::write(icloud.path().join("books/shared.epub"), "shared").unwrap();
        {
            let icloud_conn = Connection::open(icloud.path().join("quill.db")).unwrap();
            icloud_conn
                .execute_batch(
                    "PRAGMA journal_mode=WAL;
                     CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
                     INSERT INTO settings (key, value) VALUES ('from', 'mac_a');",
                )
                .unwrap();
        }

        migrate_to_icloud(&db, local.path(), icloud.path()).unwrap();

        // Should open existing iCloud DB, not overwrite
        {
            let conn = db.conn.lock().unwrap();
            let val: String = conn
                .query_row("SELECT value FROM settings WHERE key = 'from'", [], |r| {
                    r.get(0)
                })
                .unwrap();
            assert_eq!(val, "mac_a");
        }

        // Shared book still there
        assert!(icloud.path().join("books/shared.epub").exists());

        // Marker written
        assert!(is_icloud_enabled(local.path()));
    }

    // --- migrate_from_icloud ---

    #[test]
    fn test_migrate_from_icloud() {
        let local = TempDir::new().unwrap();
        let icloud = TempDir::new().unwrap();

        let db = create_test_db(local.path());
        fs::write(local.path().join("books/test.epub"), "epub data").unwrap();
        fs::write(local.path().join("covers/test.jpg"), "cover data").unwrap();
        {
            let conn = db.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO settings (key, value) VALUES ('k', 'v')",
                [],
            )
            .unwrap();
        }

        // Migrate to iCloud, then back
        migrate_to_icloud(&db, local.path(), icloud.path()).unwrap();
        migrate_from_icloud(&db, local.path(), icloud.path()).unwrap();

        // Files copied back to local
        assert!(local.path().join("books/test.epub").exists());
        assert!(local.path().join("covers/test.jpg").exists());
        assert!(local.path().join("quill.db").exists());

        // Files still in iCloud (copy, not move)
        assert!(icloud.path().join("books/test.epub").exists());
        assert!(icloud.path().join("covers/test.jpg").exists());
        assert!(icloud.path().join("quill.db").exists());

        // Marker removed
        assert!(!is_icloud_enabled(local.path()));

        // DB connection works at local path
        {
            let conn = db.conn.lock().unwrap();
            let val: String = conn
                .query_row("SELECT value FROM settings WHERE key = 'k'", [], |r| {
                    r.get(0)
                })
                .unwrap();
            assert_eq!(val, "v");
        }

        // data_dir back to local
        assert_eq!(
            *db.data_dir.lock().unwrap(),
            local.path().to_path_buf()
        );
    }
}
