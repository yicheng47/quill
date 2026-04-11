use rusqlite::params;
use serde::{Deserialize, Serialize};
use std::fs;
use tauri::State;

use crate::db::Db;
use crate::epub;
use crate::error::{AppError, AppResult};
use crate::icloud;

/// Sanitize a book title into a safe filename slug.
/// Keeps alphanumeric, spaces (→ hyphens), and common punctuation, then truncates.
fn slugify(title: &str) -> String {
    let slug: String = title
        .chars()
        .map(|c| if c.is_alphanumeric() || c == ' ' || c == '-' || c == '_' { c } else { ' ' })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join("-")
        .to_lowercase();
    // Truncate to ~60 chars at a word boundary
    if slug.len() <= 60 {
        slug
    } else {
        slug[..60].rfind('-').map_or(&slug[..60], |i| &slug[..i]).to_string()
    }
}

/// Build a human-readable filename: `{slug}_{short-id}.{ext}`
fn book_filename(title: &str, book_id: &str, ext: &str) -> String {
    let slug = slugify(title);
    let short_id = &book_id[..8]; // first 8 chars of UUID
    if slug.is_empty() {
        format!("{}.{}", book_id, ext)
    } else {
        format!("{}_{}.{}", slug, short_id, ext)
    }
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Book {
    pub id: String,
    pub title: String,
    pub author: String,
    pub description: Option<String>,
    pub cover_path: Option<String>,
    pub file_path: String,
    pub format: String,
    pub genre: Option<String>,
    pub pages: Option<i32>,
    pub status: String,
    pub progress: i32,
    pub current_cfi: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    /// Whether the book file is locally available (not an iCloud placeholder).
    #[serde(default = "default_true")]
    pub available: bool,
}

fn default_true() -> bool {
    true
}

/// Resolve relative paths in a Book to absolute using data_dir,
/// and check whether the book file is locally available.
fn resolve_book_paths(book: &mut Book, db: &Db) {
    if !std::path::Path::new(&book.file_path).is_absolute() {
        book.file_path = db
            .resolve_path(&book.file_path)
            .to_string_lossy()
            .to_string();
    }
    if let Some(ref cover) = book.cover_path {
        if !std::path::Path::new(cover).is_absolute() {
            book.cover_path = Some(
                db.resolve_path(cover)
                    .to_string_lossy()
                    .to_string(),
            );
        }
    }
    book.available = icloud::is_file_downloaded(std::path::Path::new(&book.file_path));
}

#[tauri::command]
pub async fn import_book(file_path: String, db: State<'_, Db>) -> AppResult<Book> {
    let data_dir = db
        .data_dir
        .lock()
        .map_err(|e| AppError::Other(e.to_string()))?
        .clone();
    let books_dir = data_dir.join("books");
    let covers_dir = data_dir.join("covers");

    let book_id = uuid::Uuid::new_v4().to_string();
    let src = std::path::Path::new(&file_path);

    // Extract metadata before copying
    let metadata = epub::extract_metadata(src, &covers_dir, &book_id)?;
    let pages = epub::count_chapters(src)? as i32;

    // Copy epub to app data with readable filename
    let filename = book_filename(&metadata.title, &book_id, "epub");
    let dest = books_dir.join(&filename);
    fs::copy(src, &dest)?;

    let now = chrono::Utc::now().to_rfc3339();

    // Store relative path in DB
    let rel_file_path = format!("books/{}", filename);

    let book = Book {
        id: book_id,
        title: metadata.title,
        author: metadata.author,
        description: metadata.description,
        cover_path: metadata.cover_path, // already relative from epub.rs
        file_path: rel_file_path,
        format: "epub".to_string(),
        genre: None,
        pages: Some(pages),
        status: "unread".to_string(),
        progress: 0,
        current_cfi: None,
        created_at: now.clone(),
        updated_at: now,
        available: true,
    };

    let conn = db.conn.lock().map_err(|e| AppError::Other(e.to_string()))?;
    conn.execute(
        "INSERT INTO books (id, title, author, description, cover_path, file_path, format, genre, pages, status, progress, current_cfi, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
        params![
            book.id,
            book.title,
            book.author,
            book.description,
            book.cover_path,
            book.file_path,
            book.format,
            book.genre,
            book.pages,
            book.status,
            book.progress,
            book.current_cfi,
            book.created_at,
            book.updated_at,
        ],
    )?;

    // Return book with absolute paths for the frontend
    let mut result = book;
    resolve_book_paths(&mut result, &db);
    Ok(result)
}


#[tauri::command]
pub fn list_books(
    filter: Option<String>,
    search: Option<String>,
    db: State<'_, Db>,
) -> AppResult<Vec<Book>> {
    let conn = db.conn.lock().map_err(|e| AppError::Other(e.to_string()))?;

    let mut sql = "SELECT id, title, author, description, cover_path, file_path, format, genre, pages, status, progress, current_cfi, created_at, updated_at FROM books".to_string();
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
    let mut books = stmt.query_map(params_refs.as_slice(), |row| {
        Ok(Book {
            id: row.get(0)?,
            title: row.get(1)?,
            author: row.get(2)?,
            description: row.get(3)?,
            cover_path: row.get(4)?,
            file_path: row.get(5)?,
            format: row.get(6)?,
            genre: row.get(7)?,
            pages: row.get(8)?,
            status: row.get(9)?,
            progress: row.get(10)?,
            current_cfi: row.get(11)?,
            created_at: row.get(12)?,
            updated_at: row.get(13)?,
            available: true, // resolved by resolve_book_paths below
        })
    })?
    .collect::<Result<Vec<_>, _>>()?;

    // Resolve relative paths to absolute for the frontend
    for book in &mut books {
        resolve_book_paths(book, &db);
    }

    Ok(books)
}

#[tauri::command]
pub fn get_book(id: String, db: State<'_, Db>) -> AppResult<Book> {
    let conn = db.conn.lock().map_err(|e| AppError::Other(e.to_string()))?;
    let mut book = conn.query_row(
        "SELECT id, title, author, description, cover_path, file_path, format, genre, pages, status, progress, current_cfi, created_at, updated_at FROM books WHERE id = ?1",
        params![id],
        |row| {
            Ok(Book {
                id: row.get(0)?,
                title: row.get(1)?,
                author: row.get(2)?,
                description: row.get(3)?,
                cover_path: row.get(4)?,
                file_path: row.get(5)?,
                format: row.get(6)?,
                genre: row.get(7)?,
                pages: row.get(8)?,
                status: row.get(9)?,
                progress: row.get(10)?,
                current_cfi: row.get(11)?,
                created_at: row.get(12)?,
                updated_at: row.get(13)?,
                available: true, // resolved by resolve_book_paths below
            })
        },
    )?;

    resolve_book_paths(&mut book, &db);
    Ok(book)
}

/// Check if a book's file is locally available and trigger iCloud download if not.
#[tauri::command]
pub fn check_book_available(id: String, db: State<'_, Db>) -> AppResult<bool> {
    let conn = db.conn.lock().map_err(|e| AppError::Other(e.to_string()))?;
    let file_path: String = conn.query_row(
        "SELECT file_path FROM books WHERE id = ?1",
        params![id],
        |row| row.get(0),
    )?;

    let abs_path = db.resolve_path(&file_path);
    let available = icloud::is_file_downloaded(&abs_path);

    if !available {
        icloud::trigger_download_file(&abs_path);
    }

    Ok(available)
}

#[tauri::command]
pub fn delete_book(id: String, db: State<'_, Db>) -> AppResult<()> {
    let conn = db.conn.lock().map_err(|e| AppError::Other(e.to_string()))?;

    // Get file paths before deleting (stored as relative)
    let (file_path, cover_path): (String, Option<String>) = conn.query_row(
        "SELECT file_path, cover_path FROM books WHERE id = ?1",
        params![id],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;

    // Clean up chats, messages, and the book in a transaction
    let tx = conn.unchecked_transaction()?;
    tx.execute(
        "DELETE FROM chat_messages WHERE chat_id IN (SELECT id FROM chats WHERE book_id = ?1)",
        params![id],
    )?;
    tx.execute("DELETE FROM chats WHERE book_id = ?1", params![id])?;
    tx.execute("DELETE FROM books WHERE id = ?1", params![id])?;
    tx.commit()?;

    // Resolve to absolute for file deletion
    let abs_file = db.resolve_path(&file_path);
    let _ = fs::remove_file(&abs_file);
    if let Some(cover) = cover_path {
        let abs_cover = db.resolve_path(&cover);
        let _ = fs::remove_file(&abs_cover);
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
        "UPDATE books SET progress = ?1, current_cfi = ?2, updated_at = ?3 WHERE id = ?4",
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

#[tauri::command]
pub fn update_book_status(id: String, status: String, db: State<'_, Db>) -> AppResult<()> {
    let conn = db.conn.lock().map_err(|e| AppError::Other(e.to_string()))?;
    let now = chrono::Utc::now().to_rfc3339();

    conn.execute(
        "UPDATE books SET status = ?1, updated_at = ?2 WHERE id = ?3",
        params![status, now, id],
    )?;

    Ok(())
}

#[tauri::command]
pub fn update_book_metadata(
    id: String,
    title: String,
    author: String,
    db: State<'_, Db>,
) -> AppResult<()> {
    let conn = db.conn.lock().map_err(|e| AppError::Other(e.to_string()))?;
    let now = chrono::Utc::now().to_rfc3339();

    conn.execute(
        "UPDATE books SET title = ?1, author = ?2, updated_at = ?3 WHERE id = ?4",
        params![title, author, now, id],
    )?;

    Ok(())
}

#[derive(Debug, Serialize)]
pub struct StagedPdf {
    pub book_id: String,
    /// Absolute path to the staged file inside `$APPDATA/books/`,
    /// safe for the frontend to fetch via the asset protocol.
    pub abs_path: String,
}

/// Step 1 of PDF import: copy the user-selected file into `$APPDATA/books/`
/// under a UUID filename. Returns an absolute path the frontend can read via
/// the asset protocol (so PDF metadata extraction never has to fetch from
/// arbitrary user paths, which is fragile across macOS/Tauri configurations).
#[tauri::command]
pub async fn stage_pdf_import(source_path: String, db: State<'_, Db>) -> AppResult<StagedPdf> {
    let data_dir = db
        .data_dir
        .lock()
        .map_err(|e| AppError::Other(e.to_string()))?
        .clone();
    let books_dir = data_dir.join("books");
    fs::create_dir_all(&books_dir)?;

    let book_id = uuid::Uuid::new_v4().to_string();
    let staged = books_dir.join(format!("{}.pdf", book_id));
    fs::copy(std::path::Path::new(&source_path), &staged)?;

    Ok(StagedPdf {
        book_id,
        abs_path: staged.to_string_lossy().to_string(),
    })
}

/// Step 2 of PDF import: rename the staged file to a slugged name, write the
/// cover, and insert the DB row. Caller must have first called
/// `stage_pdf_import` to obtain `book_id`.
#[tauri::command]
pub async fn commit_pdf_import(
    book_id: String,
    title: String,
    author: Option<String>,
    description: Option<String>,
    pages: i32,
    cover_data: Option<Vec<u8>>,
    db: State<'_, Db>,
) -> AppResult<Book> {
    let data_dir = db
        .data_dir
        .lock()
        .map_err(|e| AppError::Other(e.to_string()))?
        .clone();
    let books_dir = data_dir.join("books");
    let covers_dir = data_dir.join("covers");

    let staged = books_dir.join(format!("{}.pdf", book_id));
    if !staged.exists() {
        return Err(AppError::Other(format!(
            "staged PDF not found for book_id {}",
            book_id
        )));
    }

    // Rename to a human-readable filename
    let filename = book_filename(&title, &book_id, "pdf");
    let dest = books_dir.join(&filename);
    if dest != staged {
        fs::rename(&staged, &dest)?;
    }

    // Save cover image if provided
    let cover_path = if let Some(ref data) = cover_data {
        fs::create_dir_all(&covers_dir)?;
        let cover_file = covers_dir.join(format!("{}.png", book_id));
        fs::write(&cover_file, data)?;
        Some(format!("covers/{}.png", book_id))
    } else {
        None
    };

    let now = chrono::Utc::now().to_rfc3339();
    let rel_file_path = format!("books/{}", filename);

    let book = Book {
        id: book_id,
        title,
        author: author.unwrap_or_else(|| "Unknown Author".to_string()),
        description,
        cover_path,
        file_path: rel_file_path,
        format: "pdf".to_string(),
        genre: None,
        pages: Some(pages),
        status: "unread".to_string(),
        progress: 0,
        current_cfi: None,
        created_at: now.clone(),
        updated_at: now,
        available: true,
    };

    let conn = db.conn.lock().map_err(|e| AppError::Other(e.to_string()))?;
    conn.execute(
        "INSERT INTO books (id, title, author, description, cover_path, file_path, format, genre, pages, status, progress, current_cfi, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
        params![
            book.id,
            book.title,
            book.author,
            book.description,
            book.cover_path,
            book.file_path,
            book.format,
            book.genre,
            book.pages,
            book.status,
            book.progress,
            book.current_cfi,
            book.created_at,
            book.updated_at,
        ],
    )?;

    let mut result = book;
    resolve_book_paths(&mut result, &db);
    Ok(result)
}

/// Roll back a staged PDF import by deleting the staged file. Used by the
/// frontend when metadata extraction or commit fails.
#[tauri::command]
pub async fn cancel_pdf_import(book_id: String, db: State<'_, Db>) -> AppResult<()> {
    let data_dir = db
        .data_dir
        .lock()
        .map_err(|e| AppError::Other(e.to_string()))?
        .clone();
    let staged = data_dir.join("books").join(format!("{}.pdf", book_id));
    let _ = fs::remove_file(&staged);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Db;
    use rusqlite::params;
    use tempfile::TempDir;

    fn setup() -> (TempDir, Db) {
        let dir = TempDir::new().unwrap();
        let db = Db::init(&dir.path().to_path_buf()).unwrap();
        (dir, db)
    }

    fn insert_book(db: &Db, id: &str, format: &str) {
        let conn = db.conn.lock().unwrap();
        let now = chrono::Utc::now().to_rfc3339();
        conn.execute(
            "INSERT INTO books (id, title, author, file_path, format, status, progress, created_at, updated_at)
             VALUES (?1, 'Test', 'Author', 'books/test.epub', ?2, 'reading', 0, ?3, ?3)",
            params![id, format, now],
        ).unwrap();
    }

    #[test]
    fn test_format_defaults_to_epub() {
        let (_dir, db) = setup();
        let conn = db.conn.lock().unwrap();
        let now = chrono::Utc::now().to_rfc3339();
        conn.execute(
            "INSERT INTO books (id, title, author, file_path, status, progress, created_at, updated_at)
             VALUES ('b1', 'Test', 'Author', 'books/test.epub', 'reading', 0, ?1, ?1)",
            params![now],
        ).unwrap();

        let format: String = conn.query_row(
            "SELECT format FROM books WHERE id = 'b1'", [], |r| r.get(0),
        ).unwrap();
        assert_eq!(format, "epub");
    }

    #[test]
    fn test_format_pdf() {
        let (_dir, db) = setup();
        insert_book(&db, "b1", "pdf");

        let conn = db.conn.lock().unwrap();
        let format: String = conn.query_row(
            "SELECT format FROM books WHERE id = 'b1'", [], |r| r.get(0),
        ).unwrap();
        assert_eq!(format, "pdf");
    }

    #[test]
    fn test_import_pdf_inserts_with_correct_format() {
        let (dir, db) = setup();

        let src_path = dir.path().join("test.pdf");
        fs::write(&src_path, b"%PDF-1.4 fake content").unwrap();

        let conn = db.conn.lock().unwrap();
        let book_id = uuid::Uuid::new_v4().to_string();
        let now = chrono::Utc::now().to_rfc3339();
        let rel_file_path = format!("books/{}.pdf", book_id);

        let dest = dir.path().join("books").join(format!("{}.pdf", book_id));
        fs::copy(&src_path, &dest).unwrap();

        conn.execute(
            "INSERT INTO books (id, title, author, file_path, format, status, progress, pages, created_at, updated_at)
             VALUES (?1, 'My PDF', 'PDF Author', ?2, 'pdf', 'unread', 0, 42, ?3, ?3)",
            params![book_id, rel_file_path, now],
        ).unwrap();

        let (title, format, pages): (String, String, i32) = conn.query_row(
            "SELECT title, format, pages FROM books WHERE id = ?1",
            params![book_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        ).unwrap();

        assert_eq!(title, "My PDF");
        assert_eq!(format, "pdf");
        assert_eq!(pages, 42);
        assert!(dest.exists());
    }

    #[test]
    fn test_import_pdf_with_cover() {
        let (dir, db) = setup();
        let book_id = "cover-test";
        let cover_data = b"fake png data";

        let cover_file = dir.path().join("covers").join(format!("{}.png", book_id));
        fs::write(&cover_file, cover_data).unwrap();

        let conn = db.conn.lock().unwrap();
        let now = chrono::Utc::now().to_rfc3339();
        let cover_path = format!("covers/{}.png", book_id);

        conn.execute(
            "INSERT INTO books (id, title, author, file_path, format, cover_path, status, progress, created_at, updated_at)
             VALUES (?1, 'PDF With Cover', 'Author', 'books/test.pdf', 'pdf', ?2, 'unread', 0, ?3, ?3)",
            params![book_id, cover_path, now],
        ).unwrap();

        let db_cover: Option<String> = conn.query_row(
            "SELECT cover_path FROM books WHERE id = ?1",
            params![book_id],
            |r| r.get(0),
        ).unwrap();

        assert_eq!(db_cover, Some(cover_path));
        assert!(cover_file.exists());
    }

    #[test]
    fn test_list_books_returns_format() {
        let (_dir, db) = setup();
        insert_book(&db, "b1", "epub");
        insert_book(&db, "b2", "pdf");

        let conn = db.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, title, author, description, cover_path, file_path, format, genre, pages, status, progress, current_cfi, created_at, updated_at FROM books ORDER BY id",
        ).unwrap();
        let books: Vec<Book> = stmt.query_map([], |row| {
            Ok(Book {
                id: row.get(0)?,
                title: row.get(1)?,
                author: row.get(2)?,
                description: row.get(3)?,
                cover_path: row.get(4)?,
                file_path: row.get(5)?,
                format: row.get(6)?,
                genre: row.get(7)?,
                pages: row.get(8)?,
                status: row.get(9)?,
                progress: row.get(10)?,
                current_cfi: row.get(11)?,
                created_at: row.get(12)?,
                updated_at: row.get(13)?,
                available: true,
            })
        }).unwrap().collect::<Result<Vec<_>, _>>().unwrap();

        assert_eq!(books.len(), 2);
        assert_eq!(books[0].format, "epub");
        assert_eq!(books[1].format, "pdf");
    }

    #[test]
    fn test_import_pdf_none_author_defaults() {
        let (_dir, db) = setup();
        let conn = db.conn.lock().unwrap();
        let now = chrono::Utc::now().to_rfc3339();

        // Simulate import_pdf with author = None
        let author: Option<String> = None;
        let resolved_author = author.unwrap_or_else(|| "Unknown Author".to_string());

        conn.execute(
            "INSERT INTO books (id, title, author, file_path, format, status, progress, created_at, updated_at)
             VALUES ('b1', 'No Author PDF', ?1, 'books/test.pdf', 'pdf', 'unread', 0, ?2, ?2)",
            params![resolved_author, now],
        ).unwrap();

        let author_val: String = conn.query_row(
            "SELECT author FROM books WHERE id = 'b1'", [], |r| r.get(0),
        ).unwrap();
        assert_eq!(author_val, "Unknown Author");
    }

    #[test]
    fn test_import_pdf_with_all_metadata() {
        let (dir, db) = setup();

        // Create source PDF
        let src = dir.path().join("academic-paper.pdf");
        fs::write(&src, b"%PDF-1.7 fake").unwrap();

        let book_id = uuid::Uuid::new_v4().to_string();
        let now = chrono::Utc::now().to_rfc3339();
        let rel_path = format!("books/{}.pdf", book_id);
        let cover_rel = format!("covers/{}.png", book_id);

        // Copy file
        let dest = dir.path().join("books").join(format!("{}.pdf", book_id));
        fs::copy(&src, &dest).unwrap();

        // Write cover
        let cover_file = dir.path().join("covers").join(format!("{}.png", book_id));
        fs::write(&cover_file, b"PNG fake").unwrap();

        let conn = db.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO books (id, title, author, description, cover_path, file_path, format, pages, status, progress, created_at, updated_at)
             VALUES (?1, 'Deep Learning', 'Ian Goodfellow, Yoshua Bengio', 'A comprehensive textbook', ?2, ?3, 'pdf', 800, 'unread', 0, ?4, ?4)",
            params![book_id, cover_rel, rel_path, now],
        ).unwrap();

        let book: Book = conn.query_row(
            "SELECT id, title, author, description, cover_path, file_path, format, genre, pages, status, progress, current_cfi, created_at, updated_at FROM books WHERE id = ?1",
            params![book_id],
            |row| Ok(Book {
                id: row.get(0)?, title: row.get(1)?, author: row.get(2)?,
                description: row.get(3)?, cover_path: row.get(4)?, file_path: row.get(5)?,
                format: row.get(6)?, genre: row.get(7)?, pages: row.get(8)?,
                status: row.get(9)?, progress: row.get(10)?, current_cfi: row.get(11)?,
                created_at: row.get(12)?, updated_at: row.get(13)?, available: true,
            }),
        ).unwrap();

        assert_eq!(book.title, "Deep Learning");
        assert_eq!(book.author, "Ian Goodfellow, Yoshua Bengio");
        assert_eq!(book.description, Some("A comprehensive textbook".to_string()));
        assert_eq!(book.format, "pdf");
        assert_eq!(book.pages, Some(800));
        assert!(book.cover_path.is_some());
        assert!(dest.exists());
        assert!(cover_file.exists());
    }

    #[test]
    fn test_update_metadata_title_and_author() {
        let (_dir, db) = setup();
        insert_book(&db, "b1", "epub");

        let conn = db.conn.lock().unwrap();
        let now = chrono::Utc::now().to_rfc3339();
        conn.execute(
            "UPDATE books SET title = ?1, author = ?2, updated_at = ?3 WHERE id = ?4",
            params!["New Title", "New Author", now, "b1"],
        ).unwrap();

        let (title, author): (String, String) = conn.query_row(
            "SELECT title, author FROM books WHERE id = 'b1'", [], |r| Ok((r.get(0)?, r.get(1)?)),
        ).unwrap();
        assert_eq!(title, "New Title");
        assert_eq!(author, "New Author");
    }

    #[test]
    fn test_update_metadata_title_only() {
        let (_dir, db) = setup();
        insert_book(&db, "b1", "epub");

        let conn = db.conn.lock().unwrap();
        let now = chrono::Utc::now().to_rfc3339();
        conn.execute(
            "UPDATE books SET title = ?1, author = ?2, updated_at = ?3 WHERE id = ?4",
            params!["Changed Title", "Author", now, "b1"],
        ).unwrap();

        let (title, author): (String, String) = conn.query_row(
            "SELECT title, author FROM books WHERE id = 'b1'", [], |r| Ok((r.get(0)?, r.get(1)?)),
        ).unwrap();
        assert_eq!(title, "Changed Title");
        assert_eq!(author, "Author"); // unchanged (same value passed)
    }

    #[test]
    fn test_update_metadata_updates_timestamp() {
        let (_dir, db) = setup();
        insert_book(&db, "b1", "epub");

        let conn = db.conn.lock().unwrap();
        let before: String = conn.query_row(
            "SELECT updated_at FROM books WHERE id = 'b1'", [], |r| r.get(0),
        ).unwrap();

        std::thread::sleep(std::time::Duration::from_millis(10));
        let now = chrono::Utc::now().to_rfc3339();
        conn.execute(
            "UPDATE books SET title = ?1, author = ?2, updated_at = ?3 WHERE id = ?4",
            params!["New", "New", now, "b1"],
        ).unwrap();

        let after: String = conn.query_row(
            "SELECT updated_at FROM books WHERE id = 'b1'", [], |r| r.get(0),
        ).unwrap();
        assert_ne!(before, after);
    }

    #[test]
    fn test_update_metadata_nonexistent_book() {
        let (_dir, db) = setup();

        let conn = db.conn.lock().unwrap();
        let now = chrono::Utc::now().to_rfc3339();
        let rows = conn.execute(
            "UPDATE books SET title = ?1, author = ?2, updated_at = ?3 WHERE id = ?4",
            params!["Title", "Author", now, "nonexistent"],
        ).unwrap();
        assert_eq!(rows, 0); // no rows affected
    }

    #[test]
    fn test_get_book_returns_format() {
        let (_dir, db) = setup();
        insert_book(&db, "b1", "pdf");

        let conn = db.conn.lock().unwrap();
        let book: Book = conn.query_row(
            "SELECT id, title, author, description, cover_path, file_path, format, genre, pages, status, progress, current_cfi, created_at, updated_at FROM books WHERE id = 'b1'",
            [],
            |row| Ok(Book {
                id: row.get(0)?, title: row.get(1)?, author: row.get(2)?,
                description: row.get(3)?, cover_path: row.get(4)?, file_path: row.get(5)?,
                format: row.get(6)?, genre: row.get(7)?, pages: row.get(8)?,
                status: row.get(9)?, progress: row.get(10)?, current_cfi: row.get(11)?,
                created_at: row.get(12)?, updated_at: row.get(13)?, available: true,
            }),
        ).unwrap();

        assert_eq!(book.format, "pdf");
        assert_eq!(book.id, "b1");
    }
}
