use rusqlite::params;
use serde::{Deserialize, Serialize};
use tauri::State;
use uuid::Uuid;

use crate::db::Db;
use crate::error::{AppError, AppResult};
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

    sync.with_tx(&db, |tx, events| {
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

#[tauri::command]
pub fn list_chats(book_id: String, db: State<'_, Db>) -> AppResult<Vec<Chat>> {
    let conn = db.conn.lock().map_err(|e| AppError::Other(e.to_string()))?;
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
pub fn list_all_chats(db: State<'_, Db>) -> AppResult<Vec<Chat>> {
    let conn = db.conn.lock().map_err(|e| AppError::Other(e.to_string()))?;
    let mut stmt = conn.prepare(
        "SELECT c.id, c.book_id, c.title, c.model, c.pinned, c.metadata, c.created_at, c.updated_at,
                b.title,
                (SELECT COUNT(*) FROM chat_messages WHERE chat_id = c.id),
                (SELECT content FROM chat_messages WHERE chat_id = c.id ORDER BY created_at DESC LIMIT 1)
         FROM chats c LEFT JOIN books b ON c.book_id = b.id
         ORDER BY c.pinned DESC, c.updated_at DESC",
    )?;
    let chats = stmt
        .query_map([], row_to_chat_with_extras)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(chats)
}

#[tauri::command]
pub fn get_chat(chat_id: String, db: State<'_, Db>) -> AppResult<Chat> {
    let conn = db.conn.lock().map_err(|e| AppError::Other(e.to_string()))?;
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
    sync.with_tx(&db, |tx, events| {
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
    sync.with_tx(&db, |tx, events| {
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

#[tauri::command]
pub fn list_chat_messages(chat_id: String, db: State<'_, Db>) -> AppResult<Vec<ChatMsg>> {
    let conn = db.conn.lock().map_err(|e| AppError::Other(e.to_string()))?;
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

    sync.with_tx(&db, |tx, events| {
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
        let db = Db::init(&dir.path().to_path_buf()).unwrap();
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
        let conn = db.conn.lock().unwrap();
        let now = chrono::Utc::now().timestamp_millis();
        conn.execute(
            "INSERT INTO chats (id, book_id, title, pinned, created_at, updated_at)
             VALUES (?1, ?2, ?3, 0, ?4, ?4)",
            params![id, book_id, title, now],
        ).unwrap();
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

        let conn = db.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT c.id, c.book_id, c.title, c.model, c.pinned, c.metadata, c.created_at, c.updated_at,
                    b.title,
                    (SELECT COUNT(*) FROM chat_messages WHERE chat_id = c.id),
                    (SELECT content FROM chat_messages WHERE chat_id = c.id ORDER BY created_at DESC LIMIT 1)
             FROM chats c LEFT JOIN books b ON c.book_id = b.id
             ORDER BY c.updated_at DESC",
        ).unwrap();
        let chats: Vec<Chat> = stmt
            .query_map([], row_to_chat_with_extras).unwrap()
            .collect::<Result<Vec<_>, _>>().unwrap();

        assert_eq!(chats.len(), 1);
        assert_eq!(chats[0].book_title, Some("Test Book".to_string()));
        assert_eq!(chats[0].message_count, Some(2));
        assert_eq!(chats[0].last_message, Some("Hi there!".to_string()));
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
