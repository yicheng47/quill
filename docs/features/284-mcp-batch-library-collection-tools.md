# 284 - MCP Batch Library and Collection Tools

GitHub issue: https://github.com/yicheng47/quill/issues/284

## Motivation

Quill's MCP server currently exposes single-item write tools for importing/deleting books and adding/removing collection memberships. That is awkward for automation clients: importing a directory, deleting a set of books, or organizing a collection requires many tool calls and gives the client no single structured result for partial success.

The MCP surface should be batch-first for library and collection writes, and collection reads should include a direct way to fetch the full book records in a collection.

## Scope

In scope:

- Add a batch-first MCP library import tool that accepts multiple local `.epub` / `.pdf` file paths and returns per-path results.
- Add a batch-first MCP library delete tool that accepts multiple book IDs and returns per-book results.
- Add batch-first MCP collection membership tools for adding multiple books to a collection and removing multiple books from a collection.
- Add an MCP read tool for retrieving full book records from a collection, using the same MCP book projection as `list_books` / `get_book`.
- Preserve MCP write access gating through `require_sync`.
- Preserve sync events and UI notifications for imported books, deleted books, and updated collections.
- Return structured results that distinguish success, already-present/no-op, not found, unsupported format, and operation errors.

Out of scope:

- Recursive filesystem import or directory walking. Clients pass explicit file paths.
- New frontend UI for batch import/delete.
- Cover binary retrieval over MCP.
- Changing collection create/rename/delete semantics.

## Tool Interface Direction

Use batch-first canonical tool names: `import_books`, `delete_books`, `add_books_to_collection`, `remove_books_from_collection`, and `get_collection_books`.

The current single-item MCP tools `add_book`, `delete_book`, `add_book_to_collection`, and `remove_book_from_collection` should not remain as equal peers long-term, because that makes the tool surface noisier and encourages clients to choose the slower shape. Preferred implementation is to replace the public MCP registry with the batch tools and let one-item calls pass a one-element array.

If we want to avoid a breaking MCP change, keep the existing single-item tools as temporary compatibility wrappers implemented in terms of the batch tools, mark their descriptions as deprecated, and remove them in a later release.

## Implementation Phases

1. Define schemas and response DTOs for all batch tools.
   - `import_books`: `{ file_paths: string[] }` returns `{ imported: McpBook[], results: BatchItemResult[] }`.
   - `delete_books`: `{ book_ids: string[] }` returns `{ deleted: string[], results: BatchItemResult[] }`.
   - `add_books_to_collection` / `remove_books_from_collection`: `{ collection_id: string, book_ids: string[] }` returns `{ collection_id, changed: string[], results: BatchItemResult[] }`.
   - `get_collection_books`: `{ collection_id: string, filter?, search? }` returns `McpBook[]`.

2. Implement batch library import/delete on top of existing helpers.
   - Reuse `books::do_import_epub`, `books::do_import_pdf`, and `books::do_delete_book`.
   - Notify `books` for each created/deleted book, or once with a collection-safe aggregate if the notification layer gains aggregate support.
   - Continue after per-item failures and report them in the result unless the top-level request itself is invalid.

3. Implement batch collection membership tools.
   - Reuse collection membership helpers or add DB helpers that process a vector with consistent sync writes.
   - Treat duplicate existing membership and missing membership removal as no-op results, not hard failures.
   - Notify the collection once after a batch that changes membership.

4. Add `get_collection_books`.
   - Reuse the existing book query path with `collection_id` filtering instead of returning only IDs.
   - Keep file paths relative and omit cover blobs, matching `list_books`.

5. Update MCP registry and compatibility policy.
   - Register the new tools in `QuillMcpHandler::tool_router`.
   - Update `tool_router_registers_all_tools`.
   - Either remove the single-item tools from the registry or convert them into deprecated wrappers, based on the final compatibility decision.

## Verification

- MCP write access disabled: all batch write tools return the existing clear write-gating error.
- `import_books` imports mixed EPUB/PDF inputs and returns per-path failures for unsupported or missing files without losing successful imports.
- `delete_books` deletes multiple books, removes associated data and files through the existing delete helper, and reports missing IDs cleanly.
- `add_books_to_collection` and `remove_books_from_collection` update memberships for multiple books and report no-op duplicates/removals clearly.
- `get_collection_books` returns full MCP book records for a collection and does not include books outside the collection.
- MCP tool registry tests reflect the final tool surface.
- Relevant Rust tests pass for MCP server/tools and book/collection command helpers.
