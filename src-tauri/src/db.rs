use rusqlite::Connection;
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

use crate::error::AppResult;

pub struct Db {
    pub conn: Mutex<Connection>,
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

        Ok(Self {
            conn: Mutex::new(conn),
        })
    }
}
