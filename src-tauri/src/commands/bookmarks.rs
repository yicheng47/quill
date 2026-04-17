use rusqlite::params;
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::sync::events::{BookmarkPayload, EventBody, HighlightPayload};
use crate::sync::writer::SyncWriter;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Bookmark {
    pub id: String,
    pub book_id: String,
    pub cfi: String,
    pub label: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Highlight {
    pub id: String,
    pub book_id: String,
    pub cfi_range: String,
    pub color: String,
    pub note: Option<String>,
    pub text_content: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[tauri::command]
pub fn add_bookmark(
    book_id: String,
    cfi: String,
    label: Option<String>,
    db: State<'_, Db>,
    sync: State<'_, SyncWriter>,
) -> AppResult<Bookmark> {
    let id = uuid::Uuid::new_v4().to_string();
    let now = chrono::Utc::now().timestamp_millis();

    let bookmark = Bookmark {
        id: id.clone(),
        book_id: book_id.clone(),
        cfi: cfi.clone(),
        label: label.clone(),
        created_at: now,
        updated_at: now,
    };

    sync.with_tx(&db, |tx, events| {
        tx.execute(
            "INSERT INTO bookmarks (id, book_id, cfi, label, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
            params![id, book_id, cfi, label, now],
        )?;
        events.push(EventBody::BookmarkAdd(BookmarkPayload {
            id: id.clone(),
            book_id: book_id.clone(),
            cfi: cfi.clone(),
            label: label.clone(),
        }));
        Ok(())
    })?;

    Ok(bookmark)
}

#[tauri::command]
pub fn remove_bookmark(
    id: String,
    db: State<'_, Db>,
    sync: State<'_, SyncWriter>,
) -> AppResult<()> {
    sync.with_tx(&db, |tx, events| {
        tx.execute("DELETE FROM bookmarks WHERE id = ?1", params![id])?;
        events.push(EventBody::BookmarkDelete { id: id.clone() });
        Ok(())
    })
}

#[tauri::command]
pub fn list_bookmarks(book_id: String, db: State<'_, Db>) -> AppResult<Vec<Bookmark>> {
    let conn = db.conn.lock().map_err(|e| AppError::Other(e.to_string()))?;
    let mut stmt = conn.prepare(
        "SELECT id, book_id, cfi, label, created_at, updated_at FROM bookmarks WHERE book_id = ?1 ORDER BY created_at DESC",
    )?;
    let bookmarks = stmt
        .query_map(params![book_id], |row| {
            Ok(Bookmark {
                id: row.get(0)?,
                book_id: row.get(1)?,
                cfi: row.get(2)?,
                label: row.get(3)?,
                created_at: row.get(4)?,
                updated_at: row.get(5)?,
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
    sync: State<'_, SyncWriter>,
) -> AppResult<Highlight> {
    let id = uuid::Uuid::new_v4().to_string();
    let now = chrono::Utc::now().timestamp_millis();
    let color = color.unwrap_or_else(|| "yellow".to_string());

    let highlight = Highlight {
        id: id.clone(),
        book_id: book_id.clone(),
        cfi_range: cfi_range.clone(),
        color: color.clone(),
        note: note.clone(),
        text_content: text_content.clone(),
        created_at: now,
        updated_at: now,
    };

    let device = sync.self_device().to_string();
    sync.with_tx(&db, |tx, events| {
        tx.execute(
            "INSERT INTO highlights (id, book_id, cfi_range, color, note, text_content, created_at, updated_at, updated_by_device)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7, ?8)",
            params![id, book_id, cfi_range, color, note, text_content, now, device],
        )?;
        events.push(EventBody::HighlightAdd(HighlightPayload {
            id: id.clone(),
            book_id: book_id.clone(),
            cfi_range: cfi_range.clone(),
            color: color.clone(),
            note: note.clone(),
            text_content: text_content.clone(),
        }));
        Ok(())
    })?;

    Ok(highlight)
}

#[tauri::command]
pub fn remove_highlight(
    id: String,
    db: State<'_, Db>,
    sync: State<'_, SyncWriter>,
) -> AppResult<()> {
    sync.with_tx(&db, |tx, events| {
        tx.execute("DELETE FROM highlights WHERE id = ?1", params![id])?;
        events.push(EventBody::HighlightDelete { id: id.clone() });
        Ok(())
    })
}

#[tauri::command]
pub fn list_highlights(book_id: String, db: State<'_, Db>) -> AppResult<Vec<Highlight>> {
    let conn = db.conn.lock().map_err(|e| AppError::Other(e.to_string()))?;
    let mut stmt = conn.prepare(
        "SELECT id, book_id, cfi_range, color, note, text_content, created_at, updated_at FROM highlights WHERE book_id = ?1 ORDER BY created_at DESC",
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
                updated_at: row.get(7)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(highlights)
}

#[tauri::command]
pub fn update_highlight_note(
    id: String,
    note: String,
    db: State<'_, Db>,
    sync: State<'_, SyncWriter>,
) -> AppResult<()> {
    let now = chrono::Utc::now().timestamp_millis();
    let device = sync.self_device().to_string();
    sync.with_tx(&db, |tx, events| {
        tx.execute(
            "UPDATE highlights SET note = ?1, updated_at = ?2, updated_by_device = ?3 WHERE id = ?4",
            params![note, now, device, id],
        )?;
        events.push(EventBody::HighlightNoteSet {
            id: id.clone(),
            note: Some(note.clone()),
        });
        Ok(())
    })
}

#[tauri::command]
pub fn update_highlight_color(
    id: String,
    color: String,
    db: State<'_, Db>,
    sync: State<'_, SyncWriter>,
) -> AppResult<()> {
    let now = chrono::Utc::now().timestamp_millis();
    let device = sync.self_device().to_string();
    sync.with_tx(&db, |tx, events| {
        tx.execute(
            "UPDATE highlights SET color = ?1, updated_at = ?2, updated_by_device = ?3 WHERE id = ?4",
            params![color, now, device, id],
        )?;
        events.push(EventBody::HighlightColorSet {
            id: id.clone(),
            color: color.clone(),
        });
        Ok(())
    })
}
