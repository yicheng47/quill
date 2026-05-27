use std::fs;
use std::path::Path;

use base64::Engine;
use rusqlite::params;
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::db::Db;
use crate::epub;
use crate::error::{AppError, AppResult};
use crate::icloud;
use crate::sync::events::{BookImportPayload, EventBody};
use crate::sync::writer::SyncWriter;

fn cover_blob_to_data_uri(bytes: &[u8]) -> String {
    let mime = if bytes.starts_with(b"\x89PNG") {
        "image/png"
    } else if bytes.starts_with(b"\xFF\xD8\xFF") {
        "image/jpeg"
    } else if bytes.starts_with(b"GIF8") {
        "image/gif"
    } else if bytes.len() > 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP" {
        "image/webp"
    } else {
        "image/png"
    };
    let b64 = base64::engine::general_purpose::STANDARD.encode(bytes);
    format!("data:{mime};base64,{b64}")
}

fn pdf_obj_to_string(obj: &lopdf::Object) -> Option<String> {
    let bytes = obj.as_str().ok().or_else(|| obj.as_name().ok())?;
    let s = String::from_utf8_lossy(bytes).to_string();
    if s.trim().is_empty() { None } else { Some(s) }
}

fn extract_pdf_metadata(path: &Path) -> (String, String, i32) {
    let fallback_title = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("Untitled")
        .to_string();

    let Ok(doc) = lopdf::Document::load(path) else {
        return (fallback_title, "Unknown Author".into(), 0);
    };

    let pages = doc.get_pages().len() as i32;

    let info = doc
        .trailer
        .get(b"Info")
        .ok()
        .and_then(|r| r.as_reference().ok())
        .and_then(|id| doc.get_object(id).ok())
        .and_then(|o| o.as_dict().ok().cloned());

    let title = info
        .as_ref()
        .and_then(|d| d.get(b"Title").ok())
        .and_then(pdf_obj_to_string)
        .unwrap_or(fallback_title);

    let author = info
        .as_ref()
        .and_then(|d| d.get(b"Author").ok())
        .and_then(pdf_obj_to_string)
        .unwrap_or_else(|| "Unknown Author".into());

    (title, author, pages)
}


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
    // Truncate to ~60 bytes at a word boundary, but never slice into
    // a multi-byte UTF-8 character. Naive `slug[..60]` panics on
    // non-ASCII titles (e.g. CJK) where byte 60 lands mid-codepoint —
    // which surfaces as `import_book` returning a command-runtime
    // panic the UI sees as "spinner forever". `floor_char_boundary`
    // walks back to the previous char start.
    if slug.len() <= 60 {
        slug
    } else {
        let cut = floor_char_boundary(&slug, 60);
        let head = &slug[..cut];
        head.rfind('-').map_or(head, |i| &head[..i]).to_string()
    }
}

/// Largest valid char-boundary `<= max_bytes`. Stable equivalent of
/// `str::floor_char_boundary` (which is still nightly-only as of
/// rustc 1.85). Walks at most 3 bytes back since UTF-8 codepoints are
/// at most 4 bytes wide.
fn floor_char_boundary(s: &str, max_bytes: usize) -> usize {
    let mut i = max_bytes.min(s.len());
    while i > 0 && !s.is_char_boundary(i) {
        i -= 1;
    }
    i
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
    pub created_at: i64,
    pub updated_at: i64,
    /// Whether the book file is locally available (not an iCloud placeholder).
    #[serde(default = "default_true")]
    pub available: bool,
    /// Base64-encoded cover image bytes. Rendered as data URI on the frontend.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cover_data: Option<String>,
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
        if cover != "none" && !std::path::Path::new(cover).is_absolute() {
            book.cover_path = Some(
                db.resolve_path(cover)
                    .to_string_lossy()
                    .to_string(),
            );
        }
    }
    book.available = icloud::is_file_downloaded(std::path::Path::new(&book.file_path));
}

pub(crate) fn do_import_epub(
    file_path: &str,
    db: &Db,
    sync: &SyncWriter,
) -> AppResult<Book> {
    let data_dir = db
        .data_dir
        .lock()
        .map_err(|e| AppError::Other(e.to_string()))?
        .clone();
    let books_dir = data_dir.join("books");

    let book_id = uuid::Uuid::new_v4().to_string();
    let src = std::path::Path::new(file_path);

    let metadata = epub::extract_metadata(src)
        .inspect_err(|e| log::error!("import_book: extract_metadata failed for {file_path}: {e}"))?;
    let pages = epub::count_chapters(src)
        .inspect_err(|e| log::error!("import_book: count_chapters failed for {file_path}: {e}"))? as i32;

    let filename = book_filename(&metadata.title, &book_id, "epub");
    let dest = books_dir.join(&filename);
    fs::copy(src, &dest)?;

    let now = chrono::Utc::now().timestamp_millis();
    let rel_file_path = format!("books/{}", filename);
    let cover_data_b64 = metadata.cover_data.as_deref().map(|b| {
        cover_blob_to_data_uri(b)
    });

    let book = Book {
        id: book_id,
        title: metadata.title,
        author: metadata.author,
        description: metadata.description,
        cover_path: None,
        file_path: rel_file_path,
        format: "epub".to_string(),
        genre: None,
        pages: Some(pages),
        status: "unread".to_string(),
        progress: 0,
        current_cfi: None,
        created_at: now,
        updated_at: now,
        available: true,
        cover_data: cover_data_b64,
    };

    do_insert_book(&book, metadata.cover_data.as_deref(), db, sync, now)?;

    log::info!("import_book: complete id={} title={:?}", book.id, book.title);
    Ok(book)
}

pub(crate) fn do_import_pdf(
    file_path: &str,
    db: &Db,
    sync: &SyncWriter,
) -> AppResult<Book> {
    let data_dir = db
        .data_dir
        .lock()
        .map_err(|e| AppError::Other(e.to_string()))?
        .clone();
    let books_dir = data_dir.join("books");
    fs::create_dir_all(&books_dir)?;

    let book_id = uuid::Uuid::new_v4().to_string();
    let src = std::path::Path::new(file_path);

    let (title, author, pages) = extract_pdf_metadata(src);

    let filename = book_filename(&title, &book_id, "pdf");
    let dest = books_dir.join(&filename);
    fs::copy(src, &dest)?;

    let now = chrono::Utc::now().timestamp_millis();
    let rel_file_path = format!("books/{}", filename);

    let book = Book {
        id: book_id,
        title,
        author,
        description: None,
        cover_path: None,
        file_path: rel_file_path,
        format: "pdf".to_string(),
        genre: None,
        pages: Some(pages),
        status: "unread".to_string(),
        progress: 0,
        current_cfi: None,
        created_at: now,
        updated_at: now,
        available: true,
        cover_data: None,
    };

    do_insert_book(&book, None, db, sync, now)?;

    log::info!("import_book: complete id={} title={:?} format=pdf", book.id, book.title);
    Ok(book)
}

fn do_insert_book(book: &Book, cover_bytes: Option<&[u8]>, db: &Db, sync: &SyncWriter, now: i64) -> AppResult<()> {
    let device = sync.self_device().to_string();
    sync.with_tx(db, now, |tx, events| {
        tx.execute(
            "INSERT INTO books (id, title, author, description, cover_path, file_path, format, genre, pages, status, progress, current_cfi, created_at, updated_at, updated_by_device, cover_data)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)",
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
                device,
                cover_bytes,
            ],
        )?;
        events.push(EventBody::BookImport(BookImportPayload {
            id: book.id.clone(),
            title: book.title.clone(),
            author: book.author.clone(),
            description: book.description.clone(),
            cover_path: book.cover_path.clone(),
            file_path: book.file_path.clone(),
            format: book.format.clone(),
            genre: book.genre.clone(),
            pages: book.pages,
        }));
        Ok(())
    })
}

#[tauri::command]
pub async fn import_book(
    file_path: String,
    db: State<'_, Db>,
    sync: State<'_, SyncWriter>,
) -> AppResult<Book> {
    let ext = file_path
        .rsplit('.')
        .next()
        .unwrap_or("")
        .to_lowercase();
    log::info!("import_book: start file={file_path} format={ext}");
    let mut book = match ext.as_str() {
        "pdf" => do_import_pdf(&file_path, &db, &sync)?,
        _ => do_import_epub(&file_path, &db, &sync)?,
    };
    resolve_book_paths(&mut book, &db);
    Ok(book)
}


/// Shared query helper. Returns books with the **relative** `file_path`
/// and `cover_path` as stored in SQLite (`books/<slug>.epub`,
/// `covers/<id>.jpg`). The Tauri `list_books` wrapper resolves these to
/// absolute paths for the frontend; the MCP `list_books` tool returns
/// them as-is so the response doesn't leak this user's home directory
/// layout to AI clients.
/// Paginated response for `list_books`.
#[derive(Debug, serde::Serialize)]
pub struct BookPage {
    pub books: Vec<Book>,
    pub next_cursor: Option<String>,
    pub total: usize,
}

pub(crate) fn query_books(
    db: &Db,
    filter: Option<&str>,
    search: Option<&str>,
    collection_id: Option<&str>,
    cursor: Option<&str>,
    limit: usize,
) -> AppResult<BookPage> {
    let conn = db.reader();

    let use_collection = collection_id.is_some();
    let from_clause = if use_collection {
        "books INNER JOIN collection_books cb ON cb.book_id = books.id"
    } else {
        "books"
    };

    let mut conditions: Vec<String> = Vec::new();
    let mut param_values: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();

    if let Some(cid) = collection_id {
        conditions.push("cb.collection_id = ?".to_string());
        param_values.push(Box::new(cid.to_string()));
    }

    if let Some(f) = filter {
        match f {
            "reading" | "finished" | "unread" => {
                conditions.push("books.status = ?".to_string());
                param_values.push(Box::new(f.to_string()));
            }
            "all" => {}
            genre => {
                conditions.push("books.genre = ?".to_string());
                param_values.push(Box::new(genre.to_string()));
            }
        }
    }

    if let Some(q) = search {
        if !q.is_empty() {
            conditions.push("(LOWER(books.title) LIKE ? OR LOWER(books.author) LIKE ?)".to_string());
            let pattern = format!("%{}%", q.to_lowercase());
            param_values.push(Box::new(pattern.clone()));
            param_values.push(Box::new(pattern));
        }
    }

    // Cursor: "updated_at:id" — books older than cursor position.
    if let Some(c) = cursor {
        if let Some((ts_str, cid)) = c.split_once(':') {
            if let Ok(ts) = ts_str.parse::<i64>() {
                conditions.push(
                    "(books.updated_at < ? OR (books.updated_at = ? AND books.id > ?))".to_string(),
                );
                param_values.push(Box::new(ts));
                param_values.push(Box::new(ts));
                param_values.push(Box::new(cid.to_string()));
            }
        }
    }

    let where_clause = if conditions.is_empty() {
        String::new()
    } else {
        format!(" WHERE {}", conditions.join(" AND "))
    };

    // Count conditions = same as main conditions but without cursor.
    let count_where = {
        let mut cc: Vec<String> = Vec::new();
        if let Some(cid) = collection_id {
            cc.push("cb.collection_id = ?".to_string());
            let _ = cid;
        }
        if let Some(f) = filter {
            match f {
                "reading" | "finished" | "unread" => cc.push("books.status = ?".to_string()),
                "all" => {}
                _ => cc.push("books.genre = ?".to_string()),
            }
        }
        if search.is_some_and(|q| !q.is_empty()) {
            cc.push("(LOWER(books.title) LIKE ? OR LOWER(books.author) LIKE ?)".to_string());
        }
        if cc.is_empty() { String::new() } else { format!(" WHERE {}", cc.join(" AND ")) }
    };
    let count_sql = format!("SELECT COUNT(*) FROM {from_clause}{count_where}");
    let mut count_params: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();
    if let Some(cid) = collection_id {
        count_params.push(Box::new(cid.to_string()));
    }
    if let Some(f) = filter {
        match f {
            "reading" | "finished" | "unread" | "all" => {
                if f != "all" { count_params.push(Box::new(f.to_string())); }
            }
            _ => { count_params.push(Box::new(f.to_string())); }
        }
    }
    if let Some(q) = search {
        if !q.is_empty() {
            let pattern = format!("%{}%", q.to_lowercase());
            count_params.push(Box::new(pattern.clone()));
            count_params.push(Box::new(pattern));
        }
    }
    let count_refs: Vec<&dyn rusqlite::types::ToSql> = count_params.iter().map(|p| p.as_ref()).collect();
    let total: usize = conn.query_row(&count_sql, count_refs.as_slice(), |r| r.get(0))?;

    // Main query with cursor + limit.
    let sql = format!(
        "SELECT books.id, books.title, books.author, books.description, books.cover_path, books.file_path, books.format, books.genre, books.pages, books.status, books.progress, books.current_cfi, books.created_at, books.updated_at, books.cover_data FROM {from_clause}{where_clause} ORDER BY books.updated_at DESC, books.id ASC LIMIT ?",
    );
    param_values.push(Box::new((limit + 1) as i64));

    let params_refs: Vec<&dyn rusqlite::types::ToSql> = param_values.iter().map(|p| p.as_ref()).collect();

    let mut stmt = conn.prepare(&sql)?;
    let mut books: Vec<Book> = stmt.query_map(params_refs.as_slice(), |row| {
        let cover_blob: Option<Vec<u8>> = row.get(14)?;
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
            cover_data: cover_blob.filter(|b| !b.is_empty()).map(|b| cover_blob_to_data_uri(&b)),
        })
    })?
    .collect::<Result<Vec<_>, _>>()?;

    let next_cursor = if books.len() > limit {
        books.truncate(limit);
        let last = &books[limit - 1];
        Some(format!("{}:{}", last.updated_at, last.id))
    } else {
        None
    };

    Ok(BookPage { books, next_cursor, total })
}

/// Shared query helper for the single-book lookup. Same relative-path
/// guarantee as `query_books`.
pub(crate) fn query_book(db: &Db, id: &str) -> AppResult<Book> {
    let conn = db.reader();
    let book = conn.query_row(
        "SELECT id, title, author, description, cover_path, file_path, format, genre, pages, status, progress, current_cfi, created_at, updated_at, cover_data FROM books WHERE id = ?1",
        params![id],
        |row| {
            let cover_blob: Option<Vec<u8>> = row.get(14)?;
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
                cover_data: cover_blob.filter(|b| !b.is_empty()).map(|b| cover_blob_to_data_uri(&b)),
            })
        },
    )?;
    Ok(book)
}

/// Lightweight book query for MCP — computes `has_cover` from the BLOB
/// without actually loading/encoding cover bytes. Prevents hundreds of
/// MB of wasted DB reads + base64 allocations when MCP lists 1000 books.
pub(crate) fn query_books_lite(
    db: &Db,
    filter: Option<&str>,
    search: Option<&str>,
    limit: usize,
) -> AppResult<Vec<Book>> {
    let conn = db.reader();
    let mut conditions: Vec<String> = Vec::new();
    let mut param_values: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();

    if let Some(f) = filter {
        match f {
            "reading" | "finished" | "unread" => {
                conditions.push("status = ?".to_string());
                param_values.push(Box::new(f.to_string()));
            }
            "all" => {}
            genre => {
                conditions.push("genre = ?".to_string());
                param_values.push(Box::new(genre.to_string()));
            }
        }
    }
    if let Some(q) = search {
        if !q.is_empty() {
            conditions.push("(LOWER(title) LIKE ? OR LOWER(author) LIKE ?)".to_string());
            let pattern = format!("%{}%", q.to_lowercase());
            param_values.push(Box::new(pattern.clone()));
            param_values.push(Box::new(pattern));
        }
    }

    let where_clause = if conditions.is_empty() {
        String::new()
    } else {
        format!(" WHERE {}", conditions.join(" AND "))
    };

    let sql = format!(
        "SELECT id, title, author, description, cover_path, file_path, format, genre, pages, status, progress, current_cfi, created_at, updated_at, (cover_data IS NOT NULL AND LENGTH(cover_data) > 0) AS has_cover FROM books{where_clause} ORDER BY updated_at DESC LIMIT ?",
    );
    param_values.push(Box::new(limit as i64));
    let params_refs: Vec<&dyn rusqlite::types::ToSql> = param_values.iter().map(|p| p.as_ref()).collect();

    let mut stmt = conn.prepare(&sql)?;
    let books = stmt
        .query_map(params_refs.as_slice(), |row| {
            let has_cover: bool = row.get(14)?;
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
                cover_data: if has_cover { Some("has_cover".to_string()) } else { None },
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(books)
}

const DEFAULT_PAGE_SIZE: usize = 20;

#[tauri::command]
pub fn list_books(
    filter: Option<String>,
    search: Option<String>,
    collection_id: Option<String>,
    cursor: Option<String>,
    limit: Option<usize>,
    db: State<'_, Db>,
) -> AppResult<BookPage> {
    let page_size = limit.unwrap_or(DEFAULT_PAGE_SIZE);
    let mut page = query_books(
        &db,
        filter.as_deref(),
        search.as_deref(),
        collection_id.as_deref(),
        cursor.as_deref(),
        page_size,
    )?;
    for book in &mut page.books {
        resolve_book_paths(book, &db);
    }
    Ok(page)
}

#[derive(Debug, serde::Serialize)]
pub struct BookCounts {
    pub all: usize,
    pub reading: usize,
    pub finished: usize,
}

#[tauri::command]
pub fn get_book_counts(db: State<'_, Db>) -> AppResult<BookCounts> {
    let conn = db.reader();
    let all: usize = conn.query_row("SELECT COUNT(*) FROM books", [], |r| r.get(0))?;
    let reading: usize = conn.query_row(
        "SELECT COUNT(*) FROM books WHERE status = 'reading'", [], |r| r.get(0),
    )?;
    let finished: usize = conn.query_row(
        "SELECT COUNT(*) FROM books WHERE status = 'finished'", [], |r| r.get(0),
    )?;
    Ok(BookCounts { all, reading, finished })
}

#[tauri::command]
pub fn get_book(id: String, db: State<'_, Db>) -> AppResult<Book> {
    let mut book = query_book(&db, &id)?;
    resolve_book_paths(&mut book, &db);
    Ok(book)
}

/// Check if a book's file is locally available and trigger iCloud download if not.
#[tauri::command]
pub fn check_book_available(id: String, db: State<'_, Db>) -> AppResult<bool> {
    let conn = db.reader();
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
pub fn save_book_cover(
    book_id: String,
    cover_data: Vec<u8>,
    db: State<'_, Db>,
) -> AppResult<()> {
    let conn = db.conn.lock().map_err(|e| AppError::Other(e.to_string()))?;
    conn.execute(
        "UPDATE books SET cover_data = ?1 WHERE id = ?2",
        params![cover_data, book_id],
    )?;
    Ok(())
}

#[tauri::command]
pub fn mark_cover_unavailable(
    book_id: String,
    db: State<'_, Db>,
) -> AppResult<()> {
    let conn = db.conn.lock().map_err(|e| AppError::Other(e.to_string()))?;
    conn.execute(
        "UPDATE books SET cover_data = X'' WHERE id = ?1 AND cover_data IS NULL",
        params![book_id],
    )?;
    Ok(())
}

#[derive(Debug, Serialize)]
pub struct CoverBackfillEntry {
    pub id: String,
    pub file_path: String,
}

#[tauri::command]
pub fn list_books_needing_covers(db: State<'_, Db>) -> AppResult<Vec<CoverBackfillEntry>> {
    let conn = db.reader();
    let mut stmt = conn.prepare(
        "SELECT id, file_path FROM books WHERE format = 'pdf' AND cover_data IS NULL",
    )?;
    let entries: Vec<CoverBackfillEntry> = stmt
        .query_map([], |row| {
            Ok(CoverBackfillEntry {
                id: row.get(0)?,
                file_path: row.get(1)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(entries
        .into_iter()
        .map(|mut e| {
            e.file_path = db.resolve_path(&e.file_path).to_string_lossy().to_string();
            e
        })
        .collect())
}

pub(crate) fn do_delete_book(id: &str, db: &Db, sync: &SyncWriter) -> AppResult<()> {
    let file_path: String = {
        let conn = db.conn.lock().map_err(|e| AppError::Other(e.to_string()))?;
        conn.query_row(
            "SELECT file_path FROM books WHERE id = ?1",
            params![id],
            |row| row.get(0),
        )?
    };

    let now = chrono::Utc::now().timestamp_millis();
    sync.with_tx(db, now, |tx, events| {
        tx.execute(
            "DELETE FROM chat_messages WHERE chat_id IN (SELECT id FROM chats WHERE book_id = ?1)",
            params![id],
        )?;
        tx.execute("DELETE FROM chats WHERE book_id = ?1", params![id])?;
        tx.execute("DELETE FROM collection_books WHERE book_id = ?1", params![id])?;
        tx.execute("DELETE FROM highlights WHERE book_id = ?1", params![id])?;
        tx.execute("DELETE FROM bookmarks WHERE book_id = ?1", params![id])?;
        tx.execute("DELETE FROM vocab_words WHERE book_id = ?1", params![id])?;
        tx.execute("DELETE FROM translations WHERE book_id = ?1", params![id])?;
        tx.execute("DELETE FROM book_settings WHERE book_id = ?1", params![id])?;
        tx.execute("DELETE FROM books WHERE id = ?1", params![id])?;
        events.push(EventBody::BookDelete {
            id: id.to_string(),
        });
        Ok(())
    })?;

    let abs_file = db.resolve_path(&file_path);
    let _ = fs::remove_file(&abs_file);

    Ok(())
}

#[tauri::command]
pub fn delete_book(
    id: String,
    db: State<'_, Db>,
    sync: State<'_, SyncWriter>,
) -> AppResult<()> {
    do_delete_book(&id, &db, &sync)
}

#[tauri::command]
pub fn update_reading_progress(
    id: String,
    progress: i32,
    cfi: Option<String>,
    db: State<'_, Db>,
    sync: State<'_, SyncWriter>,
) -> AppResult<()> {
    let now = chrono::Utc::now().timestamp_millis();
    let device = sync.self_device().to_string();
    // Page-turn rate is dominated by this command; gate the event push on
    // the per-book throttle so a reading session doesn't balloon the log.
    // The SQL write always lands so the local UI stays current — only the
    // event publication is coalesced. Semantic transitions like
    // `mark_finished` deliberately do NOT consult the throttle.
    let emit = sync.should_emit_progress(&id);
    sync.with_tx(&db, now, |tx, events| {
        tx.execute(
            "UPDATE books SET progress = ?1, current_cfi = ?2, updated_at = ?3, updated_by_device = ?4 WHERE id = ?5",
            params![progress, cfi, now, device, id],
        )?;
        if emit {
            events.push(EventBody::BookProgressSet {
                book: id.clone(),
                progress,
                cfi: cfi.clone(),
            });
        }
        Ok(())
    })
}

#[tauri::command]
pub fn update_book_pages(id: String, pages: i32, db: State<'_, Db>) -> AppResult<()> {
    // Local-only — `pages` is derived from the book file on this device and
    // not part of the sync contract. Plain DB write, no SyncWriter.
    let conn = db.conn.lock().map_err(|e| AppError::Other(e.to_string()))?;
    conn.execute(
        "UPDATE books SET pages = ?1 WHERE id = ?2",
        params![pages, id],
    )?;
    Ok(())
}

#[tauri::command]
pub fn mark_finished(
    id: String,
    db: State<'_, Db>,
    sync: State<'_, SyncWriter>,
) -> AppResult<()> {
    let now = chrono::Utc::now().timestamp_millis();
    let device = sync.self_device().to_string();
    sync.with_tx(&db, now, |tx, events| {
        // Read the current cfi BEFORE the UPDATE so the synthesized
        // `book.progress.set` carries the resume position the local row
        // keeps. Local SQL doesn't touch `current_cfi` here, so emitting
        // `cfi: None` would silently null the column on every peer while
        // this device still has it — a snapshot-equivalence violation.
        let current_cfi: Option<String> = tx
            .query_row(
                "SELECT current_cfi FROM books WHERE id = ?1",
                params![id],
                |r| r.get(0),
            )
            .ok()
            .flatten();
        tx.execute(
            "UPDATE books SET status = 'finished', progress = 100, updated_at = ?1, updated_by_device = ?2 WHERE id = ?3",
            params![now, device, id],
        )?;
        // Mark-finished is two LWW columns moving in lockstep; the merge
        // engine has no `book.finished` event, so we publish the same pair
        // of events the user could have produced manually. The progress
        // event is published unconditionally — the throttle is for noisy
        // page-turn updates only, never for semantic transitions.
        events.push(EventBody::BookStatusSet {
            book: id.clone(),
            status: "finished".into(),
        });
        events.push(EventBody::BookProgressSet {
            book: id.clone(),
            progress: 100,
            cfi: current_cfi,
        });
        Ok(())
    })
}

pub(crate) fn do_update_book(
    id: &str,
    title: Option<&str>,
    author: Option<&str>,
    genre: Option<&str>,
    status: Option<&str>,
    db: &Db,
    sync: &SyncWriter,
) -> AppResult<Book> {
    let now = chrono::Utc::now().timestamp_millis();
    let device = sync.self_device().to_string();
    sync.with_tx(db, now, |tx, events| {
        if let Some(t) = title {
            tx.execute(
                "UPDATE books SET title = ?1, updated_at = ?2, updated_by_device = ?3 WHERE id = ?4",
                params![t, now, device, id],
            )?;
            events.push(EventBody::BookMetadataSet {
                book: id.to_string(),
                field: "title".into(),
                value: serde_json::Value::String(t.to_string()),
            });
        }
        if let Some(a) = author {
            tx.execute(
                "UPDATE books SET author = ?1, updated_at = ?2, updated_by_device = ?3 WHERE id = ?4",
                params![a, now, device, id],
            )?;
            events.push(EventBody::BookMetadataSet {
                book: id.to_string(),
                field: "author".into(),
                value: serde_json::Value::String(a.to_string()),
            });
        }
        if let Some(g) = genre {
            tx.execute(
                "UPDATE books SET genre = ?1, updated_at = ?2, updated_by_device = ?3 WHERE id = ?4",
                params![g, now, device, id],
            )?;
            events.push(EventBody::BookMetadataSet {
                book: id.to_string(),
                field: "genre".into(),
                value: serde_json::Value::String(g.to_string()),
            });
        }
        if let Some(s) = status {
            tx.execute(
                "UPDATE books SET status = ?1, updated_at = ?2, updated_by_device = ?3 WHERE id = ?4",
                params![s, now, device, id],
            )?;
            events.push(EventBody::BookStatusSet {
                book: id.to_string(),
                status: s.to_string(),
            });
        }
        Ok(())
    })?;
    query_book(db, id)
}

#[tauri::command]
pub fn update_book_status(
    id: String,
    status: String,
    db: State<'_, Db>,
    sync: State<'_, SyncWriter>,
) -> AppResult<()> {
    do_update_book(&id, None, None, None, Some(&status), &db, &sync)?;
    Ok(())
}

#[tauri::command]
pub fn update_book_metadata(
    id: String,
    title: String,
    author: String,
    db: State<'_, Db>,
    sync: State<'_, SyncWriter>,
) -> AppResult<()> {
    do_update_book(&id, Some(&title), Some(&author), None, None, &db, &sync)?;
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
    log::info!("import_book: start file={source_path} format=pdf stage=stage");

    let data_dir = db
        .data_dir
        .lock()
        .map_err(|e| AppError::Other(e.to_string()))?
        .clone();
    let books_dir = data_dir.join("books");
    fs::create_dir_all(&books_dir)?;

    let book_id = uuid::Uuid::new_v4().to_string();
    let staged = books_dir.join(format!("{}.pdf", book_id));
    fs::copy(std::path::Path::new(&source_path), &staged)
        .inspect_err(|e| log::error!("import_book: stage copy failed for {source_path}: {e}"))?;

    Ok(StagedPdf {
        book_id,
        abs_path: staged.to_string_lossy().to_string(),
    })
}

/// Step 2 of PDF import: rename the staged file to a slugged name, write the
/// cover, and insert the DB row. Caller must have first called
/// `stage_pdf_import` to obtain `book_id`.
//
// Tauri commands need an argument per UI-supplied field plus state handles,
// so the count creeps over clippy's seven-arg threshold. Bundling into a
// struct would force the frontend to wrap every call site for no
// readability gain — the field names are already explicit at the call.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn commit_pdf_import(
    book_id: String,
    title: String,
    author: Option<String>,
    description: Option<String>,
    pages: i32,
    cover_data: Option<Vec<u8>>,
    db: State<'_, Db>,
    sync: State<'_, SyncWriter>,
) -> AppResult<Book> {
    let data_dir = db
        .data_dir
        .lock()
        .map_err(|e| AppError::Other(e.to_string()))?
        .clone();
    let books_dir = data_dir.join("books");

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

    let now = chrono::Utc::now().timestamp_millis();
    let rel_file_path = format!("books/{}", filename);
    let cover_data_b64 = cover_data.as_ref().map(|d| {
        cover_blob_to_data_uri(d)
    });

    let book = Book {
        id: book_id,
        title,
        author: author.unwrap_or_else(|| "Unknown Author".to_string()),
        description,
        cover_path: None,
        file_path: rel_file_path,
        format: "pdf".to_string(),
        genre: None,
        pages: Some(pages),
        status: "unread".to_string(),
        progress: 0,
        current_cfi: None,
        created_at: now,
        updated_at: now,
        available: true,
        cover_data: cover_data_b64,
    };

    let device = sync.self_device().to_string();
    sync.with_tx(&db, now, |tx, events| {
        tx.execute(
            "INSERT INTO books (id, title, author, description, cover_path, file_path, format, genre, pages, status, progress, current_cfi, created_at, updated_at, updated_by_device, cover_data)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)",
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
                device,
                cover_data,
            ],
        )?;
        events.push(EventBody::BookImport(BookImportPayload {
            id: book.id.clone(),
            title: book.title.clone(),
            author: book.author.clone(),
            description: book.description.clone(),
            cover_path: book.cover_path.clone(),
            file_path: book.file_path.clone(),
            format: book.format.clone(),
            genre: book.genre.clone(),
            pages: book.pages,
        }));
        Ok(())
    })?;

    log::info!("import_book: complete id={} title={:?} format=pdf", book.id, book.title);

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
    let books_dir = data_dir.join("books");
    // Remove the staged UUID-named file.
    let staged = books_dir.join(format!("{}.pdf", book_id));
    let _ = fs::remove_file(&staged);
    // Also remove any renamed (slugged) file from a partial commit.
    if let Ok(entries) = fs::read_dir(&books_dir) {
        for entry in entries.flatten() {
            let name = entry.file_name();
            let name_str = name.to_string_lossy();
            if name_str.contains(&book_id[..8]) && name_str.ends_with(".pdf") {
                let _ = fs::remove_file(entry.path());
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Db;
    use rusqlite::params;
    use tempfile::TempDir;

    /// Regression: slugify of a CJK title used to panic when the
    /// 60-byte truncation point landed mid-codepoint. The user-facing
    /// symptom was `import_book` hanging forever (Tauri's command
    /// runtime swallows the panic so the spinner never resolves).
    /// This particular title — "百年孤独 (root edition note)" — slugs
    /// to exactly 62 bytes so the cut at byte 60 falls inside the
    /// last `删` character.
    #[test]
    fn slugify_does_not_panic_on_cjk_title_at_byte_boundary() {
        let title = "百年孤独(根据马尔克斯指定版本翻译,未做任何增删)";
        let slug = slugify(title);
        // Must be valid UTF-8 (the .to_string() in slugify would have
        // panicked if the slice were invalid) and not empty.
        assert!(!slug.is_empty());
        assert!(slug.chars().count() > 0);
        // Must round-trip into book_filename without panicking.
        let _ = book_filename(title, "abcdef0123456789", "epub");
    }

    /// ASCII titles still get a meaningful slug after the truncation
    /// fix (regression safety on the common path).
    #[test]
    fn slugify_truncates_long_ascii_at_word_boundary() {
        let title = "the quick brown fox jumps over the lazy dog and then keeps on running";
        let slug = slugify(title);
        assert!(slug.len() <= 60);
        assert!(slug.starts_with("the-quick-brown-fox"));
        assert!(!slug.ends_with('-'));
    }

    fn setup() -> (TempDir, Db) {
        let dir = TempDir::new().unwrap();
        let db = Db::init(dir.path()).unwrap();
        (dir, db)
    }

    fn insert_book(db: &Db, id: &str, format: &str) {
        let conn = db.conn.lock().unwrap();
        let now = chrono::Utc::now().timestamp_millis();
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
        let now = chrono::Utc::now().timestamp_millis();
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
        let now = chrono::Utc::now().timestamp_millis();
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
        let now = chrono::Utc::now().timestamp_millis();
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
                cover_data: None,
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
        let now = chrono::Utc::now().timestamp_millis();

        // Simulate import_pdf with author = None — exercise the same fallback
        // expression the command uses without literally writing
        // `None.unwrap_or_else(...)`, which clippy now flags.
        fn resolve(author: Option<String>) -> String {
            author.unwrap_or_else(|| "Unknown Author".to_string())
        }
        let resolved_author = resolve(None);

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
        let now = chrono::Utc::now().timestamp_millis();
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
                created_at: row.get(12)?, updated_at: row.get(13)?, available: true, cover_data: None,
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
        let now = chrono::Utc::now().timestamp_millis();
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
        let now = chrono::Utc::now().timestamp_millis();
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
        let before: i64 = conn.query_row(
            "SELECT updated_at FROM books WHERE id = 'b1'", [], |r| r.get(0),
        ).unwrap();

        std::thread::sleep(std::time::Duration::from_millis(10));
        let now = chrono::Utc::now().timestamp_millis();
        conn.execute(
            "UPDATE books SET title = ?1, author = ?2, updated_at = ?3 WHERE id = ?4",
            params!["New", "New", now, "b1"],
        ).unwrap();

        let after: i64 = conn.query_row(
            "SELECT updated_at FROM books WHERE id = 'b1'", [], |r| r.get(0),
        ).unwrap();
        assert_ne!(before, after);
    }

    #[test]
    fn test_update_metadata_nonexistent_book() {
        let (_dir, db) = setup();

        let conn = db.conn.lock().unwrap();
        let now = chrono::Utc::now().timestamp_millis();
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
                created_at: row.get(12)?, updated_at: row.get(13)?, available: true, cover_data: None,
            }),
        ).unwrap();

        assert_eq!(book.format, "pdf");
        assert_eq!(book.id, "b1");
    }

    // -----------------------------------------------------------------------
    // Pagination
    // -----------------------------------------------------------------------

    fn insert_book_with_ts(db: &Db, id: &str, status: &str, updated_at: i64) {
        let conn = db.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO books (id, title, author, file_path, format, status, progress, created_at, updated_at)
             VALUES (?1, ?2, 'Author', 'books/test.epub', 'epub', ?3, 0, ?4, ?4)",
            params![id, format!("Book {id}"), status, updated_at],
        ).unwrap();
    }

    #[test]
    fn pagination_returns_first_page() {
        let (_dir, db) = setup();
        for i in 0..5 {
            insert_book_with_ts(&db, &format!("b{i}"), "reading", 1000 + i);
        }
        let page = query_books(&db, None, None, None, None, 3).unwrap();
        assert_eq!(page.books.len(), 3);
        assert_eq!(page.total, 5);
        assert!(page.next_cursor.is_some());
    }

    #[test]
    fn pagination_cursor_returns_next_page() {
        let (_dir, db) = setup();
        for i in 0..5 {
            insert_book_with_ts(&db, &format!("b{i}"), "reading", 1000 + i);
        }
        let page1 = query_books(&db, None, None, None, None, 3).unwrap();
        let page2 = query_books(&db, None, None, None, page1.next_cursor.as_deref(), 3).unwrap();
        assert_eq!(page2.books.len(), 2);
        assert_eq!(page2.total, 5);
        assert!(page2.next_cursor.is_none());
    }

    #[test]
    fn pagination_no_more_pages() {
        let (_dir, db) = setup();
        for i in 0..3 {
            insert_book_with_ts(&db, &format!("b{i}"), "reading", 1000 + i);
        }
        let page = query_books(&db, None, None, None, None, 5).unwrap();
        assert_eq!(page.books.len(), 3);
        assert!(page.next_cursor.is_none());
    }

    #[test]
    fn pagination_filter_by_status() {
        let (_dir, db) = setup();
        insert_book_with_ts(&db, "b1", "reading", 1000);
        insert_book_with_ts(&db, "b2", "finished", 1001);
        insert_book_with_ts(&db, "b3", "reading", 1002);
        let page = query_books(&db, Some("reading"), None, None, None, 10).unwrap();
        assert_eq!(page.books.len(), 2);
        assert_eq!(page.total, 2);
    }

    #[test]
    fn pagination_search() {
        let (_dir, db) = setup();
        insert_book_with_ts(&db, "b1", "reading", 1000);
        insert_book_with_ts(&db, "b2", "reading", 1001);
        let page = query_books(&db, None, Some("Book b1"), None, None, 10).unwrap();
        assert_eq!(page.books.len(), 1);
        assert_eq!(page.books[0].id, "b1");
    }

    #[test]
    fn pagination_collection_filter() {
        let (_dir, db) = setup();
        insert_book_with_ts(&db, "b1", "reading", 1000);
        insert_book_with_ts(&db, "b2", "reading", 1001);
        insert_book_with_ts(&db, "b3", "reading", 1002);
        let conn = db.conn.lock().unwrap();
        let now = chrono::Utc::now().timestamp_millis();
        conn.execute(
            "INSERT INTO collections (id, name, sort_order, created_at, updated_at, updated_by_device)
             VALUES ('c1', 'Fiction', 0, ?1, ?1, 'dev')",
            params![now],
        ).unwrap();
        conn.execute(
            "INSERT INTO collection_books (collection_id, book_id, created_at, updated_at, updated_by_device)
             VALUES ('c1', 'b1', ?1, ?1, 'dev')",
            params![now],
        ).unwrap();
        conn.execute(
            "INSERT INTO collection_books (collection_id, book_id, created_at, updated_at, updated_by_device)
             VALUES ('c1', 'b3', ?1, ?1, 'dev')",
            params![now],
        ).unwrap();
        drop(conn);
        let page = query_books(&db, None, None, Some("c1"), None, 10).unwrap();
        assert_eq!(page.books.len(), 2);
        assert_eq!(page.total, 2);
    }

    #[test]
    fn pagination_collection_with_cursor() {
        let (_dir, db) = setup();
        for i in 0..5 {
            insert_book_with_ts(&db, &format!("b{i}"), "reading", 1000 + i);
        }
        let conn = db.conn.lock().unwrap();
        let now = chrono::Utc::now().timestamp_millis();
        conn.execute(
            "INSERT INTO collections (id, name, sort_order, created_at, updated_at, updated_by_device)
             VALUES ('c1', 'All Five', 0, ?1, ?1, 'dev')",
            params![now],
        ).unwrap();
        for i in 0..5 {
            conn.execute(
                "INSERT INTO collection_books (collection_id, book_id, created_at, updated_at, updated_by_device)
                 VALUES ('c1', ?1, ?2, ?2, 'dev')",
                params![format!("b{i}"), now],
            ).unwrap();
        }
        drop(conn);
        let page1 = query_books(&db, None, None, Some("c1"), None, 3).unwrap();
        assert_eq!(page1.books.len(), 3);
        assert_eq!(page1.total, 5);
        assert!(page1.next_cursor.is_some());
        let page2 = query_books(&db, None, None, Some("c1"), page1.next_cursor.as_deref(), 3).unwrap();
        assert_eq!(page2.books.len(), 2);
        assert!(page2.next_cursor.is_none());
    }
}
