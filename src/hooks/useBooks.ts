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
  genre: string | null;
  pages: number | null;
  status: "reading" | "finished" | "unread";
  progress: number;
  current_cfi: string | null;
  created_at: string;
  updated_at: string;
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

export async function importBookDialog(): Promise<Book | null> {
  const selected = await open({
    multiple: false,
    filters: [{ name: "EPUB files", extensions: ["epub"] }],
  });
  if (!selected) return null;
  return invoke<Book>("import_book", { filePath: selected });
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
