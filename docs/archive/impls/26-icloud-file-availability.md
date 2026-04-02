# Fix: Book files may not be downloaded when iCloud syncs DB entry first

## Context

When iCloud sync is enabled, the SQLite DB and the `books/`/`covers/` directories sync independently. A second device can receive the DB entry (title, metadata, progress) before the actual `.epub` file arrives. This causes books to appear in the library but fail to open, with no indication that the file is still downloading.

On macOS, evicted iCloud files are replaced with placeholder files named `.{original_name}.icloud` (e.g., `books/.my-book_abc12345.epub.icloud`). We can detect this to determine file availability.

## Approach

Add a **file availability check** on the backend that detects iCloud placeholder files, surface this as a new `available` field on the `Book` struct, and handle it gracefully in the frontend (library indicators + reader download-wait state).

---

## Step 1: Backend — Add iCloud file availability detection

**File: `src-tauri/src/icloud.rs`**

Add a function `is_file_downloaded(path: &Path) -> bool`:
- If the file exists at `path` and is not zero-length, return `true`
- Check for iCloud placeholder: given `path/to/books/foo.epub`, check if `path/to/books/.foo.epub.icloud` exists — if so, return `false`
- If neither the real file nor the placeholder exists, return `false`

Add a function `trigger_download(path: &Path)` that calls `startDownloadingUbiquitousItemAtURL` on the specific file (not the whole directory). This is the existing macOS API we already use in `ensure_downloaded()`, but targeted to a single file.

**File: `src-tauri/src/commands/books.rs`**

Add an `available` field to the `Book` struct:
```rust
pub available: bool,
```

In `resolve_book_paths()`, after resolving the absolute path, check availability using `icloud::is_file_downloaded()` and set `book.available`. This means both `list_books` and `get_book` will automatically include availability info.

Add a new Tauri command `check_book_available`:
```rust
#[tauri::command]
pub fn check_book_available(id: String, db: State<'_, Db>) -> AppResult<bool>
```
This lets the frontend poll a single book's availability without re-fetching the whole list. It should also call `trigger_download()` on the book file to ensure iCloud starts downloading it.

## Step 2: Frontend — Add `available` to Book type and library indicators

**File: `src/hooks/useBooks.ts`**

Add `available: boolean` to the `Book` interface.

Add a helper function:
```typescript
export async function checkBookAvailable(id: string): Promise<boolean> {
  return invoke<boolean>("check_book_available", { id });
}
```

**File: `src/components/BookGrid.tsx`**

When `book.available === false`:
- Overlay a cloud-download icon (lucide-react `CloudDownload`) on the book cover, semi-transparent
- Reduce opacity of the entire card slightly to visually indicate it's not ready
- On click: instead of opening the reader, show a toast or trigger the download-wait flow

**File: `src/components/BookList.tsx`**

Same treatment — show a cloud icon indicator next to the title when unavailable.

## Step 3: Frontend — Reader download-wait state

**File: `src/pages/Reader.tsx`**

Before attempting to fetch the book file (line ~328), check `book.available`:
- If `false`: show a "Downloading from iCloud..." loading state with a spinner
- Poll `check_book_available(bookId)` every 2 seconds
- When it returns `true`, proceed with the normal book open flow
- Add a timeout (e.g., 60s) after which show an error message suggesting the user check their internet connection

This replaces the current behavior where `fetch(fileUrl)` would fail silently or show a blank reader.

## Step 4: Cover graceful fallback

**File: `src/components/BookGrid.tsx` and `BookList.tsx`**

The existing fallback (show title on gray bg when `cover_path` is null) already handles the "no cover" case. For iCloud, the cover file might exist in DB but not on disk. Add an `onError` handler to the `<img>` tag that falls back to the placeholder:
```tsx
<img
  src={convertFileSrc(book.cover_path)}
  onError={(e) => { e.currentTarget.style.display = 'none'; }}
  ...
/>
```
Show the text fallback when the image fails to load, not just when `cover_path` is null.

## Step 5: i18n keys

**Files: `src/i18n/en.json`, `src/i18n/zh.json`**

Add keys:
- `reader.downloadingFromICloud` — "Downloading from iCloud..." / "正在从 iCloud 下载..."
- `reader.downloadTimeout` — "Download is taking too long. Please check your internet connection." / "下载时间过长，请检查网络连接。"
- `bookGrid.icloudPending` — "Downloading from iCloud" / "正在从 iCloud 下载"

## Files to modify

| File | Change |
|------|--------|
| `src-tauri/src/icloud.rs` | Add `is_file_downloaded()`, `trigger_download()` |
| `src-tauri/src/commands/books.rs` | Add `available` field, `check_book_available` command |
| `src-tauri/src/lib.rs` | Register `check_book_available` command |
| `src/hooks/useBooks.ts` | Add `available` to Book type, add `checkBookAvailable()` |
| `src/components/BookGrid.tsx` | Cloud indicator overlay, cover `onError` fallback |
| `src/components/BookList.tsx` | Cloud indicator, cover `onError` fallback |
| `src/pages/Reader.tsx` | Download-wait state before opening book |
| `src/i18n/en.json` | New translation keys |
| `src/i18n/zh.json` | New translation keys |

## Verification

1. **Unit tests**: Add tests in `icloud.rs` for `is_file_downloaded()` — test with real file, placeholder file, and missing file
2. **Manual test (no iCloud)**: With iCloud disabled, all books should show `available: true` — no regressions
3. **Manual test (iCloud)**: Import a book on Device A, open Quill on Device B before file syncs — should see cloud indicator in library and download-wait in reader
4. **Cover fallback**: Delete a cover file from disk, reload library — should show text placeholder instead of broken image
