# PDF Support — Implementation Plan

## Architecture Summary

foliate-js already handles PDF rendering: `view.js` detects `%PDF-` magic bytes, routes to `pdf.js` (vendored PDF.js). The `makePDF` function returns a book object with the same interface as EPUB (sections, metadata, toc, getCover). Same events (`relocate`, `create-overlay`, `draw-annotation`) work for PDFs.

Main work: (1) backend accepts PDFs with frontend-extracted metadata, (2) frontend import flow detects format and branches, (3) Reader passes correct filename so foliate-js routes to PDF, (4) minor display adjustments.

---

## Phase 1: Backend Foundation

### Files

| File | Action |
|------|--------|
| `src-tauri/migrations/004_pdf_support.sql` | CREATE |
| `src-tauri/src/db.rs` | MODIFY (add migration) |
| `src-tauri/src/commands/books.rs` | MODIFY (add `format` to Book, add `import_pdf`) |
| `src-tauri/src/lib.rs` | MODIFY (register command) |

### Details

**`004_pdf_support.sql`:**
```sql
ALTER TABLE books ADD COLUMN format TEXT NOT NULL DEFAULT 'epub';
```

**`db.rs`** — Add after schema3 block:
```rust
let schema4 = include_str!("../migrations/004_pdf_support.sql");
conn.execute_batch(schema4)?;
```

**`books.rs`** — Add `pub format: String` to `Book` struct. Update all SELECT queries and row mappings to include `format` column. Add `import_pdf` command:
```rust
#[tauri::command]
pub async fn import_pdf(
    source_path: String,
    title: String,
    author: Option<String>,
    description: Option<String>,
    pages: i32,
    cover_data: Option<Vec<u8>>,
    db: State<'_, Db>,
) -> AppResult<Book>
```
- Generates UUID, copies PDF to `books/{uuid}.pdf`
- Saves cover bytes to `covers/{uuid}.png` if provided
- INSERT with `format = 'pdf'`

**`lib.rs`** — Add `commands::books::import_pdf` to handler list.

---

## Phase 2: Frontend Import Flow

### Files

| File | Action |
|------|--------|
| `src/hooks/useBooks.ts` | MODIFY (add `format` to Book, update file filter) |
| `src/utils/pdfMetadata.ts` | CREATE |
| `src/pages/Home.tsx` | MODIFY (accept .pdf in drag-drop, branch import) |

### Details

**`useBooks.ts`** — Add `format: 'epub' | 'pdf'` to Book interface. Update `importBookDialog` file filter to accept `["epub", "pdf"]`. Branch import by extension.

**`pdfMetadata.ts`** — New utility:
1. Fetch PDF via `convertFileSrc(filePath)`, create `File` blob
2. Call foliate-js `makeBook(file)` to get book object
3. Read `book.metadata` for title/author/description
4. Read `book.sections.length` for page count
5. Call `book.getCover()` for first-page thumbnail → `Uint8Array`
6. Fallback: parse filename if no embedded title
7. Returns `{ title, author, description, pages, coverData }`

**`Home.tsx`** — Accept `.pdf` in drag-drop filter. Branch import call by extension. Update UI text ("EPUB" → "EPUB & PDF", "Import EPUB" → "Import Book").

---

## Phase 3: Reader Adjustments

### Files

| File | Action |
|------|--------|
| `src/pages/Reader.tsx` | MODIFY |
| `src/components/ReaderSettings.tsx` | MODIFY |

### Details

**`Reader.tsx`:**
- Fix hardcoded `"book.epub"` filename — use `book.${book.format === 'pdf' ? 'pdf' : 'epub'}` so foliate-js routes correctly
- Format-aware header subtitle: "Page X of Y" for PDFs, "Chapter X of Y" for EPUBs
- No changes needed for progress bar — `relocate` event provides `fraction` and `location` for both formats
- No changes for bookmarks/highlights — foliate-js generates CFI-like position strings for PDFs via `CFI.fake.fromIndex()`

**`ReaderSettings.tsx`:**
- Accept optional `bookFormat` prop
- Hide font/spacing controls when `bookFormat === 'pdf'` (PDF renders as canvas, not styled HTML)
- Keep theme controls

---

## Phase 4: AI Integration

### Files

| File | Action |
|------|--------|
| `src/pages/Reader.tsx` | MODIFY |
| `src/components/AiPanel.tsx` | MODIFY |

### Details

**`Reader.tsx`** — Include page number in AI context for PDFs:
```ts
setAiContext({
  text: contextMenu.text,
  cfi: contextMenu.cfiRange,
  page: book.format === 'pdf' ? pageInfo?.current : undefined,
});
```

**`AiPanel.tsx`** — Update context type to include optional `page?: number`. Display "Page X" for PDFs in context references.

---

## What Does NOT Need Changes

- **Bookmarks/Highlights** — foliate-js generates CFI-like strings for PDFs. Existing `cfi`/`cfi_range` columns work as-is.
- **`tauri.conf.json`** — `$APPDATA/**` scope already covers `books/*.pdf`.
- **`Cargo.toml`** — No new Rust deps (metadata extraction on frontend).
- **`epub.rs`** — Only used for EPUB. `import_pdf` bypasses it.
- **`Sidebar.tsx`** — Books are books regardless of format.

---

## Phase Dependencies

```
Phase 1 (Backend)
  │
  v
Phase 2 (Import Flow) ──── Phase 3 (Reader)
  │                           │
  └───────────┬───────────────┘
              v
        Phase 4 (AI)
```

Phases 2 and 3 can run in parallel once Phase 1 is done.
