use rusqlite::params;
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::db::Db;
use crate::error::{AppError, AppResult};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Bookmark {
    pub id: String,
    pub book_id: String,
    pub cfi: String,
    pub label: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Highlight {
    pub id: String,
    pub book_id: String,
    pub cfi_range: String,
    pub color: String,
    pub note: Option<String>,
    pub text_content: Option<String>,
    pub created_at: String,
}

#[tauri::command]
pub fn add_bookmark(
    book_id: String,
    cfi: String,
    label: Option<String>,
    db: State<'_, Db>,
) -> AppResult<Bookmark> {
    let conn = db.conn.lock().map_err(|e| AppError::Other(e.to_string()))?;
    let id = uuid::Uuid::new_v4().to_string();
    let now = chrono::Utc::now().to_rfc3339();

    conn.execute(
        "INSERT INTO bookmarks (id, book_id, cfi, label, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![id, book_id, cfi, label, now],
    )?;

    Ok(Bookmark {
        id,
        book_id,
        cfi,
        label,
        created_at: now,
    })
}

#[tauri::command]
pub fn remove_bookmark(id: String, db: State<'_, Db>) -> AppResult<()> {
    let conn = db.conn.lock().map_err(|e| AppError::Other(e.to_string()))?;
    conn.execute("DELETE FROM bookmarks WHERE id = ?1", params![id])?;
    Ok(())
}

#[tauri::command]
pub fn list_bookmarks(book_id: String, db: State<'_, Db>) -> AppResult<Vec<Bookmark>> {
    let conn = db.conn.lock().map_err(|e| AppError::Other(e.to_string()))?;
    let mut stmt = conn.prepare(
        "SELECT id, book_id, cfi, label, created_at FROM bookmarks WHERE book_id = ?1 ORDER BY created_at DESC",
    )?;
    let bookmarks = stmt
        .query_map(params![book_id], |row| {
            Ok(Bookmark {
                id: row.get(0)?,
                book_id: row.get(1)?,
                cfi: row.get(2)?,
                label: row.get(3)?,
                created_at: row.get(4)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(bookmarks)
}

#[tauri::command]
pub fn add_highlight(
    book_id: String,
    cfi_range: String,
    color: Option<String>,
    note: Option<String>,
    text_content: Option<String>,
    db: State<'_, Db>,
) -> AppResult<Highlight> {
    let conn = db.conn.lock().map_err(|e| AppError::Other(e.to_string()))?;
    let id = uuid::Uuid::new_v4().to_string();
    let now = chrono::Utc::now().to_rfc3339();
    let color = color.unwrap_or_else(|| "yellow".to_string());

    conn.execute(
        "INSERT INTO highlights (id, book_id, cfi_range, color, note, text_content, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![id, book_id, cfi_range, color, note, text_content, now],
    )?;

    Ok(Highlight {
        id,
        book_id,
        cfi_range,
        color,
        note,
        text_content,
        created_at: now,
    })
}

#[tauri::command]
pub fn remove_highlight(id: String, db: State<'_, Db>) -> AppResult<()> {
    let conn = db.conn.lock().map_err(|e| AppError::Other(e.to_string()))?;
    conn.execute("DELETE FROM highlights WHERE id = ?1", params![id])?;
    Ok(())
}

#[tauri::command]
pub fn list_highlights(book_id: String, db: State<'_, Db>) -> AppResult<Vec<Highlight>> {
    let conn = db.conn.lock().map_err(|e| AppError::Other(e.to_string()))?;
    let mut stmt = conn.prepare(
        "SELECT id, book_id, cfi_range, color, note, text_content, created_at FROM highlights WHERE book_id = ?1 ORDER BY created_at DESC",
    )?;
    let highlights = stmt
        .query_map(params![book_id], |row| {
            Ok(Highlight {
                id: row.get(0)?,
                book_id: row.get(1)?,
                cfi_range: row.get(2)?,
                color: row.get(3)?,
                note: row.get(4)?,
                text_content: row.get(5)?,
                created_at: row.get(6)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(highlights)
}

#[tauri::command]
pub fn update_highlight_note(id: String, note: String, db: State<'_, Db>) -> AppResult<()> {
    let conn = db.conn.lock().map_err(|e| AppError::Other(e.to_string()))?;
    conn.execute(
        "UPDATE highlights SET note = ?1 WHERE id = ?2",
        params![note, id],
    )?;
    Ok(())
}

#[tauri::command]
pub fn update_highlight_color(id: String, color: String, db: State<'_, Db>) -> AppResult<()> {
    let conn = db.conn.lock().map_err(|e| AppError::Other(e.to_string()))?;
    conn.execute(
        "UPDATE highlights SET color = ?1 WHERE id = ?2",
        params![color, id],
    )?;
    Ok(())
}
