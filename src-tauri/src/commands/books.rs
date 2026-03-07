use rusqlite::params;
use serde::{Deserialize, Serialize};
use std::fs;
use tauri::{Manager, State};

use crate::db::Db;
use crate::epub;
use crate::error::{AppError, AppResult};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Book {
    pub id: String,
    pub title: String,
    pub author: String,
    pub description: Option<String>,
    pub cover_path: Option<String>,
    pub file_path: String,
    pub genre: Option<String>,
    pub pages: Option<i32>,
    pub status: String,
    pub progress: i32,
    pub current_cfi: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[tauri::command]
pub async fn import_book(file_path: String, app: tauri::AppHandle, db: State<'_, Db>) -> AppResult<Book> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e: tauri::Error| AppError::Other(e.to_string()))?;
    let books_dir = app_data_dir.join("books");
    let covers_dir = app_data_dir.join("covers");

    let book_id = uuid::Uuid::new_v4().to_string();
    let src = std::path::Path::new(&file_path);

    // Extract metadata before copying
    let metadata = epub::extract_metadata(src, &covers_dir, &book_id)?;
    let pages = epub::count_chapters(src)? as i32;

    // Copy epub to app data
    let dest = books_dir.join(format!("{}.epub", book_id));
    fs::copy(src, &dest)?;

    let now = chrono::Utc::now().to_rfc3339();
    let dest_str = dest.to_string_lossy().to_string();

    let book = Book {
        id: book_id,
        title: metadata.title,
        author: metadata.author,
        description: metadata.description,
        cover_path: metadata.cover_path,
        file_path: dest_str,
        genre: None,
        pages: Some(pages),
        status: "unread".to_string(),
        progress: 0,
        current_cfi: None,
        created_at: now.clone(),
        updated_at: now,
    };

    let conn = db.conn.lock().map_err(|e| AppError::Other(e.to_string()))?;
    conn.execute(
        "INSERT INTO books (id, title, author, description, cover_path, file_path, genre, pages, status, progress, current_cfi, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
        params![
            book.id,
            book.title,
            book.author,
            book.description,
            book.cover_path,
            book.file_path,
            book.genre,
            book.pages,
            book.status,
            book.progress,
            book.current_cfi,
            book.created_at,
            book.updated_at,
        ],
    )?;

    Ok(book)
}


#[tauri::command]
pub fn list_books(
    filter: Option<String>,
    search: Option<String>,
    db: State<'_, Db>,
) -> AppResult<Vec<Book>> {
    let conn = db.conn.lock().map_err(|e| AppError::Other(e.to_string()))?;

    let mut sql = "SELECT id, title, author, description, cover_path, file_path, genre, pages, status, progress, current_cfi, created_at, updated_at FROM books".to_string();
    let mut conditions: Vec<String> = Vec::new();
    let mut param_values: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();

    if let Some(ref f) = filter {
        match f.as_str() {
            "reading" | "finished" | "unread" => {
                conditions.push("status = ?".to_string());
                param_values.push(Box::new(f.clone()));
            }
            "all" => {}
            genre => {
                conditions.push("genre = ?".to_string());
                param_values.push(Box::new(genre.to_string()));
            }
        }
    }

    if let Some(ref q) = search {
        if !q.is_empty() {
            conditions.push("(LOWER(title) LIKE ? OR LOWER(author) LIKE ?)".to_string());
            let pattern = format!("%{}%", q.to_lowercase());
            param_values.push(Box::new(pattern.clone()));
            param_values.push(Box::new(pattern));
        }
    }

    if !conditions.is_empty() {
        sql.push_str(" WHERE ");
        sql.push_str(&conditions.join(" AND "));
    }

    sql.push_str(" ORDER BY updated_at DESC");

    let params_refs: Vec<&dyn rusqlite::types::ToSql> = param_values.iter().map(|p| p.as_ref()).collect();

    let mut stmt = conn.prepare(&sql)?;
    let books = stmt.query_map(params_refs.as_slice(), |row| {
        Ok(Book {
            id: row.get(0)?,
            title: row.get(1)?,
            author: row.get(2)?,
            description: row.get(3)?,
            cover_path: row.get(4)?,
            file_path: row.get(5)?,
            genre: row.get(6)?,
            pages: row.get(7)?,
            status: row.get(8)?,
            progress: row.get(9)?,
            current_cfi: row.get(10)?,
            created_at: row.get(11)?,
            updated_at: row.get(12)?,
        })
    })?
    .collect::<Result<Vec<_>, _>>()?;

    Ok(books)
}

#[tauri::command]
pub fn get_book(id: String, db: State<'_, Db>) -> AppResult<Book> {
    let conn = db.conn.lock().map_err(|e| AppError::Other(e.to_string()))?;
    let book = conn.query_row(
        "SELECT id, title, author, description, cover_path, file_path, genre, pages, status, progress, current_cfi, created_at, updated_at FROM books WHERE id = ?1",
        params![id],
        |row| {
            Ok(Book {
                id: row.get(0)?,
                title: row.get(1)?,
                author: row.get(2)?,
                description: row.get(3)?,
                cover_path: row.get(4)?,
                file_path: row.get(5)?,
                genre: row.get(6)?,
                pages: row.get(7)?,
                status: row.get(8)?,
                progress: row.get(9)?,
                current_cfi: row.get(10)?,
                created_at: row.get(11)?,
                updated_at: row.get(12)?,
            })
        },
    )?;
    Ok(book)
}

#[tauri::command]
pub fn delete_book(id: String, db: State<'_, Db>) -> AppResult<()> {
    let conn = db.conn.lock().map_err(|e| AppError::Other(e.to_string()))?;

    // Get file paths before deleting
    let (file_path, cover_path): (String, Option<String>) = conn.query_row(
        "SELECT file_path, cover_path FROM books WHERE id = ?1",
        params![id],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;

    conn.execute("DELETE FROM books WHERE id = ?1", params![id])?;

    // Clean up files (best-effort)
    let _ = fs::remove_file(&file_path);
    if let Some(cover) = cover_path {
        let _ = fs::remove_file(&cover);
    }

    Ok(())
}

#[tauri::command]
pub fn update_reading_progress(
    id: String,
    progress: i32,
    cfi: Option<String>,
    db: State<'_, Db>,
) -> AppResult<()> {
    let conn = db.conn.lock().map_err(|e| AppError::Other(e.to_string()))?;
    let now = chrono::Utc::now().to_rfc3339();

    conn.execute(
        "UPDATE books SET progress = ?1, current_cfi = ?2, status = 'reading', updated_at = ?3 WHERE id = ?4",
        params![progress, cfi, now, id],
    )?;

    Ok(())
}

#[tauri::command]
pub fn update_book_pages(id: String, pages: i32, db: State<'_, Db>) -> AppResult<()> {
    let conn = db.conn.lock().map_err(|e| AppError::Other(e.to_string()))?;
    conn.execute(
        "UPDATE books SET pages = ?1 WHERE id = ?2",
        params![pages, id],
    )?;
    Ok(())
}

#[tauri::command]
pub fn mark_finished(id: String, db: State<'_, Db>) -> AppResult<()> {
    let conn = db.conn.lock().map_err(|e| AppError::Other(e.to_string()))?;
    let now = chrono::Utc::now().to_rfc3339();

    conn.execute(
        "UPDATE books SET status = 'finished', progress = 100, updated_at = ?1 WHERE id = ?2",
        params![now, id],
    )?;

    Ok(())
}
