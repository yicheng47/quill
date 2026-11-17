use std::path::{Path, PathBuf};

pub const PROD_IDENTIFIER: &str = "com.wycstudios.quill";
pub const DEV_IDENTIFIER: &str = "com.wycstudios.quill-dev";

/// Bundle identifier for OS-scoped paths (logs, app_data).
pub fn bundle_identifier(is_dev: bool) -> &'static str {
    if is_dev {
        DEV_IDENTIFIER
    } else {
        PROD_IDENTIFIER
    }
}

/// Resolve the app-data directory under an OS-provided base directory
/// (`~/Library/Application Support` on macOS, `%APPDATA%` on Windows).
pub fn resolve_data_dir_from_base(base_dir: &Path, is_dev: bool) -> PathBuf {
    base_dir.join(bundle_identifier(is_dev))
}

pub fn macos_app_data_dir(home: &Path, is_dev: bool) -> PathBuf {
    home.join("Library")
        .join("Application Support")
        .join(bundle_identifier(is_dev))
}

pub fn windows_app_data_dir(appdata: &Path, is_dev: bool) -> PathBuf {
    appdata.join(bundle_identifier(is_dev))
}

pub fn macos_log_dir(home: &Path, is_dev: bool) -> PathBuf {
    home.join("Library")
        .join("Logs")
        .join(bundle_identifier(is_dev))
}

pub fn windows_log_dir(local_appdata: &Path, is_dev: bool) -> PathBuf {
    local_appdata
        .join(bundle_identifier(is_dev))
        .join("logs")
}

/// Resolve the OS-conventional log directory for this build configuration.
pub fn resolve_log_dir(is_dev: bool) -> PathBuf {
    #[cfg(target_os = "macos")]
    {
        let home = std::env::var_os("HOME")
            .map(PathBuf::from)
            .expect("HOME env var");
        macos_log_dir(&home, is_dev)
    }
    #[cfg(target_os = "windows")]
    {
        let base = std::env::var_os("LOCALAPPDATA")
            .map(PathBuf::from)
            .expect("LOCALAPPDATA env var");
        windows_log_dir(&base, is_dev)
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let identifier = bundle_identifier(is_dev);
        let base = std::env::var_os("XDG_DATA_HOME")
            .map(PathBuf::from)
            .or_else(|| {
                std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".local/share"))
            })
            .expect("HOME or XDG_DATA_HOME env var");
        base.join(identifier).join("logs")
    }
}

/// Resolve the OS-conventional app-data directory when there is no shell
/// (`quill-mcp` stdio binary and unit tests).
pub fn resolve_app_data_dir(is_dev: bool) -> PathBuf {
    #[cfg(target_os = "macos")]
    {
        let home = std::env::var_os("HOME")
            .map(PathBuf::from)
            .expect("HOME env var");
        macos_app_data_dir(&home, is_dev)
    }
    #[cfg(target_os = "windows")]
    {
        let base = std::env::var_os("APPDATA")
            .map(PathBuf::from)
            .expect("APPDATA env var");
        windows_app_data_dir(&base, is_dev)
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let identifier = bundle_identifier(is_dev);
        let base = std::env::var_os("XDG_DATA_HOME")
            .map(PathBuf::from)
            .or_else(|| {
                std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".local/share"))
            })
            .expect("HOME or XDG_DATA_HOME env var");
        base.join(identifier)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pins_macos_prod_and_dev_app_data_dirs() {
        let home = Path::new("/Users/tester");
        assert_eq!(
            macos_app_data_dir(home, false),
            PathBuf::from("/Users/tester/Library/Application Support/com.wycstudios.quill")
        );
        assert_eq!(
            macos_app_data_dir(home, true),
            PathBuf::from("/Users/tester/Library/Application Support/com.wycstudios.quill-dev")
        );
    }

    #[test]
    fn pins_windows_prod_and_dev_app_data_dirs() {
        let appdata = Path::new(r"C:\Users\tester\AppData\Roaming");
        assert_eq!(
            windows_app_data_dir(appdata, false),
            Path::new(r"C:\Users\tester\AppData\Roaming").join("com.wycstudios.quill")
        );
        assert_eq!(
            windows_app_data_dir(appdata, true),
            Path::new(r"C:\Users\tester\AppData\Roaming").join("com.wycstudios.quill-dev")
        );
    }

    #[test]
    fn resolve_data_dir_from_base_applies_dev_suffix() {
        let base = Path::new("/tmp/appdata");
        assert_eq!(
            resolve_data_dir_from_base(base, false),
            PathBuf::from("/tmp/appdata/com.wycstudios.quill")
        );
        assert_eq!(
            resolve_data_dir_from_base(base, true),
            PathBuf::from("/tmp/appdata/com.wycstudios.quill-dev")
        );
    }

    #[test]
    fn resolve_log_dir_uses_dev_suffix_when_dev() {
        let dir = resolve_log_dir(true);
        let dir_str = dir.to_string_lossy().to_string();
        assert!(
            dir_str.contains("com.wycstudios.quill-dev"),
            "dev log dir {dir_str} should contain com.wycstudios.quill-dev",
        );
        let stripped = dir_str.replace("com.wycstudios.quill-dev", "");
        assert!(
            !stripped.contains("com.wycstudios.quill"),
            "dev log dir {dir_str} leaks the prod identifier outside the -dev suffix",
        );
    }

    #[test]
    fn pins_macos_and_windows_log_dirs() {
        let home = Path::new("/Users/tester");
        assert_eq!(
            macos_log_dir(home, false),
            PathBuf::from("/Users/tester/Library/Logs/com.wycstudios.quill")
        );
        assert_eq!(
            macos_log_dir(home, true),
            PathBuf::from("/Users/tester/Library/Logs/com.wycstudios.quill-dev")
        );

        let local = Path::new(r"C:\Users\tester\AppData\Local");
        assert_eq!(
            windows_log_dir(local, false),
            local.join("com.wycstudios.quill").join("logs")
        );
        assert_eq!(
            windows_log_dir(local, true),
            local.join("com.wycstudios.quill-dev").join("logs")
        );
    }
}
