CREATE TABLE IF NOT EXISTS book_settings (
  book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (book_id, key)
);
