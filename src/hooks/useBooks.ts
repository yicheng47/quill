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
  cover_data: string | null;
}

interface BookPage {
  books: Book[];
  next_cursor: string | null;
  total: number;
}

export function useBooks(filter?: string, search?: string, collectionId?: string) {
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
        collectionId: collectionId || null,
        cursor: null,
        limit: null,
      });
      setBooks(page.books);
      setTotal(page.total);
      setCursor(page.next_cursor);
      setHasMore(page.next_cursor !== null);
    } catch (err) {
      console.error("Failed to load books:", err);
    } finally {
      setLoading(false);
    }
  }, [filter, search, collectionId]);

  const loadMore = useCallback(async () => {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await invoke<BookPage>("list_books", {
        filter: filter || null,
        search: search || null,
        collectionId: collectionId || null,
        cursor,
        limit: null,
      });
      setBooks((prev) => [...prev, ...page.books]);
      setCursor(page.next_cursor);
      setHasMore(page.next_cursor !== null);
    } catch (err) {
      console.error("Failed to load more books:", err);
    } finally {
      setLoadingMore(false);
    }
  }, [cursor, filter, search, collectionId, loadingMore]);

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
  return invoke<Book>("import_book", { filePath });
}

export const importBookDialog = { pickFile, importFile };

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

export async function checkBookReadable(id: string): Promise<boolean> {
  return invoke<boolean>("check_book_readable", { id });
}
