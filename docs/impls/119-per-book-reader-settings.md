# Per-Book Reader Display Settings

## Context

Reader display settings (font, font size, line spacing, character spacing, word spacing, margins, theme, reading mode, brightness, page columns) are stored globally in the `settings` table. Changing any setting while reading one book affects all books.

Each book should have its own reader settings. When opening a book, use its saved settings if they exist, otherwise fall back to global defaults. The reader popover should persist to **that book only**.

## Approach

Add a `book_settings` table keyed on `(book_id, key)`, add backend commands for per-book get/set, and change the frontend to load/save per-book settings instead of global ones. Global settings remain as defaults for new books.

---

## Step 1: Database migration

**File: `src-tauri/migrations/007_book_settings.sql`**

```sql
CREATE TABLE IF NOT EXISTS book_settings (
  book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (book_id, key)
);
```

**File: `src-tauri/src/db.rs`**

Add entry `(7, include_str!("../migrations/007_book_settings.sql"))` to the `MIGRATIONS` array at line 14.

## Step 2: Backend commands for per-book settings

**File: `src-tauri/src/commands/settings.rs`**

Add two new commands following the existing patterns:

### `get_book_settings(book_id: String, db: State<Db>) -> AppResult<HashMap<String, String>>`

```sql
SELECT key, value FROM book_settings WHERE book_id = ?1
```

Returns all per-book overrides for the given book. No secrets involved — reader display settings are never sensitive.

### `set_book_settings_bulk(book_id: String, settings: HashMap<String, String>, db: State<Db>) -> AppResult<()>`

Loop through entries and upsert:

```sql
INSERT INTO book_settings (book_id, key, value) VALUES (?1, ?2, ?3)
ON CONFLICT(book_id, key) DO UPDATE SET value = ?3
```

No need for a single `set_book_setting` — the reader always saves all 10 settings at once via `set_settings_bulk`.

## Step 3: Register new commands

**File: `src-tauri/src/lib.rs`**

Add to the `generate_handler!` macro under the `// Settings` section (after line 88):

```rust
commands::settings::get_book_settings,
commands::settings::set_book_settings_bulk,
```

## Step 4: Frontend — load per-book settings with global fallback

**File: `src/pages/Reader.tsx`**

Change the settings loading effect (lines 264–279). Instead of only calling `getAllSettings()`, also invoke `get_book_settings` and merge:

```typescript
// Load both global and per-book settings
const [globalSettings, bookSettings] = await Promise.all([
  getAllSettings(),
  invoke<Record<string, string>>("get_book_settings", { bookId }),
]);
// Per-book overrides take precedence over global defaults
const s = { ...globalSettings, ...bookSettings };
```

The rest of the mapping logic (lines 265–277) stays the same — same keys, same parsing.

## Step 5: Frontend — persist to per-book settings

**File: `src/pages/Reader.tsx`**

Change the persist effect (lines 285–302). Replace the `set_settings_bulk` invoke with `set_book_settings_bulk`:

```typescript
invoke("set_book_settings_bulk", {
  bookId,
  settings: {
    reader_theme: theme,
    brightness: String(brightness),
    // ... same keys as today
  },
}).catch(() => {});
```

This is a one-line change — swap the command name and add `bookId` to the payload. Global settings are no longer written from the reader.

## Step 6: Backend unit tests

**File: `src-tauri/src/commands/settings.rs`**

Add tests following existing patterns (see `db.rs` test module):

1. **`test_book_settings_roundtrip`** — set bulk for a book, get back, verify values match
2. **`test_book_settings_isolation`** — set different values for two books, verify each returns its own
3. **`test_book_settings_cascade_delete`** — delete a book, verify its `book_settings` rows are gone

---

## Files to modify

| File | Change |
|------|--------|
| `src-tauri/migrations/007_book_settings.sql` | New migration: `book_settings` table |
| `src-tauri/src/db.rs` | Register migration 7 in `MIGRATIONS` array |
| `src-tauri/src/commands/settings.rs` | Add `get_book_settings` and `set_book_settings_bulk` commands + tests |
| `src-tauri/src/lib.rs` | Register new commands in `generate_handler!` |
| `src/pages/Reader.tsx` | Load from per-book with global fallback; persist to per-book |

## Verification

- **Unit tests:** Run `cargo test` — new tests for roundtrip, isolation, cascade delete
- **Manual test:**
  1. Open Book A, change font to Inter and font size to 32 → close reader
  2. Open Book B → should show global defaults (Georgia, 26px)
  3. Reopen Book A → should show Inter, 32px
  4. Change Book B to dark theme → Book A should remain unchanged
  5. Delete Book A → verify no orphaned rows in `book_settings` (cascade)
  6. Import a new book → should use global defaults (no per-book rows yet)
- **Edge case:** Existing users upgrading — no per-book rows exist, so all books fall back to global settings seamlessly. No data migration needed.
