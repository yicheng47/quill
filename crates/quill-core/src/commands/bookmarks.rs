use std::path::Path;

use rusqlite::params;
use serde::{Deserialize, Serialize};

use crate::commands::books::cover_blob_to_data_uri;
use crate::db::Db;
use crate::error::AppResult;
use crate::host::Core;

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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub book_title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub book_author: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
pub struct HighlightBookSummary {
    pub book_id: String,
    pub book_title: String,
    pub book_author: String,
    pub book_progress: i32,
    pub cover_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cover_data: Option<String>,
    pub count: usize,
}

#[derive(Debug, Serialize, Clone)]
pub struct HighlightCounts {
    pub total: usize,
    pub book_count: usize,
    pub books: Vec<HighlightBookSummary>,
}

pub fn add_bookmark(
    core: &Core,
    book_id: String,
    cfi: String,
    label: Option<String>,
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

    core.db.with_tx(|tx| {
        tx.execute(
            "INSERT INTO bookmarks (id, book_id, cfi, label, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
            params![id, book_id, cfi, label, now],
        )?;
        Ok(())
    })?;

    Ok(bookmark)
}

pub fn remove_bookmark(core: &Core, id: String) -> AppResult<()> {
    core.db.with_tx(|tx| {
        tx.execute("DELETE FROM bookmarks WHERE id = ?1", params![id])?;
        Ok(())
    })
}

/// Shared query helper. Same shape as `list_bookmarks` — both the app
/// command and the MCP `get_bookmarks` tool call this so the column
/// list lives in exactly one place.
pub(crate) fn query_bookmarks(db: &Db, book_id: &str) -> AppResult<Vec<Bookmark>> {
    let conn = db.reader();
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

pub fn list_bookmarks(core: &Core, book_id: String) -> AppResult<Vec<Bookmark>> {
    query_bookmarks(&core.db, &book_id)
}

pub fn add_highlight(
    core: &Core,
    book_id: String,
    cfi_range: String,
    color: Option<String>,
    note: Option<String>,
    text_content: Option<String>,
) -> AppResult<Highlight> {
    let id = uuid::Uuid::new_v4().to_string();
    let now = chrono::Utc::now().timestamp_millis();
    let color = color.unwrap_or_else(|| "yellow".to_string());

    log::debug!("highlights: add_highlight book_id={book_id} color={color}");

    let highlight = Highlight {
        id: id.clone(),
        book_id: book_id.clone(),
        cfi_range: cfi_range.clone(),
        color: color.clone(),
        note: note.clone(),
        text_content: text_content.clone(),
        created_at: now,
        updated_at: now,
        book_title: None,
        book_author: None,
    };

    core.db.with_tx(|tx| {
        tx.execute(
            "INSERT INTO highlights (id, book_id, cfi_range, color, note, text_content, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)",
            params![id, book_id, cfi_range, color, note, text_content, now],
        )?;
        Ok(())
    })?;

    Ok(highlight)
}

pub fn remove_highlight(core: &Core, id: String) -> AppResult<()> {
    core.db.with_tx(|tx| {
        tx.execute("DELETE FROM highlights WHERE id = ?1", params![id])?;
        Ok(())
    })
}

/// Shared query helper. Mirror of `list_highlights` for the MCP
/// `get_highlights` tool — keeps the column list canonical.
pub(crate) fn query_highlights(db: &Db, book_id: &str) -> AppResult<Vec<Highlight>> {
    let conn = db.reader();
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
                book_title: None,
                book_author: None,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(highlights)
}

pub fn list_highlights(core: &Core, book_id: String) -> AppResult<Vec<Highlight>> {
    query_highlights(&core.db, &book_id)
}

pub(crate) fn query_all_highlights(
    db: &Db,
    book_id: Option<&str>,
    search: Option<&str>,
    sort: Option<&str>,
) -> AppResult<Vec<Highlight>> {
    let conn = db.reader();
    let mut values: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();
    let where_clause = if let Some(bid) = book_id.filter(|b| !b.is_empty()) {
        values.push(Box::new(bid.to_string()));
        " WHERE h.book_id = ?"
    } else {
        ""
    };

    let order_clause = match sort {
        Some("oldest") => "ORDER BY h.created_at ASC, h.id ASC",
        _ => "ORDER BY h.created_at DESC, h.id ASC",
    };

    let sql = format!(
        "SELECT h.id, h.book_id, h.cfi_range, h.color, h.note, h.text_content, h.created_at, h.updated_at, b.title, b.author
         FROM highlights h
         LEFT JOIN books b ON h.book_id = b.id
         {where_clause}
         {order_clause}"
    );
    let refs: Vec<&dyn rusqlite::types::ToSql> = values.iter().map(|v| v.as_ref()).collect();
    let mut stmt = conn.prepare(&sql)?;
    let mut highlights = stmt
        .query_map(refs.as_slice(), |row| {
            Ok(Highlight {
                id: row.get(0)?,
                book_id: row.get(1)?,
                cfi_range: row.get(2)?,
                color: row.get(3)?,
                note: row.get(4)?,
                text_content: row.get(5)?,
                created_at: row.get(6)?,
                updated_at: row.get(7)?,
                book_title: row.get(8)?,
                book_author: row.get(9)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;

    // Case-fold both query and stored fields in Rust so non-ASCII text
    // (e.g. "Émile Zola") folds symmetrically and `%`/`_` stay literal.
    if let Some(q) = search.filter(|s| !s.is_empty()) {
        let needle = q.to_lowercase();
        highlights.retain(|h| {
            h.text_content
                .as_deref()
                .is_some_and(|s| s.to_lowercase().contains(&needle))
                || h.note
                    .as_deref()
                    .is_some_and(|s| s.to_lowercase().contains(&needle))
                || h.book_title
                    .as_deref()
                    .is_some_and(|s| s.to_lowercase().contains(&needle))
                || h.book_author
                    .as_deref()
                    .is_some_and(|s| s.to_lowercase().contains(&needle))
        });
    }

    Ok(highlights)
}

pub fn list_all_highlights(
    core: &Core,
    book_id: Option<String>,
    search: Option<String>,
    sort: Option<String>,
) -> AppResult<Vec<Highlight>> {
    query_all_highlights(
        &core.db,
        book_id.as_deref(),
        search.as_deref(),
        sort.as_deref(),
    )
}

pub(crate) fn query_highlight_counts(db: &Db) -> AppResult<HighlightCounts> {
    let conn = db.reader();
    let mut stmt = conn.prepare(
        "SELECT agg.book_id,
                COALESCE(b.title, ''),
                COALESCE(b.author, ''),
                COALESCE(b.progress, 0),
                b.cover_path,
                b.cover_data,
                agg.cnt,
                agg.latest_highlight_at
         FROM (
             SELECT book_id,
                    COUNT(*) AS cnt,
                    MAX(created_at) AS latest_highlight_at
             FROM highlights
             GROUP BY book_id
         ) agg
         LEFT JOIN books b ON agg.book_id = b.id
         ORDER BY agg.cnt DESC, agg.latest_highlight_at DESC, agg.book_id ASC",
    )?;
    let books = stmt
        .query_map([], |row| {
            let raw_cover_path: Option<String> = row.get(4)?;
            let cover_path = raw_cover_path.map(|cover| {
                if cover != "none" && !Path::new(&cover).is_absolute() {
                    db.resolve_path(&cover).to_string_lossy().to_string()
                } else {
                    cover
                }
            });
            let cover_blob: Option<Vec<u8>> = row.get(5)?;
            let cover_data = cover_blob
                .filter(|b| !b.is_empty())
                .map(|b| cover_blob_to_data_uri(&b));
            Ok(HighlightBookSummary {
                book_id: row.get(0)?,
                book_title: row.get(1)?,
                book_author: row.get(2)?,
                book_progress: row.get(3)?,
                cover_path,
                cover_data,
                count: row.get(6)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;

    let total = books.iter().map(|b| b.count).sum();
    let book_count = books.len();
    Ok(HighlightCounts {
        total,
        book_count,
        books,
    })
}

pub fn get_highlight_counts(core: &Core) -> AppResult<HighlightCounts> {
    query_highlight_counts(&core.db)
}

pub fn update_highlight_note(core: &Core, id: String, note: String) -> AppResult<()> {
    let now = chrono::Utc::now().timestamp_millis();
    core.db.with_tx(|tx| {
        tx.execute(
            "UPDATE highlights SET note = ?1, updated_at = ?2 WHERE id = ?3",
            params![note, now, id],
        )?;
        Ok(())
    })
}

pub fn update_highlight_color(core: &Core, id: String, color: String) -> AppResult<()> {
    let now = chrono::Utc::now().timestamp_millis();
    core.db.with_tx(|tx| {
        tx.execute(
            "UPDATE highlights SET color = ?1, updated_at = ?2 WHERE id = ?3",
            params![color, now, id],
        )?;
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn setup() -> (TempDir, Db) {
        let dir = TempDir::new().unwrap();
        let db = Db::init(dir.path()).unwrap();
        (dir, db)
    }

    fn insert_book(
        db: &Db,
        id: &str,
        title: &str,
        author: &str,
        progress: i32,
        cover_path: Option<&str>,
        cover_data: Option<&[u8]>,
    ) {
        let conn = db.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO books (id, title, author, cover_path, file_path, format, status, progress, created_at, updated_at, cover_data)
             VALUES (?1, ?2, ?3, ?4, 'books/test.epub', 'epub', 'reading', ?5, 1000, 1000, ?6)",
            params![id, title, author, cover_path, progress, cover_data],
        )
        .unwrap();
    }

    fn insert_highlight(
        db: &Db,
        id: &str,
        book_id: &str,
        text: Option<&str>,
        note: Option<&str>,
        color: &str,
        created_at: i64,
    ) {
        let conn = db.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO highlights (id, book_id, cfi_range, color, note, text_content, created_at, updated_at)
             VALUES (?1, ?2, 'epubcfi(/6/2)', ?3, ?4, ?5, ?6, ?6)",
            params![id, book_id, color, note, text, created_at],
        )
        .unwrap();
    }

    #[test]
    fn query_highlights_omits_optional_book_metadata_in_json() {
        let (_dir, db) = setup();
        insert_book(&db, "b1", "Notes from Underground", "Dostoevsky", 12, None, None);
        insert_highlight(&db, "h1", "b1", Some("I am a sick man."), None, "violet", 2000);

        let list = query_highlights(&db, "b1").unwrap();
        assert_eq!(list.len(), 1);
        let json = serde_json::to_value(&list[0]).unwrap();
        assert!(json.get("book_title").is_none());
        assert!(json.get("book_author").is_none());
    }

    #[test]
    fn query_all_highlights_filters_searches_and_sorts() {
        let (_dir, db) = setup();
        insert_book(&db, "b1", "Notes from Underground", "Fyodor Dostoevsky", 4, None, None);
        insert_book(&db, "b2", "100% Pure Design", "Jane Doe", 50, None, None);
        insert_book(&db, "b3", "Germinal", "Émile Zola", 20, None, None);
        insert_book(&db, "b4", "1000 Nights", "Anon", 10, None, None);

        insert_highlight(&db, "h1", "b1", Some("I am a spiteful man."), Some("opening"), "violet", 1000);
        insert_highlight(&db, "h2", "b1", Some("To think too much is a disease."), None, "yellow", 3000);
        insert_highlight(&db, "h3", "b2", Some("Good typography is invisible."), Some("note_key"), "green", 2000);
        insert_highlight(&db, "h4", "b3", Some("A bright café morning."), None, "blue", 2500);
        insert_highlight(&db, "h5", "b4", Some("notexkey"), None, "pink", 500);

        // Default sort: newest first
        let newest = query_all_highlights(&db, None, None, None).unwrap();
        let ids: Vec<&str> = newest.iter().map(|h| h.id.as_str()).collect();
        assert_eq!(ids, vec!["h2", "h4", "h3", "h1", "h5"]);
        assert_eq!(newest[0].book_title.as_deref(), Some("Notes from Underground"));
        assert_eq!(newest[0].book_author.as_deref(), Some("Fyodor Dostoevsky"));

        // Oldest sort
        let oldest = query_all_highlights(&db, None, None, Some("oldest")).unwrap();
        let old_ids: Vec<&str> = oldest.iter().map(|h| h.id.as_str()).collect();
        assert_eq!(old_ids, vec!["h5", "h1", "h3", "h4", "h2"]);

        // Book filter
        let b1_only = query_all_highlights(&db, Some("b1"), None, None).unwrap();
        assert_eq!(b1_only.len(), 2);

        // Case-insensitive search across text_content, note, title, author, non-ASCII, and literal %/_
        assert_eq!(query_all_highlights(&db, None, Some("SPITEFUL"), None).unwrap().len(), 1);
        assert_eq!(query_all_highlights(&db, None, Some("opening"), None).unwrap().len(), 1);
        assert_eq!(query_all_highlights(&db, None, Some("dostoevsky"), None).unwrap().len(), 2);
        assert_eq!(query_all_highlights(&db, None, Some("émile zola"), None).unwrap().len(), 1);
        assert_eq!(query_all_highlights(&db, None, Some("ÉMILE"), None).unwrap().len(), 1);
        assert_eq!(query_all_highlights(&db, None, Some("CAFÉ"), None).unwrap().len(), 1);
        let pct = query_all_highlights(&db, None, Some("100%"), None).unwrap();
        assert_eq!(pct.len(), 1);
        assert_eq!(pct[0].book_id, "b2");
        let under = query_all_highlights(&db, None, Some("note_key"), None).unwrap();
        assert_eq!(under.len(), 1);
        assert_eq!(under[0].book_id, "b2");
    }

    #[test]
    fn query_highlight_counts_orders_and_resolves_covers() {
        let (dir, db) = setup();
        insert_book(
            &db,
            "b1",
            "Book One",
            "Author One",
            15,
            Some("covers/b1.jpg"),
            Some(b"\x89PNGfake"),
        );
        insert_book(&db, "b2", "Book Two", "Author Two", 80, Some("none"), None);
        insert_book(&db, "b3", "Book Three", "Author Three", 0, None, None);

        // b2 has 2 highlights (latest 2000), b1 has 2 highlights (latest 3000) -> b1 sorts before b2 on tie
        insert_highlight(&db, "h1", "b2", Some("A"), None, "yellow", 1000);
        insert_highlight(&db, "h2", "b2", Some("B"), None, "yellow", 2000);
        insert_highlight(&db, "h3", "b1", Some("C"), None, "blue", 1500);
        insert_highlight(&db, "h4", "b1", Some("D"), None, "pink", 3000);
        insert_highlight(&db, "h5", "b3", Some("E"), None, "green", 5000);

        let counts = query_highlight_counts(&db).unwrap();
        assert_eq!(counts.total, 5);
        assert_eq!(counts.book_count, 3);
        let order: Vec<&str> = counts.books.iter().map(|b| b.book_id.as_str()).collect();
        assert_eq!(order, vec!["b1", "b2", "b3"]);

        assert_eq!(counts.books[0].count, 2);
        assert_eq!(counts.books[0].book_progress, 15);
        assert_eq!(
            counts.books[0].cover_path.as_deref(),
            Some(dir.path().join("covers/b1.jpg").to_string_lossy().as_ref())
        );
        assert!(counts.books[0]
            .cover_data
            .as_deref()
            .is_some_and(|s| s.starts_with("data:image/png;base64,")));

        assert_eq!(counts.books[1].cover_path.as_deref(), Some("none"));
        assert!(counts.books[1].cover_data.is_none());
    }
}
