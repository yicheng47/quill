use rusqlite::params;
use serde::{Deserialize, Serialize};

use crate::db::Db;
use crate::error::AppResult;
use crate::host::Core;
use crate::sync::events::{EventBody, VocabPayload};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct VocabWord {
    pub id: String,
    pub book_id: String,
    pub word: String,
    pub definition: String,
    pub context_sentence: Option<String>,
    pub context_explanation: Option<String>,
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

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq)]
pub struct VocabLemmaCheck {
    pub total_count: i64,
    pub matches_this_passage: bool,
}

fn non_empty_trimmed(val: Option<&str>) -> Option<&str> {
    val.map(str::trim).filter(|s| !s.is_empty())
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
        context_explanation: row.get(11)?,
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
        context_explanation: row.get(11)?,
        book_title: row.get(12)?,
    })
}

const SELECT_COLS: &str = "id, book_id, word, definition, context_sentence, cfi, mastery, review_count, next_review_at, created_at, updated_at, context_explanation";

pub fn add_vocab_word(
    core: &Core,
    book_id: String,
    word: String,
    definition: String,
    context_sentence: Option<String>,
    context_explanation: Option<String>,
    cfi: Option<String>,
) -> AppResult<VocabWord> {
    let id = uuid::Uuid::new_v4().to_string();
    let now = chrono::Utc::now().timestamp_millis();
    let device = core.sync_writer.self_device().to_string();

    let word = word.trim().to_string();
    let cfi = non_empty_trimmed(cfi.as_deref()).map(str::to_string);
    let context_sentence = non_empty_trimmed(context_sentence.as_deref()).map(str::to_string);

    log::debug!("vocab: add_vocab_word book_id={book_id} word={word:?}");

    // Dedup happens inside the sync transaction by (book_id, word, cfi) —
    // falling back to (book_id, word, context_sentence) when cfi is absent —
    // so multiple distinct encounters of the same canonical lemma save cleanly
    // while duplicate clicks on the same passage remain idempotent.
    let vocab = core.sync_writer.with_tx(&core.db, now, |tx, events| {
        let existing: Option<VocabWord> = if let Some(cfi_val) = cfi.as_deref() {
            let mut stmt = tx.prepare(&format!(
                "SELECT {} FROM vocab_words WHERE book_id = ?1 AND TRIM(word) = ?2 COLLATE NOCASE AND TRIM(cfi) = ?3 LIMIT 1",
                SELECT_COLS
            ))?;
            let found = stmt
                .query_map(params![book_id, word, cfi_val], row_to_vocab)?
                .next()
                .transpose()?;
            found
        } else if let Some(ctx_val) = context_sentence.as_deref() {
            let mut stmt = tx.prepare(&format!(
                "SELECT {} FROM vocab_words WHERE book_id = ?1 AND TRIM(word) = ?2 COLLATE NOCASE AND (cfi IS NULL OR TRIM(cfi) = '') AND TRIM(context_sentence) = ?3 LIMIT 1",
                SELECT_COLS
            ))?;
            let found = stmt
                .query_map(params![book_id, word, ctx_val], row_to_vocab)?
                .next()
                .transpose()?;
            found
        } else {
            let mut stmt = tx.prepare(&format!(
                "SELECT {} FROM vocab_words WHERE book_id = ?1 AND TRIM(word) = ?2 COLLATE NOCASE AND (cfi IS NULL OR TRIM(cfi) = '') AND (context_sentence IS NULL OR TRIM(context_sentence) = '') LIMIT 1",
                SELECT_COLS
            ))?;
            let found = stmt
                .query_map(params![book_id, word], row_to_vocab)?
                .next()
                .transpose()?;
            found
        };
        if let Some(existing) = existing {
            // Existing match → no SQL write, no event published. The
            // closure still returns the row so the frontend gets the
            // canonical record.
            return Ok(existing);
        }

        tx.execute(
            "INSERT INTO vocab_words (id, book_id, word, definition, context_sentence, context_explanation, cfi, mastery, review_count, next_review_at, created_at, updated_at, updated_by_device)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'new', 0, NULL, ?8, ?8, ?9)",
            params![id, book_id, word, definition, context_sentence, context_explanation, cfi, now, device],
        )?;
        events.push(EventBody::VocabAdd(VocabPayload {
            id: id.clone(),
            book_id: book_id.clone(),
            word: word.clone(),
            definition: definition.clone(),
            context_sentence: context_sentence.clone(),
            context_explanation: context_explanation.clone(),
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
            context_explanation: context_explanation.clone(),
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

pub fn remove_vocab_word(core: &Core, id: String) -> AppResult<()> {
    let now = chrono::Utc::now().timestamp_millis();
    core.sync_writer.with_tx(&core.db, now, |tx, events| {
        tx.execute("DELETE FROM vocab_words WHERE id = ?1", params![id])?;
        events.push(EventBody::VocabDelete { id: id.clone() });
        Ok(())
    })
}

pub(crate) fn query_vocab_words(db: &Db, book_id: &str) -> AppResult<Vec<VocabWord>> {
    let conn = db.reader();
    let mut stmt = conn.prepare(&format!(
        "SELECT {} FROM vocab_words WHERE book_id = ?1 ORDER BY created_at DESC",
        SELECT_COLS
    ))?;
    let words = stmt
        .query_map(params![book_id], row_to_vocab)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(words)
}

pub fn list_vocab_words(core: &Core, book_id: String) -> AppResult<Vec<VocabWord>> {
    query_vocab_words(&core.db, &book_id)
}

pub fn check_vocab_exists(core: &Core, book_id: String, word: String) -> AppResult<Option<String>> {
    let conn = core.db.reader();
    let mut stmt = conn.prepare(
        "SELECT id FROM vocab_words WHERE book_id = ?1 AND word = ?2 COLLATE NOCASE LIMIT 1",
    )?;
    let id: Option<String> = stmt
        .query_map(params![book_id, word], |row| row.get(0))?
        .next()
        .transpose()?;
    Ok(id)
}

pub fn check_vocab_lemma(
    core: &Core,
    lemma: String,
    book_id: Option<String>,
    cfi: Option<String>,
    context_sentence: Option<String>,
) -> AppResult<VocabLemmaCheck> {
    let trimmed = lemma.trim();
    if trimmed.is_empty() {
        return Ok(VocabLemmaCheck {
            total_count: 0,
            matches_this_passage: false,
        });
    }

    let conn = core.db.reader();
    let total_count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM vocab_words WHERE TRIM(word) = ?1 COLLATE NOCASE",
        params![trimmed],
        |row| row.get(0),
    )?;

    let matches_this_passage = if total_count == 0 {
        false
    } else if let Some(bid) = non_empty_trimmed(book_id.as_deref()) {
        if let Some(cfi_val) = non_empty_trimmed(cfi.as_deref()) {
            conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM vocab_words WHERE book_id = ?1 AND TRIM(word) = ?2 COLLATE NOCASE AND TRIM(cfi) = ?3)",
                params![bid, trimmed, cfi_val],
                |row| row.get::<_, i64>(0),
            )? != 0
        } else if let Some(ctx_val) = non_empty_trimmed(context_sentence.as_deref()) {
            conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM vocab_words WHERE book_id = ?1 AND TRIM(word) = ?2 COLLATE NOCASE AND (cfi IS NULL OR TRIM(cfi) = '') AND TRIM(context_sentence) = ?3)",
                params![bid, trimmed, ctx_val],
                |row| row.get::<_, i64>(0),
            )? != 0
        } else {
            conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM vocab_words WHERE book_id = ?1 AND TRIM(word) = ?2 COLLATE NOCASE AND (cfi IS NULL OR TRIM(cfi) = '') AND (context_sentence IS NULL OR TRIM(context_sentence) = ''))",
                params![bid, trimmed],
                |row| row.get::<_, i64>(0),
            )? != 0
        }
    } else {
        false
    };

    Ok(VocabLemmaCheck {
        total_count,
        matches_this_passage,
    })
}

pub fn remove_vocab_lemma(core: &Core, word: String) -> AppResult<usize> {
    let trimmed = word.trim().to_string();
    if trimmed.is_empty() {
        return Ok(0);
    }
    let now = chrono::Utc::now().timestamp_millis();
    core.sync_writer.with_tx(&core.db, now, |tx, events| {
        let ids: Vec<String> = {
            let mut stmt =
                tx.prepare("SELECT id FROM vocab_words WHERE TRIM(word) = ?1 COLLATE NOCASE")?;
            let rows = stmt
                .query_map(params![trimmed], |row| row.get::<_, String>(0))?
                .collect::<Result<Vec<_>, _>>()?;
            rows
        };
        for id in &ids {
            tx.execute("DELETE FROM vocab_words WHERE id = ?1", params![id])?;
            events.push(EventBody::VocabDelete { id: id.clone() });
        }
        Ok(ids.len())
    })
}

pub fn list_all_vocab_words(core: &Core) -> AppResult<Vec<VocabWord>> {
    let conn = core.db.reader();
    let mut stmt = conn.prepare(
        "SELECT v.id, v.book_id, v.word, v.definition, v.context_sentence, v.cfi, v.mastery, v.review_count, v.next_review_at, v.created_at, v.updated_at, v.context_explanation, b.title FROM vocab_words v LEFT JOIN books b ON v.book_id = b.id ORDER BY v.created_at DESC"
    )?;
    let words = stmt
        .query_map([], row_to_vocab_with_book)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(words)
}

pub fn update_vocab_mastery(
    core: &Core,
    id: String,
    mastery: String,
    next_review_at: Option<i64>,
) -> AppResult<()> {
    let now = chrono::Utc::now().timestamp_millis();
    let device = core.sync_writer.self_device().to_string();
    core.sync_writer.with_tx(&core.db, now, |tx, events| {
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

pub(crate) fn query_vocab_due(db: &Db) -> AppResult<Vec<VocabWord>> {
    let conn = db.reader();
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

pub fn list_vocab_due_for_review(core: &Core) -> AppResult<Vec<VocabWord>> {
    query_vocab_due(&core.db)
}

pub(crate) fn query_vocab_stats(db: &Db) -> AppResult<VocabStats> {
    let conn = db.reader();
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

pub fn get_vocab_stats(core: &Core) -> AppResult<VocabStats> {
    query_vocab_stats(&core.db)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::host::{boot, BootConfig, ShellHost};
    use std::path::Path;
    use std::sync::Arc;
    use tempfile::TempDir;

    struct NoopHost;
    impl ShellHost for NoopHost {
        fn emit(&self, _event: &str, _payload: serde_json::Value) {}
        fn emit_to(&self, _window: &str, _event: &str, _payload: serde_json::Value) {}
        fn open_url(&self, _url: &str) -> AppResult<()> {
            Ok(())
        }
        fn reveal_path(&self, _path: &Path) -> AppResult<()> {
            Ok(())
        }
    }

    fn setup_core() -> (TempDir, Arc<Core>) {
        let dir = TempDir::new().unwrap();
        let core = boot(
            BootConfig {
                app_data_base_dir: dir.path().join("appdata"),
                log_dir: dir.path().join("logs"),
                is_dev: true,
                mcp_binary_path: dir.path().join("quill-mcp"),
                pdfium_path: None,
                dict_path: None,
            },
            Arc::new(NoopHost),
        )
        .unwrap();

        let conn = core.db.conn.lock().unwrap();
        let now = chrono::Utc::now().timestamp_millis();
        for bid in ["b1", "b2"] {
            conn.execute(
                "INSERT INTO books (id, title, author, file_path, format, status, progress, created_at, updated_at)
                 VALUES (?1, ?2, 'Author', 'books/test.epub', 'epub', 'reading', 0, ?3, ?3)",
                params![bid, format!("Book {bid}"), now],
            )
            .unwrap();
        }
        drop(conn);
        (dir, core)
    }

    #[test]
    fn allows_multiple_encounters_under_one_lemma_and_dedupes_identical_passage() {
        let (_dir, core) = setup_core();

        let e1 = add_vocab_word(
            &core,
            "b1".into(),
            "mortify".into(),
            "/ˈmɔːr.tɪ.faɪ/ verb. Humiliate.".into(),
            Some("I am mortifying myself.".into()),
            Some("Note 1".into()),
            Some("epubcfi(/6/4!/4/2)".into()),
        )
        .unwrap();

        // Identical (book_id, word, cfi) is idempotent
        let dup = add_vocab_word(
            &core,
            "b1".into(),
            "Mortify".into(),
            "Other def".into(),
            Some("I am mortifying myself.".into()),
            None,
            Some("epubcfi(/6/4!/4/2)".into()),
        )
        .unwrap();
        assert_eq!(dup.id, e1.id);

        // Different CFI in same book inserts a second encounter
        let e2 = add_vocab_word(
            &core,
            "b1".into(),
            "mortify".into(),
            "/ˈmɔːr.tɪ.faɪ/ verb. Humiliate.".into(),
            Some("She felt mortified.".into()),
            Some("Note 2".into()),
            Some("epubcfi(/6/8!/4/6)".into()),
        )
        .unwrap();
        assert_ne!(e2.id, e1.id);

        // Different book with no CFI falls back to context_sentence dedup
        let e3 = add_vocab_word(
            &core,
            "b2".into(),
            "mortify".into(),
            "/ˈmɔːr.tɪ.faɪ/ verb. Humiliate.".into(),
            Some("Utterly mortified on the landing.".into()),
            None,
            None,
        )
        .unwrap();
        let dup_ctx = add_vocab_word(
            &core,
            "b2".into(),
            "mortify".into(),
            "/ˈmɔːr.tɪ.faɪ/ verb. Humiliate.".into(),
            Some("Utterly mortified on the landing.".into()),
            None,
            None,
        )
        .unwrap();
        assert_eq!(dup_ctx.id, e3.id);

        // Different context_sentence when cfi is None inserts cleanly
        let e4 = add_vocab_word(
            &core,
            "b2".into(),
            "mortify".into(),
            "/ˈmɔːr.tɪ.faɪ/ verb. Humiliate.".into(),
            Some("Another mortifying scene.".into()),
            None,
            None,
        )
        .unwrap();
        assert_ne!(e4.id, e3.id);

        // check_vocab_lemma reports total across all books + passage-level match
        let hit_cfi = check_vocab_lemma(
            &core,
            "mortify".into(),
            Some("b1".into()),
            Some("epubcfi(/6/4!/4/2)".into()),
            None,
        )
        .unwrap();
        assert_eq!(
            hit_cfi,
            VocabLemmaCheck {
                total_count: 4,
                matches_this_passage: true,
            }
        );

        let miss_cfi = check_vocab_lemma(
            &core,
            "mortify".into(),
            Some("b1".into()),
            Some("epubcfi(/6/99!/4/2)".into()),
            None,
        )
        .unwrap();
        assert_eq!(
            miss_cfi,
            VocabLemmaCheck {
                total_count: 4,
                matches_this_passage: false,
            }
        );

        let hit_ctx = check_vocab_lemma(
            &core,
            "mortify".into(),
            Some("b2".into()),
            None,
            Some("Utterly mortified on the landing.".into()),
        )
        .unwrap();
        assert_eq!(
            hit_ctx,
            VocabLemmaCheck {
                total_count: 4,
                matches_this_passage: true,
            }
        );

        // Keep unrelated word intact when removing lemma
        add_vocab_word(
            &core,
            "b1".into(),
            "palimpsest".into(),
            "noun. Reused manuscript.".into(),
            None,
            None,
            None,
        )
        .unwrap();

        let removed = remove_vocab_lemma(&core, "MORTIFY".into()).unwrap();
        assert_eq!(removed, 4);

        let remaining = list_all_vocab_words(&core).unwrap();
        assert_eq!(remaining.len(), 1);
        assert_eq!(remaining[0].word, "palimpsest");
    }
}
