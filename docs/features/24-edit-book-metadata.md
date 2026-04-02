# 24 — Edit Book Metadata

**GitHub Issue:** [#125](https://github.com/yicheng47/quill/issues/125)

## Motivation

EPUB files often ship with incorrect, incomplete, or missing metadata — wrong author names, garbled titles, or generic placeholders. Users currently have no way to fix this within Quill, forcing them to use external tools or live with bad data in their library. Letting users edit book title and author directly in Quill keeps the library clean without leaving the app.

## Scope

### In scope

- Edit **title** and **author** fields for any book in the library.
- Persist edits in the local database (override layer — original metadata preserved).
- Surface the edit UI from the book detail / context menu in the Home library view.
- Reflect updated metadata immediately across library grid, reader title bar, and anywhere else the fields appear.

### Out of scope (future)

- Editing other metadata fields (publisher, series, description, cover image, tags).
- Writing changes back into the EPUB file itself.
- Batch editing multiple books at once.

## Implementation Phases

### Phase 1 — Backend: metadata override storage

1. Add a migration: `books` table gets nullable `title_override` and `author_override` columns.
2. Add Tauri command `update_book_metadata(id, title, author)` that writes overrides.
3. Update book query logic: return `COALESCE(title_override, title)` and `COALESCE(author_override, author)` so overrides take precedence transparently.
4. Unit tests for the new command and COALESCE behavior.

### Phase 2 — Frontend: edit metadata UI

1. Add an "Edit Metadata" action to the book context menu (right-click / three-dot menu) on the Home page.
2. On click, open a modal/popover with two text fields: **Title** and **Author**, pre-filled with current values.
3. Save button calls `update_book_metadata`; cancel dismisses without changes.
4. On save, refresh the book list so updated metadata appears immediately.
5. i18n keys for all new strings.

### Phase 3 — Reader integration

1. If the reader title bar or any reader UI shows book title/author, ensure it reads from the same COALESCE'd values.
2. No separate editing UI in the reader — edits happen from the library view.

## Verification

- [ ] Edit title only → library shows new title, author unchanged.
- [ ] Edit author only → library shows new author, title unchanged.
- [ ] Edit both → both update.
- [ ] Cancel without saving → no changes.
- [ ] Close and reopen app → overrides persist.
- [ ] Original EPUB metadata is never modified.
- [ ] Reader title bar reflects overrides.
