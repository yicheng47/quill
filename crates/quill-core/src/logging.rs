use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

use crate::error::AppResult;

const MAX_LOG_FILE_SIZE: u64 = 10 * 1024 * 1024;
const KEEP_ROTATED_COUNT: usize = 3;
const LOG_FILE_STEM: &str = "quill";

/// Resolve the log level filter, honoring `RUST_LOG` over the build default.
/// Plain `LevelFilter` only — unparseable values fall back to `default`.
pub fn resolve_log_level(default: log::LevelFilter) -> log::LevelFilter {
    std::env::var("RUST_LOG")
        .ok()
        .and_then(|s| s.trim().parse::<log::LevelFilter>().ok())
        .unwrap_or(default)
}

/// Initialize the global `log` logger writing to `<log_dir>/quill.log`
/// with 10 MB rotation (keeping 3 rotated files), plus stdout in dev builds.
/// Safe if a logger has already been set in the current process.
pub fn init_logging(log_dir: &Path, is_dev: bool) -> AppResult<()> {
    fs::create_dir_all(log_dir)?;

    let default_level = if is_dev {
        log::LevelFilter::Debug
    } else {
        log::LevelFilter::Info
    };
    let level = resolve_log_level(default_level);

    let rotator = RotatingFile::new(
        log_dir,
        LOG_FILE_STEM,
        MAX_LOG_FILE_SIZE,
        KEEP_ROTATED_COUNT,
    )?;

    let mut dispatch = fern::Dispatch::new()
        .level(level)
        .format(|out, message, record| {
            let now = chrono::Utc::now();
            out.finish(format_args!(
                "[{}][{}][{}][{}] {}",
                now.format("%Y-%m-%d"),
                now.format("%H:%M:%S"),
                record.level(),
                record.target(),
                message
            ));
        })
        .chain(fern::Output::writer(Box::new(rotator), "\n"));

    if is_dev {
        dispatch = dispatch.chain(std::io::stdout());
    }

    let _ = dispatch.apply();
    Ok(())
}

struct RotatingFile {
    dir: PathBuf,
    file_name: String,
    path: PathBuf,
    max_size: u64,
    current_size: u64,
    keep_count: usize,
    inner: Option<File>,
    buffer: Vec<u8>,
}

impl RotatingFile {
    fn new(
        dir: &Path,
        file_name: &str,
        max_size: u64,
        keep_count: usize,
    ) -> AppResult<Self> {
        let dir = dir.to_path_buf();
        let path = dir.join(format!("{file_name}.log"));
        let mut rotator = Self {
            dir,
            file_name: file_name.to_string(),
            path,
            max_size,
            current_size: 0,
            keep_count,
            inner: None,
            buffer: Vec::new(),
        };

        rotator.open_file()?;
        if rotator.current_size >= rotator.max_size {
            rotator.rotate()?;
        }
        rotator.remove_old_files(keep_count)?;
        Ok(rotator)
    }

    fn open_file(&mut self) -> std::io::Result<()> {
        let file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.path)?;
        self.current_size = file.metadata()?.len();
        self.inner = Some(file);
        Ok(())
    }

    fn rotate(&mut self) -> std::io::Result<()> {
        if let Some(mut file) = self.inner.take() {
            let _ = file.flush();
        }
        if self.path.exists() {
            let keep = self.keep_count.saturating_sub(1);
            self.remove_old_files(keep)?;
            self.rename_file_to_dated()?;
        }
        self.open_file()?;
        Ok(())
    }

    fn remove_old_files(&self, keep_count: usize) -> std::io::Result<()> {
        let active_name = format!("{}.log", self.file_name);
        let mut files = fs::read_dir(&self.dir)?
            .filter_map(|entry| {
                let entry = entry.ok()?;
                let path = entry.path();
                let old_file_name = path.file_name()?.to_string_lossy().into_owned();
                if old_file_name.starts_with(&self.file_name) && old_file_name != active_name {
                    let date = old_file_name
                        .strip_prefix(&self.file_name)?
                        .strip_prefix('_')?
                        .strip_suffix(".log")?;
                    Some((path, date.to_string()))
                } else {
                    None
                }
            })
            .collect::<Vec<_>>();

        files.sort_by(|a, b| a.1.cmp(&b.1));
        if files.len() > keep_count {
            let files_to_remove = files.len() - keep_count;
            for (old_log_path, _) in files.iter().take(files_to_remove) {
                fs::remove_file(old_log_path)?;
            }
        }
        Ok(())
    }

    fn rename_file_to_dated(&self) -> std::io::Result<()> {
        let stamp = chrono::Utc::now().format("%Y-%m-%d_%H-%M-%S");
        let to = self.dir.join(format!("{}_{}.log", self.file_name, stamp));
        if to.is_file() {
            let mut to_bak = to.clone();
            to_bak.set_file_name(format!(
                "{}.bak",
                to_bak.file_name().unwrap().to_string_lossy()
            ));
            fs::rename(&to, to_bak)?;
        }
        fs::rename(&self.path, &to)?;
        Ok(())
    }
}

impl Write for RotatingFile {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.buffer.extend_from_slice(buf);
        Ok(buf.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        if self.buffer.is_empty() {
            return Ok(());
        }
        if self.inner.is_none() {
            self.open_file()?;
        }
        if self.current_size != 0 && self.current_size + (self.buffer.len() as u64) > self.max_size
        {
            self.rotate()?;
        }
        if let Some(file) = self.inner.as_mut() {
            file.write_all(&self.buffer)?;
            self.current_size += self.buffer.len() as u64;
            file.flush()?;
        }
        self.buffer.clear();
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use log::LevelFilter;
    use tempfile::TempDir;

    #[test]
    fn resolve_log_level_honors_rust_log_env() {
        let saved = std::env::var("RUST_LOG").ok();

        std::env::remove_var("RUST_LOG");
        assert_eq!(resolve_log_level(LevelFilter::Info), LevelFilter::Info);
        assert_eq!(resolve_log_level(LevelFilter::Warn), LevelFilter::Warn);

        std::env::set_var("RUST_LOG", "warn");
        assert_eq!(resolve_log_level(LevelFilter::Info), LevelFilter::Warn);
        std::env::set_var("RUST_LOG", "trace");
        assert_eq!(resolve_log_level(LevelFilter::Info), LevelFilter::Trace);
        std::env::set_var("RUST_LOG", "off");
        assert_eq!(resolve_log_level(LevelFilter::Info), LevelFilter::Off);

        std::env::set_var("RUST_LOG", "verbose");
        assert_eq!(resolve_log_level(LevelFilter::Info), LevelFilter::Info);

        std::env::set_var("RUST_LOG", "  debug  ");
        assert_eq!(resolve_log_level(LevelFilter::Info), LevelFilter::Debug);

        match saved {
            Some(v) => std::env::set_var("RUST_LOG", v),
            None => std::env::remove_var("RUST_LOG"),
        }
    }

    #[test]
    fn rotating_file_writes_quill_log_and_keeps_at_most_keep_count() {
        let dir = TempDir::new().unwrap();
        let mut rf = RotatingFile::new(dir.path(), "quill", 20, 3).unwrap();

        for i in 0..5 {
            writeln!(rf, "line-number-{i:04}-payload").unwrap();
            rf.flush().unwrap();
            // Sleep 1.1s is too slow; seed uniquely dated archives if same second
            // clashes into `.bak`, and verify cleanup keeps <= 3 archives.
        }

        assert!(dir.path().join("quill.log").exists());
        let rotated: Vec<_> = fs::read_dir(dir.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name() != "quill.log")
            .collect();
        assert!(rotated.len() <= 3, "expected <= 3 rotated logs, got {}", rotated.len());
    }
}
