use rusqlite::{params, Connection};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use crate::error::AppResult;

pub struct Db {
    pub conn: Mutex<Connection>,
    pub data_dir: Mutex<PathBuf>,
}

impl Db {
    pub fn init(app_data_dir: &PathBuf) -> AppResult<Self> {
        fs::create_dir_all(app_data_dir)?;
        fs::create_dir_all(app_data_dir.join("books"))?;
        fs::create_dir_all(app_data_dir.join("covers"))?;

        let db_path = app_data_dir.join("quill.db");
        let conn = Connection::open(&db_path)?;

        conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;")?;

        let schema = include_str!("../migrations/001_init.sql");
        conn.execute_batch(schema)?;

        // One-time migration: convert absolute paths to relative
        Self::migrate_to_relative_paths(&conn, app_data_dir)?;

        Ok(Self {
            conn: Mutex::new(conn),
            data_dir: Mutex::new(app_data_dir.clone()),
        })
    }

    /// Resolve a relative path (e.g. "books/abc.epub") to an absolute path using data_dir.
    /// If the path is already absolute, returns it as-is.
    pub fn resolve_path(&self, relative: &str) -> PathBuf {
        let path = Path::new(relative);
        if path.is_absolute() {
            path.to_path_buf()
        } else {
            self.data_dir.lock().unwrap().join(relative)
        }
    }

    /// Migrate existing absolute paths in the books table to relative paths.
    fn migrate_to_relative_paths(conn: &Connection, data_dir: &Path) -> AppResult<()> {
        let prefix = format!(
            "{}/",
            data_dir.to_string_lossy().trim_end_matches('/')
        );

        let mut stmt = conn.prepare(
            "SELECT id, file_path, cover_path FROM books WHERE file_path LIKE '/%'",
        )?;
        let rows: Vec<(String, String, Option<String>)> = stmt
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?
            .collect::<Result<Vec<_>, _>>()?;

        for (id, file_path, cover_path) in rows {
            let rel_file = match file_path.strip_prefix(&prefix) {
                Some(rel) => rel.to_string(),
                None => file_path,
            };
            let rel_cover = cover_path.map(|c| match c.strip_prefix(&prefix) {
                Some(rel) => rel.to_string(),
                None => c,
            });

            conn.execute(
                "UPDATE books SET file_path = ?1, cover_path = ?2 WHERE id = ?3",
                params![rel_file, rel_cover, id],
            )?;
        }

        Ok(())
    }
}
