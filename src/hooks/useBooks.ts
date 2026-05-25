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

export function useBooks(filter?: string, search?: string) {
  const [books, setBooks] = useState<Book[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const result = await invoke<Book[]>("list_books", {
        filter: filter || null,
        search: search || null,
      });
      setBooks(result);
    } catch (err) {
      console.error("Failed to load books:", err);
    } finally {
      setLoading(false);
    }
  }, [filter, search]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { books, loading, refresh };
}

async function pickFile(): Promise<string | null> {
  return open({
    multiple: false,
    filters: [{ name: "Books", extensions: ["epub", "pdf"] }],
  });
}

async function importFile(filePath: string): Promise<Book> {
  const book = await invoke<Book>("import_book", { filePath });
  if (book.format === "pdf" && !book.cover_path) {
    try {
      await backfillPdfCover(book);
      book.cover_path = `covers/${book.id}.png`;
    } catch (err) {
      console.warn("PDF cover backfill failed:", err);
    }
  }
  return book;
}

async function backfillPdfCover(book: Book): Promise<void> {
  const { extractPdfCover } = await import("../utils/pdfMetadata");
  const coverData = await extractPdfCover(book.file_path);
  if (coverData) {
    await invoke("save_book_cover", {
      bookId: book.id,
      coverData: Array.from(coverData),
    });
  }
}

export const importBookDialog = { pickFile, importFile };

const BACKFILL_BATCH_SIZE = 3;
const BACKFILL_DELAY_MS = 1000;
let backfillRunning = false;

export async function backfillMissingCovers(): Promise<void> {
  if (backfillRunning) return;
  backfillRunning = true;
  try {
    const books = await invoke<Book[]>("list_books", { filter: null, search: null });
    const missing = books.filter((b) => b.format === "pdf" && !b.cover_path);
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
        }
      } catch (err) {
        console.warn(`Cover backfill failed for ${book.id}:`, err);
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
  return invoke<Book>("get_book", { id });
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
