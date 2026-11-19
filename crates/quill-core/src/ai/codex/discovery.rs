use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use serde::Serialize;

/// The oldest Codex the app-server protocol code is verified against.
pub const MIN_VERSION: Version = Version(0, 170, 0);

const SHELL_LOOKUP_TIMEOUT: Duration = Duration::from_secs(4);
const VERSION_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct Version(pub u64, pub u64, pub u64);

impl std::fmt::Display for Version {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}.{}.{}", self.0, self.1, self.2)
    }
}

impl Serialize for Version {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

/// Parse the output of `codex --version` (`codex-cli 0.170.0`). Accepts a
/// bare version, a `v` prefix and a pre-release or build suffix.
pub fn parse_version(output: &str) -> Option<Version> {
    output.split_whitespace().rev().find_map(|token| {
        let token = token.trim_start_matches('v');
        let core = token.split(['-', '+']).next()?;
        let mut parts = core.split('.');
        let major = parts.next()?.parse().ok()?;
        let minor = parts.next()?.parse().ok()?;
        let patch = parts.next().unwrap_or("0").parse().ok()?;
        if parts.next().is_some() {
            return None;
        }
        Some(Version(major, minor, patch))
    })
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Found {
    pub path: PathBuf,
    /// True when the path came from the user's override in settings.
    pub from_override: bool,
}

/// Where to look on this machine, gathered once so the lookup order itself
/// is a pure function.
pub struct Environment {
    pub home: Option<PathBuf>,
    pub path_var: Option<std::ffi::OsString>,
    pub appdata: Option<PathBuf>,
    pub windows: bool,
}

impl Environment {
    pub fn current() -> Self {
        Self {
            home: std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
                .map(PathBuf::from),
            path_var: std::env::var_os("PATH"),
            appdata: std::env::var_os("APPDATA").map(PathBuf::from),
            windows: cfg!(windows),
        }
    }
}

fn binary_names(windows: bool) -> &'static [&'static str] {
    if windows {
        &["codex.exe", "codex.cmd"]
    } else {
        &["codex"]
    }
}

/// The usual install locations, in the order they are tried, after the
/// override and the login shell.
pub fn install_locations(env: &Environment) -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = Vec::new();
    if env.windows {
        if let Some(appdata) = &env.appdata {
            dirs.push(appdata.join("npm"));
        }
    } else {
        dirs.push(PathBuf::from("/opt/homebrew/bin"));
        dirs.push(PathBuf::from("/usr/local/bin"));
        if let Some(home) = &env.home {
            dirs.push(home.join(".local/bin"));
            dirs.push(home.join(".npm-global/bin"));
            dirs.push(home.join(".volta/bin"));
            dirs.push(home.join(".bun/bin"));
            let nvm = home.join(".nvm/versions/node");
            if let Ok(entries) = std::fs::read_dir(&nvm) {
                let mut versions: Vec<(Option<Version>, PathBuf)> = entries
                    .flatten()
                    .map(|e| {
                        let name = e.file_name().to_string_lossy().into_owned();
                        (parse_version(&name), e.path().join("bin"))
                    })
                    .collect();
                versions.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| b.1.cmp(&a.1)));
                dirs.extend(versions.into_iter().map(|(_, p)| p));
            }
        }
    }
    if let Some(path_var) = &env.path_var {
        dirs.extend(std::env::split_paths(path_var));
    }

    let mut out = Vec::new();
    for dir in dirs {
        for name in binary_names(env.windows) {
            let candidate = dir.join(name);
            if !out.contains(&candidate) {
                out.push(candidate);
            }
        }
    }
    out
}

/// Expand a leading `~/` or `~\` against `home`.
pub fn expand_tilde(raw: &str, home: Option<&Path>) -> PathBuf {
    if let Some(home) = home {
        if raw == "~" {
            return home.to_path_buf();
        }
        if let Some(rest) = raw.strip_prefix("~/").or_else(|| raw.strip_prefix("~\\")) {
            return home.join(rest);
        }
    }
    PathBuf::from(raw)
}

/// Lookup order: the override (alone, when set), then the login shell's
/// answer, then the install locations.
pub fn resolve(
    override_path: Option<&str>,
    shell_lookup: impl FnOnce() -> Option<PathBuf>,
    locations: impl FnOnce() -> Vec<PathBuf>,
    is_file: impl Fn(&Path) -> bool,
) -> Option<Found> {
    if let Some(raw) = override_path.map(str::trim).filter(|p| !p.is_empty()) {
        let path = PathBuf::from(raw);
        return is_file(&path).then_some(Found {
            path,
            from_override: true,
        });
    }
    if let Some(path) = shell_lookup().filter(|p| is_file(p)) {
        return Some(Found {
            path,
            from_override: false,
        });
    }
    locations().into_iter().find(|p| is_file(p)).map(|path| Found {
        path,
        from_override: false,
    })
}

/// Ask the user's login shell where `codex` is, since an app launched from
/// Finder does not inherit the shell's PATH.
async fn login_shell_lookup() -> Option<PathBuf> {
    if cfg!(windows) {
        return None;
    }
    let shell = std::env::var("SHELL").ok().filter(|s| !s.is_empty())?;
    let mut cmd = tokio::process::Command::new(shell);
    cmd.args(["-ilc", "command -v codex"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    let output = tokio::time::timeout(SHELL_LOOKUP_TIMEOUT, cmd.output())
        .await
        .ok()?
        .ok()?;
    shell_lookup_answer(&String::from_utf8_lossy(&output.stdout))
}

/// An interactive shell may print banners before the answer, so take the
/// last line that is an absolute path.
fn shell_lookup_answer(stdout: &str) -> Option<PathBuf> {
    stdout
        .lines()
        .rev()
        .map(str::trim)
        .find(|line| line.starts_with('/'))
        .map(PathBuf::from)
}

pub async fn find(override_path: Option<&str>) -> Option<Found> {
    let env = Environment::current();
    let expanded_override = override_path
        .map(str::trim)
        .filter(|p| !p.is_empty())
        .map(|raw| expand_tilde(raw, env.home.as_deref()).to_string_lossy().into_owned());
    let shell_answer = if expanded_override.is_some() {
        None
    } else {
        login_shell_lookup().await
    };
    resolve(
        expanded_override.as_deref(),
        || shell_answer,
        || install_locations(&env),
        |p| p.is_file(),
    )
}

/// A command for the Codex binary at `path`. An npm-installed `codex` is a
/// Node script, so its own folder (where nvm and Homebrew keep `node`) goes
/// first on PATH for an app that did not inherit the shell's.
pub fn command(path: &Path) -> tokio::process::Command {
    let mut cmd = tokio::process::Command::new(path);
    if let Some(dir) = path.parent() {
        let mut dirs = vec![dir.to_path_buf()];
        if !cfg!(windows) {
            dirs.push(PathBuf::from("/opt/homebrew/bin"));
            dirs.push(PathBuf::from("/usr/local/bin"));
        }
        if let Some(current) = std::env::var_os("PATH") {
            dirs.extend(std::env::split_paths(&current));
        }
        if let Ok(joined) = std::env::join_paths(dirs) {
            cmd.env("PATH", joined);
        }
    }
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

struct TempProbeDir(PathBuf);

impl TempProbeDir {
    fn new() -> Result<Self, String> {
        let path = std::env::temp_dir().join(format!("quill-codex-version-{}", ulid::Ulid::new()));
        std::fs::create_dir_all(&path)
            .map_err(|e| format!("could not create temporary probe directory {}: {e}", path.display()))?;
        Ok(Self(path))
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TempProbeDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

pub async fn read_version(path: &Path) -> Result<Version, String> {
    // Isolate `CODEX_HOME` for the `--version` probe: Codex's arg0 bootstrap
    // creates `$CODEX_HOME/tmp/arg0-<os>/codex-arg0*` before CLI dispatch and
    // `--version` exits before removing it.
    let probe_home = TempProbeDir::new()?;
    let mut cmd = command(path);
    cmd.arg("--version")
        .env("CODEX_HOME", probe_home.path())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let output = tokio::time::timeout(VERSION_TIMEOUT, cmd.output())
        .await
        .map_err(|_| "codex --version timed out".to_string())?
        .map_err(|e| format!("could not run {}: {e}", path.display()))?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    parse_version(&stdout).ok_or_else(|| {
        let stderr = String::from_utf8_lossy(&output.stderr);
        format!("unrecognised codex --version output: {}{}", stdout.trim(), stderr.trim())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    #[test]
    fn parses_versions() {
        assert_eq!(parse_version("codex-cli 0.170.0\n"), Some(Version(0, 170, 0)));
        assert_eq!(parse_version("0.141.2"), Some(Version(0, 141, 2)));
        assert_eq!(parse_version("codex-cli v1.2.3-alpha.4"), Some(Version(1, 2, 3)));
        assert_eq!(parse_version("codex 0.171.0+build7"), Some(Version(0, 171, 0)));
        assert_eq!(parse_version("codex 2.1"), Some(Version(2, 1, 0)));
        assert_eq!(parse_version("codex-cli"), None);
        assert_eq!(parse_version(""), None);
    }

    #[test]
    fn minimum_version_gate() {
        assert!(Version(0, 141, 2) < MIN_VERSION);
        assert!(Version(0, 169, 99) < MIN_VERSION);
        assert!(Version(0, 170, 0) >= MIN_VERSION);
        assert!(Version(0, 170, 1) >= MIN_VERSION);
        assert!(Version(1, 0, 0) >= MIN_VERSION);
        assert_eq!(MIN_VERSION.to_string(), "0.170.0");
    }

    #[test]
    fn override_wins_and_is_not_second_guessed() {
        let shell_called = Cell::new(false);
        let found = resolve(
            Some(" /custom/codex "),
            || {
                shell_called.set(true);
                Some(PathBuf::from("/shell/codex"))
            },
            || vec![PathBuf::from("/opt/homebrew/bin/codex")],
            |_| true,
        );
        assert_eq!(
            found,
            Some(Found { path: PathBuf::from("/custom/codex"), from_override: true })
        );
        assert!(!shell_called.get());

        let missing = resolve(
            Some("/missing/codex"),
            || Some(PathBuf::from("/shell/codex")),
            || vec![PathBuf::from("/opt/homebrew/bin/codex")],
            |p| p != Path::new("/missing/codex"),
        );
        assert_eq!(missing, None, "a missing override reports not installed");
    }

    #[test]
    fn login_shell_comes_before_install_locations() {
        let found = resolve(
            None,
            || Some(PathBuf::from("/shell/codex")),
            || vec![PathBuf::from("/opt/homebrew/bin/codex")],
            |_| true,
        );
        assert_eq!(found.unwrap().path, PathBuf::from("/shell/codex"));

        let blank_override = resolve(
            Some("  "),
            || None,
            || vec![PathBuf::from("/a/codex"), PathBuf::from("/b/codex")],
            |p| p == Path::new("/b/codex"),
        );
        assert_eq!(
            blank_override,
            Some(Found { path: PathBuf::from("/b/codex"), from_override: false })
        );

        let none = resolve(None, || None, Vec::new, |_| true);
        assert_eq!(none, None);
    }

    #[test]
    fn shell_answer_skips_banner_lines() {
        assert_eq!(
            shell_lookup_answer("Welcome!\n/Users/me/.local/bin/codex\n"),
            Some(PathBuf::from("/Users/me/.local/bin/codex"))
        );
        assert_eq!(shell_lookup_answer("codex not found\n"), None);
    }

    #[test]
    fn mac_install_locations_in_order() {
        let env = Environment {
            home: Some(PathBuf::from("/Users/me")),
            path_var: std::env::join_paths(["/usr/bin", "/opt/homebrew/bin"]).ok(),
            appdata: None,
            windows: false,
        };
        let locations = install_locations(&env);
        let expected_prefix: Vec<PathBuf> = [
            "/opt/homebrew/bin/codex",
            "/usr/local/bin/codex",
            "/Users/me/.local/bin/codex",
            "/Users/me/.npm-global/bin/codex",
        ]
        .iter()
        .map(PathBuf::from)
        .collect();
        assert_eq!(&locations[..4], &expected_prefix[..]);
        assert_eq!(locations.last(), Some(&PathBuf::from("/usr/bin/codex")));
        assert_eq!(
            locations.iter().filter(|p| *p == Path::new("/opt/homebrew/bin/codex")).count(),
            1,
            "PATH entries already listed are not repeated"
        );
    }

    #[test]
    fn windows_install_locations_use_npm_folder_then_path() {
        let env = Environment {
            home: Some(PathBuf::from("C:/Users/me")),
            path_var: None,
            appdata: Some(PathBuf::from("C:/Users/me/AppData/Roaming")),
            windows: true,
        };
        assert_eq!(
            install_locations(&env),
            vec![
                PathBuf::from("C:/Users/me/AppData/Roaming/npm/codex.exe"),
                PathBuf::from("C:/Users/me/AppData/Roaming/npm/codex.cmd"),
            ]
        );
    }

    #[test]
    fn expand_tilde_resolves_home_prefix() {
        let home = Path::new("/Users/me");
        assert_eq!(expand_tilde("~/bin/codex", Some(home)), PathBuf::from("/Users/me/bin/codex"));
        assert_eq!(expand_tilde("~", Some(home)), PathBuf::from("/Users/me"));
        assert_eq!(expand_tilde("/abs/codex", Some(home)), PathBuf::from("/abs/codex"));
        assert_eq!(expand_tilde("~/bin/codex", None), PathBuf::from("~/bin/codex"));
    }

    #[test]
    fn nvm_versions_sort_by_semver_not_lexicographically() {
        let dir = tempfile::TempDir::new().unwrap();
        let nvm = dir.path().join(".nvm/versions/node");
        for ver in ["v9.11.2", "v18.20.0", "v22.12.0"] {
            std::fs::create_dir_all(nvm.join(ver).join("bin")).unwrap();
        }
        let env = Environment {
            home: Some(dir.path().to_path_buf()),
            path_var: None,
            appdata: None,
            windows: false,
        };
        let nvm_entries: Vec<PathBuf> = install_locations(&env)
            .into_iter()
            .filter(|p| p.starts_with(&nvm))
            .collect();
        assert_eq!(
            nvm_entries,
            vec![
                nvm.join("v22.12.0/bin/codex"),
                nvm.join("v18.20.0/bin/codex"),
                nvm.join("v9.11.2/bin/codex"),
            ]
        );
    }
}
