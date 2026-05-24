# Edit Book Metadata

**Issue:** [#125](https://github.com/yicheng47/quill/issues/125)
**Spec:** `docs/features/24-edit-book-metadata.md`

## Context

EPUBs often ship with wrong/garbled metadata. Users need to fix title and author within Quill without leaving the app.

## Approach

Directly update `title` and `author` columns in the `books` table — no migration, no override columns. Original metadata still lives in the EPUB file if ever needed. Add a new Tauri command and an "Edit Info" context menu action with a small modal.

---

## Step 1: Add `update_book_metadata` command

**File: `src-tauri/src/commands/books.rs`** — add after `update_book_status` (~line 370)

```rust
#[tauri::command]
pub fn update_book_metadata(
    id: String,
    title: String,
    author: String,
    db: State<'_, Db>,
) -> AppResult<()> {
    let conn = db.conn.lock().map_err(|e| AppError::Other(e.to_string()))?;
    let now = chrono::Utc::now().to_rfc3339();

    conn.execute(
        "UPDATE books SET title = ?1, author = ?2, updated_at = ?3 WHERE id = ?4",
        params![title, author, now, id],
    )?;

    Ok(())
}
```

**File: `src-tauri/src/lib.rs:70-81`** — register the new command

Add `commands::books::update_book_metadata` to the `invoke_handler` list.

---

## Step 2: Add frontend command wrapper

**File: `src/hooks/useBooks.ts`** — add after `updateBookStatus` (~line 101)

```typescript
export async function updateBookMetadata(
  id: string,
  title: string,
  author: string
): Promise<void> {
  return invoke("update_book_metadata", { id, title, author });
}
```

---

## Step 3: Create EditMetadataModal component

**File: `src/components/EditMetadataModal.tsx`** (new)

Small modal following the `SaveDialog.tsx` pattern (fixed overlay, 400px card, Escape/click-outside dismiss):

- Props: `{ open, bookId, currentTitle, currentAuthor, onClose, onSaved }`
- Two `<Input>` fields (title, author) pre-filled with current values
- Cancel (ghost button) and Save (primary button)
- Save calls `updateBookMetadata(bookId, title, author)` then `onSaved()`
- Disable Save button when both fields are unchanged
- Trim whitespace; don't allow empty title

### Figma design prompt

> Modal dialog, 400px wide, centered on screen with dark overlay. Rounded-xl card with bg-surface. Heading: "Edit Info" (18px semibold). Two stacked input fields with labels ("Title", "Author"), each h-9 with border styling. 16px gap between fields. Button row at bottom: Cancel (ghost) on left, Save (primary) on right. Follows the app's existing SaveDialog spacing and color tokens.

---

## Step 4: Wire into BookContextMenu

**File: `src/components/BookContextMenu.tsx`**

Add prop:
```typescript
onEditInfo: () => void;
```

Add an "Edit Info" menu item with `Pencil` icon (from lucide-react) between the status actions section and the collection section divider (~line 187):

```tsx
<div className="mx-3 my-1 h-px bg-border/80" />

<button onClick={onEditInfo} className="flex items-center gap-3 ...">
  <Pencil size={16} className="text-text-muted" />
  <span className="...">{t("bookMenu.editInfo")}</span>
</button>
```

---

## Step 5: Wire into BookGrid and BookList

**File: `src/components/BookGrid.tsx`** and **`src/components/BookList.tsx`**

Both components manage context menu state. Add:

1. State for edit modal: `const [editBook, setEditBook] = useState<Book | null>(null)`
2. Pass `onEditInfo` to `BookContextMenu`
3. `onEditInfo` sets `editBook` to the right-clicked book and closes context menu
4. Render `<EditMetadataModal>` when `editBook !== null`, with `onSaved` calling `onBooksChanged`

---

## Step 6: i18n keys

**File: `src/i18n/en.json`** — add:
```json
"bookMenu.editInfo": "Edit Info",
"editInfo.title": "Edit Info",
"editInfo.bookTitle": "Title",
"editInfo.bookAuthor": "Author",
"editInfo.cancel": "Cancel",
"editInfo.save": "Save"
```

**File: `src/i18n/zh.json`** — add:
```json
"bookMenu.editInfo": "编辑信息",
"editInfo.title": "编辑信息",
"editInfo.bookTitle": "标题",
"editInfo.bookAuthor": "作者",
"editInfo.cancel": "取消",
"editInfo.save": "保存"
```

---

## Step 7: Reader integration

**No code changes needed.** The Reader fetches book data via `get_book` (`Reader.tsx:~183`), which reads `title` and `author` directly. Title bar at lines 960-972 displays `book.title` — automatically picks up edits.

---

## Files to modify

| File | Change |
|------|--------|
| `src-tauri/src/commands/books.rs` | Add `update_book_metadata` command |
| `src-tauri/src/lib.rs` | Register new command |
| `src/hooks/useBooks.ts` | Add `updateBookMetadata` wrapper |
| `src/components/EditMetadataModal.tsx` | **New** — edit modal component |
| `src/components/BookContextMenu.tsx` | Add "Edit Info" action + new prop |
| `src/components/BookGrid.tsx` | Wire up edit modal |
| `src/components/BookList.tsx` | Wire up edit modal |
| `src/i18n/en.json` | New translation keys |
| `src/i18n/zh.json` | New translation keys |

## Verification

- [ ] Edit title only → library shows new title, author unchanged
- [ ] Edit author only → author updates, title unchanged
- [ ] Edit both → both update
- [ ] Cancel / Escape → no changes
- [ ] Search finds books by edited title/author
- [ ] Close and reopen app → edits persist
- [ ] Open book in reader → title bar reflects edits
- [ ] Original EPUB file is never modified (edits are DB-only)
- [ ] Empty title blocked (Save disabled)
