use std::collections::HashSet;

use rusqlite::params;
use serde::{Deserialize, Serialize};

use crate::db::Db;
use crate::error::AppResult;
use crate::host::Core;
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

pub(crate) fn query_collections(db: &Db) -> AppResult<Vec<Collection>> {
    let conn = db.reader();
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

pub fn list_collections(core: &Core) -> AppResult<Vec<Collection>> {
    query_collections(&core.db)
}

pub(crate) fn do_create_collection(
    name: &str,
    db: &Db,
    sync: &SyncWriter,
) -> AppResult<Collection> {
    let id = uuid::Uuid::new_v4().to_string();
    let now = chrono::Utc::now().timestamp_millis();
    let device = sync.self_device().to_string();

    sync.with_tx(db, now, |tx, events| {
        let max_order: i32 = tx
            .query_row(
                "SELECT COALESCE(MAX(sort_order), -1) FROM collections",
                [],
                |r| r.get(0),
            )
            .unwrap_or(-1);
        let sort_order = max_order + 1;
        tx.execute(
            "INSERT INTO collections (id, name, sort_order, created_at, updated_at, updated_by_device) VALUES (?1, ?2, ?3, ?4, ?4, ?5)",
            params![id, name, sort_order, now, device],
        )?;
        events.push(EventBody::CollectionCreate {
            id: id.clone(),
            name: name.to_string(),
            sort_order,
        });
        Ok(Collection {
            id: id.clone(),
            name: name.to_string(),
            book_count: 0,
            sort_order,
            created_at: now,
            updated_at: now,
        })
    })
}

pub fn create_collection(core: &Core, name: String) -> AppResult<Collection> {
    do_create_collection(&name, &core.db, &core.sync_writer)
}

pub(crate) fn do_rename_collection(
    id: &str,
    name: &str,
    db: &Db,
    sync: &SyncWriter,
) -> AppResult<()> {
    let now = chrono::Utc::now().timestamp_millis();
    let device = sync.self_device().to_string();
    sync.with_tx(db, now, |tx, events| {
        tx.execute(
            "UPDATE collections SET name = ?1, updated_at = ?2, updated_by_device = ?3 WHERE id = ?4",
            params![name, now, device, id],
        )?;
        events.push(EventBody::CollectionRename {
            id: id.to_string(),
            name: name.to_string(),
        });
        Ok(())
    })
}

pub fn rename_collection(core: &Core, id: String, name: String) -> AppResult<()> {
    do_rename_collection(&id, &name, &core.db, &core.sync_writer)
}

pub(crate) fn do_delete_collection(id: &str, db: &Db, sync: &SyncWriter) -> AppResult<()> {
    let now = chrono::Utc::now().timestamp_millis();
    sync.with_tx(db, now, |tx, events| {
        tx.execute(
            "DELETE FROM collection_books WHERE collection_id = ?1",
            params![id],
        )?;
        tx.execute("DELETE FROM collections WHERE id = ?1", params![id])?;
        events.push(EventBody::CollectionDelete {
            id: id.to_string(),
        });
        Ok(())
    })
}

pub fn delete_collection(core: &Core, id: String) -> AppResult<()> {
    do_delete_collection(&id, &core.db, &core.sync_writer)
}

pub fn reorder_collections(core: &Core, ids: Vec<String>) -> AppResult<()> {
    let now = chrono::Utc::now().timestamp_millis();
    let device = core.sync_writer.self_device().to_string();
    core.sync_writer.with_tx(&core.db, now, |tx, events| {
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

pub(crate) fn do_add_book_to_collection(
    collection_id: &str,
    book_id: &str,
    db: &Db,
    sync: &SyncWriter,
) -> AppResult<()> {
    let now = chrono::Utc::now().timestamp_millis();
    let device = sync.self_device().to_string();
    sync.with_tx(db, now, |tx, events| {
        tx.execute(
            "INSERT OR IGNORE INTO collection_books (collection_id, book_id, created_at, updated_at, updated_by_device) VALUES (?1, ?2, ?3, ?3, ?4)",
            params![collection_id, book_id, now, device],
        )?;
        events.push(EventBody::CollectionBookAdd {
            collection: collection_id.to_string(),
            book: book_id.to_string(),
        });
        Ok(())
    })
}

pub fn add_book_to_collection(
    core: &Core,
    collection_id: String,
    book_id: String,
) -> AppResult<()> {
    do_add_book_to_collection(&collection_id, &book_id, &core.db, &core.sync_writer)
}

pub(crate) fn do_remove_book_from_collection(
    collection_id: &str,
    book_id: &str,
    db: &Db,
    sync: &SyncWriter,
) -> AppResult<()> {
    let now = chrono::Utc::now().timestamp_millis();
    sync.with_tx(db, now, |tx, events| {
        tx.execute(
            "DELETE FROM collection_books WHERE collection_id = ?1 AND book_id = ?2",
            params![collection_id, book_id],
        )?;
        events.push(EventBody::CollectionBookRemove {
            collection: collection_id.to_string(),
            book: book_id.to_string(),
        });
        Ok(())
    })
}

pub fn remove_book_from_collection(
    core: &Core,
    collection_id: String,
    book_id: String,
) -> AppResult<()> {
    do_remove_book_from_collection(&collection_id, &book_id, &core.db, &core.sync_writer)
}

pub fn list_books_in_collection(core: &Core, collection_id: String) -> AppResult<Vec<String>> {
    let conn = core.db.reader();
    let mut stmt = conn.prepare(
        "SELECT book_id FROM collection_books WHERE collection_id = ?1",
    )?;
    let book_ids = stmt
        .query_map(params![collection_id], |row| row.get(0))?
        .collect::<Result<Vec<String>, _>>()?;
    Ok(book_ids)
}

pub(crate) fn query_book_collections(db: &Db, book_id: &str) -> AppResult<Vec<String>> {
    let conn = db.reader();
    let mut stmt = conn.prepare(
        "SELECT cb.collection_id
         FROM collection_books cb
         INNER JOIN collections c ON c.id = cb.collection_id
         WHERE cb.book_id = ?1
         ORDER BY c.sort_order, c.created_at",
    )?;
    let collection_ids = stmt
        .query_map(params![book_id], |row| row.get(0))?
        .collect::<Result<Vec<String>, _>>()?;
    Ok(collection_ids)
}

pub fn list_book_collections(core: &Core, book_id: String) -> AppResult<Vec<String>> {
    query_book_collections(&core.db, &book_id)
}

pub(crate) fn do_add_books_to_collection(
    collection_id: &str,
    book_ids: &[String],
    db: &Db,
    sync: &SyncWriter,
) -> AppResult<()> {
    let mut seen = HashSet::with_capacity(book_ids.len());
    for book_id in book_ids {
        if !seen.insert(book_id.as_str()) {
            continue;
        }
        do_add_book_to_collection(collection_id, book_id, db, sync)?;
    }
    Ok(())
}

pub fn add_books_to_collection(
    core: &Core,
    collection_id: String,
    book_ids: Vec<String>,
) -> AppResult<()> {
    do_add_books_to_collection(&collection_id, &book_ids, &core.db, &core.sync_writer)
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::params;
    use tempfile::TempDir;

    fn setup() -> (TempDir, Db, SyncWriter) {
        let dir = TempDir::new().unwrap();
        let db = Db::init(dir.path()).unwrap();
        let sync = SyncWriter::new("dev-1".to_string());
        (dir, db, sync)
    }

    fn seed_book(db: &Db, id: &str) {
        let conn = db.conn.lock().unwrap();
        let now = chrono::Utc::now().timestamp_millis();
        conn.execute(
            "INSERT INTO books (id, title, author, file_path, format, status, progress, created_at, updated_at)
             VALUES (?1, ?2, 'Author', 'books/test.epub', 'epub', 'unread', 0, ?3, ?3)",
            params![id, format!("Book {id}"), now],
        )
        .unwrap();
    }

    #[test]
    fn list_book_collections_returns_sorted_membership() {
        let (_dir, db, sync) = setup();
        seed_book(&db, "b1");
        seed_book(&db, "b2");

        let c1 = do_create_collection("First", &db, &sync).unwrap();
        let c2 = do_create_collection("Second", &db, &sync).unwrap();

        assert!(query_book_collections(&db, "b1").unwrap().is_empty());

        do_add_book_to_collection(&c2.id, "b1", &db, &sync).unwrap();
        do_add_book_to_collection(&c1.id, "b1", &db, &sync).unwrap();
        assert_eq!(
            query_book_collections(&db, "b1").unwrap(),
            vec![c1.id.clone(), c2.id.clone()]
        );

        do_remove_book_from_collection(&c1.id, "b1", &db, &sync).unwrap();
        assert_eq!(query_book_collections(&db, "b1").unwrap(), vec![c2.id]);
        assert!(query_book_collections(&db, "b2").unwrap().is_empty());
    }

    #[test]
    fn add_books_to_collection_matches_per_book_sync_events() {
        let (_dir1, db_batch, sync_batch) = setup();
        seed_book(&db_batch, "b1");
        seed_book(&db_batch, "b2");
        let c_batch = do_create_collection("Batch", &db_batch, &sync_batch).unwrap();
        sync_batch.set_should_queue(true);

        do_add_books_to_collection(
            &c_batch.id,
            &["b1".into(), "b2".into(), "b1".into()],
            &db_batch,
            &sync_batch,
        )
        .unwrap();

        let (_dir2, db_single, sync_single) = setup();
        seed_book(&db_single, "b1");
        seed_book(&db_single, "b2");
        let c_single = do_create_collection("Single", &db_single, &sync_single).unwrap();
        sync_single.set_should_queue(true);

        do_add_book_to_collection(&c_single.id, "b1", &db_single, &sync_single).unwrap();
        do_add_book_to_collection(&c_single.id, "b2", &db_single, &sync_single).unwrap();

        assert_eq!(
            query_book_collections(&db_batch, "b1").unwrap(),
            vec![c_batch.id.clone()]
        );
        assert_eq!(
            query_book_collections(&db_batch, "b2").unwrap(),
            vec![c_batch.id.clone()]
        );

        let read_outbox = |db: &Db| -> Vec<serde_json::Value> {
            let conn = db.conn.lock().unwrap();
            let mut stmt = conn
                .prepare("SELECT body_json FROM _pending_publish ORDER BY rowid")
                .unwrap();
            stmt.query_map([], |row| {
                let s: String = row.get(0)?;
                Ok(serde_json::from_str::<serde_json::Value>(&s).unwrap())
            })
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap()
        };

        let batch_events = read_outbox(&db_batch);
        let single_events = read_outbox(&db_single);
        assert_eq!(batch_events.len(), 2);
        assert_eq!(single_events.len(), 2);
        for (b, s) in batch_events.iter().zip(single_events.iter()) {
            assert_eq!(b["type"], s["type"]);
            assert_eq!(b["payload"]["book"], s["payload"]["book"]);
            assert_eq!(b["payload"]["collection"], c_batch.id);
        }
    }
}
