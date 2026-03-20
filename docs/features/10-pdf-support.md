# PDF Support

**Version:** 0.1
**Date:** March 20, 2026
**Status:** Design

---

## 1. Motivation

Quill only supports EPUB files. This is a significant limitation — PDFs are by far the most common document format for academic papers, textbooks, technical manuals, and professional documents. The primary target audience (students, researchers, professionals) works with PDFs daily.

Adding PDF support transforms Quill from "an EPUB reader with AI" to "a reading app with AI" — a much larger addressable market and a much easier pitch.

---

## 2. What Already Exists

| Layer | What's built | Where |
|-------|-------------|-------|
| foliate-js PDF renderer | `pdf.js` — implements foliate's book interface using Mozilla PDF.js | `dist/foliate-js/pdf.js` |
| PDF.js library | v5.5.207 vendored with worker, CMaps, standard fonts | `dist/foliate-js/vendor/pdfjs/` |
| File type detection | `makeBook()` in `view.js` checks magic bytes (`%PDF-`) and routes to PDF renderer | `dist/foliate-js/view.js:13-18, 106-109` |
| PDF rendering | Canvas + text layer (selectable text) + annotation layer (links) per page | `dist/foliate-js/pdf.js` |
| PDF metadata | Title, author, description, subject, publisher extracted from PDF info dict | `dist/foliate-js/pdf.js` |
| PDF TOC | Outlines extracted as nested TOC entries | `dist/foliate-js/pdf.js` |
| PDF layout | `pre-paginated` (fixed layout), each page is a section | `dist/foliate-js/pdf.js` |

**What's missing:**
- Backend: `import_book` only handles EPUB files (uses `epub` crate for metadata)
- Backend: No PDF metadata extraction in Rust
- Database: No `format` column to distinguish book types
- Frontend: Import dialog only accepts `.epub`
- Frontend: Position tracking assumes CFI (EPUB-specific)
- Frontend: Cover extraction for PDFs during import
- Frontend: Page-count extraction for PDFs

---

## 3. Feature Design

### 3.1 Import Flow

**Approach:** Extract PDF metadata on the frontend using foliate-js, send it to the backend along with the file. This avoids pulling in a heavy Rust PDF crate and reuses what foliate-js already does.

**Flow:**
1. User drops or selects a `.pdf` file (import dialog accepts both `.epub` and `.pdf`)
2. Frontend loads the file with foliate-js `makeBook()` to extract metadata:
   - Title, author, description (from PDF info dict)
   - Page count (from PDF.js `numPages`)
   - Cover image (render first page as thumbnail blob)
3. Frontend calls a new `import_pdf` command with:
   - Source file path
   - Extracted metadata (title, author, description, page count)
   - Cover image bytes
4. Backend copies the PDF to `books/{uuid}.pdf`, saves cover, inserts DB record with `format = 'pdf'`

**Fallback metadata:** If the PDF has no embedded title/author (common for scanned documents), use the filename as the title and leave author empty.

### 3.2 Reading Experience

The reading experience should be nearly identical to EPUB. foliate-js handles the rendering — the main differences are in position tracking and navigation.

**What works automatically:**
- Page rendering (canvas + text layer)
- Text selection
- TOC navigation (from PDF outlines)
- Zoom / layout (foliate-js handles pre-paginated layout)
- Theme application (foliate-js applies styles)

**What needs adjustment:**
- Progress tracking uses page numbers instead of CFI
- Page display shows "Page 12 of 340" instead of chapter-based progress
- Bookmarks reference page numbers instead of CFI ranges

### 3.3 Position & Progress Tracking

| Concept | EPUB | PDF |
|---------|------|-----|
| Position | CFI string (`epubcfi(/6/4!/4/2/1:0)`) | JSON: `{"page": 12}` |
| Progress | Percentage from CFI fraction | `current_page / total_pages` |
| Bookmark | CFI range | `{"page": 12}` |
| Highlight | CFI range + text | Page number + text (CFI range from foliate-js if available) |

The existing `current_cfi` column will store a JSON string for PDFs. The frontend detects the book format and parses accordingly.

### 3.4 Highlights & Bookmarks

foliate-js provides a unified annotation interface across formats. The `create-overlay` and `draw-annotation` events work the same way — the underlying position format just differs. Store whatever position reference foliate-js provides (it uses its own internal CFI-like references even for PDFs).

### 3.5 AI Context

When the user selects text and sends it to AI, the flow is the same:
- Selected text is captured via `doc.getSelection().toString()`
- Position is captured via `view.getCFI()` (foliate-js provides this for PDFs too)
- Context message sent to AI includes the selected passage
- The only change: metadata stores page number alongside the position reference for display purposes

---

## 4. Backend Changes

### 4.1 Database Migration (`004_pdf_support.sql`)

```sql
-- Add format column to books table
ALTER TABLE books ADD COLUMN format TEXT NOT NULL DEFAULT 'epub';
```

### 4.2 New Command: `import_pdf`

```rust
#[tauri::command]
pub fn import_pdf(
    source_path: String,
    title: String,
    author: Option<String>,
    description: Option<String>,
    pages: i32,
    cover_data: Option<Vec<u8>>,
    db: State<'_, Db>,
    app: AppHandle,
) -> AppResult<Book>
```

- Generates UUID, copies PDF to `books/{uuid}.pdf`
- Saves cover image if provided
- Inserts book record with `format = 'pdf'`

### 4.3 Modify Existing Commands

| Command | Change |
|---------|--------|
| `import_book` | Rename to `import_epub` for clarity, or detect format and branch |
| `list_books` | Include `format` in returned `Book` struct |
| `get_book` | Include `format` in returned `Book` struct |
| `update_reading_progress` | No change needed — already stores CFI as optional string |

### 4.4 Book Struct Update

```rust
pub struct Book {
    // ... existing fields ...
    pub format: String, // "epub" or "pdf"
}
```

---

## 5. Frontend Changes

### Files to modify:

| File | Change |
|------|--------|
| `src/pages/Home.tsx` | Accept `.pdf` in import dialog file filter |
| `src/pages/Reader.tsx` | Detect format, adjust progress display (page-based vs CFI-based), pass format to child components |
| `src/hooks/useBooks.ts` | Handle `import_pdf` command, include `format` in Book type |
| `src/components/AiPanel.tsx` | Display page number in context reference for PDFs |
| `src/components/BookmarksPanel.tsx` | Show page number instead of chapter for PDF bookmarks |
| `src/components/Sidebar.tsx` | No change — books are books regardless of format |

### Type changes:

```typescript
interface Book {
  // ... existing fields ...
  format: 'epub' | 'pdf';
}
```

### Import flow change:

```typescript
// Current: direct invoke
await invoke('import_book', { sourcePath });

// New: detect format, branch logic
if (file.endsWith('.pdf')) {
  const metadata = await extractPdfMetadata(file); // uses foliate-js
  await invoke('import_pdf', { sourcePath, ...metadata });
} else {
  await invoke('import_book', { sourcePath });
}
```

---

## 6. Implementation Phases

### Phase 1: Backend Foundation
- Add `004_pdf_support.sql` migration
- Add `format` field to `Book` struct
- Implement `import_pdf` command (file copy + DB insert, metadata from frontend)
- Update `list_books` and `get_book` to return format

### Phase 2: Import Flow
- Update file picker to accept `.epub, .pdf`
- Implement frontend PDF metadata extraction using foliate-js `makeBook()`
- Extract cover (render first page to canvas → blob)
- Wire up `import_pdf` invocation
- PDF books appear in library with correct metadata and cover

### Phase 3: Reader Adjustments
- Detect book format in Reader.tsx and store in state
- Adjust progress bar: page-based display for PDFs
- Adjust position saving: store page-based position for PDFs
- Test highlights, bookmarks, and text selection with PDFs

### Phase 4: AI Integration
- Ensure selected text + page context is passed correctly for PDFs
- Store page number in chat message metadata
- Display "Page X" instead of chapter name in AI panel context references

---

## 7. Scoping Notes

**In scope:**
- Import and read PDFs with the same core UX as EPUB
- Text selection, highlights, bookmarks
- AI assistant works with PDF content
- Library shows PDFs alongside EPUBs

**Out of scope (future):**
- PDF form filling
- PDF annotation export (to the PDF file itself)
- Scanned PDF OCR (text layer required for selection/AI)
- PDF editing or markup beyond highlights

---

## 8. Verification

1. Drop a PDF file into library → imported with correct title, author, cover
2. Drop a PDF with no metadata → filename used as title, first page as cover
3. Open PDF → pages render correctly with selectable text
4. Navigate via TOC → jumps to correct page
5. Select text → context menu works (highlight, Ask AI, copy)
6. Create highlight → overlay appears, persisted across sessions
7. Bookmark a page → appears in bookmarks panel with page number
8. Ask AI about selected text → response references correct page
9. Close and reopen → resumes at last read page
10. Library shows EPUBs and PDFs together, both searchable and filterable
11. Progress bar shows page-based progress for PDFs
