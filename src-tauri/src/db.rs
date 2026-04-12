use rusqlite::{params, Connection};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use crate::error::AppResult;

const MIGRATIONS: &[(i64, &str)] = &[
    (1, include_str!("../migrations/001_init.sql")),
    (2, include_str!("../migrations/002_vocab.sql")),
    (3, include_str!("../migrations/003_chats.sql")),
    (4, include_str!("../migrations/004_pdf_support.sql")),
    (5, include_str!("../migrations/005_collection_sort_order.sql")),
    (6, include_str!("../migrations/006_translations.sql")),
    (7, include_str!("../migrations/007_book_settings.sql")),
    (8, include_str!("../migrations/008_drop_book_settings.sql")),
];

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

        conn.execute_batch("PRAGMA journal_mode=DELETE; PRAGMA foreign_keys=ON;")?;

        Self::run_migrations(&conn)?;

        // One-time migration: convert absolute paths to relative
        Self::migrate_to_relative_paths(&conn, app_data_dir)?;

        Ok(Self {
            conn: Mutex::new(conn),
            data_dir: Mutex::new(app_data_dir.clone()),
        })
    }

    fn run_migrations(conn: &Connection) -> AppResult<()> {
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL);",
        )?;

        let current: i64 = conn
            .query_row("SELECT COALESCE(MAX(version), 0) FROM schema_version", [], |r| {
                r.get(0)
            })
            .unwrap_or(0);

        for &(version, sql) in MIGRATIONS {
            if version > current {
                // ALTER TABLE migrations may fail if column already exists
                if version == 4 || version == 5 {
                    let _ = conn.execute_batch(sql);
                } else {
                    conn.execute_batch(sql)?;
                }
            }
        }

        // Set version to the latest migration
        let latest = MIGRATIONS.last().map(|(v, _)| *v).unwrap_or(0);
        if latest > current {
            conn.execute("DELETE FROM schema_version", [])?;
            conn.execute(
                "INSERT INTO schema_version (version) VALUES (?1)",
                params![latest],
            )?;
        }

        Ok(())
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

    /// Run migrations on an already-open connection (for testing).
    #[cfg(test)]
    pub fn run_migrations_on(conn: &Connection) -> AppResult<()> {
        Self::run_migrations(conn)
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

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn setup() -> (TempDir, Db) {
        let dir = TempDir::new().unwrap();
        let db = Db::init(&dir.path().to_path_buf()).unwrap();
        (dir, db)
    }

    #[test]
    fn test_fresh_db_creates_schema_version() {
        let (_dir, db) = setup();
        let conn = db.conn.lock().unwrap();
        let version: i64 =
            conn.query_row("SELECT version FROM schema_version", [], |r| r.get(0)).unwrap();
        assert_eq!(version, 8);
    }

    #[test]
    fn test_fresh_db_creates_all_tables() {
        let (_dir, db) = setup();
        let conn = db.conn.lock().unwrap();
        let tables: Vec<String> = conn
            .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert!(tables.contains(&"books".to_string()));
        assert!(tables.contains(&"settings".to_string()));
        assert!(tables.contains(&"highlights".to_string()));
        assert!(tables.contains(&"vocab_words".to_string()));
        assert!(tables.contains(&"chats".to_string()));
        assert!(tables.contains(&"chat_messages".to_string()));
        assert!(tables.contains(&"translations".to_string()));
        assert!(tables.contains(&"book_settings".to_string()));
        assert!(tables.contains(&"schema_version".to_string()));
    }

    #[test]
    fn test_idempotent_migrations() {
        let (_dir, db) = setup();
        // Running init again should not fail
        let conn = db.conn.lock().unwrap();
        Db::run_migrations_on(&conn).unwrap();
        let version: i64 =
            conn.query_row("SELECT version FROM schema_version", [], |r| r.get(0)).unwrap();
        assert_eq!(version, 8);
    }

    #[test]
    fn test_books_has_format_column() {
        let (_dir, db) = setup();
        let conn = db.conn.lock().unwrap();
        let now = chrono::Utc::now().to_rfc3339();
        // Insert without format — should default to 'epub'
        conn.execute(
            "INSERT INTO books (id, title, author, file_path, status, progress, created_at, updated_at)
             VALUES ('b1', 'Test', 'Author', 'books/test.epub', 'reading', 0, ?1, ?1)",
            params![now],
        )
        .unwrap();
        let format: String =
            conn.query_row("SELECT format FROM books WHERE id = 'b1'", [], |r| r.get(0)).unwrap();
        assert_eq!(format, "epub");
    }

    #[test]
    fn test_schema_version_count() {
        let (_dir, db) = setup();
        let conn = db.conn.lock().unwrap();
        // Should have exactly one row
        let count: i64 =
            conn.query_row("SELECT COUNT(*) FROM schema_version", [], |r| r.get(0)).unwrap();
        assert_eq!(count, 1);
    }
}
