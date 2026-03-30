# 21 — AI Auto-Sort Books into Collections

GitHub Issue: https://github.com/yicheng47/quill/issues/105

## Motivation

As a user's library grows, manually organizing books into collections becomes tedious. The app already has collections and AI infrastructure — combining them lets the AI analyze book metadata (title, author, description, genre) and automatically suggest or create collections, then sort books into them. This turns a manual chore into a one-click action.

## Scope

### In Scope

1. **AI-powered collection suggestions** — Given the user's library, the AI analyzes book metadata and proposes a set of collections with book assignments.
2. **Review before applying** — The user sees the AI's proposed sorting (collection names + which books go where) and can accept, edit, or reject before anything is written.
3. **Merge with existing collections** — If the user already has collections, the AI should be aware of them and can suggest adding books to existing collections or creating new ones.
4. **One book, multiple collections** — A book can belong to multiple collections (the junction table already supports this).
5. **Incremental sorting** — After importing new books, the user can re-run the sort to classify only unsorted books (books not in any collection).

### Out of Scope

- Automatic sorting on import (no background AI calls without user action).
- Smart/dynamic collections based on rules (e.g., "all books by Author X").
- Sorting based on reading content — only metadata is used (title, author, description, genre).

## UX Flow

1. User clicks an "Auto-sort" button (in the library toolbar or collections sidebar).
2. App sends book metadata + existing collections to the AI.
3. AI returns a structured response: a list of collections, each with assigned book IDs.
4. A review modal shows the proposed sorting — grouped by collection, with book covers/titles.
5. User can:
   - Accept all
   - Remove individual books from a proposed collection
   - Rename a proposed collection
   - Dismiss a proposed collection entirely
6. On confirm, collections are created (or matched to existing ones) and books are assigned.

## AI Prompt Design

The prompt should include:
- List of books with metadata: `{ id, title, author, description?, genre? }`
- List of existing collections: `{ id, name }`
- Instructions to return structured JSON:
  ```json
  {
    "collections": [
      {
        "name": "Science Fiction",
        "existing_collection_id": null,
        "book_ids": ["uuid1", "uuid2"]
      },
      {
        "name": "History",
        "existing_collection_id": "existing-uuid",
        "book_ids": ["uuid3"]
      }
    ]
  }
  ```
- Guidelines: prefer fewer, broader collections over many niche ones; respect existing collection names; a book can appear in multiple collections; use the user's UI language for collection names.

## Implementation Phases

### Phase 1: Backend Command

- Add a new Tauri command `ai_sort_collections(db, secrets, app)` that:
  1. Fetches all books (metadata only) and existing collections.
  2. Builds the AI prompt with structured book/collection data.
  3. Calls the configured AI provider (non-streaming, since we need structured JSON).
  4. Parses the JSON response into a typed struct.
  5. Returns the proposed sorting to the frontend.
- Handle errors: no AI configured, empty library, API failure, malformed response.
- Consider token limits: if the library is very large, batch or summarize.

### Phase 2: Review UI

- Add an "Auto-sort" button to the library/collections UI.
- Build a review modal showing proposed collections and their books.
- Allow the user to edit the proposal: rename collections, remove books, dismiss collections.
- On confirm, call existing `create_collection` and `add_book_to_collection` commands.

### Phase 3: Incremental Sorting

- Add an option to sort only books not currently in any collection.
- Filter the book list sent to the AI to only include unsorted books.
- Still include existing collections in the prompt so the AI can assign to them.

## Verification

- [ ] AI returns valid structured JSON with collection names and book assignments.
- [ ] Review modal displays proposed sorting with book covers and titles.
- [ ] User can accept, edit, or reject the proposal.
- [ ] Existing collections are reused when the AI suggests matching names.
- [ ] New collections are created correctly with proper sort_order.
- [ ] Books are assigned to collections on confirm.
- [ ] Incremental sort only processes books not in any collection.
- [ ] Works with all supported AI providers (Anthropic, OpenAI, Ollama, etc.).
- [ ] Handles edge cases: empty library, no AI configured, API error, no genre/description metadata.
- [ ] Collection names use the user's UI language.
