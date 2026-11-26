use std::collections::HashSet;

use rusqlite::params;
use serde::{Deserialize, Serialize};

use crate::db::Db;
use crate::error::AppResult;
use crate::host::Core;

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

pub(crate) fn do_create_collection(name: &str, db: &Db) -> AppResult<Collection> {
    let id = uuid::Uuid::new_v4().to_string();
    let now = chrono::Utc::now().timestamp_millis();

    db.with_tx(|tx| {
        let max_order: i32 = tx
            .query_row(
                "SELECT COALESCE(MAX(sort_order), -1) FROM collections",
                [],
                |r| r.get(0),
            )
            .unwrap_or(-1);
        let sort_order = max_order + 1;
        tx.execute(
            "INSERT INTO collections (id, name, sort_order, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?4)",
            params![id, name, sort_order, now],
        )?;
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
    do_create_collection(&name, &core.db)
}

pub(crate) fn do_rename_collection(id: &str, name: &str, db: &Db) -> AppResult<()> {
    let now = chrono::Utc::now().timestamp_millis();
    db.with_tx(|tx| {
        tx.execute(
            "UPDATE collections SET name = ?1, updated_at = ?2 WHERE id = ?3",
            params![name, now, id],
        )?;
        Ok(())
    })
}

pub fn rename_collection(core: &Core, id: String, name: String) -> AppResult<()> {
    do_rename_collection(&id, &name, &core.db)
}

pub(crate) fn do_delete_collection(id: &str, db: &Db) -> AppResult<()> {
    db.with_tx(|tx| {
        tx.execute(
            "DELETE FROM collection_books WHERE collection_id = ?1",
            params![id],
        )?;
        tx.execute("DELETE FROM collections WHERE id = ?1", params![id])?;
        Ok(())
    })
}

pub fn delete_collection(core: &Core, id: String) -> AppResult<()> {
    do_delete_collection(&id, &core.db)
}

pub fn reorder_collections(core: &Core, ids: Vec<String>) -> AppResult<()> {
    let now = chrono::Utc::now().timestamp_millis();
    core.db.with_tx(|tx| {
        for (i, id) in ids.iter().enumerate() {
            let sort_order = i as i32;
            tx.execute(
                "UPDATE collections SET sort_order = ?1, updated_at = ?2 WHERE id = ?3",
                params![sort_order, now, id],
            )?;
        }
        Ok(())
    })
}

pub(crate) fn do_add_book_to_collection(
    collection_id: &str,
    book_id: &str,
    db: &Db,
) -> AppResult<()> {
    let now = chrono::Utc::now().timestamp_millis();
    db.with_tx(|tx| {
        tx.execute(
            "INSERT OR IGNORE INTO collection_books (collection_id, book_id, created_at, updated_at) VALUES (?1, ?2, ?3, ?3)",
            params![collection_id, book_id, now],
        )?;
        Ok(())
    })
}

pub fn add_book_to_collection(
    core: &Core,
    collection_id: String,
    book_id: String,
) -> AppResult<()> {
    do_add_book_to_collection(&collection_id, &book_id, &core.db)
}

pub(crate) fn do_remove_book_from_collection(
    collection_id: &str,
    book_id: &str,
    db: &Db,
) -> AppResult<()> {
    db.with_tx(|tx| {
        tx.execute(
            "DELETE FROM collection_books WHERE collection_id = ?1 AND book_id = ?2",
            params![collection_id, book_id],
        )?;
        Ok(())
    })
}

pub fn remove_book_from_collection(
    core: &Core,
    collection_id: String,
    book_id: String,
) -> AppResult<()> {
    do_remove_book_from_collection(&collection_id, &book_id, &core.db)
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
) -> AppResult<()> {
    let now = chrono::Utc::now().timestamp_millis();
    let mut seen = HashSet::with_capacity(book_ids.len());
    db.with_tx(|tx| {
        for book_id in book_ids {
            if !seen.insert(book_id.as_str()) {
                continue;
            }
            tx.execute(
                "INSERT OR IGNORE INTO collection_books (collection_id, book_id, created_at, updated_at) VALUES (?1, ?2, ?3, ?3)",
                params![collection_id, book_id, now],
            )?;
        }
        Ok(())
    })
}

pub fn add_books_to_collection(
    core: &Core,
    collection_id: String,
    book_ids: Vec<String>,
) -> AppResult<()> {
    do_add_books_to_collection(&collection_id, &book_ids, &core.db)
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::params;
    use tempfile::TempDir;

    fn setup() -> (TempDir, Db) {
        let dir = TempDir::new().unwrap();
        let db = Db::init(dir.path()).unwrap();
        (dir, db)
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
        let (_dir, db) = setup();
        seed_book(&db, "b1");
        seed_book(&db, "b2");

        let c1 = do_create_collection("First", &db).unwrap();
        let c2 = do_create_collection("Second", &db).unwrap();

        assert!(query_book_collections(&db, "b1").unwrap().is_empty());

        do_add_book_to_collection(&c2.id, "b1", &db).unwrap();
        do_add_book_to_collection(&c1.id, "b1", &db).unwrap();
        assert_eq!(
            query_book_collections(&db, "b1").unwrap(),
            vec![c1.id.clone(), c2.id.clone()]
        );

        do_remove_book_from_collection(&c1.id, "b1", &db).unwrap();
        assert_eq!(query_book_collections(&db, "b1").unwrap(), vec![c2.id]);
        assert!(query_book_collections(&db, "b2").unwrap().is_empty());
    }

    #[test]
    fn add_books_to_collection_deduplicates_and_matches_single_adds() {
        let (_dir, db) = setup();
        seed_book(&db, "b1");
        seed_book(&db, "b2");
        let c = do_create_collection("Batch", &db).unwrap();

        do_add_books_to_collection(&c.id, &["b1".into(), "b2".into(), "b1".into()], &db).unwrap();

        assert_eq!(query_book_collections(&db, "b1").unwrap(), vec![c.id.clone()]);
        assert_eq!(query_book_collections(&db, "b2").unwrap(), vec![c.id.clone()]);
        let collections = query_collections(&db).unwrap();
        assert_eq!(collections[0].book_count, 2);
    }
}
