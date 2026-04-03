# 25 — Collection Folders

**Status:** Planned
**GitHub Issue:** https://github.com/yicheng47/quill/issues/129

## Motivation

As users accumulate books in a single collection, finding specific titles becomes harder. Folders within a collection let users sub-organize books — e.g., a "CS" collection could have "Algorithms", "Systems", and "Networking" folders — without the overhead of creating entirely separate collections.

## Scope

### In Scope

- **Folders inside collections** — one level deep only (no nested folders)
- **Flexible book placement** — a book can be loose at the collection root, inside one or more folders, or both
- **CRUD for folders** — create, rename, delete folders within a collection
- **Drag-and-drop** — move books into/out of folders
- **Folder view in main content area** — when viewing a collection in Home, folders appear as visual groups or clickable cards; sidebar stays unchanged
- **Sort order** — folders are reorderable within a collection

### Out of Scope

- Nested folders (folders within folders)
- Folders outside of collections (top-level sidebar folders)
- AI-powered auto-sorting into folders (could be a future extension of #21)

## Data Model

### New table: `collection_folders`

| Column       | Type    | Notes                                    |
|-------------|---------|------------------------------------------|
| `id`        | TEXT PK | UUID                                     |
| `collection_id` | TEXT NOT NULL | FK → `collections(id)` ON DELETE CASCADE |
| `name`      | TEXT NOT NULL |                                          |
| `sort_order`| INTEGER NOT NULL | Default 0                               |
| `created_at`| TEXT NOT NULL | ISO 8601                                |

### New junction table: `collection_folder_books`

| Column    | Type | Notes                                         |
|-----------|------|-----------------------------------------------|
| `folder_id` | TEXT | FK → `collection_folders(id)` ON DELETE CASCADE |
| `book_id`   | TEXT | FK → `books(id)` ON DELETE CASCADE              |
| PK        |      | `(folder_id, book_id)`                         |

Books remain in `collection_books` for collection membership. `collection_folder_books` adds an optional folder assignment within that collection. Deleting a folder removes folder assignments but does not remove books from the collection.

## Implementation Phases

### Phase 1 — Backend

1. Add migration creating `collection_folders` and `collection_folder_books` tables
2. Add Tauri commands:
   - `list_collection_folders(collection_id)` → `Vec<CollectionFolder>`
   - `create_collection_folder(collection_id, name)` → `CollectionFolder`
   - `rename_collection_folder(id, name)`
   - `delete_collection_folder(id)` — removes folder + junction entries, books stay in collection
   - `reorder_collection_folders(ids: Vec<String>)`
   - `add_book_to_folder(folder_id, book_id)` — INSERT OR IGNORE
   - `remove_book_from_folder(folder_id, book_id)`
   - `list_books_in_folder(folder_id)` → `Vec<String>`
3. Unit tests for all commands

### Phase 2 — Frontend Hook

1. Add `useCollectionFolders(collectionId)` hook exposing:
   - `folders`, `refresh`, `create`, `rename`, `remove`, `reorder`, `addBook`, `removeBook`

### Phase 3 — UI (Main Content Area)

1. When viewing a collection in Home:
   - Show folder cards/sections above or among loose books
   - Click a folder to expand/navigate into it, showing its books
   - "Unfiled" section for books not in any folder
2. Folder management:
   - Create folder via "+" button or context menu within collection view
   - Rename/delete via right-click context menu on folder
   - Drag books into folders, drag out to remove from folder
3. Book context menu update:
   - When inside a collection view, add "Move to Folder" submenu listing folders
   - "Remove from Folder" option when viewing a folder

### Phase 4 — i18n

1. Add translation keys for all new UI strings in `en.json` and `zh.json`

## Verification

1. Create a collection, add books, create folders, move books between folders and root
2. Verify a book can exist in multiple folders and at root simultaneously
3. Delete a folder → books remain in collection
4. Delete a collection → folders and all junction entries cascade-delete
5. Reorder folders, verify persistence across app restart
6. Verify all strings are translated (en + zh)
