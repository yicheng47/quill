# 316 — Chats Infinite Scroll with Backend Pagination

GitHub issue: https://github.com/yicheng47/quill/issues/316

## Motivation

`list_all_chats` (`src-tauri/src/commands/chats.rs:150`) returns every chat in the database with no limit, and the Chats view holds the entire result in memory so it can do its own searching, grouping, and counting. The query is also heavier per row than it first appears — two correlated subqueries per chat, a `COUNT(*)` over `chat_messages` and a last-message content lookup:

```sql
SELECT c.id, …, b.title,
       (SELECT COUNT(*) FROM chat_messages WHERE chat_id = c.id),
       (SELECT content FROM chat_messages WHERE chat_id = c.id ORDER BY created_at DESC, rowid DESC LIMIT 1)
FROM chats c LEFT JOIN books b ON c.book_id = b.id
ORDER BY c.pinned DESC, c.updated_at DESC
```

Nothing bounds that, and the whole cost is paid on every mount of the view. Chat history only accumulates — every Explain, every Quote, every sidebar conversation — so this degrades quietly and continuously.

The Library already solved the same problem. `list_books` takes `search` / `cursor` / `limit` and returns `{ books, next_cursor, total }`; `useBooks` holds cursor state and exposes `loadMore`; `BookGrid`'s `LoadMoreSentinel` drives it from an `IntersectionObserver` with a 200px root margin; and `get_book_counts` serves the sidebar badges separately from the page. Chats should adopt that same shape rather than invent a second one.

## Scope

In scope:

- **Paginated `list_all_chats`.** Add `search`, `cursor`, and `limit` parameters and return a `ChatPage` — `{ chats, next_cursor, total }` — mirroring `BookPage`. Keyset cursor over the existing `(pinned DESC, updated_at DESC, id)` ordering, so the cursor stays stable as rows are added.
- **Backend search.** Today search is a client-side `title.toLowerCase().includes(q)` across the full in-memory array (`ChatsContent.tsx:17-21`). Under pagination that would only ever match already-loaded pages, which is worse than useless — it looks like a working search that silently misses results. Move it into the SQL `WHERE`, debounced from the frontend exactly as the books path does. Title-only, matching current behavior.
- **Backend counts.** The book filter dropdown renders a per-book chat count and an "All books" total (`ChatsContent.tsx:39-59`), both derived today by walking the full array. Neither is computable from a single page. Add a counts command following the `get_book_counts` precedent.
- **Flat list, grouping dropped.** Chats are currently grouped by book (`ChatsContent.tsx:28-38`) while sorted by `pinned DESC, updated_at DESC` — so a given book's chats are scattered throughout the ordering. Paginating that ordering fragments every group across page boundaries. The list becomes flat and recency-ordered, with the book name on each row. The book filter dropdown already covers "show me one book's chats", so the grouping affordance is not load-bearing.
- **Infinite scroll.** `useAllChats` gains cursor / `hasMore` / `loadingMore` state and a `loadMore` callback; the list renders the same sentinel pattern as `BookGrid`.

Out of scope:

- `list_chats(book_id)` — the reader sidebar's per-book list, naturally bounded by a single book's chats.
- `list_chat_messages` — also unbounded, but paginating *within* an open conversation is a different problem, with scroll-anchoring and streaming-append concerns that don't apply here. Deserves its own issue.
- Full-text search across message bodies. Search stays title-only.
- Any change to how chats are created, renamed, pinned, or deleted.

## Implementation Phases

1. **Backend — pagination.** `ChatPage` type, keyset cursor encode/decode over `(pinned, updated_at, id)`, `search` predicate, `limit` with a sensible default. Unit tests: page boundaries, cursor round-trip, a `search` that matches across a page boundary, stable ordering when a chat is touched mid-scroll.

2. **Backend — counts.** Total chats plus per-book counts in one command. Unit tests for the empty case and for chats whose book row is missing (the `LEFT JOIN` already tolerates this — "Unknown Book" in the UI).

3. **Frontend — hook.** `useAllChats` mirrors `useBooks`: cursor state, `loadMore`, `hasMore`, `loadingMore`, and a `refresh` that resets to the first page. Remove the client-side search filter and the count derivation.

4. **Frontend — list.** Flat recency-ordered rows with the book name per row, plus the load-more sentinel. Deleting or renaming a chat updates the loaded pages without a full refetch where practical.

5. **QA.** Exercise against a large chat history.

## Verification

- Opening Chats loads one page, and scrolling to the bottom appends the next without a visible stall.
- Search matches chats that were never loaded into the first page — the case that proves search moved server-side.
- The book filter dropdown's counts equal the true totals, not the count of loaded rows.
- Pinned chats still sort ahead of unpinned ones, across page boundaries.
- Creating, renaming, deleting, or pinning a chat leaves the list consistent without a full reload.
- A chat whose book row is missing still renders under "Unknown Book".
- The reader sidebar's per-book chat list is unchanged.
