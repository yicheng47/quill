use rusqlite::params;
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::db::Db;
use crate::error::{AppError, AppResult};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Collection {
    pub id: String,
    pub name: String,
    pub book_count: i32,
    pub created_at: String,
}

#[tauri::command]
pub fn list_collections(db: State<'_, Db>) -> AppResult<Vec<Collection>> {
    let conn = db.conn.lock().map_err(|e| AppError::Other(e.to_string()))?;
    let mut stmt = conn.prepare(
        "SELECT c.id, c.name, c.created_at, COUNT(cb.book_id) as book_count
         FROM collections c
         LEFT JOIN collection_books cb ON c.id = cb.collection_id
         GROUP BY c.id
         ORDER BY c.name",
    )?;
    let collections = stmt
        .query_map([], |row| {
            Ok(Collection {
                id: row.get(0)?,
                name: row.get(1)?,
                created_at: row.get(2)?,
                book_count: row.get(3)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(collections)
}

#[tauri::command]
pub fn create_collection(name: String, db: State<'_, Db>) -> AppResult<Collection> {
    let conn = db.conn.lock().map_err(|e| AppError::Other(e.to_string()))?;
    let id = uuid::Uuid::new_v4().to_string();
    let now = chrono::Utc::now().to_rfc3339();

    conn.execute(
        "INSERT INTO collections (id, name, created_at) VALUES (?1, ?2, ?3)",
        params![id, name, now],
    )?;

    Ok(Collection {
        id,
        name,
        book_count: 0,
        created_at: now,
    })
}

#[tauri::command]
pub fn delete_collection(id: String, db: State<'_, Db>) -> AppResult<()> {
    let conn = db.conn.lock().map_err(|e| AppError::Other(e.to_string()))?;
    conn.execute("DELETE FROM collections WHERE id = ?1", params![id])?;
    Ok(())
}

#[tauri::command]
pub fn add_book_to_collection(
    collection_id: String,
    book_id: String,
    db: State<'_, Db>,
) -> AppResult<()> {
    let conn = db.conn.lock().map_err(|e| AppError::Other(e.to_string()))?;
    conn.execute(
        "INSERT OR IGNORE INTO collection_books (collection_id, book_id) VALUES (?1, ?2)",
        params![collection_id, book_id],
    )?;
    Ok(())
}

#[tauri::command]
pub fn remove_book_from_collection(
    collection_id: String,
    book_id: String,
    db: State<'_, Db>,
) -> AppResult<()> {
    let conn = db.conn.lock().map_err(|e| AppError::Other(e.to_string()))?;
    conn.execute(
        "DELETE FROM collection_books WHERE collection_id = ?1 AND book_id = ?2",
        params![collection_id, book_id],
    )?;
    Ok(())
}

#[tauri::command]
pub fn list_books_in_collection(
    collection_id: String,
    db: State<'_, Db>,
) -> AppResult<Vec<String>> {
    let conn = db.conn.lock().map_err(|e| AppError::Other(e.to_string()))?;
    let mut stmt = conn.prepare(
        "SELECT book_id FROM collection_books WHERE collection_id = ?1",
    )?;
    let book_ids = stmt
        .query_map(params![collection_id], |row| row.get(0))?
        .collect::<Result<Vec<String>, _>>()?;
    Ok(book_ids)
}
