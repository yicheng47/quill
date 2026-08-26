use base64::Engine;
use rusqlite::params;
use serde::{Deserialize, Serialize};
use tauri::State;
use uuid::Uuid;

use crate::db::Db;
use crate::error::AppResult;
use crate::sync::events::{ChatMessagePayload, EventBody};
use crate::sync::writer::SyncWriter;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Chat {
    pub id: String,
    pub book_id: String,
    pub title: String,
    pub model: Option<String>,
    pub pinned: bool,
    pub metadata: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub book_title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message_count: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_message: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ChatMsg {
    pub id: String,
    pub chat_id: String,
    pub role: String,
    pub content: String,
    pub context: Option<String>,
    pub metadata: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Serialize)]
pub struct ChatPage {
    pub chats: Vec<Chat>,
    pub next_cursor: Option<String>,
    pub total: usize,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
struct ChatCursor {
    pinned: bool,
    updated_at: i64,
    id: String,
}

#[derive(Debug, Serialize)]
pub struct ChatBookCount {
    pub book_id: String,
    pub book_title: Option<String>,
    pub count: usize,
}

#[derive(Debug, Serialize)]
pub struct ChatCounts {
    pub total: usize,
    pub by_book: Vec<ChatBookCount>,
}

fn encode_chat_cursor(cursor: &ChatCursor) -> String {
    let json = serde_json::to_vec(cursor).expect("chat cursor serialization cannot fail");
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(json)
}

fn decode_chat_cursor(cursor: &str) -> Option<ChatCursor> {
    let json = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(cursor)
        .ok()?;
    serde_json::from_slice(&json).ok()
}

fn chat_search_pattern(search: &str) -> String {
    let escaped = search
        .to_lowercase()
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_");
    format!("%{escaped}%")
}

fn row_to_chat(row: &rusqlite::Row) -> rusqlite::Result<Chat> {
    Ok(Chat {
        id: row.get(0)?,
        book_id: row.get(1)?,
        title: row.get(2)?,
        model: row.get(3)?,
        pinned: row.get::<_, i64>(4)? != 0,
        metadata: row.get(5)?,
        created_at: row.get(6)?,
        updated_at: row.get(7)?,
        book_title: None,
        message_count: None,
        last_message: None,
    })
}

fn row_to_chat_with_extras(row: &rusqlite::Row) -> rusqlite::Result<Chat> {
    Ok(Chat {
        id: row.get(0)?,
        book_id: row.get(1)?,
        title: row.get(2)?,
        model: row.get(3)?,
        pinned: row.get::<_, i64>(4)? != 0,
        metadata: row.get(5)?,
        created_at: row.get(6)?,
        updated_at: row.get(7)?,
        book_title: row.get(8)?,
        message_count: row.get(9)?,
        last_message: row.get(10)?,
    })
}

fn row_to_msg(row: &rusqlite::Row) -> rusqlite::Result<ChatMsg> {
    Ok(ChatMsg {
        id: row.get(0)?,
        chat_id: row.get(1)?,
        role: row.get(2)?,
        content: row.get(3)?,
        context: row.get(4)?,
        metadata: row.get(5)?,
        created_at: row.get(6)?,
        updated_at: row.get(7)?,
    })
}

#[tauri::command]
pub fn create_chat(
    book_id: String,
    title: Option<String>,
    model: Option<String>,
    db: State<'_, Db>,
    sync: State<'_, SyncWriter>,
) -> AppResult<Chat> {
    let id = Uuid::new_v4().to_string();
    let now = chrono::Utc::now().timestamp_millis();
    let title = title.unwrap_or_else(|| "New chat".to_string());
    let device = sync.self_device().to_string();

    let chat = Chat {
        id: id.clone(),
        book_id: book_id.clone(),
        title: title.clone(),
        model: model.clone(),
        pinned: false,
        metadata: None,
        created_at: now,
        updated_at: now,
        book_title: None,
        message_count: None,
        last_message: None,
    };

    sync.with_tx(&db, now, |tx, events| {
        tx.execute(
            "INSERT INTO chats (id, book_id, title, model, pinned, metadata, created_at, updated_at, updated_by_device)
             VALUES (?1, ?2, ?3, ?4, 0, NULL, ?5, ?5, ?6)",
            params![id, book_id, title, model, now, device],
        )?;
        events.push(EventBody::ChatCreate {
            id: id.clone(),
            book: book_id.clone(),
            title: title.clone(),
            model: model.clone(),
        });
        Ok(())
    })?;

    Ok(chat)
}

pub(crate) fn query_chats(db: &Db, book_id: &str) -> AppResult<Vec<Chat>> {
    let conn = db.reader();
    let mut stmt = conn.prepare(
        "SELECT id, book_id, title, model, pinned, metadata, created_at, updated_at
         FROM chats WHERE book_id = ?1
         ORDER BY pinned DESC, updated_at DESC",
    )?;
    let chats = stmt
        .query_map(params![book_id], row_to_chat)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(chats)
}

#[tauri::command]
pub fn list_chats(book_id: String, db: State<'_, Db>) -> AppResult<Vec<Chat>> {
    query_chats(&db, &book_id)
}

#[tauri::command]
pub fn list_all_chats(
    search: Option<String>,
    book_id: Option<String>,
    cursor: Option<String>,
    limit: Option<usize>,
    db: State<'_, Db>,
) -> AppResult<ChatPage> {
    query_all_chats(
        &db,
        search.as_deref(),
        book_id.as_deref(),
        cursor.as_deref(),
        limit.unwrap_or(DEFAULT_PAGE_SIZE).max(1),
    )
}

const DEFAULT_PAGE_SIZE: usize = 20;

pub(crate) fn query_all_chats(
    db: &Db,
    search: Option<&str>,
    book_id: Option<&str>,
    cursor: Option<&str>,
    limit: usize,
) -> AppResult<ChatPage> {
    let conn = db.reader();

    let mut count_conditions: Vec<String> = Vec::new();
    let mut count_values: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();
    if let Some(search) = search.filter(|search| !search.is_empty()) {
        count_conditions.push("LOWER(c.title) LIKE ? ESCAPE '\\'".to_string());
        count_values.push(Box::new(chat_search_pattern(search)));
    }
    if let Some(book_id) = book_id {
        count_conditions.push("c.book_id = ?".to_string());
        count_values.push(Box::new(book_id.to_string()));
    }
    let count_where = if count_conditions.is_empty() {
        String::new()
    } else {
        format!(" WHERE {}", count_conditions.join(" AND "))
    };
    let count_refs: Vec<&dyn rusqlite::types::ToSql> =
        count_values.iter().map(|value| value.as_ref()).collect();
    let total = conn.query_row(
        &format!("SELECT COUNT(*) FROM chats c{count_where}"),
        count_refs.as_slice(),
        |row| row.get(0),
    )?;

    let mut conditions: Vec<String> = Vec::new();
    let mut values: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();
    if let Some(search) = search.filter(|search| !search.is_empty()) {
        conditions.push("LOWER(c.title) LIKE ? ESCAPE '\\'".to_string());
        values.push(Box::new(chat_search_pattern(search)));
    }
    if let Some(book_id) = book_id {
        conditions.push("c.book_id = ?".to_string());
        values.push(Box::new(book_id.to_string()));
    }
    if let Some(cursor) = cursor.and_then(decode_chat_cursor) {
        conditions.push(
            "(c.pinned < ? OR (c.pinned = ? AND (c.updated_at < ? OR (c.updated_at = ? AND c.id > ?))))"
                .to_string(),
        );
        let pinned = i64::from(cursor.pinned);
        values.push(Box::new(pinned));
        values.push(Box::new(pinned));
        values.push(Box::new(cursor.updated_at));
        values.push(Box::new(cursor.updated_at));
        values.push(Box::new(cursor.id));
    }
    let where_clause = if conditions.is_empty() {
        String::new()
    } else {
        format!(" WHERE {}", conditions.join(" AND "))
    };
    values.push(Box::new((limit + 1) as i64));
    let value_refs: Vec<&dyn rusqlite::types::ToSql> =
        values.iter().map(|value| value.as_ref()).collect();
    let sql = format!(
        "SELECT c.id, c.book_id, c.title, c.model, c.pinned, c.metadata, c.created_at, c.updated_at,
                b.title,
                (SELECT COUNT(*) FROM chat_messages WHERE chat_id = c.id),
                (SELECT content FROM chat_messages WHERE chat_id = c.id ORDER BY created_at DESC, rowid DESC LIMIT 1)
         FROM chats c LEFT JOIN books b ON c.book_id = b.id
         {where_clause}
         ORDER BY c.pinned DESC, c.updated_at DESC, c.id ASC
         LIMIT ?"
    );
    let mut stmt = conn.prepare(&sql)?;
    let mut chats = stmt
        .query_map(value_refs.as_slice(), row_to_chat_with_extras)?
        .collect::<Result<Vec<_>, _>>()?;

    let next_cursor = if chats.len() > limit {
        chats.truncate(limit);
        let last = &chats[limit - 1];
        Some(encode_chat_cursor(&ChatCursor {
            pinned: last.pinned,
            updated_at: last.updated_at,
            id: last.id.clone(),
        }))
    } else {
        None
    };

    Ok(ChatPage {
        chats,
        next_cursor,
        total,
    })
}

pub(crate) fn query_chat_counts(db: &Db) -> AppResult<ChatCounts> {
    let conn = db.reader();
    let total = conn.query_row("SELECT COUNT(*) FROM chats", [], |row| row.get(0))?;
    let mut stmt = conn.prepare(
        "SELECT c.book_id, b.title, COUNT(*)
         FROM chats c LEFT JOIN books b ON c.book_id = b.id
         GROUP BY c.book_id, b.title
         ORDER BY COUNT(*) DESC, COALESCE(b.title, '') COLLATE NOCASE ASC, c.book_id ASC",
    )?;
    let by_book = stmt
        .query_map([], |row| {
            Ok(ChatBookCount {
                book_id: row.get(0)?,
                book_title: row.get(1)?,
                count: row.get(2)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(ChatCounts { total, by_book })
}

#[tauri::command]
pub fn get_chat_counts(db: State<'_, Db>) -> AppResult<ChatCounts> {
    query_chat_counts(&db)
}

#[tauri::command]
pub fn get_chat(chat_id: String, db: State<'_, Db>) -> AppResult<Chat> {
    let conn = db.reader();
    let chat = conn.query_row(
        "SELECT id, book_id, title, model, pinned, metadata, created_at, updated_at
         FROM chats WHERE id = ?1",
        params![chat_id],
        row_to_chat,
    )?;
    Ok(chat)
}

#[tauri::command]
pub fn delete_chat(
    chat_id: String,
    db: State<'_, Db>,
    sync: State<'_, SyncWriter>,
) -> AppResult<()> {
    let now = chrono::Utc::now().timestamp_millis();
    sync.with_tx(&db, now, |tx, events| {
        tx.execute(
            "DELETE FROM chat_messages WHERE chat_id = ?1",
            params![chat_id],
        )?;
        tx.execute("DELETE FROM chats WHERE id = ?1", params![chat_id])?;
        events.push(EventBody::ChatDelete {
            id: chat_id.clone(),
        });
        Ok(())
    })
}

#[tauri::command]
pub fn rename_chat(
    chat_id: String,
    title: String,
    db: State<'_, Db>,
    sync: State<'_, SyncWriter>,
) -> AppResult<()> {
    let now = chrono::Utc::now().timestamp_millis();
    let device = sync.self_device().to_string();
    sync.with_tx(&db, now, |tx, events| {
        tx.execute(
            "UPDATE chats SET title = ?1, updated_at = ?2, updated_by_device = ?3 WHERE id = ?4",
            params![title, now, device, chat_id],
        )?;
        events.push(EventBody::ChatRename {
            id: chat_id.clone(),
            title: title.clone(),
        });
        Ok(())
    })
}

pub(crate) fn query_chat_messages(db: &Db, chat_id: &str) -> AppResult<Vec<ChatMsg>> {
    let conn = db.reader();
    let mut stmt = conn.prepare(
        "SELECT id, chat_id, role, content, context, metadata, created_at, updated_at
         FROM chat_messages WHERE chat_id = ?1
         ORDER BY created_at ASC",
    )?;
    let msgs = stmt
        .query_map(params![chat_id], row_to_msg)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(msgs)
}

#[tauri::command]
pub fn list_chat_messages(chat_id: String, db: State<'_, Db>) -> AppResult<Vec<ChatMsg>> {
    query_chat_messages(&db, &chat_id)
}

#[tauri::command]
pub fn save_chat_message(
    chat_id: String,
    role: String,
    content: String,
    context: Option<String>,
    metadata: Option<String>,
    db: State<'_, Db>,
    sync: State<'_, SyncWriter>,
) -> AppResult<ChatMsg> {
    let id = Uuid::new_v4().to_string();
    let now = chrono::Utc::now().timestamp_millis();
    let device = sync.self_device().to_string();

    let msg = ChatMsg {
        id: id.clone(),
        chat_id: chat_id.clone(),
        role: role.clone(),
        content: content.clone(),
        context: context.clone(),
        metadata: metadata.clone(),
        created_at: now,
        updated_at: now,
    };

    sync.with_tx(&db, now, |tx, events| {
        tx.execute(
            "INSERT INTO chat_messages (id, chat_id, role, content, context, metadata, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)",
            params![id, chat_id, role, content, context, metadata, now],
        )?;
        // Bump the parent chat's updated_at — same pattern the merge engine
        // uses on `chat.message.add` (LWW guard avoids dragging chats
        // backward when older peer messages replay).
        tx.execute(
            "UPDATE chats SET updated_at = ?1, updated_by_device = ?2
             WHERE id = ?3
               AND (updated_at < ?1 OR (updated_at = ?1 AND updated_by_device < ?2))",
            params![now, device, chat_id],
        )?;
        events.push(EventBody::ChatMessageAdd(ChatMessagePayload {
            id: id.clone(),
            chat_id: chat_id.clone(),
            role: role.clone(),
            content: content.clone(),
            context: context.clone(),
            metadata: metadata.clone(),
        }));
        Ok(())
    })?;

    Ok(msg)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Db;
    use tempfile::TempDir;

    fn setup() -> (TempDir, Db) {
        let dir = TempDir::new().unwrap();
        let db = Db::init(dir.path()).unwrap();
        // Insert a test book for foreign key references
        let conn = db.conn.lock().unwrap();
        let t0: i64 = 1704067200000; // 2024-01-01T00:00:00Z
        conn.execute(
            "INSERT INTO books (id, title, author, file_path, status, progress, created_at, updated_at)
             VALUES ('book1', 'Test Book', 'Author', 'books/test.epub', 'reading', 0, ?1, ?1)",
            params![t0],
        ).unwrap();
        conn.execute(
            "INSERT INTO books (id, title, author, file_path, status, progress, created_at, updated_at)
             VALUES ('book2', 'Second Book', 'Author 2', 'books/test2.epub', 'reading', 0, ?1, ?1)",
            params![t0],
        ).unwrap();
        drop(conn);
        (dir, db)
    }

    fn insert_chat(db: &Db, id: &str, book_id: &str, title: &str) {
        insert_chat_at(
            db,
            id,
            book_id,
            title,
            false,
            chrono::Utc::now().timestamp_millis(),
        );
    }

    fn insert_chat_at(
        db: &Db,
        id: &str,
        book_id: &str,
        title: &str,
        pinned: bool,
        updated_at: i64,
    ) {
        let conn = db.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO chats (id, book_id, title, pinned, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
            params![id, book_id, title, pinned, updated_at],
        )
        .unwrap();
    }

    fn insert_msg(db: &Db, chat_id: &str, role: &str, content: &str) {
        let conn = db.conn.lock().unwrap();
        let id = Uuid::new_v4().to_string();
        let now = chrono::Utc::now().timestamp_millis();
        conn.execute(
            "INSERT INTO chat_messages (id, chat_id, role, content, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
            params![id, chat_id, role, content, now],
        ).unwrap();
    }

    fn count_chats(db: &Db) -> i64 {
        let conn = db.conn.lock().unwrap();
        conn.query_row("SELECT COUNT(*) FROM chats", [], |r| r.get(0)).unwrap()
    }

    fn count_messages(db: &Db) -> i64 {
        let conn = db.conn.lock().unwrap();
        conn.query_row("SELECT COUNT(*) FROM chat_messages", [], |r| r.get(0)).unwrap()
    }

    // --- create_chat ---

    #[test]
    fn test_create_chat_default_title() {
        let (_dir, db) = setup();
        let conn = db.conn.lock().unwrap();
        let id = Uuid::new_v4().to_string();
        let now = chrono::Utc::now().timestamp_millis();
        conn.execute(
            "INSERT INTO chats (id, book_id, title, pinned, created_at, updated_at)
             VALUES (?1, 'book1', 'New chat', 0, ?2, ?2)",
            params![id, now],
        ).unwrap();

        let chat: Chat = conn.query_row(
            "SELECT id, book_id, title, model, pinned, metadata, created_at, updated_at FROM chats WHERE id = ?1",
            params![id],
            row_to_chat,
        ).unwrap();

        assert_eq!(chat.title, "New chat");
        assert_eq!(chat.book_id, "book1");
        assert!(!chat.pinned);
        assert!(chat.model.is_none());
    }

    #[test]
    fn test_create_chat_custom_title() {
        let (_dir, db) = setup();
        let conn = db.conn.lock().unwrap();
        let id = Uuid::new_v4().to_string();
        let now = chrono::Utc::now().timestamp_millis();
        conn.execute(
            "INSERT INTO chats (id, book_id, title, model, pinned, created_at, updated_at)
             VALUES (?1, 'book1', 'My Discussion', 'gpt-4o', 0, ?2, ?2)",
            params![id, now],
        ).unwrap();

        let chat: Chat = conn.query_row(
            "SELECT id, book_id, title, model, pinned, metadata, created_at, updated_at FROM chats WHERE id = ?1",
            params![id],
            row_to_chat,
        ).unwrap();

        assert_eq!(chat.title, "My Discussion");
        assert_eq!(chat.model, Some("gpt-4o".to_string()));
    }

    // --- list_chats ---

    #[test]
    fn test_list_chats_filters_by_book() {
        let (_dir, db) = setup();
        insert_chat(&db, "c1", "book1", "Chat A");
        insert_chat(&db, "c2", "book1", "Chat B");
        insert_chat(&db, "c3", "book2", "Chat C");

        let conn = db.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, book_id, title, model, pinned, metadata, created_at, updated_at
             FROM chats WHERE book_id = ?1 ORDER BY updated_at DESC",
        ).unwrap();
        let chats: Vec<Chat> = stmt
            .query_map(params!["book1"], row_to_chat).unwrap()
            .collect::<Result<Vec<_>, _>>().unwrap();

        assert_eq!(chats.len(), 2);
        assert!(chats.iter().all(|c| c.book_id == "book1"));
    }

    #[test]
    fn test_list_chats_empty() {
        let (_dir, db) = setup();
        let conn = db.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, book_id, title, model, pinned, metadata, created_at, updated_at
             FROM chats WHERE book_id = ?1",
        ).unwrap();
        let chats: Vec<Chat> = stmt
            .query_map(params!["book1"], row_to_chat).unwrap()
            .collect::<Result<Vec<_>, _>>().unwrap();

        assert!(chats.is_empty());
    }

    // --- list_all_chats ---

    #[test]
    fn test_list_all_chats_with_extras() {
        let (_dir, db) = setup();
        insert_chat(&db, "c1", "book1", "Chat A");
        insert_msg(&db, "c1", "user", "Hello");
        insert_msg(&db, "c1", "assistant", "Hi there!");

        let page = query_all_chats(&db, None, None, None, 20).unwrap();

        assert_eq!(page.chats.len(), 1);
        assert_eq!(page.chats[0].book_title, Some("Test Book".to_string()));
        assert_eq!(page.chats[0].message_count, Some(2));
        assert_eq!(page.chats[0].last_message, Some("Hi there!".to_string()));
    }

    #[test]
    fn test_chat_cursor_round_trip() {
        let cursor = ChatCursor {
            pinned: true,
            updated_at: 1704067200123,
            id: "chat:id/with symbols".to_string(),
        };

        assert_eq!(
            decode_chat_cursor(&encode_chat_cursor(&cursor)),
            Some(cursor)
        );
    }

    #[test]
    fn test_list_all_chats_page_boundaries_and_pinned_order() {
        let (_dir, db) = setup();
        insert_chat_at(&db, "p2", "book1", "Pinned older", true, 200);
        insert_chat_at(&db, "u1", "book1", "Unpinned newer", false, 500);
        insert_chat_at(&db, "p1", "book1", "Pinned newer", true, 400);
        insert_chat_at(&db, "u2", "book1", "Unpinned older", false, 100);

        let first = query_all_chats(&db, None, None, None, 2).unwrap();
        assert_eq!(first.total, 4);
        assert_eq!(
            first
                .chats
                .iter()
                .map(|chat| chat.id.as_str())
                .collect::<Vec<_>>(),
            ["p1", "p2"]
        );

        let second = query_all_chats(&db, None, None, first.next_cursor.as_deref(), 2).unwrap();
        assert_eq!(second.total, 4);
        assert_eq!(
            second
                .chats
                .iter()
                .map(|chat| chat.id.as_str())
                .collect::<Vec<_>>(),
            ["u1", "u2"]
        );
        assert!(second.next_cursor.is_none());
    }

    #[test]
    fn test_list_all_chats_uses_id_tiebreaker_across_pages() {
        let (_dir, db) = setup();
        insert_chat_at(&db, "c3", "book1", "Third", false, 100);
        insert_chat_at(&db, "c1", "book1", "First", false, 100);
        insert_chat_at(&db, "c2", "book1", "Second", false, 100);

        let first = query_all_chats(&db, None, None, None, 2).unwrap();
        let second = query_all_chats(&db, None, None, first.next_cursor.as_deref(), 2).unwrap();

        assert_eq!(
            first
                .chats
                .iter()
                .map(|chat| chat.id.as_str())
                .collect::<Vec<_>>(),
            ["c1", "c2"]
        );
        assert_eq!(second.chats[0].id, "c3");
    }

    #[test]
    fn test_list_all_chats_walks_large_history_without_gaps() {
        let (_dir, db) = setup();
        for index in 0..45 {
            let id = format!("c{index:02}");
            insert_chat_at(&db, &id, "book1", &id, false, index);
        }

        let mut cursor = None;
        let mut ids = Vec::new();
        loop {
            let page = query_all_chats(&db, None, None, cursor.as_deref(), 20).unwrap();
            ids.extend(page.chats.into_iter().map(|chat| chat.id));
            let Some(next_cursor) = page.next_cursor else {
                break;
            };
            cursor = Some(next_cursor);
        }

        assert_eq!(ids.len(), 45);
        assert_eq!(ids.iter().collect::<std::collections::HashSet<_>>().len(), 45);
        assert_eq!(ids.first().unwrap(), "c44");
        assert_eq!(ids.last().unwrap(), "c00");
    }

    #[test]
    fn test_list_all_chats_search_matches_across_page_boundary() {
        let (_dir, db) = setup();
        insert_chat_at(&db, "c4", "book1", "Needle newest", false, 400);
        insert_chat_at(&db, "c3", "book1", "Unrelated", false, 300);
        insert_chat_at(&db, "c2", "book2", "Another unrelated", false, 200);
        insert_chat_at(&db, "c1", "book2", "Old NEEDLE result", false, 100);
        insert_msg(&db, "c3", "user", "needle only appears in this message");

        let first = query_all_chats(&db, Some("needle"), None, None, 1).unwrap();
        assert_eq!(first.total, 2);
        assert_eq!(first.chats[0].id, "c4");

        let second =
            query_all_chats(&db, Some("needle"), None, first.next_cursor.as_deref(), 1).unwrap();
        assert_eq!(second.chats.len(), 1);
        assert_eq!(second.chats[0].id, "c1");
    }

    #[test]
    fn test_list_all_chats_search_treats_like_metacharacters_literally() {
        let (_dir, db) = setup();
        insert_chat_at(&db, "percent", "book1", "100% useful", false, 500);
        insert_chat_at(&db, "plain-percent", "book1", "100 percent useful", false, 400);
        insert_chat_at(&db, "underscore", "book1", "Chat_1", false, 300);
        insert_chat_at(&db, "plain-underscore", "book1", "ChatA1", false, 200);
        insert_chat_at(&db, "backslash", "book1", "Path \\ notes", false, 100);

        let percent = query_all_chats(&db, Some("%"), None, None, 20).unwrap();
        let underscore = query_all_chats(&db, Some("_"), None, None, 20).unwrap();
        let backslash = query_all_chats(&db, Some("\\"), None, None, 20).unwrap();

        assert_eq!(percent.total, 1);
        assert_eq!(percent.chats[0].id, "percent");
        assert_eq!(underscore.total, 1);
        assert_eq!(underscore.chats[0].id, "underscore");
        assert_eq!(backslash.total, 1);
        assert_eq!(backslash.chats[0].id, "backslash");
    }

    #[test]
    fn test_list_all_chats_filters_by_book_before_pagination() {
        let (_dir, db) = setup();
        insert_chat_at(&db, "c3", "book1", "Other book", false, 300);
        insert_chat_at(&db, "c2", "book2", "First match", false, 200);
        insert_chat_at(&db, "c1", "book2", "Second match", false, 100);

        let page = query_all_chats(&db, None, Some("book2"), None, 20).unwrap();

        assert_eq!(page.total, 2);
        assert_eq!(
            page.chats
                .iter()
                .map(|chat| chat.id.as_str())
                .collect::<Vec<_>>(),
            ["c2", "c1"]
        );
    }

    #[test]
    fn test_list_all_chats_stays_stable_when_loaded_chat_is_touched() {
        let (_dir, db) = setup();
        insert_chat_at(&db, "c4", "book1", "Newest", false, 400);
        insert_chat_at(&db, "c3", "book1", "Second", false, 300);
        insert_chat_at(&db, "c2", "book1", "Third", false, 200);
        insert_chat_at(&db, "c1", "book1", "Oldest", false, 100);

        let first = query_all_chats(&db, None, None, None, 2).unwrap();
        let conn = db.conn.lock().unwrap();
        conn.execute("UPDATE chats SET updated_at = 500 WHERE id = 'c4'", [])
            .unwrap();
        drop(conn);

        let second = query_all_chats(&db, None, None, first.next_cursor.as_deref(), 2).unwrap();
        assert_eq!(
            second
                .chats
                .iter()
                .map(|chat| chat.id.as_str())
                .collect::<Vec<_>>(),
            ["c2", "c1"]
        );
    }

    #[test]
    fn test_get_chat_counts_empty() {
        let (_dir, db) = setup();

        let counts = query_chat_counts(&db).unwrap();

        assert_eq!(counts.total, 0);
        assert!(counts.by_book.is_empty());
    }

    #[test]
    fn test_get_chat_counts_includes_missing_book() {
        let (_dir, db) = setup();
        insert_chat_at(&db, "c1", "missing-book", "Orphaned", false, 100);
        insert_chat_at(&db, "c2", "missing-book", "Also orphaned", false, 200);

        let counts = query_chat_counts(&db).unwrap();

        assert_eq!(counts.total, 2);
        assert_eq!(counts.by_book.len(), 1);
        assert_eq!(counts.by_book[0].book_id, "missing-book");
        assert_eq!(counts.by_book[0].book_title, None);
        assert_eq!(counts.by_book[0].count, 2);
    }

    // --- delete_chat (transaction) ---

    #[test]
    fn test_delete_chat_removes_messages() {
        let (_dir, db) = setup();
        insert_chat(&db, "c1", "book1", "Chat A");
        insert_msg(&db, "c1", "user", "Hello");
        insert_msg(&db, "c1", "assistant", "Hi!");

        assert_eq!(count_chats(&db), 1);
        assert_eq!(count_messages(&db), 2);

        // Delete in transaction
        {
            let conn = db.conn.lock().unwrap();
            let tx = conn.unchecked_transaction().unwrap();
            tx.execute("DELETE FROM chat_messages WHERE chat_id = ?1", params!["c1"]).unwrap();
            tx.execute("DELETE FROM chats WHERE id = ?1", params!["c1"]).unwrap();
            tx.commit().unwrap();
        }

        assert_eq!(count_chats(&db), 0);
        assert_eq!(count_messages(&db), 0);
    }

    #[test]
    fn test_delete_chat_does_not_affect_other_chats() {
        let (_dir, db) = setup();
        insert_chat(&db, "c1", "book1", "Chat A");
        insert_chat(&db, "c2", "book1", "Chat B");
        insert_msg(&db, "c1", "user", "Hello");
        insert_msg(&db, "c2", "user", "World");

        {
            let conn = db.conn.lock().unwrap();
            let tx = conn.unchecked_transaction().unwrap();
            tx.execute("DELETE FROM chat_messages WHERE chat_id = ?1", params!["c1"]).unwrap();
            tx.execute("DELETE FROM chats WHERE id = ?1", params!["c1"]).unwrap();
            tx.commit().unwrap();
        }

        assert_eq!(count_chats(&db), 1);
        assert_eq!(count_messages(&db), 1);
    }

    // --- delete_book cleans up chats ---

    #[test]
    fn test_delete_book_cleans_up_chats_and_messages() {
        let (_dir, db) = setup();
        insert_chat(&db, "c1", "book1", "Chat A");
        insert_chat(&db, "c2", "book1", "Chat B");
        insert_chat(&db, "c3", "book2", "Chat C");
        insert_msg(&db, "c1", "user", "msg1");
        insert_msg(&db, "c2", "user", "msg2");
        insert_msg(&db, "c3", "user", "msg3");

        assert_eq!(count_chats(&db), 3);
        assert_eq!(count_messages(&db), 3);

        // Simulate delete_book for book1
        {
            let conn = db.conn.lock().unwrap();
            conn.execute(
                "DELETE FROM chat_messages WHERE chat_id IN (SELECT id FROM chats WHERE book_id = ?1)",
                params!["book1"],
            ).unwrap();
            conn.execute("DELETE FROM chats WHERE book_id = ?1", params!["book1"]).unwrap();
            conn.execute("DELETE FROM books WHERE id = ?1", params!["book1"]).unwrap();
        }

        // book2's chat and message should remain
        assert_eq!(count_chats(&db), 1);
        assert_eq!(count_messages(&db), 1);
    }

    // --- rename_chat ---

    #[test]
    fn test_rename_chat() {
        let (_dir, db) = setup();
        insert_chat(&db, "c1", "book1", "New chat");

        let conn = db.conn.lock().unwrap();
        let now = chrono::Utc::now().timestamp_millis();
        conn.execute(
            "UPDATE chats SET title = ?1, updated_at = ?2 WHERE id = ?3",
            params!["Renamed", now, "c1"],
        ).unwrap();

        let chat: Chat = conn.query_row(
            "SELECT id, book_id, title, model, pinned, metadata, created_at, updated_at FROM chats WHERE id = ?1",
            params!["c1"],
            row_to_chat,
        ).unwrap();

        assert_eq!(chat.title, "Renamed");
    }

    // --- save_chat_message ---

    #[test]
    fn test_save_message_updates_chat_updated_at() {
        let (_dir, db) = setup();
        insert_chat(&db, "c1", "book1", "Chat A");

        let original_updated: i64 = {
            let conn = db.conn.lock().unwrap();
            conn.query_row("SELECT updated_at FROM chats WHERE id = 'c1'", [], |r| r.get(0)).unwrap()
        };

        std::thread::sleep(std::time::Duration::from_millis(10));

        // Insert message and update chat's updated_at
        {
            let conn = db.conn.lock().unwrap();
            let now = chrono::Utc::now().timestamp_millis();
            conn.execute(
                "INSERT INTO chat_messages (id, chat_id, role, content, created_at, updated_at)
                 VALUES ('m1', 'c1', 'user', 'Hello', ?1, ?1)",
                params![now],
            ).unwrap();
            conn.execute(
                "UPDATE chats SET updated_at = ?1 WHERE id = 'c1'",
                params![now],
            ).unwrap();
        }

        let new_updated: i64 = {
            let conn = db.conn.lock().unwrap();
            conn.query_row("SELECT updated_at FROM chats WHERE id = 'c1'", [], |r| r.get(0)).unwrap()
        };

        assert_ne!(original_updated, new_updated);
    }

    // --- list_chat_messages ---

    #[test]
    fn test_list_messages_ordered_by_created_at() {
        let (_dir, db) = setup();
        insert_chat(&db, "c1", "book1", "Chat A");

        {
            let conn = db.conn.lock().unwrap();
            let t1: i64 = 1704067200000; // 2024-01-01T00:00:00Z
            let t2: i64 = 1704067201000; // 2024-01-01T00:00:01Z
            let t3: i64 = 1704067202000; // 2024-01-01T00:00:02Z
            conn.execute(
                "INSERT INTO chat_messages (id, chat_id, role, content, created_at, updated_at)
                 VALUES ('m1', 'c1', 'user', 'First', ?1, ?1)",
                params![t1],
            ).unwrap();
            conn.execute(
                "INSERT INTO chat_messages (id, chat_id, role, content, context, created_at, updated_at)
                 VALUES ('m2', 'c1', 'assistant', 'Second', NULL, ?1, ?1)",
                params![t2],
            ).unwrap();
            conn.execute(
                "INSERT INTO chat_messages (id, chat_id, role, content, context, created_at, updated_at)
                 VALUES ('m3', 'c1', 'user', 'Third', 'some highlighted text', ?1, ?1)",
                params![t3],
            ).unwrap();
        }

        let conn = db.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, chat_id, role, content, context, metadata, created_at, updated_at
             FROM chat_messages WHERE chat_id = ?1 ORDER BY created_at ASC",
        ).unwrap();
        let msgs: Vec<ChatMsg> = stmt
            .query_map(params!["c1"], row_to_msg).unwrap()
            .collect::<Result<Vec<_>, _>>().unwrap();

        assert_eq!(msgs.len(), 3);
        assert_eq!(msgs[0].content, "First");
        assert_eq!(msgs[1].content, "Second");
        assert_eq!(msgs[2].content, "Third");
        assert_eq!(msgs[2].context, Some("some highlighted text".to_string()));
    }

    // --- metadata JSON field ---

    #[test]
    fn test_metadata_json_roundtrip() {
        let (_dir, db) = setup();
        let conn = db.conn.lock().unwrap();
        let now = chrono::Utc::now().timestamp_millis();
        let meta = r#"{"temperature":0.7,"tokens":150}"#;

        conn.execute(
            "INSERT INTO chats (id, book_id, title, pinned, metadata, created_at, updated_at)
             VALUES ('c1', 'book1', 'Chat', 0, ?1, ?2, ?2)",
            params![meta, now],
        ).unwrap();

        let chat: Chat = conn.query_row(
            "SELECT id, book_id, title, model, pinned, metadata, created_at, updated_at FROM chats WHERE id = 'c1'",
            [],
            row_to_chat,
        ).unwrap();

        assert_eq!(chat.metadata, Some(meta.to_string()));
    }
}
