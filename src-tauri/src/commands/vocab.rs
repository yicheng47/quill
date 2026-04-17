use rusqlite::params;
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::sync::events::{EventBody, VocabPayload};
use crate::sync::writer::SyncWriter;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct VocabWord {
    pub id: String,
    pub book_id: String,
    pub word: String,
    pub definition: String,
    pub context_sentence: Option<String>,
    pub cfi: Option<String>,
    pub mastery: String,
    pub review_count: i64,
    pub next_review_at: Option<i64>,
    pub created_at: i64,
    pub updated_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub book_title: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct VocabStats {
    pub total: i64,
    pub new_count: i64,
    pub learning_count: i64,
    pub mastered_count: i64,
    pub due_for_review: i64,
}

fn row_to_vocab(row: &rusqlite::Row) -> rusqlite::Result<VocabWord> {
    Ok(VocabWord {
        id: row.get(0)?,
        book_id: row.get(1)?,
        word: row.get(2)?,
        definition: row.get(3)?,
        context_sentence: row.get(4)?,
        cfi: row.get(5)?,
        mastery: row.get(6)?,
        review_count: row.get(7)?,
        next_review_at: row.get(8)?,
        created_at: row.get(9)?,
        updated_at: row.get(10)?,
        book_title: None,
    })
}

fn row_to_vocab_with_book(row: &rusqlite::Row) -> rusqlite::Result<VocabWord> {
    Ok(VocabWord {
        id: row.get(0)?,
        book_id: row.get(1)?,
        word: row.get(2)?,
        definition: row.get(3)?,
        context_sentence: row.get(4)?,
        cfi: row.get(5)?,
        mastery: row.get(6)?,
        review_count: row.get(7)?,
        next_review_at: row.get(8)?,
        created_at: row.get(9)?,
        updated_at: row.get(10)?,
        book_title: row.get(11)?,
    })
}

const SELECT_COLS: &str = "id, book_id, word, definition, context_sentence, cfi, mastery, review_count, next_review_at, created_at, updated_at";

#[tauri::command]
pub fn add_vocab_word(
    book_id: String,
    word: String,
    definition: String,
    context_sentence: Option<String>,
    cfi: Option<String>,
    db: State<'_, Db>,
    sync: State<'_, SyncWriter>,
) -> AppResult<VocabWord> {
    let id = uuid::Uuid::new_v4().to_string();
    let now = chrono::Utc::now().timestamp_millis();
    let device = sync.self_device().to_string();

    // Dedup happens inside the sync transaction so two concurrent adds
    // can't both observe "missing" and insert duplicates. There's no
    // unique index on (book_id, word) — the conn mutex serializes the
    // whole tx, so the second writer's check sees the first writer's
    // committed row.
    let vocab = sync.with_tx(&db, now, |tx, events| {
        let existing: Option<VocabWord> = {
            let mut stmt = tx.prepare(&format!(
                "SELECT {} FROM vocab_words WHERE book_id = ?1 AND word = ?2 COLLATE NOCASE LIMIT 1",
                SELECT_COLS
            ))?;
            let row = stmt
                .query_map(params![book_id, word], row_to_vocab)?
                .next()
                .transpose()?;
            row
        };
        if let Some(existing) = existing {
            // Existing match → no SQL write, no event published. The
            // closure still returns the row so the frontend gets the
            // canonical record.
            return Ok(existing);
        }

        tx.execute(
            "INSERT INTO vocab_words (id, book_id, word, definition, context_sentence, cfi, mastery, review_count, next_review_at, created_at, updated_at, updated_by_device)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'new', 0, NULL, ?7, ?7, ?8)",
            params![id, book_id, word, definition, context_sentence, cfi, now, device],
        )?;
        events.push(EventBody::VocabAdd(VocabPayload {
            id: id.clone(),
            book_id: book_id.clone(),
            word: word.clone(),
            definition: definition.clone(),
            context_sentence: context_sentence.clone(),
            cfi: cfi.clone(),
            mastery: "new".to_string(),
            review_count: 0,
            next_review_at: None,
        }));
        Ok(VocabWord {
            id: id.clone(),
            book_id: book_id.clone(),
            word: word.clone(),
            definition: definition.clone(),
            context_sentence: context_sentence.clone(),
            cfi: cfi.clone(),
            mastery: "new".to_string(),
            review_count: 0,
            next_review_at: None,
            created_at: now,
            updated_at: now,
            book_title: None,
        })
    })?;

    Ok(vocab)
}

#[tauri::command]
pub fn remove_vocab_word(
    id: String,
    db: State<'_, Db>,
    sync: State<'_, SyncWriter>,
) -> AppResult<()> {
    let now = chrono::Utc::now().timestamp_millis();
    sync.with_tx(&db, now, |tx, events| {
        tx.execute("DELETE FROM vocab_words WHERE id = ?1", params![id])?;
        events.push(EventBody::VocabDelete { id: id.clone() });
        Ok(())
    })
}

#[tauri::command]
pub fn list_vocab_words(book_id: String, db: State<'_, Db>) -> AppResult<Vec<VocabWord>> {
    let conn = db.conn.lock().map_err(|e| AppError::Other(e.to_string()))?;
    let mut stmt = conn.prepare(&format!(
        "SELECT {} FROM vocab_words WHERE book_id = ?1 ORDER BY created_at DESC",
        SELECT_COLS
    ))?;
    let words = stmt
        .query_map(params![book_id], row_to_vocab)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(words)
}

#[tauri::command]
pub fn check_vocab_exists(
    book_id: String,
    word: String,
    db: State<'_, Db>,
) -> AppResult<Option<String>> {
    let conn = db.conn.lock().map_err(|e| AppError::Other(e.to_string()))?;
    let mut stmt = conn.prepare(
        "SELECT id FROM vocab_words WHERE book_id = ?1 AND word = ?2 COLLATE NOCASE LIMIT 1",
    )?;
    let id: Option<String> = stmt
        .query_map(params![book_id, word], |row| row.get(0))?
        .next()
        .transpose()?;
    Ok(id)
}

#[tauri::command]
pub fn list_all_vocab_words(db: State<'_, Db>) -> AppResult<Vec<VocabWord>> {
    let conn = db.conn.lock().map_err(|e| AppError::Other(e.to_string()))?;
    let mut stmt = conn.prepare(
        "SELECT v.id, v.book_id, v.word, v.definition, v.context_sentence, v.cfi, v.mastery, v.review_count, v.next_review_at, v.created_at, v.updated_at, b.title FROM vocab_words v LEFT JOIN books b ON v.book_id = b.id ORDER BY v.created_at DESC"
    )?;
    let words = stmt
        .query_map([], row_to_vocab_with_book)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(words)
}

#[tauri::command]
pub fn update_vocab_mastery(
    id: String,
    mastery: String,
    next_review_at: Option<i64>,
    db: State<'_, Db>,
    sync: State<'_, SyncWriter>,
) -> AppResult<()> {
    let now = chrono::Utc::now().timestamp_millis();
    let device = sync.self_device().to_string();
    sync.with_tx(&db, now, |tx, events| {
        tx.execute(
            "UPDATE vocab_words SET mastery = ?1, next_review_at = ?2, review_count = review_count + 1, updated_at = ?3, updated_by_device = ?4 WHERE id = ?5",
            params![mastery, next_review_at, now, device, id],
        )?;
        // Read the post-increment review_count so the event carries an
        // absolute value (replay needs that to stay idempotent — see the
        // VocabMasterySet docstring in events.rs).
        let review_count: i64 = tx
            .query_row(
                "SELECT review_count FROM vocab_words WHERE id = ?1",
                params![id],
                |r| r.get(0),
            )
            .unwrap_or(0);
        events.push(EventBody::VocabMasterySet {
            id: id.clone(),
            mastery: mastery.clone(),
            next_review_at,
            review_count,
        });
        Ok(())
    })
}

#[tauri::command]
pub fn list_vocab_due_for_review(db: State<'_, Db>) -> AppResult<Vec<VocabWord>> {
    let conn = db.conn.lock().map_err(|e| AppError::Other(e.to_string()))?;
    let now_ms = chrono::Utc::now().timestamp_millis();
    let mut stmt = conn.prepare(&format!(
        "SELECT {} FROM vocab_words WHERE next_review_at IS NOT NULL AND next_review_at <= ?1 ORDER BY next_review_at ASC",
        SELECT_COLS
    ))?;
    let words = stmt
        .query_map(params![now_ms], row_to_vocab)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(words)
}

#[tauri::command]
pub fn get_vocab_stats(db: State<'_, Db>) -> AppResult<VocabStats> {
    let conn = db.conn.lock().map_err(|e| AppError::Other(e.to_string()))?;
    let now_ms = chrono::Utc::now().timestamp_millis();
    let total: i64 = conn.query_row("SELECT COUNT(*) FROM vocab_words", [], |r| r.get(0))?;
    let new_count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM vocab_words WHERE mastery = 'new'",
        [],
        |r| r.get(0),
    )?;
    let learning_count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM vocab_words WHERE mastery = 'learning'",
        [],
        |r| r.get(0),
    )?;
    let mastered_count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM vocab_words WHERE mastery = 'mastered'",
        [],
        |r| r.get(0),
    )?;
    let due_for_review: i64 = conn.query_row(
        "SELECT COUNT(*) FROM vocab_words WHERE next_review_at IS NOT NULL AND next_review_at <= ?1",
        params![now_ms],
        |r| r.get(0),
    )?;
    Ok(VocabStats {
        total,
        new_count,
        learning_count,
        mastered_count,
        due_for_review,
    })
}
