# 248 — Backend Pagination for Book List

PR: https://github.com/yicheng47/quill/pull/248

## Problem

`list_books` returns all books at once. With 329+ books, this means:
- Large IPC payload on every filter/search change
- 329 cover images hit Tauri's asset protocol simultaneously
- On synced devices with iCloud covers, this hangs the app

## Solution

Cursor-based pagination. The backend returns one page at a time (default 20 books). The frontend renders the first page immediately and loads more on scroll.

## Backend Changes

### `list_books` command

Current signature:
```rust
fn list_books(filter: Option<String>, search: Option<String>, db: State<Db>) -> AppResult<Vec<Book>>
```

New signature:
```rust
fn list_books(
    filter: Option<String>,
    search: Option<String>,
    cursor: Option<String>,  // opaque cursor (book id from last page)
    limit: Option<usize>,    // default 20
    db: State<Db>,
) -> AppResult<BookPage>
```

Response:
```rust
#[derive(Serialize)]
struct BookPage {
    books: Vec<Book>,
    next_cursor: Option<String>,  // null = no more pages
    total: usize,                 // total count for the filter (for "All Books (329)")
}
```

### SQL query

```sql
SELECT ... FROM books
WHERE (filter conditions)
  AND (search conditions)
  AND updated_at < ?cursor_updated_at   -- cursor position
ORDER BY updated_at DESC
LIMIT ?limit + 1                        -- fetch one extra to know if there's a next page
```

The cursor encodes the `updated_at` + `id` of the last book in the previous page (for stable pagination when timestamps collide). Using `updated_at DESC` matches the current default sort order.

The +1 trick: fetch 21 rows, return 20. If 21 came back, there's a next page — set `next_cursor` to the 20th book's position. If ≤20 came back, `next_cursor = null`.

### Total count

A separate `SELECT COUNT(*)` with the same filter/search conditions. Cached per filter change, not per page fetch.

## Frontend Changes

### `useBooks` hook

```typescript
interface UseBooks {
  books: Book[];
  total: number;
  loading: boolean;
  loadMore: () => void;
  hasMore: boolean;
  refresh: () => void;
}
```

- `books` accumulates across pages (page 1 + page 2 + ...)
- `loadMore()` fetches the next page using the cursor
- `refresh()` resets to page 1 (filter/search change)
- `hasMore` is true when `next_cursor` is not null

### BookGrid / BookList

Add a "load more" trigger at the bottom — either:
- IntersectionObserver on a sentinel element (loads automatically on scroll)
- Or a simple "Load more" button

### Filter / search changes

When filter or search changes, reset to page 1 (clear accumulated books, fetch fresh).

### Sidebar counts

The `total` field from the first page response drives the count badges ("All Books 329", "Currently Reading 4"). No separate query needed.

## Migration

None — this is a query-level change, no schema modification.

## Verification

- Library with 329 books → first 20 render immediately
- Scroll down → next 20 load seamlessly
- Switch filter → resets to page 1 of new filter
- Search → resets to page 1 with search results
- Sidebar counts still accurate
- Synced device with iCloud covers → only 20 asset loads at a time, no hang
