import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";

export interface Book {
  id: string;
  title: string;
  author: string;
  description: string | null;
  cover_path: string | null;
  file_path: string;
  format: "epub" | "pdf";
  genre: string | null;
  pages: number | null;
  status: "reading" | "finished" | "unread";
  progress: number;
  current_cfi: string | null;
  created_at: number;
  updated_at: number;
  available: boolean;
}

interface BookPage {
  books: Book[];
  next_cursor: string | null;
  total: number;
}

export function useBooks(filter?: string, search?: string) {
  const [books, setBooks] = useState<Book[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const page = await invoke<BookPage>("list_books", {
        filter: filter || null,
        search: search || null,
        cursor: null,
        limit: null,
      });
      setBooks(page.books.map((b) => ({
        ...b,
        cover_path: b.cover_path === "none" ? null : b.cover_path,
      })));
      setTotal(page.total);
      setCursor(page.next_cursor);
      setHasMore(page.next_cursor !== null);
    } catch (err) {
      console.error("Failed to load books:", err);
    } finally {
      setLoading(false);
    }
  }, [filter, search]);

  const loadMore = useCallback(async () => {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await invoke<BookPage>("list_books", {
        filter: filter || null,
        search: search || null,
        cursor,
        limit: null,
      });
      setBooks((prev) => [
        ...prev,
        ...page.books.map((b) => ({
          ...b,
          cover_path: b.cover_path === "none" ? null : b.cover_path,
        })),
      ]);
      setCursor(page.next_cursor);
      setHasMore(page.next_cursor !== null);
    } catch (err) {
      console.error("Failed to load more books:", err);
    } finally {
      setLoadingMore(false);
    }
  }, [cursor, filter, search, loadingMore]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { books, total, loading, loadingMore, hasMore, loadMore, refresh };
}

async function pickFile(): Promise<string | null> {
  return open({
    multiple: false,
    filters: [{ name: "Books", extensions: ["epub", "pdf"] }],
  });
}

async function importFile(filePath: string): Promise<Book> {
  const ext = filePath.split(".").pop()?.toLowerCase();
  if (ext === "pdf") {
    return importPdfStaged(filePath);
  }
  return invoke<Book>("import_book", { filePath });
}

async function importPdfStaged(filePath: string): Promise<Book> {
  const { book_id, abs_path } = await invoke<{ book_id: string; abs_path: string }>(
    "stage_pdf_import",
    { sourcePath: filePath },
  );
  try {
    const { extractPdfMetadata, filenameToTitle } = await import("../utils/pdfMetadata");
    const meta = await extractPdfMetadata(abs_path, filenameToTitle(filePath));
    const book = await invoke<Book>("commit_pdf_import", {
      bookId: book_id,
      title: meta.title,
      author: meta.author,
      description: meta.description,
      pages: meta.pages,
      coverData: meta.coverData ? Array.from(meta.coverData) : null,
    });
    return book;
  } catch (err) {
    await invoke("cancel_pdf_import", { bookId: book_id }).catch(() => {});
    throw err;
  }
}

export const importBookDialog = { pickFile, importFile };

const BACKFILL_BATCH_SIZE = 3;
const BACKFILL_DELAY_MS = 1000;
let backfillRunning = false;

function needsCover(b: Book): boolean {
  return b.format === "pdf" && !b.cover_path;
}

export async function backfillMissingCovers(): Promise<void> {
  if (backfillRunning) return;
  backfillRunning = true;
  try {
    const page = await invoke<BookPage>("list_books", { filter: null, search: null, cursor: null, limit: 1000 });
    const missing = page.books.filter(needsCover);
    if (missing.length === 0) {
      backfillRunning = false;
      return;
    }
    const batch = missing.slice(0, BACKFILL_BATCH_SIZE);
    const { extractPdfCover } = await import("../utils/pdfMetadata");
    for (const book of batch) {
      try {
        const coverData = await extractPdfCover(book.file_path);
        if (coverData) {
          await invoke("save_book_cover", {
            bookId: book.id,
            coverData: Array.from(coverData),
          });
        } else {
          await invoke("mark_cover_unavailable", { bookId: book.id });
        }
      } catch (err) {
        console.warn(`Cover backfill failed for ${book.id}:`, err);
        await invoke("mark_cover_unavailable", { bookId: book.id }).catch(() => {});
      }
    }
    if (missing.length > BACKFILL_BATCH_SIZE) {
      setTimeout(() => {
        backfillRunning = false;
        backfillMissingCovers();
      }, BACKFILL_DELAY_MS);
    } else {
      backfillRunning = false;
    }
  } catch {
    backfillRunning = false;
  }
}

export async function getBook(id: string): Promise<Book> {
  const b = await invoke<Book>("get_book", { id });
  if (b.cover_path === "none") b.cover_path = null;
  return b;
}

export async function deleteBook(id: string): Promise<void> {
  return invoke("delete_book", { id });
}

export async function updateReadingProgress(
  id: string,
  progress: number,
  cfi?: string
): Promise<void> {
  return invoke("update_reading_progress", {
    id,
    progress,
    cfi: cfi || null,
  });
}

export async function markFinished(id: string): Promise<void> {
  return invoke("mark_finished", { id });
}

export async function updateBookStatus(id: string, status: "reading" | "finished" | "unread"): Promise<void> {
  return invoke("update_book_status", { id, status });
}

export async function updateBookMetadata(
  id: string,
  title: string,
  author: string
): Promise<void> {
  return invoke("update_book_metadata", { id, title, author });
}

export async function checkBookAvailable(id: string): Promise<boolean> {
  return invoke<boolean>("check_book_available", { id });
}
