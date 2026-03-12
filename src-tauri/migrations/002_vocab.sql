CREATE TABLE IF NOT EXISTS vocab_words (
  id TEXT PRIMARY KEY,
  book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  word TEXT NOT NULL,
  definition TEXT NOT NULL,
  context_sentence TEXT,
  cfi TEXT,
  mastery TEXT NOT NULL DEFAULT 'new',
  review_count INTEGER NOT NULL DEFAULT 0,
  next_review_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_vocab_book_id ON vocab_words(book_id);
CREATE INDEX IF NOT EXISTS idx_vocab_mastery ON vocab_words(mastery);
