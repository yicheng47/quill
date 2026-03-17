# iCloud Sync — Phase 3 & 4 Implementation Plan

## Context

Quill stores all data locally. Users with multiple Macs can't sync their library. Phases 1 (relative paths) and 2 (secrets separation) are complete — the codebase is ready for iCloud Drive integration.

This plan implements **Phase 3** (iCloud Rust module) and **Phase 4** (Tauri commands & iCloud-aware app init) from `docs/features/06-icloud-sync.md`. Phase 5 (frontend) is deferred to a follow-up.

### Key existing types

- `Db` (`src-tauri/src/db.rs`): `conn: Mutex<Connection>`, `data_dir: Mutex<PathBuf>` — both swappable at runtime
- `Secrets` (`src-tauri/src/secrets.rs`): local-only store, always at `app_data_dir`
- `AppError` / `AppResult<T>` (`src-tauri/src/error.rs`): `Db`, `Io`, `Epub`, `Ai`, `Other(String)` variants

---

## Step 1: Add dependencies — `src-tauri/Cargo.toml`

Append after `rand = "0.8"`:

```toml
objc2 = "0.6"
objc2-foundation = { version = "0.3", features = ["NSFileManager", "NSString", "NSURL", "NSError"] }
```

---

## Step 2: Create `src-tauri/src/icloud.rs`

```rust
use std::fs;
use std::path::{Path, PathBuf};

use rusqlite::Connection;

use crate::db::Db;
use crate::error::{AppError, AppResult};

#[cfg(target_os = "macos")]
use objc2_foundation::{NSFileManager, NSString, NSURL};

const ICLOUD_CONTAINER_ID: &str = "iCloud.com.jason.quill";
const MARKER_FILE: &str = ".icloud_enabled";

/// Get the iCloud ubiquity container URL for this app.
/// Returns `None` if iCloud is unavailable (not signed in, no entitlement).
#[cfg(target_os = "macos")]
pub fn get_icloud_container_url() -> Option<PathBuf> {
    unsafe {
        let fm = NSFileManager::defaultManager();
        let container_id = NSString::from_str(ICLOUD_CONTAINER_ID);
        let url = fm.URLForUbiquityContainerIdentifier(Some(&container_id))?;
        let path = url.path()?;
        Some(PathBuf::from(path.to_string()))
    }
}

#[cfg(not(target_os = "macos"))]
pub fn get_icloud_container_url() -> Option<PathBuf> {
    None
}

/// Returns the iCloud Documents directory (container/Documents/).
pub fn icloud_data_dir() -> Option<PathBuf> {
    get_icloud_container_url().map(|p| p.join("Documents"))
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
        // First device — checkpoint WAL, close DB, move files to iCloud
        {
            let mut conn = db.conn.lock().map_err(|e| AppError::Other(e.to_string()))?;
            conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")?;
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
    new_conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;")?;

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
        conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")?;
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
    new_conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;")?;

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
pub fn wal_checkpoint(db: &Db) -> AppResult<()> {
    let conn = db.conn.lock().map_err(|e| AppError::Other(e.to_string()))?;
    conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")?;
    Ok(())
}

/// Trigger iCloud to download evicted files. Best-effort — errors are logged but don't block.
#[cfg(target_os = "macos")]
pub fn ensure_downloaded(icloud_dir: &Path) -> AppResult<()> {
    unsafe {
        let fm = NSFileManager::defaultManager();
        for name in &["quill.db", "books", "covers"] {
            let path = icloud_dir.join(name);
            let path_str = NSString::from_str(&path.to_string_lossy());
            let url = NSURL::fileURLWithPath(&path_str);
            if let Err(e) = fm.startDownloadingUbiquitousItemAtURL(&url) {
                eprintln!("iCloud: failed to trigger download for {}: {}", name, e);
            }
        }
    }
    Ok(())
}

#[cfg(not(target_os = "macos"))]
pub fn ensure_downloaded(_icloud_dir: &Path) -> AppResult<()> {
    Ok(())
}

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
```

### Design notes for `icloud.rs`

- **Connection swap pattern**: Before moving/copying DB files, we checkpoint the WAL then swap the live `Mutex<Connection>` with an in-memory placeholder. This closes the file handle so `fs::rename` / `fs::copy` works cleanly. After the move, we open a new connection at the target path and swap it in.
- **`#[cfg]` guards**: Only `get_icloud_container_url` and `ensure_downloaded` use objc2 FFI. The rest is pure Rust filesystem operations.
- **Copy vs move**: `migrate_from_icloud` copies (not moves) so iCloud retains the data for other devices.

---

## Step 3: Create `src-tauri/Entitlements.plist`

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>com.apple.developer.ubiquity-container-identifiers</key>
    <array>
        <string>iCloud.com.jason.quill</string>
    </array>
</dict>
</plist>
```

---

## Step 4: Update `src-tauri/tauri.conf.json`

Two changes:

1. Set `bundle.macOS.entitlements` from `null` to `"Entitlements.plist"`
2. Add iCloud path to `app.security.assetProtocol.scope` array:

```json
"scope": ["$APPDATA/**", "$HOME/Library/Mobile Documents/iCloud~com~jason~quill/Documents/**"]
```

---

## Step 5: Update `src-tauri/capabilities/default.json`

Add iCloud path to the `fs:scope` allow array:

```json
{
  "identifier": "fs:scope",
  "allow": [
    { "path": "$APPDATA/**" },
    { "path": "$HOME/Library/Mobile Documents/iCloud~com~jason~quill/Documents/**" }
  ]
}
```

---

## Step 6: Create `src-tauri/src/commands/icloud.rs`

```rust
use serde::Serialize;
use tauri::{AppHandle, Manager, State};

use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::icloud;

#[derive(Serialize)]
pub struct ICloudStatus {
    available: bool,
    enabled: bool,
}

#[tauri::command]
pub fn icloud_status(app: AppHandle) -> AppResult<ICloudStatus> {
    let local_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::Other(e.to_string()))?;
    Ok(ICloudStatus {
        available: icloud::icloud_data_dir().is_some(),
        enabled: icloud::is_icloud_enabled(&local_dir),
    })
}

#[tauri::command]
pub fn icloud_enable(app: AppHandle, db: State<'_, Db>) -> AppResult<()> {
    let local_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::Other(e.to_string()))?;
    let icloud_dir = icloud::icloud_data_dir()
        .ok_or_else(|| AppError::Other("iCloud is not available".to_string()))?;

    icloud::ensure_downloaded(&icloud_dir)?;
    icloud::migrate_to_icloud(&db, &local_dir, &icloud_dir)
}

#[tauri::command]
pub fn icloud_disable(app: AppHandle, db: State<'_, Db>) -> AppResult<()> {
    let local_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::Other(e.to_string()))?;
    let icloud_dir = icloud::icloud_data_dir()
        .ok_or_else(|| AppError::Other("iCloud is not available".to_string()))?;

    icloud::migrate_from_icloud(&db, &local_dir, &icloud_dir)
}
```

---

## Step 7: Update `src-tauri/src/commands/mod.rs`

Add `pub mod icloud;` (alphabetically between `collections` and `oauth`).

---

## Step 8: Update `src-tauri/src/lib.rs`

Four changes to the existing `run()` function:

### 8a. Add module declaration

Add `mod icloud;` after `mod error;` (line 5).

### 8b. iCloud-aware startup in `setup()`

Replace the current `app_data_dir` + `Db::init` block (lines 19-24):

```rust
// Before:
let app_data_dir = app.path().app_data_dir().expect("...");
let db = Db::init(&app_data_dir).expect("...");
let secrets = Secrets::init(&app_data_dir).expect("...");

// After:
let local_dir = app.path().app_data_dir().expect("failed to resolve app data dir");

let data_dir = if icloud::is_icloud_enabled(&local_dir) {
    match icloud::icloud_data_dir() {
        Some(dir) => {
            let _ = icloud::ensure_downloaded(&dir);
            dir
        }
        None => local_dir.clone(),
    }
} else {
    local_dir.clone()
};

let db = Db::init(&data_dir).expect("failed to initialize database");
// Secrets DB always lives at the local app_data_dir (never syncs to iCloud)
let secrets = Secrets::init(&local_dir).expect("failed to initialize secrets store");
```

### 8c. WAL checkpoint on exit

Change `.run(tauri::generate_context!()).expect(...)` to `.build()` + `.run()`:

```rust
// Before (line 87-88):
.run(tauri::generate_context!())
.expect("error while running tauri application");

// After:
.build(tauri::generate_context!())
.expect("error while building tauri application");

app.run(|app_handle, event| {
    if let tauri::RunEvent::ExitRequested { .. } = event {
        if let Some(db) = app_handle.try_state::<Db>() {
            let _ = icloud::wal_checkpoint(&db);
        }
    }
});
```

This requires binding the builder to `let app = tauri::Builder::default()...`.

### 8d. Register iCloud commands

Add to the `invoke_handler` list:

```rust
// iCloud
commands::icloud::icloud_status,
commands::icloud::icloud_enable,
commands::icloud::icloud_disable,
```

---

## Files Summary

| Action | File |
|--------|------|
| Modify | `src-tauri/Cargo.toml` — add objc2 deps |
| Create | `src-tauri/src/icloud.rs` — FFI, migration, checkpoint |
| Create | `src-tauri/Entitlements.plist` — iCloud entitlement |
| Modify | `src-tauri/tauri.conf.json` — entitlements ref, asset scope |
| Modify | `src-tauri/capabilities/default.json` — fs scope |
| Create | `src-tauri/src/commands/icloud.rs` — Tauri commands |
| Modify | `src-tauri/src/commands/mod.rs` — add icloud module |
| Modify | `src-tauri/src/lib.rs` — iCloud-aware init, WAL checkpoint on exit, register commands |

## Verification

1. `cargo build` passes
2. Without iCloud entitlement/signing: app starts normally using local storage (graceful fallback)
3. `icloud_status` returns `{ available: false, enabled: false }` when not signed in / no entitlement
4. With entitlement + iCloud signed in: `icloud_status` returns `available: true`
5. `icloud_enable` moves files to `~/Library/Mobile Documents/iCloud~com~jason~quill/Documents/`, books/covers load correctly
6. `icloud_disable` copies files back to local, app works normally
7. App exit triggers WAL checkpoint (verify no WAL/SHM files remain after clean shutdown)
8. Second device with iCloud enabled picks up existing data without overwriting
