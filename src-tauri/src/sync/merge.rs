//! Deterministic per-event merge.
//!
//! `apply_event(tx, event)` folds one peer event into the local SQLite
//! materialized view. Three rules:
//!
//! 1. **Add events** (`*.add`, `*.create`, `*.import`) use `INSERT OR IGNORE`
//!    and are guarded by a tombstone check on the entity's id. Once a row is
//!    deleted, a later add with the same id never resurrects it — the user
//!    must mint a new id.
//! 2. **LWW updates** (`*.set`, `*.rename`, `*.color.set`, …) compare the
//!    tuple `(stored.updated_at, stored.updated_by_device)` against
//!    `(event.ts, event.device)`. Strict-less-than wins; equality means we've
//!    already applied this exact write. The compare lives in the `WHERE`
//!    clause so SQLite skips the row in one statement.
//! 3. **Deletes** drop the row plus all FK-children manually (the replay
//!    engine runs with `PRAGMA foreign_keys = OFF` so cascades don't fire),
//!    then `INSERT OR IGNORE` a tombstone keyed `(entity, id)`.
//!
//! Foreign keys are deliberately off during apply because cross-device
//! ordering can deliver a child event before its parent (e.g. a clock-skewed
//! `highlight.add` arriving before `book.import`). Letting the orphan land
//! and then catching up when the parent appears is safer than failing the
//! whole replay tick. The UI joins through parents, so orphans are invisible
//! until the parent shows up.

use rusqlite::{params, Transaction};
use serde_json::Value;

use crate::error::{AppError, AppResult};

use super::events::{
    BookImportPayload, BookmarkPayload, ChatMessagePayload, Event, EventBody, HighlightPayload,
    TranslationPayload, VocabPayload,
};

/// Fold `event` into `tx`. Idempotent — applying the same event twice is a
/// no-op (LWW equality and `INSERT OR IGNORE` both short-circuit).
pub fn apply_event(tx: &Transaction, event: &Event) -> AppResult<()> {
    match &event.body {
        EventBody::BookImport(p) => apply_book_import(tx, event, p),
        EventBody::BookDelete { id } => apply_book_delete(tx, event, id),
        EventBody::BookProgressSet { book, progress, cfi } => {
            apply_book_progress(tx, event, book, *progress, cfi.as_deref())
        }
        EventBody::BookStatusSet { book, status } => {
            apply_book_status(tx, event, book, status)
        }
        EventBody::BookMetadataSet { book, field, value } => {
            apply_book_metadata(tx, event, book, field, value)
        }

        EventBody::HighlightAdd(p) => apply_highlight_add(tx, event, p),
        EventBody::HighlightDelete { id } => apply_highlight_delete(tx, event, id),
        EventBody::HighlightColorSet { id, color } => {
            apply_highlight_color(tx, event, id, color)
        }
        EventBody::HighlightNoteSet { id, note } => {
            apply_highlight_note(tx, event, id, note.as_deref())
        }

        EventBody::BookmarkAdd(p) => apply_bookmark_add(tx, event, p),
        EventBody::BookmarkDelete { id } => apply_bookmark_delete(tx, event, id),

        EventBody::VocabAdd(p) => apply_vocab_add(tx, event, p),
        EventBody::VocabMasterySet {
            id,
            mastery,
            next_review_at,
            review_count,
        } => apply_vocab_mastery(tx, event, id, mastery, *next_review_at, *review_count),
        EventBody::VocabDelete { id } => apply_vocab_delete(tx, event, id),

        EventBody::TranslationAdd(p) => apply_translation_add(tx, event, p),
        EventBody::TranslationDelete { id } => apply_translation_delete(tx, event, id),

        EventBody::CollectionCreate { id, name, sort_order } => {
            apply_collection_create(tx, event, id, name, *sort_order)
        }
        EventBody::CollectionRename { id, name } => apply_collection_rename(tx, event, id, name),
        EventBody::CollectionReorder { id, sort_order } => {
            apply_collection_reorder(tx, event, id, *sort_order)
        }
        EventBody::CollectionDelete { id } => apply_collection_delete(tx, event, id),
        EventBody::CollectionBookAdd { collection, book } => {
            apply_collection_book_add(tx, event, collection, book)
        }
        EventBody::CollectionBookRemove { collection, book } => {
            apply_collection_book_remove(tx, event, collection, book)
        }

        EventBody::ChatCreate { id, book, title, model } => {
            apply_chat_create(tx, event, id, book, title, model.as_deref())
        }
        EventBody::ChatRename { id, title } => apply_chat_rename(tx, event, id, title),
        EventBody::ChatDelete { id } => apply_chat_delete(tx, event, id),
        EventBody::ChatMessageAdd(p) => apply_chat_message_add(tx, event, p),
    }
}

// ---------------------------------------------------------------------------
// Tombstone helpers.
// ---------------------------------------------------------------------------

/// Tombstone entity tags. Stable strings — they appear on disk in
/// `_tombstones.entity` and inside snapshots, so don't rename casually.
pub mod entity {
    pub const BOOK: &str = "book";
    pub const HIGHLIGHT: &str = "highlight";
    pub const BOOKMARK: &str = "bookmark";
    pub const VOCAB: &str = "vocab";
    pub const TRANSLATION: &str = "translation";
    pub const COLLECTION: &str = "collection";
    /// Composite-key entity for `collection_books`. Id format:
    /// `"<collection_id>:<book_id>"`.
    pub const COLLECTION_BOOK: &str = "collection_book";
    pub const CHAT: &str = "chat";
    pub const CHAT_MESSAGE: &str = "chat_message";
}

pub fn is_tombstoned(tx: &Transaction, entity: &str, id: &str) -> AppResult<bool> {
    let exists: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM _tombstones WHERE entity = ?1 AND id = ?2)",
        params![entity, id],
        |r| r.get(0),
    )?;
    Ok(exists)
}

pub fn insert_tombstone(tx: &Transaction, entity: &str, id: &str, ts: i64) -> AppResult<()> {
    tx.execute(
        "INSERT OR IGNORE INTO _tombstones (entity, id, ts) VALUES (?1, ?2, ?3)",
        params![entity, id, ts],
    )?;
    Ok(())
}

// ---------------------------------------------------------------------------
// books
// ---------------------------------------------------------------------------

fn apply_book_import(tx: &Transaction, event: &Event, p: &BookImportPayload) -> AppResult<()> {
    if is_tombstoned(tx, entity::BOOK, &p.id)? {
        return Ok(());
    }
    tx.execute(
        "INSERT OR IGNORE INTO books
         (id, title, author, description, cover_path, file_path, genre, pages,
          format, status, progress, current_cfi, created_at, updated_at, updated_by_device)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'unread', 0, NULL, ?10, ?10, ?11)",
        params![
            p.id,
            p.title,
            p.author,
            p.description,
            p.cover_path,
            p.file_path,
            p.genre,
            p.pages,
            p.format,
            event.ts,
            event.device,
        ],
    )?;
    Ok(())
}

fn apply_book_delete(tx: &Transaction, event: &Event, id: &str) -> AppResult<()> {
    // Manual cascade — replay runs with FK off; we walk every child table
    // explicitly so the UI doesn't see orphan rows hanging off a deleted book.
    tx.execute("DELETE FROM bookmarks WHERE book_id = ?1", params![id])?;
    tx.execute("DELETE FROM highlights WHERE book_id = ?1", params![id])?;
    tx.execute("DELETE FROM vocab_words WHERE book_id = ?1", params![id])?;
    tx.execute(
        "DELETE FROM collection_books WHERE book_id = ?1",
        params![id],
    )?;
    tx.execute("DELETE FROM translations WHERE book_id = ?1", params![id])?;
    // Chat messages reference chats, not books — but chats reference books, so
    // wipe both in order. No FK declared between chats↔chat_messages, so we
    // collect chat ids first and delete messages per chat.
    let chat_ids: Vec<String> = {
        let mut stmt = tx.prepare("SELECT id FROM chats WHERE book_id = ?1")?;
        let collected: Vec<String> = stmt
            .query_map(params![id], |r| r.get::<_, String>(0))?
            .collect::<Result<_, _>>()?;
        collected
    };
    for chat_id in &chat_ids {
        tx.execute(
            "DELETE FROM chat_messages WHERE chat_id = ?1",
            params![chat_id],
        )?;
    }
    tx.execute("DELETE FROM chats WHERE book_id = ?1", params![id])?;
    tx.execute("DELETE FROM books WHERE id = ?1", params![id])?;

    insert_tombstone(tx, entity::BOOK, id, event.ts)?;
    Ok(())
}

fn apply_book_progress(
    tx: &Transaction,
    event: &Event,
    book: &str,
    progress: i32,
    cfi: Option<&str>,
) -> AppResult<()> {
    tx.execute(
        "UPDATE books
         SET progress = ?1, current_cfi = ?2, updated_at = ?3, updated_by_device = ?4
         WHERE id = ?5
           AND (updated_at < ?3 OR (updated_at = ?3 AND updated_by_device < ?4))",
        params![progress, cfi, event.ts, event.device, book],
    )?;
    Ok(())
}

fn apply_book_status(tx: &Transaction, event: &Event, book: &str, status: &str) -> AppResult<()> {
    tx.execute(
        "UPDATE books
         SET status = ?1, updated_at = ?2, updated_by_device = ?3
         WHERE id = ?4
           AND (updated_at < ?2 OR (updated_at = ?2 AND updated_by_device < ?3))",
        params![status, event.ts, event.device, book],
    )?;
    Ok(())
}

fn apply_book_metadata(
    tx: &Transaction,
    event: &Event,
    book: &str,
    field: &str,
    value: &Value,
) -> AppResult<()> {
    // Allowlist — only fields the metadata-set event is allowed to touch.
    // Unknown fields (e.g. from a future schema) are dropped silently rather
    // than blowing up a whole replay tick.
    let column = match field {
        "title" | "author" | "description" | "cover_path" | "genre" | "file_path" => field,
        "pages" => "pages",
        _ => {
            eprintln!("sync: unknown book.metadata.set field {field:?}, skipping");
            return Ok(());
        }
    };

    let sql = format!(
        "UPDATE books
         SET {column} = ?1, updated_at = ?2, updated_by_device = ?3
         WHERE id = ?4
           AND (updated_at < ?2 OR (updated_at = ?2 AND updated_by_device < ?3))"
    );

    if column == "pages" {
        let int_val: Option<i64> = match value {
            Value::Null => None,
            Value::Number(n) => n.as_i64().or_else(|| n.as_u64().map(|u| u as i64)),
            other => {
                return Err(AppError::Other(format!(
                    "book.metadata.set pages expects number/null, got {other:?}"
                )));
            }
        };
        tx.execute(
            &sql,
            params![int_val, event.ts, event.device, book],
        )?;
    } else {
        let str_val: Option<String> = match value {
            Value::Null => None,
            Value::String(s) => Some(s.clone()),
            other => {
                return Err(AppError::Other(format!(
                    "book.metadata.set {field} expects string/null, got {other:?}"
                )));
            }
        };
        tx.execute(
            &sql,
            params![str_val, event.ts, event.device, book],
        )?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// highlights
// ---------------------------------------------------------------------------

fn apply_highlight_add(tx: &Transaction, event: &Event, p: &HighlightPayload) -> AppResult<()> {
    if is_tombstoned(tx, entity::HIGHLIGHT, &p.id)? {
        return Ok(());
    }
    tx.execute(
        "INSERT OR IGNORE INTO highlights
         (id, book_id, cfi_range, color, note, text_content,
          created_at, updated_at, updated_by_device)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7, ?8)",
        params![
            p.id,
            p.book_id,
            p.cfi_range,
            p.color,
            p.note,
            p.text_content,
            event.ts,
            event.device,
        ],
    )?;
    Ok(())
}

fn apply_highlight_delete(tx: &Transaction, event: &Event, id: &str) -> AppResult<()> {
    tx.execute("DELETE FROM highlights WHERE id = ?1", params![id])?;
    insert_tombstone(tx, entity::HIGHLIGHT, id, event.ts)?;
    Ok(())
}

fn apply_highlight_color(tx: &Transaction, event: &Event, id: &str, color: &str) -> AppResult<()> {
    tx.execute(
        "UPDATE highlights
         SET color = ?1, updated_at = ?2, updated_by_device = ?3
         WHERE id = ?4
           AND (updated_at < ?2 OR (updated_at = ?2 AND updated_by_device < ?3))",
        params![color, event.ts, event.device, id],
    )?;
    Ok(())
}

fn apply_highlight_note(
    tx: &Transaction,
    event: &Event,
    id: &str,
    note: Option<&str>,
) -> AppResult<()> {
    tx.execute(
        "UPDATE highlights
         SET note = ?1, updated_at = ?2, updated_by_device = ?3
         WHERE id = ?4
           AND (updated_at < ?2 OR (updated_at = ?2 AND updated_by_device < ?3))",
        params![note, event.ts, event.device, id],
    )?;
    Ok(())
}

// ---------------------------------------------------------------------------
// bookmarks (append-only — no LWW, no updated_by_device)
// ---------------------------------------------------------------------------

fn apply_bookmark_add(tx: &Transaction, event: &Event, p: &BookmarkPayload) -> AppResult<()> {
    if is_tombstoned(tx, entity::BOOKMARK, &p.id)? {
        return Ok(());
    }
    tx.execute(
        "INSERT OR IGNORE INTO bookmarks (id, book_id, cfi, label, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
        params![p.id, p.book_id, p.cfi, p.label, event.ts],
    )?;
    Ok(())
}

fn apply_bookmark_delete(tx: &Transaction, event: &Event, id: &str) -> AppResult<()> {
    tx.execute("DELETE FROM bookmarks WHERE id = ?1", params![id])?;
    insert_tombstone(tx, entity::BOOKMARK, id, event.ts)?;
    Ok(())
}

// ---------------------------------------------------------------------------
// vocab
// ---------------------------------------------------------------------------

fn apply_vocab_add(tx: &Transaction, event: &Event, p: &VocabPayload) -> AppResult<()> {
    if is_tombstoned(tx, entity::VOCAB, &p.id)? {
        return Ok(());
    }
    tx.execute(
        "INSERT OR IGNORE INTO vocab_words
         (id, book_id, word, definition, context_sentence, cfi,
          mastery, review_count, next_review_at,
          created_at, updated_at, updated_by_device)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10, ?11)",
        params![
            p.id,
            p.book_id,
            p.word,
            p.definition,
            p.context_sentence,
            p.cfi,
            p.mastery,
            p.review_count,
            p.next_review_at,
            event.ts,
            event.device,
        ],
    )?;
    Ok(())
}

fn apply_vocab_mastery(
    tx: &Transaction,
    event: &Event,
    id: &str,
    mastery: &str,
    next_review_at: Option<i64>,
    review_count: i64,
) -> AppResult<()> {
    tx.execute(
        "UPDATE vocab_words
         SET mastery = ?1,
             next_review_at = ?2,
             review_count = ?3,
             updated_at = ?4,
             updated_by_device = ?5
         WHERE id = ?6
           AND (updated_at < ?4 OR (updated_at = ?4 AND updated_by_device < ?5))",
        params![mastery, next_review_at, review_count, event.ts, event.device, id],
    )?;
    Ok(())
}

fn apply_vocab_delete(tx: &Transaction, event: &Event, id: &str) -> AppResult<()> {
    tx.execute("DELETE FROM vocab_words WHERE id = ?1", params![id])?;
    insert_tombstone(tx, entity::VOCAB, id, event.ts)?;
    Ok(())
}

// ---------------------------------------------------------------------------
// translations (append-only)
// ---------------------------------------------------------------------------

fn apply_translation_add(tx: &Transaction, event: &Event, p: &TranslationPayload) -> AppResult<()> {
    if is_tombstoned(tx, entity::TRANSLATION, &p.id)? {
        return Ok(());
    }
    tx.execute(
        "INSERT OR IGNORE INTO translations
         (id, book_id, source_text, translated_text, target_language, cfi,
          created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)",
        params![
            p.id,
            p.book_id,
            p.source_text,
            p.translated_text,
            p.target_language,
            p.cfi,
            event.ts,
        ],
    )?;
    Ok(())
}

fn apply_translation_delete(tx: &Transaction, event: &Event, id: &str) -> AppResult<()> {
    tx.execute("DELETE FROM translations WHERE id = ?1", params![id])?;
    insert_tombstone(tx, entity::TRANSLATION, id, event.ts)?;
    Ok(())
}

// ---------------------------------------------------------------------------
// collections + collection_books
// ---------------------------------------------------------------------------

fn apply_collection_create(
    tx: &Transaction,
    event: &Event,
    id: &str,
    name: &str,
    sort_order: i32,
) -> AppResult<()> {
    if is_tombstoned(tx, entity::COLLECTION, id)? {
        return Ok(());
    }
    tx.execute(
        "INSERT OR IGNORE INTO collections
         (id, name, sort_order, created_at, updated_at, updated_by_device)
         VALUES (?1, ?2, ?3, ?4, ?4, ?5)",
        params![id, name, sort_order, event.ts, event.device],
    )?;
    Ok(())
}

fn apply_collection_rename(tx: &Transaction, event: &Event, id: &str, name: &str) -> AppResult<()> {
    tx.execute(
        "UPDATE collections
         SET name = ?1, updated_at = ?2, updated_by_device = ?3
         WHERE id = ?4
           AND (updated_at < ?2 OR (updated_at = ?2 AND updated_by_device < ?3))",
        params![name, event.ts, event.device, id],
    )?;
    Ok(())
}

fn apply_collection_reorder(
    tx: &Transaction,
    event: &Event,
    id: &str,
    sort_order: i32,
) -> AppResult<()> {
    tx.execute(
        "UPDATE collections
         SET sort_order = ?1, updated_at = ?2, updated_by_device = ?3
         WHERE id = ?4
           AND (updated_at < ?2 OR (updated_at = ?2 AND updated_by_device < ?3))",
        params![sort_order, event.ts, event.device, id],
    )?;
    Ok(())
}

fn apply_collection_delete(tx: &Transaction, event: &Event, id: &str) -> AppResult<()> {
    // Manual cascade: drop the join rows, then the collection itself. Tombstone
    // each join under the composite-key entity so a delayed `collection.book.add`
    // for the same pair stays suppressed.
    let pairs: Vec<String> = {
        let mut stmt =
            tx.prepare("SELECT book_id FROM collection_books WHERE collection_id = ?1")?;
        let collected: Vec<String> = stmt
            .query_map(params![id], |r| r.get::<_, String>(0))?
            .collect::<Result<_, _>>()?;
        collected
    };
    for book_id in pairs {
        let key = format!("{id}:{book_id}");
        insert_tombstone(tx, entity::COLLECTION_BOOK, &key, event.ts)?;
    }
    tx.execute(
        "DELETE FROM collection_books WHERE collection_id = ?1",
        params![id],
    )?;
    tx.execute("DELETE FROM collections WHERE id = ?1", params![id])?;
    insert_tombstone(tx, entity::COLLECTION, id, event.ts)?;
    Ok(())
}

fn apply_collection_book_add(
    tx: &Transaction,
    event: &Event,
    collection: &str,
    book: &str,
) -> AppResult<()> {
    let key = format!("{collection}:{book}");
    if is_tombstoned(tx, entity::COLLECTION_BOOK, &key)? {
        return Ok(());
    }
    tx.execute(
        "INSERT OR IGNORE INTO collection_books
         (collection_id, book_id, created_at, updated_at, updated_by_device)
         VALUES (?1, ?2, ?3, ?3, ?4)",
        params![collection, book, event.ts, event.device],
    )?;
    Ok(())
}

fn apply_collection_book_remove(
    tx: &Transaction,
    event: &Event,
    collection: &str,
    book: &str,
) -> AppResult<()> {
    tx.execute(
        "DELETE FROM collection_books WHERE collection_id = ?1 AND book_id = ?2",
        params![collection, book],
    )?;
    let key = format!("{collection}:{book}");
    insert_tombstone(tx, entity::COLLECTION_BOOK, &key, event.ts)?;
    Ok(())
}

// ---------------------------------------------------------------------------
// chats + chat_messages
// ---------------------------------------------------------------------------

fn apply_chat_create(
    tx: &Transaction,
    event: &Event,
    id: &str,
    book: &str,
    title: &str,
    model: Option<&str>,
) -> AppResult<()> {
    if is_tombstoned(tx, entity::CHAT, id)? {
        return Ok(());
    }
    tx.execute(
        "INSERT OR IGNORE INTO chats
         (id, book_id, title, model, pinned, created_at, updated_at, updated_by_device)
         VALUES (?1, ?2, ?3, ?4, 0, ?5, ?5, ?6)",
        params![id, book, title, model, event.ts, event.device],
    )?;
    Ok(())
}

fn apply_chat_rename(tx: &Transaction, event: &Event, id: &str, title: &str) -> AppResult<()> {
    tx.execute(
        "UPDATE chats
         SET title = ?1, updated_at = ?2, updated_by_device = ?3
         WHERE id = ?4
           AND (updated_at < ?2 OR (updated_at = ?2 AND updated_by_device < ?3))",
        params![title, event.ts, event.device, id],
    )?;
    Ok(())
}

fn apply_chat_delete(tx: &Transaction, event: &Event, id: &str) -> AppResult<()> {
    tx.execute("DELETE FROM chat_messages WHERE chat_id = ?1", params![id])?;
    tx.execute("DELETE FROM chats WHERE id = ?1", params![id])?;
    insert_tombstone(tx, entity::CHAT, id, event.ts)?;
    Ok(())
}

fn apply_chat_message_add(
    tx: &Transaction,
    event: &Event,
    p: &ChatMessagePayload,
) -> AppResult<()> {
    if is_tombstoned(tx, entity::CHAT_MESSAGE, &p.id)? {
        return Ok(());
    }
    tx.execute(
        "INSERT OR IGNORE INTO chat_messages
         (id, chat_id, role, content, context, metadata, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)",
        params![
            p.id,
            p.chat_id,
            p.role,
            p.content,
            p.context,
            p.metadata,
            event.ts,
        ],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    //! Each test follows the same shape: open an in-memory DB, run migrations
    //! up to 11, build events, apply, assert SQL state. We toggle FK off for
    //! the apply tx because the replay engine does the same — see the module
    //! docstring for the rationale.

    use super::*;
    use crate::db::Db;
    use crate::sync::events::*;
    use rusqlite::Connection;
    use serde_json::json;

    fn open_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys=ON;").unwrap();
        Db::run_migrations_on(&conn).unwrap();
        conn.execute_batch("PRAGMA foreign_keys=OFF;").unwrap();
        conn
    }

    fn ev(ts: i64, device: &str, body: EventBody) -> Event {
        Event {
            id: format!("01HYZX0000000000000000{:04X}", ts as u16),
            ts,
            device: device.to_string(),
            v: EVENT_SCHEMA_VERSION,
            body,
            extra: serde_json::Map::new(),
        }
    }

    fn apply_all(conn: &mut Connection, events: &[Event]) {
        let tx = conn.transaction().unwrap();
        for e in events {
            apply_event(&tx, e).expect("apply_event failed");
        }
        tx.commit().unwrap();
    }

    fn import_book(id: &str) -> EventBody {
        EventBody::BookImport(BookImportPayload {
            id: id.into(),
            title: "T".into(),
            author: "A".into(),
            description: None,
            cover_path: None,
            file_path: format!("books/{id}.epub"),
            format: "epub".into(),
            genre: None,
            pages: Some(100),
        })
    }

    fn add_highlight(id: &str, book: &str, color: &str) -> EventBody {
        EventBody::HighlightAdd(HighlightPayload {
            id: id.into(),
            book_id: book.into(),
            cfi_range: "epubcfi(/6/4!/2,/1:0,/1:5)".into(),
            color: color.into(),
            note: None,
            text_content: None,
        })
    }

    // -----------------------------------------------------------------------
    // book.import / book.delete + tombstone semantics
    // -----------------------------------------------------------------------

    #[test]
    fn book_import_inserts_with_event_metadata() {
        let mut db = open_db();
        apply_all(
            &mut db,
            &[ev(1000, "dev-A", import_book("b1"))],
        );

        let (title, ts, dev): (String, i64, String) = db
            .query_row(
                "SELECT title, updated_at, updated_by_device FROM books WHERE id = 'b1'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!(title, "T");
        assert_eq!(ts, 1000);
        assert_eq!(dev, "dev-A");
    }

    #[test]
    fn book_delete_removes_row_and_writes_tombstone() {
        let mut db = open_db();
        apply_all(
            &mut db,
            &[
                ev(1000, "dev-A", import_book("b1")),
                ev(2000, "dev-A", EventBody::BookDelete { id: "b1".into() }),
            ],
        );

        let n: i64 = db
            .query_row("SELECT COUNT(*) FROM books WHERE id = 'b1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 0);
        let tomb: i64 = db
            .query_row(
                "SELECT COUNT(*) FROM _tombstones WHERE entity = 'book' AND id = 'b1'",
                [], |r| r.get(0),
            )
            .unwrap();
        assert_eq!(tomb, 1);
    }

    #[test]
    fn tombstone_blocks_resurrection() {
        // delete then add (later ts, same id) → row stays gone.
        let mut db = open_db();
        apply_all(
            &mut db,
            &[
                ev(1000, "dev-A", import_book("b1")),
                ev(2000, "dev-A", EventBody::BookDelete { id: "b1".into() }),
                ev(3000, "dev-A", import_book("b1")),
            ],
        );
        let n: i64 = db
            .query_row("SELECT COUNT(*) FROM books WHERE id = 'b1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 0, "tombstone should block re-import even at higher ts");
    }

    #[test]
    fn book_delete_cascades_to_children() {
        let mut db = open_db();
        apply_all(
            &mut db,
            &[
                ev(1000, "dev-A", import_book("b1")),
                ev(1001, "dev-A", add_highlight("h1", "b1", "yellow")),
                ev(
                    1002,
                    "dev-A",
                    EventBody::BookmarkAdd(BookmarkPayload {
                        id: "bm1".into(),
                        book_id: "b1".into(),
                        cfi: "epubcfi(/6/4!)".into(),
                        label: None,
                    }),
                ),
                ev(2000, "dev-A", EventBody::BookDelete { id: "b1".into() }),
            ],
        );
        for table in ["books", "highlights", "bookmarks"] {
            let n: i64 = db
                .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0))
                .unwrap();
            assert_eq!(n, 0, "{table} should be empty after book delete");
        }
    }

    // -----------------------------------------------------------------------
    // LWW correctness
    // -----------------------------------------------------------------------

    #[test]
    fn book_progress_lww_higher_ts_wins_regardless_of_order() {
        // Apply lower-ts last; LWW guard rejects it, so progress stays at the
        // higher-ts value.
        let mut db1 = open_db();
        apply_all(
            &mut db1,
            &[
                ev(1000, "dev-A", import_book("b1")),
                ev(
                    1500,
                    "dev-A",
                    EventBody::BookProgressSet {
                        book: "b1".into(),
                        progress: 50,
                        cfi: Some("c50".into()),
                    },
                ),
                ev(
                    2000,
                    "dev-A",
                    EventBody::BookProgressSet {
                        book: "b1".into(),
                        progress: 80,
                        cfi: Some("c80".into()),
                    },
                ),
            ],
        );
        let mut db2 = open_db();
        apply_all(
            &mut db2,
            &[
                ev(1000, "dev-A", import_book("b1")),
                ev(
                    2000,
                    "dev-A",
                    EventBody::BookProgressSet {
                        book: "b1".into(),
                        progress: 80,
                        cfi: Some("c80".into()),
                    },
                ),
                ev(
                    1500,
                    "dev-A",
                    EventBody::BookProgressSet {
                        book: "b1".into(),
                        progress: 50,
                        cfi: Some("c50".into()),
                    },
                ),
            ],
        );

        for db in [&db1, &db2] {
            let (p, cfi): (i32, String) = db
                .query_row(
                    "SELECT progress, current_cfi FROM books WHERE id = 'b1'",
                    [], |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .unwrap();
            assert_eq!(p, 80);
            assert_eq!(cfi, "c80");
        }
    }

    #[test]
    fn same_ms_lww_breaks_tie_by_device_uuid() {
        // Two devices write the same field at the same ms. The lexicographically
        // larger device id wins the tuple compare.
        let mut db = open_db();
        apply_all(
            &mut db,
            &[
                ev(1000, "dev-A", import_book("b1")),
                ev(
                    2000,
                    "dev-A",
                    EventBody::BookStatusSet {
                        book: "b1".into(),
                        status: "reading".into(),
                    },
                ),
                ev(
                    2000,
                    "dev-B",
                    EventBody::BookStatusSet {
                        book: "b1".into(),
                        status: "finished".into(),
                    },
                ),
            ],
        );
        let (status, dev): (String, String) = db
            .query_row(
                "SELECT status, updated_by_device FROM books WHERE id = 'b1'",
                [], |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(status, "finished", "dev-B > dev-A in tuple compare");
        assert_eq!(dev, "dev-B");

        // Reverse order — same outcome.
        let mut db2 = open_db();
        apply_all(
            &mut db2,
            &[
                ev(1000, "dev-A", import_book("b1")),
                ev(
                    2000,
                    "dev-B",
                    EventBody::BookStatusSet {
                        book: "b1".into(),
                        status: "finished".into(),
                    },
                ),
                ev(
                    2000,
                    "dev-A",
                    EventBody::BookStatusSet {
                        book: "b1".into(),
                        status: "reading".into(),
                    },
                ),
            ],
        );
        let status2: String = db2
            .query_row("SELECT status FROM books WHERE id = 'b1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(status2, "finished");
    }

    #[test]
    fn highlight_color_lww_skips_older_event() {
        let mut db = open_db();
        apply_all(
            &mut db,
            &[
                ev(1000, "dev-A", import_book("b1")),
                ev(1100, "dev-A", add_highlight("h1", "b1", "yellow")),
                ev(
                    1300,
                    "dev-A",
                    EventBody::HighlightColorSet {
                        id: "h1".into(),
                        color: "pink".into(),
                    },
                ),
                ev(
                    1200,
                    "dev-A",
                    EventBody::HighlightColorSet {
                        id: "h1".into(),
                        color: "green".into(),
                    },
                ),
            ],
        );
        let color: String = db
            .query_row("SELECT color FROM highlights WHERE id = 'h1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(color, "pink", "older color event must lose");
    }

    #[test]
    fn vocab_mastery_carries_review_count_idempotently() {
        let mut db = open_db();
        apply_all(
            &mut db,
            &[
                ev(1000, "dev-A", import_book("b1")),
                ev(
                    1100,
                    "dev-A",
                    EventBody::VocabAdd(VocabPayload {
                        id: "v1".into(),
                        book_id: "b1".into(),
                        word: "serendipity".into(),
                        definition: "fortunate".into(),
                        context_sentence: None,
                        cfi: None,
                        mastery: "new".into(),
                        review_count: 0,
                        next_review_at: None,
                    }),
                ),
                ev(
                    1200,
                    "dev-A",
                    EventBody::VocabMasterySet {
                        id: "v1".into(),
                        mastery: "learning".into(),
                        next_review_at: Some(2_000_000),
                        review_count: 1,
                    },
                ),
                ev(
                    1300,
                    "dev-A",
                    EventBody::VocabMasterySet {
                        id: "v1".into(),
                        mastery: "learning".into(),
                        next_review_at: Some(3_000_000),
                        review_count: 2,
                    },
                ),
            ],
        );
        let (m, n): (String, i64) = db
            .query_row(
                "SELECT mastery, review_count FROM vocab_words WHERE id = 'v1'",
                [], |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(m, "learning");
        assert_eq!(n, 2, "absolute review_count from later event wins");
    }

    // -----------------------------------------------------------------------
    // Determinism (shuffle property)
    // -----------------------------------------------------------------------

    #[test]
    fn shuffled_apply_yields_identical_state() {
        // Build a fixed event set, apply in two different orders, compare
        // every column on every row. Apply order must not matter once events
        // are sorted by (ts, device).
        let events: Vec<Event> = vec![
            ev(1000, "dev-A", import_book("b1")),
            ev(1000, "dev-B", import_book("b2")),
            ev(1100, "dev-A", add_highlight("h1", "b1", "yellow")),
            ev(1200, "dev-B", add_highlight("h2", "b2", "blue")),
            ev(
                1300,
                "dev-A",
                EventBody::HighlightColorSet {
                    id: "h1".into(),
                    color: "pink".into(),
                },
            ),
            ev(
                1400,
                "dev-A",
                EventBody::BookProgressSet {
                    book: "b1".into(),
                    progress: 25,
                    cfi: Some("c25".into()),
                },
            ),
            ev(
                1500,
                "dev-B",
                EventBody::BookProgressSet {
                    book: "b1".into(),
                    progress: 50,
                    cfi: Some("c50".into()),
                },
            ),
            ev(
                1600,
                "dev-A",
                EventBody::CollectionCreate {
                    id: "c1".into(),
                    name: "Top".into(),
                    sort_order: 0,
                },
            ),
            ev(
                1700,
                "dev-A",
                EventBody::CollectionBookAdd {
                    collection: "c1".into(),
                    book: "b1".into(),
                },
            ),
            ev(
                1800,
                "dev-A",
                EventBody::CollectionRename {
                    id: "c1".into(),
                    name: "Favorites".into(),
                },
            ),
            ev(
                1900,
                "dev-B",
                EventBody::HighlightDelete { id: "h2".into() },
            ),
        ];

        let mut sorted = events.clone();
        sorted.sort_by(|a, b| (a.ts, &a.device).cmp(&(b.ts, &b.device)));

        let mut reverse = sorted.clone();
        reverse.reverse();
        // After reversing we still need (ts, device) order before apply (the
        // determinism rule); the property under test is "any pre-sort
        // permutation produces the same state."
        reverse.sort_by(|a, b| (a.ts, &a.device).cmp(&(b.ts, &b.device)));

        let mut db1 = open_db();
        apply_all(&mut db1, &sorted);
        let mut db2 = open_db();
        apply_all(&mut db2, &reverse);

        let dump = |db: &Connection| -> Vec<(String, String)> {
            let tables = [
                "books",
                "highlights",
                "bookmarks",
                "vocab_words",
                "translations",
                "collections",
                "collection_books",
                "chats",
                "chat_messages",
                "_tombstones",
            ];
            let mut out = Vec::new();
            for t in tables {
                let mut stmt = db
                    .prepare(&format!("SELECT * FROM {t} ORDER BY 1, 2"))
                    .unwrap();
                let cols = stmt.column_count();
                let rows = stmt
                    .query_map([], |r| {
                        let mut s = String::new();
                        for i in 0..cols {
                            let v: rusqlite::types::Value = r.get(i)?;
                            s.push_str(&format!("{v:?}|"));
                        }
                        Ok(s)
                    })
                    .unwrap();
                for row in rows {
                    out.push((t.to_string(), row.unwrap()));
                }
            }
            out
        };
        assert_eq!(dump(&db1), dump(&db2), "shuffle changed final state");
    }

    // -----------------------------------------------------------------------
    // book.metadata.set
    // -----------------------------------------------------------------------

    #[test]
    fn book_metadata_set_updates_string_field_under_lww() {
        let mut db = open_db();
        apply_all(
            &mut db,
            &[
                ev(1000, "dev-A", import_book("b1")),
                ev(
                    2000,
                    "dev-A",
                    EventBody::BookMetadataSet {
                        book: "b1".into(),
                        field: "author".into(),
                        value: json!("Leo Tolstoy"),
                    },
                ),
            ],
        );
        let author: String = db
            .query_row("SELECT author FROM books WHERE id = 'b1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(author, "Leo Tolstoy");
    }

    #[test]
    fn book_metadata_set_pages_accepts_number_and_null() {
        let mut db = open_db();
        apply_all(
            &mut db,
            &[
                ev(1000, "dev-A", import_book("b1")),
                ev(
                    2000,
                    "dev-A",
                    EventBody::BookMetadataSet {
                        book: "b1".into(),
                        field: "pages".into(),
                        value: json!(1225),
                    },
                ),
            ],
        );
        let pages: Option<i64> = db
            .query_row("SELECT pages FROM books WHERE id = 'b1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(pages, Some(1225));

        apply_all(
            &mut db,
            &[ev(
                3000,
                "dev-A",
                EventBody::BookMetadataSet {
                    book: "b1".into(),
                    field: "pages".into(),
                    value: Value::Null,
                },
            )],
        );
        let pages: Option<i64> = db
            .query_row("SELECT pages FROM books WHERE id = 'b1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(pages, None);
    }

    #[test]
    fn book_metadata_unknown_field_is_skipped() {
        let mut db = open_db();
        apply_all(
            &mut db,
            &[
                ev(1000, "dev-A", import_book("b1")),
                ev(
                    2000,
                    "dev-A",
                    EventBody::BookMetadataSet {
                        book: "b1".into(),
                        field: "future_field".into(),
                        value: json!("anything"),
                    },
                ),
            ],
        );
        // No panic, no crash; row's updated_at is unchanged from the import.
        let ts: i64 = db
            .query_row("SELECT updated_at FROM books WHERE id = 'b1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(ts, 1000);
    }

    // -----------------------------------------------------------------------
    // collection_books composite-key tombstone
    // -----------------------------------------------------------------------

    #[test]
    fn collection_book_remove_then_add_blocked_by_composite_tombstone() {
        let mut db = open_db();
        apply_all(
            &mut db,
            &[
                ev(1000, "dev-A", import_book("b1")),
                ev(
                    1100,
                    "dev-A",
                    EventBody::CollectionCreate {
                        id: "c1".into(),
                        name: "Top".into(),
                        sort_order: 0,
                    },
                ),
                ev(
                    1200,
                    "dev-A",
                    EventBody::CollectionBookAdd {
                        collection: "c1".into(),
                        book: "b1".into(),
                    },
                ),
                ev(
                    1300,
                    "dev-A",
                    EventBody::CollectionBookRemove {
                        collection: "c1".into(),
                        book: "b1".into(),
                    },
                ),
                ev(
                    1400,
                    "dev-A",
                    EventBody::CollectionBookAdd {
                        collection: "c1".into(),
                        book: "b1".into(),
                    },
                ),
            ],
        );
        let n: i64 = db
            .query_row(
                "SELECT COUNT(*) FROM collection_books WHERE collection_id = 'c1' AND book_id = 'b1'",
                [], |r| r.get(0),
            )
            .unwrap();
        assert_eq!(n, 0, "composite tombstone should suppress re-add");
    }

    // -----------------------------------------------------------------------
    // Idempotency under repeated apply
    // -----------------------------------------------------------------------

    #[test]
    fn double_apply_is_a_noop() {
        let events = vec![
            ev(1000, "dev-A", import_book("b1")),
            ev(1100, "dev-A", add_highlight("h1", "b1", "yellow")),
            ev(
                1200,
                "dev-A",
                EventBody::HighlightColorSet {
                    id: "h1".into(),
                    color: "pink".into(),
                },
            ),
        ];
        let mut db = open_db();
        apply_all(&mut db, &events);
        // Snapshot the row state, then re-apply.
        let before: (String, i64, String) = db
            .query_row(
                "SELECT color, updated_at, updated_by_device FROM highlights WHERE id = 'h1'",
                [], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        apply_all(&mut db, &events);
        let after: (String, i64, String) = db
            .query_row(
                "SELECT color, updated_at, updated_by_device FROM highlights WHERE id = 'h1'",
                [], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!(before, after);
    }
}
