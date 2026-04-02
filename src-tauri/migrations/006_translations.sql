CREATE TABLE IF NOT EXISTS translations (
    id TEXT PRIMARY KEY,
    book_id TEXT NOT NULL,
    source_text TEXT NOT NULL,
    translated_text TEXT NOT NULL,
    target_language TEXT NOT NULL,
    cfi TEXT,
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_translations_book
    ON translations (book_id);
