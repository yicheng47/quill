use rusqlite::params;
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::db::Db;
use crate::error::{AppError, AppResult};

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
    pub next_review_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
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
) -> AppResult<VocabWord> {
    let conn = db.conn.lock().map_err(|e| AppError::Other(e.to_string()))?;

    // Dedup: check if same word+book_id exists
    let existing: Option<VocabWord> = {
        let mut stmt = conn.prepare(&format!(
            "SELECT {} FROM vocab_words WHERE book_id = ?1 AND word = ?2 COLLATE NOCASE LIMIT 1",
            SELECT_COLS
        ))?;
        let result = stmt.query_map(params![book_id, word], row_to_vocab)?
            .next()
            .transpose()?;
        result
    };

    if let Some(existing) = existing {
        return Ok(existing);
    }

    let id = uuid::Uuid::new_v4().to_string();
    let now = chrono::Utc::now().to_rfc3339();

    conn.execute(
        "INSERT INTO vocab_words (id, book_id, word, definition, context_sentence, cfi, mastery, review_count, next_review_at, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'new', 0, NULL, ?7, ?7)",
        params![id, book_id, word, definition, context_sentence, cfi, now],
    )?;

    Ok(VocabWord {
        id,
        book_id,
        word,
        definition,
        context_sentence,
        cfi,
        mastery: "new".to_string(),
        review_count: 0,
        next_review_at: None,
        created_at: now.clone(),
        updated_at: now,
    })
}

#[tauri::command]
pub fn remove_vocab_word(id: String, db: State<'_, Db>) -> AppResult<()> {
    let conn = db.conn.lock().map_err(|e| AppError::Other(e.to_string()))?;
    conn.execute("DELETE FROM vocab_words WHERE id = ?1", params![id])?;
    Ok(())
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
    let mut stmt = conn.prepare(&format!(
        "SELECT {} FROM vocab_words ORDER BY created_at DESC",
        SELECT_COLS
    ))?;
    let words = stmt
        .query_map([], row_to_vocab)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(words)
}

#[tauri::command]
pub fn update_vocab_mastery(
    id: String,
    mastery: String,
    next_review_at: Option<String>,
    db: State<'_, Db>,
) -> AppResult<()> {
    let conn = db.conn.lock().map_err(|e| AppError::Other(e.to_string()))?;
    let now = chrono::Utc::now().to_rfc3339();
    conn.execute(
        "UPDATE vocab_words SET mastery = ?1, next_review_at = ?2, review_count = review_count + 1, updated_at = ?3 WHERE id = ?4",
        params![mastery, next_review_at, now, id],
    )?;
    Ok(())
}

#[tauri::command]
pub fn list_vocab_due_for_review(db: State<'_, Db>) -> AppResult<Vec<VocabWord>> {
    let conn = db.conn.lock().map_err(|e| AppError::Other(e.to_string()))?;
    let mut stmt = conn.prepare(&format!(
        "SELECT {} FROM vocab_words WHERE next_review_at IS NOT NULL AND next_review_at <= datetime('now') ORDER BY next_review_at ASC",
        SELECT_COLS
    ))?;
    let words = stmt
        .query_map([], row_to_vocab)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(words)
}

#[tauri::command]
pub fn get_vocab_stats(db: State<'_, Db>) -> AppResult<VocabStats> {
    let conn = db.conn.lock().map_err(|e| AppError::Other(e.to_string()))?;
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
        "SELECT COUNT(*) FROM vocab_words WHERE next_review_at IS NOT NULL AND next_review_at <= datetime('now')",
        [],
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
