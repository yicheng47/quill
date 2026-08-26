# Impl Plan — 316: Chats Infinite Scroll with Backend Pagination

Spec: `docs/features/316-chats-pagination.md`. The reader sidebar commands `list_chats(book_id)` and `list_chat_messages` remain unchanged.

## Backend

- Add `ChatPage { chats, next_cursor, total }` and a shared `query_all_chats` helper. Accept optional title search, optional book filter, optional cursor, and a bounded page size through `list_all_chats`, following `list_books`.
- Encode the keyset cursor as JSON plus base64 so chat IDs and timestamps round-trip without delimiter ambiguity. The tuple is `(pinned DESC, updated_at DESC, id ASC)`; the SQL continuation predicate advances across pinned state, timestamp, and ID tie-breaks.
- Add migration 014 with a matching `(pinned DESC, updated_at DESC, id ASC)` index so SQLite can stop after the requested page instead of sorting the full chat table and evaluating both correlated message subqueries for every row.
- Apply title-only case-insensitive search in both the page query and its cursor-free total query, escaping SQL `LIKE` metacharacters so search retains literal substring semantics. Fetch `limit + 1` rows to determine `next_cursor`.
- Add `get_chat_counts`, returning the global total plus per-book `{ book_id, book_title, count }` rows ordered by count and title. Count from `chats LEFT JOIN books` so soft references to deleted/missing books remain represented.
- Add backend unit tests for page boundaries and cursor round-trip, search beyond the first page, stable continuation after a previously loaded chat is touched, pinned ordering across boundaries, empty counts, and missing-book counts.

## Frontend

- Expand `useAllChats(search, bookId)` to mirror `useBooks`: first-page loading, cursor state, `loadMore`, `hasMore`, `loadingMore`, `refresh`, total count, stale-response rejection, and local mutation helpers for delete and rename.
- Fetch chat counts independently through `get_chat_counts`; build the book filter from those backend totals instead of loaded chat pages.
- Debounce the search input by 250 ms and pass it to the backend. Pass the selected book ID as a backend filter so the dropdown still shows the complete matching list under pagination.
- Replace grouped rendering with one flat `(pinned, updated_at, id)` ordered list. Show the book title in every row, use `common.unknownBook` for missing rows, and append the same 200 px `IntersectionObserver` sentinel used by the library.
- Keep detail-view rename and delete operations reflected in the loaded page locally, then refresh counts only when deletion changes totals.

## Design Prompt

Keep the existing Chats page visual language and row density. Present a single recency-ordered stream instead of book sections, put the source book as quiet secondary metadata on every row, preserve search and book filtering in the header, and use an unobtrusive centered loading spinner when more rows are fetched near the bottom.

## Checks

Run `cargo test` and `cargo clippy -- -D warnings` in `src-tauri/`, then `npm test`, `npm run lint`, `npx tsc --noEmit`, and `npm run build`. Verify the spec checklist with pagination/search/count/order behavior covered by automated tests and the frontend loading/mutation states inspected in the final diff.
