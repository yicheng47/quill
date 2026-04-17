use rusqlite::params;
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::sync::events::EventBody;
use crate::sync::writer::SyncWriter;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Collection {
    pub id: String,
    pub name: String,
    pub book_count: i32,
    pub sort_order: i32,
    pub created_at: i64,
    pub updated_at: i64,
}

#[tauri::command]
pub fn list_collections(db: State<'_, Db>) -> AppResult<Vec<Collection>> {
    let conn = db.conn.lock().map_err(|e| AppError::Other(e.to_string()))?;
    let mut stmt = conn.prepare(
        "SELECT c.id, c.name, c.created_at, c.updated_at, c.sort_order, COUNT(cb.book_id) as book_count
         FROM collections c
         LEFT JOIN collection_books cb ON c.id = cb.collection_id
         GROUP BY c.id
         ORDER BY c.sort_order, c.created_at",
    )?;
    let collections = stmt
        .query_map([], |row| {
            Ok(Collection {
                id: row.get(0)?,
                name: row.get(1)?,
                created_at: row.get(2)?,
                updated_at: row.get(3)?,
                sort_order: row.get(4)?,
                book_count: row.get(5)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(collections)
}

#[tauri::command]
pub fn create_collection(
    name: String,
    db: State<'_, Db>,
    sync: State<'_, SyncWriter>,
) -> AppResult<Collection> {
    let id = uuid::Uuid::new_v4().to_string();
    let now = chrono::Utc::now().timestamp_millis();
    let device = sync.self_device().to_string();

    // Compute sort_order outside the closure so the value is available for
    // both the SQL INSERT and the event payload — and so the closure stays
    // small.
    let sort_order: i32 = {
        let conn = db.conn.lock().map_err(|e| AppError::Other(e.to_string()))?;
        let max_order: i32 = conn
            .query_row("SELECT COALESCE(MAX(sort_order), -1) FROM collections", [], |r| r.get(0))
            .unwrap_or(-1);
        max_order + 1
    };

    let collection = Collection {
        id: id.clone(),
        name: name.clone(),
        book_count: 0,
        sort_order,
        created_at: now,
        updated_at: now,
    };

    sync.with_tx(&db, |tx, events| {
        tx.execute(
            "INSERT INTO collections (id, name, sort_order, created_at, updated_at, updated_by_device) VALUES (?1, ?2, ?3, ?4, ?4, ?5)",
            params![id, name, sort_order, now, device],
        )?;
        events.push(EventBody::CollectionCreate {
            id: id.clone(),
            name: name.clone(),
            sort_order,
        });
        Ok(())
    })?;

    Ok(collection)
}

#[tauri::command]
pub fn rename_collection(
    id: String,
    name: String,
    db: State<'_, Db>,
    sync: State<'_, SyncWriter>,
) -> AppResult<()> {
    let now = chrono::Utc::now().timestamp_millis();
    let device = sync.self_device().to_string();
    sync.with_tx(&db, |tx, events| {
        tx.execute(
            "UPDATE collections SET name = ?1, updated_at = ?2, updated_by_device = ?3 WHERE id = ?4",
            params![name, now, device, id],
        )?;
        events.push(EventBody::CollectionRename {
            id: id.clone(),
            name: name.clone(),
        });
        Ok(())
    })
}

#[tauri::command]
pub fn delete_collection(
    id: String,
    db: State<'_, Db>,
    sync: State<'_, SyncWriter>,
) -> AppResult<()> {
    sync.with_tx(&db, |tx, events| {
        // Mirror `cascade_delete_collection` — replay runs FK off, so the
        // join rows have to be wiped manually here too.
        tx.execute(
            "DELETE FROM collection_books WHERE collection_id = ?1",
            params![id],
        )?;
        tx.execute("DELETE FROM collections WHERE id = ?1", params![id])?;
        events.push(EventBody::CollectionDelete { id: id.clone() });
        Ok(())
    })
}

#[tauri::command]
pub fn reorder_collections(
    ids: Vec<String>,
    db: State<'_, Db>,
    sync: State<'_, SyncWriter>,
) -> AppResult<()> {
    let now = chrono::Utc::now().timestamp_millis();
    let device = sync.self_device().to_string();
    sync.with_tx(&db, |tx, events| {
        for (i, id) in ids.iter().enumerate() {
            let sort_order = i as i32;
            tx.execute(
                "UPDATE collections SET sort_order = ?1, updated_at = ?2, updated_by_device = ?3 WHERE id = ?4",
                params![sort_order, now, device, id],
            )?;
            events.push(EventBody::CollectionReorder {
                id: id.clone(),
                sort_order,
            });
        }
        Ok(())
    })
}

#[tauri::command]
pub fn add_book_to_collection(
    collection_id: String,
    book_id: String,
    db: State<'_, Db>,
    sync: State<'_, SyncWriter>,
) -> AppResult<()> {
    let now = chrono::Utc::now().timestamp_millis();
    let device = sync.self_device().to_string();
    sync.with_tx(&db, |tx, events| {
        tx.execute(
            "INSERT OR IGNORE INTO collection_books (collection_id, book_id, created_at, updated_at, updated_by_device) VALUES (?1, ?2, ?3, ?3, ?4)",
            params![collection_id, book_id, now, device],
        )?;
        events.push(EventBody::CollectionBookAdd {
            collection: collection_id.clone(),
            book: book_id.clone(),
        });
        Ok(())
    })
}

#[tauri::command]
pub fn remove_book_from_collection(
    collection_id: String,
    book_id: String,
    db: State<'_, Db>,
    sync: State<'_, SyncWriter>,
) -> AppResult<()> {
    sync.with_tx(&db, |tx, events| {
        tx.execute(
            "DELETE FROM collection_books WHERE collection_id = ?1 AND book_id = ?2",
            params![collection_id, book_id],
        )?;
        events.push(EventBody::CollectionBookRemove {
            collection: collection_id.clone(),
            book: book_id.clone(),
        });
        Ok(())
    })
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
