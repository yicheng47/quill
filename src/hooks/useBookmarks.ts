import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";

export interface Bookmark {
  id: string;
  book_id: string;
  cfi: string;
  label: string | null;
  created_at: string;
}

export interface Highlight {
  id: string;
  book_id: string;
  cfi_range: string;
  color: string;
  note: string | null;
  text_content: string | null;
  created_at: string;
}

export function useBookmarks(bookId: string) {
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([]);

  const refresh = useCallback(async () => {
    try {
      const result = await invoke<Bookmark[]>("list_bookmarks", {
        bookId,
      });
      setBookmarks(result);
    } catch (err) {
      console.error("Failed to load bookmarks:", err);
    }
  }, [bookId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const add = useCallback(
    async (cfi: string, label?: string) => {
      const bookmark = await invoke<Bookmark>("add_bookmark", {
        bookId,
        cfi,
        label: label || null,
      });
      setBookmarks((prev) => [bookmark, ...prev]);
      return bookmark;
    },
    [bookId]
  );

  const remove = useCallback(async (id: string) => {
    await invoke("remove_bookmark", { id });
    setBookmarks((prev) => prev.filter((b) => b.id !== id));
  }, []);

  return { bookmarks, refresh, add, remove };
}

export function useHighlights(bookId: string) {
  const [highlights, setHighlights] = useState<Highlight[]>([]);

  const refresh = useCallback(async () => {
    try {
      const result = await invoke<Highlight[]>("list_highlights", {
        bookId,
      });
      setHighlights(result);
    } catch (err) {
      console.error("Failed to load highlights:", err);
    }
  }, [bookId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const add = useCallback(
    async (
      cfiRange: string,
      color?: string,
      note?: string,
      textContent?: string
    ) => {
      const highlight = await invoke<Highlight>("add_highlight", {
        bookId,
        cfiRange,
        color: color || null,
        note: note || null,
        textContent: textContent || null,
      });
      setHighlights((prev) => [highlight, ...prev]);
      return highlight;
    },
    [bookId]
  );

  const remove = useCallback(async (id: string) => {
    await invoke("remove_highlight", { id });
    setHighlights((prev) => prev.filter((h) => h.id !== id));
  }, []);

  const updateNote = useCallback(async (id: string, note: string) => {
    await invoke("update_highlight_note", { id, note });
    setHighlights((prev) =>
      prev.map((h) => (h.id === id ? { ...h, note } : h))
    );
  }, []);

  return { highlights, refresh, add, remove, updateNote };
}
