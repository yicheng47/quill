-- Migration 009 — normalize timestamps across every synced table.
--
-- Converts every TEXT RFC-3339 timestamp to INTEGER unix milliseconds and
-- adds `updated_at` to tables that lacked it. After this migration every
-- synced table has: `created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL`.
--
-- Mechanics: SQLite's 12-step table-rebuild pattern. CREATE TABLE <x>_new with
-- the final schema, INSERT INTO <x>_new SELECT ... FROM <x> converting
-- timestamps to unix millis in SQL, DROP <x>, RENAME <x>_new → <x>. One
-- transaction; any failure rolls back the whole thing leaving the DB
-- byte-identical to pre-migration.
--
-- Foreign keys are toggled OFF around the rebuild because rebuilding a parent
-- table (books, collections) would otherwise cascade-delete child rows via
-- ON DELETE CASCADE. PRAGMA foreign_keys can only change outside a
-- transaction, hence the OFF → BEGIN → … → COMMIT → ON sequence. Child tables
-- are rebuilt after their parents so their FK declarations resolve.
--
-- Timestamp conversion formula:
--   CAST(strftime('%s', ts) AS INTEGER) * 1000
--     + CAST(substr(strftime('%f', ts), -3) AS INTEGER)
-- = integer unix seconds × 1000 + the 3-digit millisecond tail from the
-- SS.SSS fractional-seconds output. This is exact at millisecond precision
-- for every format chrono's `to_rfc3339()` emits (bare / .SSS / nanoseconds
-- / Z suffix / +HH:MM suffix). Nanosecond digits beyond millisecond are
-- silently truncated, which matches the target precision. Using julianday()
-- would lose ±1ms to double-precision float rounding at this magnitude.
--
-- On malformed input, strftime() returns NULL → CAST(NULL AS INTEGER) = NULL
-- → INSERT into the NOT NULL column fails → transaction rolls back. Safe by
-- construction; the user's DB is never left in an intermediate state.
--
-- See `docs/impls/31-sync.md` §"Schema normalization" for the design rationale.

PRAGMA foreign_keys = OFF;

BEGIN;

-- ---------------------------------------------------------------------------
-- books (parent — rebuild before any table that references it)
-- ---------------------------------------------------------------------------
CREATE TABLE books_new (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  author TEXT NOT NULL,
  description TEXT,
  cover_path TEXT,
  file_path TEXT NOT NULL,
  genre TEXT,
  pages INTEGER,
  format TEXT NOT NULL DEFAULT 'epub',
  status TEXT NOT NULL DEFAULT 'unread',
  progress INTEGER NOT NULL DEFAULT 0,
  current_cfi TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
INSERT INTO books_new (id, title, author, description, cover_path, file_path,
                      genre, pages, format, status, progress, current_cfi,
                      created_at, updated_at)
SELECT id, title, author, description, cover_path, file_path,
       genre, pages, format, status, progress, current_cfi,
       CAST(strftime('%s', created_at) AS INTEGER) * 1000
         + CAST(substr(strftime('%f', created_at), -3) AS INTEGER),
       CAST(strftime('%s', updated_at) AS INTEGER) * 1000
         + CAST(substr(strftime('%f', updated_at), -3) AS INTEGER)
FROM books;
DROP TABLE books;
ALTER TABLE books_new RENAME TO books;

-- ---------------------------------------------------------------------------
-- collections (parent of collection_books — rebuild before it)
-- ---------------------------------------------------------------------------
CREATE TABLE collections_new (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
INSERT INTO collections_new (id, name, sort_order, created_at, updated_at)
SELECT id, name, sort_order,
       CAST(strftime('%s', created_at) AS INTEGER) * 1000
         + CAST(substr(strftime('%f', created_at), -3) AS INTEGER),
       CAST(strftime('%s', created_at) AS INTEGER) * 1000
         + CAST(substr(strftime('%f', created_at), -3) AS INTEGER)
FROM collections;
DROP TABLE collections;
ALTER TABLE collections_new RENAME TO collections;

-- ---------------------------------------------------------------------------
-- bookmarks (child of books)
-- ---------------------------------------------------------------------------
CREATE TABLE bookmarks_new (
  id TEXT PRIMARY KEY,
  book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  cfi TEXT NOT NULL,
  label TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
INSERT INTO bookmarks_new (id, book_id, cfi, label, created_at, updated_at)
SELECT id, book_id, cfi, label,
       CAST(strftime('%s', created_at) AS INTEGER) * 1000
         + CAST(substr(strftime('%f', created_at), -3) AS INTEGER),
       CAST(strftime('%s', created_at) AS INTEGER) * 1000
         + CAST(substr(strftime('%f', created_at), -3) AS INTEGER)
FROM bookmarks;
DROP TABLE bookmarks;
ALTER TABLE bookmarks_new RENAME TO bookmarks;

-- ---------------------------------------------------------------------------
-- highlights (child of books)
-- ---------------------------------------------------------------------------
CREATE TABLE highlights_new (
  id TEXT PRIMARY KEY,
  book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  cfi_range TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT 'yellow',
  note TEXT,
  text_content TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
INSERT INTO highlights_new (id, book_id, cfi_range, color, note, text_content,
                            created_at, updated_at)
SELECT id, book_id, cfi_range, color, note, text_content,
       CAST(strftime('%s', created_at) AS INTEGER) * 1000
         + CAST(substr(strftime('%f', created_at), -3) AS INTEGER),
       CAST(strftime('%s', created_at) AS INTEGER) * 1000
         + CAST(substr(strftime('%f', created_at), -3) AS INTEGER)
FROM highlights;
DROP TABLE highlights;
ALTER TABLE highlights_new RENAME TO highlights;

-- ---------------------------------------------------------------------------
-- vocab_words (child of books; next_review_at stays nullable)
-- ---------------------------------------------------------------------------
CREATE TABLE vocab_words_new (
  id TEXT PRIMARY KEY,
  book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  word TEXT NOT NULL,
  definition TEXT NOT NULL,
  context_sentence TEXT,
  cfi TEXT,
  mastery TEXT NOT NULL DEFAULT 'new',
  review_count INTEGER NOT NULL DEFAULT 0,
  next_review_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
INSERT INTO vocab_words_new (id, book_id, word, definition, context_sentence, cfi,
                             mastery, review_count, next_review_at,
                             created_at, updated_at)
SELECT id, book_id, word, definition, context_sentence, cfi,
       mastery, review_count,
       CASE WHEN next_review_at IS NULL THEN NULL
            ELSE CAST(strftime('%s', next_review_at) AS INTEGER) * 1000
                   + CAST(substr(strftime('%f', next_review_at), -3) AS INTEGER)
       END,
       CAST(strftime('%s', created_at) AS INTEGER) * 1000
         + CAST(substr(strftime('%f', created_at), -3) AS INTEGER),
       CAST(strftime('%s', updated_at) AS INTEGER) * 1000
         + CAST(substr(strftime('%f', updated_at), -3) AS INTEGER)
FROM vocab_words;
DROP TABLE vocab_words;
ALTER TABLE vocab_words_new RENAME TO vocab_words;
CREATE INDEX IF NOT EXISTS idx_vocab_book_id ON vocab_words(book_id);
CREATE INDEX IF NOT EXISTS idx_vocab_mastery ON vocab_words(mastery);

-- ---------------------------------------------------------------------------
-- collection_books (junction; no timestamps today — backfill with migration time)
-- ---------------------------------------------------------------------------
CREATE TABLE collection_books_new (
  collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (collection_id, book_id)
);
INSERT INTO collection_books_new (collection_id, book_id, created_at, updated_at)
SELECT collection_id, book_id,
       CAST(strftime('%s', 'now') AS INTEGER) * 1000
         + CAST(substr(strftime('%f', 'now'), -3) AS INTEGER),
       CAST(strftime('%s', 'now') AS INTEGER) * 1000
         + CAST(substr(strftime('%f', 'now'), -3) AS INTEGER)
FROM collection_books;
DROP TABLE collection_books;
ALTER TABLE collection_books_new RENAME TO collection_books;

-- ---------------------------------------------------------------------------
-- chats (soft-reference to books — no FK declared, but rebuild anyway)
-- ---------------------------------------------------------------------------
CREATE TABLE chats_new (
  id TEXT PRIMARY KEY,
  book_id TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT 'New chat',
  model TEXT,
  pinned INTEGER NOT NULL DEFAULT 0,
  metadata TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
INSERT INTO chats_new (id, book_id, title, model, pinned, metadata,
                       created_at, updated_at)
SELECT id, book_id, title, model, pinned, metadata,
       CAST(strftime('%s', created_at) AS INTEGER) * 1000
         + CAST(substr(strftime('%f', created_at), -3) AS INTEGER),
       CAST(strftime('%s', updated_at) AS INTEGER) * 1000
         + CAST(substr(strftime('%f', updated_at), -3) AS INTEGER)
FROM chats;
DROP TABLE chats;
ALTER TABLE chats_new RENAME TO chats;
CREATE INDEX IF NOT EXISTS idx_chat_book_id ON chats(book_id);

-- ---------------------------------------------------------------------------
-- chat_messages (soft-reference to chats)
-- ---------------------------------------------------------------------------
CREATE TABLE chat_messages_new (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  context TEXT,
  metadata TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
INSERT INTO chat_messages_new (id, chat_id, role, content, context, metadata,
                               created_at, updated_at)
SELECT id, chat_id, role, content, context, metadata,
       CAST(strftime('%s', created_at) AS INTEGER) * 1000
         + CAST(substr(strftime('%f', created_at), -3) AS INTEGER),
       CAST(strftime('%s', created_at) AS INTEGER) * 1000
         + CAST(substr(strftime('%f', created_at), -3) AS INTEGER)
FROM chat_messages;
DROP TABLE chat_messages;
ALTER TABLE chat_messages_new RENAME TO chat_messages;
CREATE INDEX IF NOT EXISTS idx_chat_msg_chat_id ON chat_messages(chat_id);

-- ---------------------------------------------------------------------------
-- translations (soft-reference to books)
-- ---------------------------------------------------------------------------
CREATE TABLE translations_new (
  id TEXT PRIMARY KEY,
  book_id TEXT NOT NULL,
  source_text TEXT NOT NULL,
  translated_text TEXT NOT NULL,
  target_language TEXT NOT NULL,
  cfi TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
INSERT INTO translations_new (id, book_id, source_text, translated_text,
                              target_language, cfi, created_at, updated_at)
SELECT id, book_id, source_text, translated_text, target_language, cfi,
       CAST(strftime('%s', created_at) AS INTEGER) * 1000
         + CAST(substr(strftime('%f', created_at), -3) AS INTEGER),
       CAST(strftime('%s', created_at) AS INTEGER) * 1000
         + CAST(substr(strftime('%f', created_at), -3) AS INTEGER)
FROM translations;
DROP TABLE translations;
ALTER TABLE translations_new RENAME TO translations;
CREATE INDEX IF NOT EXISTS idx_translations_book ON translations(book_id);

COMMIT;

PRAGMA foreign_keys = ON;
