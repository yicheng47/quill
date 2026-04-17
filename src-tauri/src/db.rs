use rusqlite::{params, Connection};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

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
    (9, include_str!("../migrations/009_normalize_timestamps.sql")),
    (10, include_str!("../migrations/010_replay_state.sql")),
    (11, include_str!("../migrations/011_lww_tiebreak_and_outbox.sql")),
];

/// SQLite handle for the local materialized view.
///
/// `conn` and `data_dir` live behind `Arc<Mutex<…>>` so `Db` is cheaply
/// `Clone`-able. Cloning shares the underlying mutex; the sync watcher
/// holds one clone in its dedicated thread while Tauri's command
/// dispatcher holds another in app state. Without the `Arc` we would
/// either force every command signature to switch to `State<Arc<Db>>`
/// or push `app_handle.state::<Db>()` indirection into the watcher
/// loop — both worse than this two-line shape change.
pub struct Db {
    pub conn: Arc<Mutex<Connection>>,
    pub data_dir: Arc<Mutex<PathBuf>>,
}

impl Clone for Db {
    fn clone(&self) -> Self {
        Self {
            conn: Arc::clone(&self.conn),
            data_dir: Arc::clone(&self.data_dir),
        }
    }
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
            conn: Arc::new(Mutex::new(conn)),
            data_dir: Arc::new(Mutex::new(app_data_dir.clone())),
        })
    }

    fn run_migrations(conn: &Connection) -> AppResult<()> {
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL);",
        )?;

        let mut current: i64 = conn
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
                // Advance schema_version per migration, so a failure in a later
                // migration doesn't force successful earlier ones to re-run.
                conn.execute("DELETE FROM schema_version", [])?;
                conn.execute(
                    "INSERT INTO schema_version (version) VALUES (?1)",
                    params![version],
                )?;
                current = version;
            }
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

    /// Run migrations on an already-open connection. Public so the sync
    /// snapshot module can spin up an in-memory DB to materialize state
    /// without going through `Db::init` (which assumes a real on-disk
    /// data dir layout).
    pub fn run_migrations_on(conn: &Connection) -> AppResult<()> {
        Self::run_migrations(conn)
    }

    /// Run migrations up to (and including) `max_version`. For tests that need
    /// to seed data at a specific schema version before applying a later migration.
    #[cfg(test)]
    pub fn run_migrations_up_to(conn: &Connection, max_version: i64) -> AppResult<()> {
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL);",
        )?;

        let mut current: i64 = conn
            .query_row("SELECT COALESCE(MAX(version), 0) FROM schema_version", [], |r| {
                r.get(0)
            })
            .unwrap_or(0);

        for &(version, sql) in MIGRATIONS {
            if version > max_version {
                break;
            }
            if version > current {
                if version == 4 || version == 5 {
                    let _ = conn.execute_batch(sql);
                } else {
                    conn.execute_batch(sql)?;
                }
                conn.execute("DELETE FROM schema_version", [])?;
                conn.execute(
                    "INSERT INTO schema_version (version) VALUES (?1)",
                    params![version],
                )?;
                current = version;
            }
        }

        Ok(())
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
        assert_eq!(version, 11);
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
        assert!(tables.contains(&"_replay_state".to_string()));
        assert!(tables.contains(&"_tombstones".to_string()));
        assert!(tables.contains(&"_pending_publish".to_string()));
    }

    #[test]
    fn test_idempotent_migrations() {
        let (_dir, db) = setup();
        // Running init again should not fail
        let conn = db.conn.lock().unwrap();
        Db::run_migrations_on(&conn).unwrap();
        let version: i64 =
            conn.query_row("SELECT version FROM schema_version", [], |r| r.get(0)).unwrap();
        assert_eq!(version, 11);
    }

    #[test]
    fn test_books_has_format_column() {
        let (_dir, db) = setup();
        let conn = db.conn.lock().unwrap();
        let now_ms = chrono::Utc::now().timestamp_millis();
        // Insert without format — should default to 'epub'
        conn.execute(
            "INSERT INTO books (id, title, author, file_path, status, progress, created_at, updated_at)
             VALUES ('b1', 'Test', 'Author', 'books/test.epub', 'reading', 0, ?1, ?1)",
            params![now_ms],
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

    // -----------------------------------------------------------------------
    // Migration 009 integrity — TEXT → INTEGER millis conversion.
    //
    // These tests seed a v8 DB with realistic RFC-3339 strings matching every
    // precision chrono's to_rfc3339() emits (bare, .SSS, nanosecond, `Z` vs
    // `+00:00` suffix), run migration 9 via the framework, and verify each
    // row's INTEGER value equals `DateTime::parse_from_rfc3339(orig).timestamp_millis()`.
    // -----------------------------------------------------------------------

    fn rfc3339_to_millis(s: &str) -> i64 {
        chrono::DateTime::parse_from_rfc3339(s)
            .unwrap_or_else(|_| panic!("test bug: malformed RFC-3339: {s}"))
            .timestamp_millis()
    }

    fn seed_v8(dir: &TempDir) -> Connection {
        let conn = Connection::open(dir.path().join("quill.db")).unwrap();
        conn.execute_batch("PRAGMA journal_mode=DELETE; PRAGMA foreign_keys=ON;").unwrap();
        Db::run_migrations_up_to(&conn, 8).unwrap();
        conn
    }

    #[test]
    fn test_migration_009_converts_book_timestamps() {
        let dir = TempDir::new().unwrap();
        let conn = seed_v8(&dir);

        // Cover every format chrono to_rfc3339() can emit.
        let ts_bare      = "2024-01-15T12:34:56+00:00";           // no sub-second
        let ts_millis    = "2024-06-15T12:34:56.789+00:00";       // 3 digits
        let ts_nanos     = "2026-03-10T08:15:30.123456789+00:00"; // 9 digits
        let ts_z         = "2025-12-25T00:00:00Z";                // Z suffix, no frac
        let ts_z_millis  = "2025-12-25T00:00:00.500Z";            // Z suffix with millis

        for (id, c, u) in [
            ("b1", ts_bare, ts_millis),
            ("b2", ts_nanos, ts_z),
            ("b3", ts_z_millis, ts_bare),
        ] {
            conn.execute(
                "INSERT INTO books (id, title, author, file_path, status, progress, created_at, updated_at)
                 VALUES (?1, 'T', 'A', 'books/x.epub', 'reading', 0, ?2, ?3)",
                params![id, c, u],
            ).unwrap();
        }

        Db::run_migrations_up_to(&conn, 9).unwrap();

        // Verify column types are INTEGER.
        let (ty_c, ty_u): (String, String) = {
            let mut types = std::collections::HashMap::new();
            let mut stmt = conn.prepare("PRAGMA table_info(books)").unwrap();
            let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(1)?, r.get::<_, String>(2)?))).unwrap();
            for row in rows {
                let (n, t) = row.unwrap();
                types.insert(n, t);
            }
            (types.remove("created_at").unwrap(), types.remove("updated_at").unwrap())
        };
        assert_eq!(ty_c, "INTEGER");
        assert_eq!(ty_u, "INTEGER");

        // Verify values.
        for (id, expected_c, expected_u) in [
            ("b1", rfc3339_to_millis(ts_bare), rfc3339_to_millis(ts_millis)),
            ("b2", rfc3339_to_millis(ts_nanos), rfc3339_to_millis(ts_z)),
            ("b3", rfc3339_to_millis(ts_z_millis), rfc3339_to_millis(ts_bare)),
        ] {
            let (c, u): (i64, i64) = conn.query_row(
                "SELECT created_at, updated_at FROM books WHERE id = ?1",
                params![id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            ).unwrap();
            assert_eq!(c, expected_c, "book {id} created_at mismatch");
            assert_eq!(u, expected_u, "book {id} updated_at mismatch");
        }
    }

    #[test]
    fn test_migration_009_adds_updated_at_to_append_only_tables() {
        let dir = TempDir::new().unwrap();
        let conn = seed_v8(&dir);

        // Parent book.
        let book_ts = "2024-01-15T12:34:56+00:00";
        conn.execute(
            "INSERT INTO books (id, title, author, file_path, status, progress, created_at, updated_at)
             VALUES ('b1', 'T', 'A', 'books/x.epub', 'reading', 0, ?1, ?1)",
            params![book_ts],
        ).unwrap();

        // Bookmark, highlight (both had only created_at pre-migration).
        let bm_ts = "2024-02-20T08:00:00+00:00";
        conn.execute(
            "INSERT INTO bookmarks (id, book_id, cfi, created_at)
             VALUES ('bm1', 'b1', 'epubcfi(/6/4!)', ?1)",
            params![bm_ts],
        ).unwrap();
        let hl_ts = "2024-03-01T10:30:45.500+00:00";
        conn.execute(
            "INSERT INTO highlights (id, book_id, cfi_range, color, created_at)
             VALUES ('hl1', 'b1', 'epubcfi(/6/4!/2)', 'yellow', ?1)",
            params![hl_ts],
        ).unwrap();

        // Translation + chat_message (also created_at-only).
        let tr_ts = "2024-04-10T14:15:00+00:00";
        conn.execute(
            "INSERT INTO translations (id, book_id, source_text, translated_text, target_language, created_at)
             VALUES ('tr1', 'b1', 'hello', '你好', 'zh', ?1)",
            params![tr_ts],
        ).unwrap();

        let chat_ts = "2024-05-15T09:00:00+00:00";
        conn.execute(
            "INSERT INTO chats (id, book_id, title, pinned, created_at, updated_at)
             VALUES ('c1', 'b1', 'Chat', 0, ?1, ?1)",
            params![chat_ts],
        ).unwrap();
        let msg_ts = "2024-05-15T09:00:05+00:00";
        conn.execute(
            "INSERT INTO chat_messages (id, chat_id, role, content, created_at)
             VALUES ('m1', 'c1', 'user', 'hi', ?1)",
            params![msg_ts],
        ).unwrap();

        Db::run_migrations_up_to(&conn, 9).unwrap();

        // For append-only tables, updated_at should equal created_at.
        for (sql, expected) in [
            ("SELECT created_at, updated_at FROM bookmarks WHERE id = 'bm1'", rfc3339_to_millis(bm_ts)),
            ("SELECT created_at, updated_at FROM highlights WHERE id = 'hl1'", rfc3339_to_millis(hl_ts)),
            ("SELECT created_at, updated_at FROM translations WHERE id = 'tr1'", rfc3339_to_millis(tr_ts)),
            ("SELECT created_at, updated_at FROM chat_messages WHERE id = 'm1'", rfc3339_to_millis(msg_ts)),
        ] {
            let (c, u): (i64, i64) = conn.query_row(sql, [], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
            assert_eq!(c, expected, "{sql}: created_at mismatch");
            assert_eq!(u, expected, "{sql}: updated_at should equal created_at for append-only tables");
        }
    }

    #[test]
    fn test_migration_009_collection_books_backfilled_with_migration_time() {
        let dir = TempDir::new().unwrap();
        let conn = seed_v8(&dir);

        let book_ts = "2024-01-15T12:34:56+00:00";
        conn.execute(
            "INSERT INTO books (id, title, author, file_path, status, progress, created_at, updated_at)
             VALUES ('b1', 'T', 'A', 'books/x.epub', 'reading', 0, ?1, ?1)",
            params![book_ts],
        ).unwrap();
        let coll_ts = "2024-02-01T00:00:00+00:00";
        conn.execute(
            "INSERT INTO collections (id, name, sort_order, created_at) VALUES ('c1', 'Favorites', 0, ?1)",
            params![coll_ts],
        ).unwrap();
        conn.execute(
            "INSERT INTO collection_books (collection_id, book_id) VALUES ('c1', 'b1')",
            [],
        ).unwrap();

        let before_migrate_ms = chrono::Utc::now().timestamp_millis();
        Db::run_migrations_up_to(&conn, 9).unwrap();
        let after_migrate_ms = chrono::Utc::now().timestamp_millis();

        let (c, u): (i64, i64) = conn.query_row(
            "SELECT created_at, updated_at FROM collection_books WHERE collection_id = 'c1' AND book_id = 'b1'",
            [], |r| Ok((r.get(0)?, r.get(1)?)),
        ).unwrap();
        // Backfilled with migration time — within the bracket [before, after].
        assert!(c >= before_migrate_ms - 1000 && c <= after_migrate_ms + 1000, "created_at {c} not in bracket");
        assert!(u >= before_migrate_ms - 1000 && u <= after_migrate_ms + 1000, "updated_at {u} not in bracket");
    }

    #[test]
    fn test_migration_009_vocab_next_review_nullable_preserved() {
        let dir = TempDir::new().unwrap();
        let conn = seed_v8(&dir);

        let book_ts = "2024-01-15T12:34:56+00:00";
        conn.execute(
            "INSERT INTO books (id, title, author, file_path, status, progress, created_at, updated_at)
             VALUES ('b1', 'T', 'A', 'books/x.epub', 'reading', 0, ?1, ?1)",
            params![book_ts],
        ).unwrap();

        // One vocab with next_review_at set, one without.
        let nr_ts = "2024-07-01T00:00:00+00:00";
        conn.execute(
            "INSERT INTO vocab_words (id, book_id, word, definition, mastery, review_count, next_review_at, created_at, updated_at)
             VALUES ('v1', 'b1', 'hello', 'greeting', 'new', 0, ?1, ?2, ?2)",
            params![nr_ts, book_ts],
        ).unwrap();
        conn.execute(
            "INSERT INTO vocab_words (id, book_id, word, definition, mastery, review_count, next_review_at, created_at, updated_at)
             VALUES ('v2', 'b1', 'world', 'planet', 'new', 0, NULL, ?1, ?1)",
            params![book_ts],
        ).unwrap();

        Db::run_migrations_up_to(&conn, 9).unwrap();

        let nr1: Option<i64> = conn.query_row(
            "SELECT next_review_at FROM vocab_words WHERE id = 'v1'", [], |r| r.get(0),
        ).unwrap();
        let nr2: Option<i64> = conn.query_row(
            "SELECT next_review_at FROM vocab_words WHERE id = 'v2'", [], |r| r.get(0),
        ).unwrap();
        assert_eq!(nr1, Some(rfc3339_to_millis(nr_ts)));
        assert_eq!(nr2, None);
    }

    #[test]
    fn test_migration_009_preserves_row_counts_and_fk_integrity() {
        let dir = TempDir::new().unwrap();
        let conn = seed_v8(&dir);

        // Seed every table with some rows.
        let ts = "2024-06-15T12:00:00+00:00";
        for i in 0..5 {
            conn.execute(
                "INSERT INTO books (id, title, author, file_path, status, progress, created_at, updated_at)
                 VALUES (?1, 'T', 'A', 'books/x.epub', 'reading', 0, ?2, ?2)",
                params![format!("b{i}"), ts],
            ).unwrap();
        }
        for i in 0..3 {
            conn.execute(
                "INSERT INTO bookmarks (id, book_id, cfi, created_at) VALUES (?1, 'b0', 'cfi', ?2)",
                params![format!("bm{i}"), ts],
            ).unwrap();
        }
        for i in 0..4 {
            conn.execute(
                "INSERT INTO highlights (id, book_id, cfi_range, color, created_at) VALUES (?1, 'b1', 'cfi', 'yellow', ?2)",
                params![format!("hl{i}"), ts],
            ).unwrap();
        }
        conn.execute(
            "INSERT INTO collections (id, name, sort_order, created_at) VALUES ('c1', 'Top', 0, ?1)",
            params![ts],
        ).unwrap();
        conn.execute(
            "INSERT INTO collection_books (collection_id, book_id) VALUES ('c1', 'b0'), ('c1', 'b1')",
            [],
        ).unwrap();

        let counts_before: Vec<(String, i64)> = [
            "books", "bookmarks", "highlights", "collections", "collection_books",
            "vocab_words", "chats", "chat_messages", "translations",
        ]
        .iter()
        .map(|t| {
            let n: i64 = conn
                .query_row(&format!("SELECT COUNT(*) FROM {t}"), [], |r| r.get(0))
                .unwrap();
            (t.to_string(), n)
        })
        .collect();

        Db::run_migrations_up_to(&conn, 9).unwrap();

        // Row counts unchanged.
        for (t, expected) in counts_before {
            let n: i64 = conn
                .query_row(&format!("SELECT COUNT(*) FROM {t}"), [], |r| r.get(0))
                .unwrap();
            assert_eq!(n, expected, "{t} row count changed");
        }

        // FK integrity post-migration.
        conn.execute_batch("PRAGMA foreign_keys = ON;").unwrap();
        let violations: i64 = conn
            .query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |r| r.get(0))
            .unwrap();
        assert_eq!(violations, 0, "foreign key violations after migration");
    }

    // -----------------------------------------------------------------------
    // Migration 011 integrity — `updated_by_device` backfill + `_pending_publish`
    // creation. Seeds a v10 DB with rows on every LWW-backed table, runs 011,
    // verifies the new column defaults to 'migration' on every legacy row and
    // the outbox is empty.
    // -----------------------------------------------------------------------

    #[test]
    fn test_migration_011_backfills_updated_by_device_and_creates_outbox() {
        let dir = TempDir::new().unwrap();
        let conn = Connection::open(dir.path().join("quill.db")).unwrap();
        conn.execute_batch("PRAGMA journal_mode=DELETE; PRAGMA foreign_keys=ON;").unwrap();
        Db::run_migrations_up_to(&conn, 10).unwrap();

        let ts = chrono::Utc::now().timestamp_millis();

        // Seed one row on every LWW-backed table (parents first).
        conn.execute(
            "INSERT INTO books (id, title, author, file_path, status, progress, created_at, updated_at)
             VALUES ('b1', 'T', 'A', 'books/x.epub', 'reading', 0, ?1, ?1)",
            params![ts],
        ).unwrap();
        conn.execute(
            "INSERT INTO collections (id, name, sort_order, created_at, updated_at) VALUES ('c1', 'Top', 0, ?1, ?1)",
            params![ts],
        ).unwrap();
        conn.execute(
            "INSERT INTO collection_books (collection_id, book_id, created_at, updated_at) VALUES ('c1', 'b1', ?1, ?1)",
            params![ts],
        ).unwrap();
        conn.execute(
            "INSERT INTO highlights (id, book_id, cfi_range, color, created_at, updated_at)
             VALUES ('h1', 'b1', 'epubcfi(/6/4!/2)', 'yellow', ?1, ?1)",
            params![ts],
        ).unwrap();
        conn.execute(
            "INSERT INTO vocab_words (id, book_id, word, definition, mastery, review_count, created_at, updated_at)
             VALUES ('v1', 'b1', 'serendipity', 'fortunate accident', 'new', 0, ?1, ?1)",
            params![ts],
        ).unwrap();
        conn.execute(
            "INSERT INTO chats (id, book_id, title, pinned, created_at, updated_at)
             VALUES ('ch1', 'b1', 'New chat', 0, ?1, ?1)",
            params![ts],
        ).unwrap();

        // Apply migration 011.
        Db::run_migrations_up_to(&conn, 11).unwrap();

        // Every legacy row got the sentinel.
        for (sql, expected) in [
            ("SELECT updated_by_device FROM books WHERE id = 'b1'", "migration"),
            ("SELECT updated_by_device FROM collections WHERE id = 'c1'", "migration"),
            ("SELECT updated_by_device FROM collection_books WHERE collection_id = 'c1' AND book_id = 'b1'", "migration"),
            ("SELECT updated_by_device FROM highlights WHERE id = 'h1'", "migration"),
            ("SELECT updated_by_device FROM vocab_words WHERE id = 'v1'", "migration"),
            ("SELECT updated_by_device FROM chats WHERE id = 'ch1'", "migration"),
        ] {
            let got: String = conn.query_row(sql, [], |r| r.get(0)).unwrap();
            assert_eq!(got, expected, "{sql}");
        }

        // Column declared NOT NULL — INSERT without it should fail.
        let err = conn.execute(
            "INSERT INTO highlights (id, book_id, cfi_range, color, created_at, updated_at, updated_by_device)
             VALUES ('h2', 'b1', 'epubcfi(/6/4!/4)', 'pink', ?1, ?1, NULL)",
            params![ts],
        );
        assert!(err.is_err(), "NULL into NOT NULL column should fail");

        // _pending_publish exists and is empty.
        let outbox_count: i64 =
            conn.query_row("SELECT COUNT(*) FROM _pending_publish", [], |r| r.get(0)).unwrap();
        assert_eq!(outbox_count, 0);

        // schema_version advanced.
        let v: i64 = conn.query_row("SELECT version FROM schema_version", [], |r| r.get(0)).unwrap();
        assert_eq!(v, 11);
    }

    #[test]
    fn test_migration_009_malformed_timestamp_rolls_back() {
        let dir = TempDir::new().unwrap();
        let conn = seed_v8(&dir);

        let ts = "2024-06-15T12:00:00+00:00";
        conn.execute(
            "INSERT INTO books (id, title, author, file_path, status, progress, created_at, updated_at)
             VALUES ('b1', 'T', 'A', 'books/x.epub', 'reading', 0, ?1, ?1)",
            params![ts],
        ).unwrap();
        // Inject a malformed timestamp — julianday returns NULL, the NOT NULL
        // INSERT fails, the whole migration rolls back.
        conn.execute(
            "INSERT INTO books (id, title, author, file_path, status, progress, created_at, updated_at)
             VALUES ('b2', 'Bad', 'A', 'books/y.epub', 'reading', 0, 'not a date', ?1)",
            params![ts],
        ).unwrap();

        let result = Db::run_migrations_up_to(&conn, 9);
        assert!(result.is_err(), "migration should fail on malformed timestamp");

        // Schema is unchanged: created_at is still TEXT, both rows still present.
        let ty: String = conn.query_row(
            "SELECT type FROM pragma_table_info('books') WHERE name = 'created_at'",
            [], |r| r.get(0),
        ).unwrap();
        assert_eq!(ty, "TEXT", "books.created_at should still be TEXT after rollback");

        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM books", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 2, "rows should still be present after rollback");

        // schema_version should still be 8.
        let v: i64 = conn
            .query_row("SELECT version FROM schema_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(v, 8, "schema_version should not advance on failed migration");
    }
}
