import { useState, useEffect, useCallback, useRef } from "react";
import { invoke } from "../platform";

export interface Bookmark {
  id: string;
  book_id: string;
  cfi: string;
  label: string | null;
  created_at: number;
  updated_at: number;
}

export interface Highlight {
  id: string;
  book_id: string;
  cfi_range: string;
  color: string;
  note: string | null;
  text_content: string | null;
  created_at: number;
  updated_at: number;
  book_title?: string;
  book_author?: string;
}

export interface HighlightBookSummary {
  book_id: string;
  book_title: string;
  book_author: string;
  book_progress: number;
  cover_path: string | null;
  cover_data?: string | null;
  count: number;
}

export interface HighlightCounts {
  total: number;
  book_count: number;
  books: HighlightBookSummary[];
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

  const updateColor = useCallback(async (id: string, color: string) => {
    await invoke("update_highlight_color", { id, color });
    setHighlights((prev) =>
      prev.map((h) => (h.id === id ? { ...h, color } : h))
    );
  }, []);

  return { highlights, refresh, add, remove, updateNote, updateColor };
}

export function useAllHighlights(bookId?: string | null, search?: string) {
  const [highlights, setHighlights] = useState<Highlight[]>([]);
  const [counts, setCounts] = useState<HighlightCounts>({ total: 0, book_count: 0, books: [] });
  const [loading, setLoading] = useState(true);
  const listRequestIdRef = useRef(0);
  const countsRequestIdRef = useRef(0);

  const refreshCounts = useCallback(async () => {
    const requestId = ++countsRequestIdRef.current;
    try {
      const res = await invoke<HighlightCounts>("get_highlight_counts");
      if (requestId !== countsRequestIdRef.current) return;
      setCounts(res);
    } catch (err) {
      if (requestId === countsRequestIdRef.current) {
        console.error("Failed to load highlight counts:", err);
      }
    }
  }, []);

  const refreshList = useCallback(
    async (showLoading: boolean) => {
      const requestId = ++listRequestIdRef.current;
      if (showLoading) setLoading(true);
      try {
        const res = await invoke<Highlight[]>("list_all_highlights", {
          bookId: bookId || null,
          search: search || null,
          sort: null,
        });
        if (requestId !== listRequestIdRef.current) return;
        setHighlights(Array.isArray(res) ? res : []);
      } catch (err) {
        if (requestId === listRequestIdRef.current) {
          console.error("Failed to load all highlights:", err);
        }
      } finally {
        if (showLoading && requestId === listRequestIdRef.current) {
          setLoading(false);
        }
      }
    },
    [bookId, search],
  );

  const refresh = useCallback(async () => {
    await Promise.all([refreshList(false), refreshCounts()]);
  }, [refreshList, refreshCounts]);

  useEffect(() => {
    void refreshCounts();
  }, [refreshCounts]);

  useEffect(() => {
    void refreshList(true);
  }, [refreshList]);

  const remove = useCallback(
    async (id: string) => {
      await invoke("remove_highlight", { id });
      setHighlights((prev) => prev.filter((h) => h.id !== id));
      await refreshCounts();
    },
    [refreshCounts],
  );

  const updateNote = useCallback(async (id: string, note: string) => {
    await invoke("update_highlight_note", { id, note });
    setHighlights((prev) => prev.map((h) => (h.id === id ? { ...h, note } : h)));
  }, []);

  const updateColor = useCallback(async (id: string, color: string) => {
    await invoke("update_highlight_color", { id, color });
    setHighlights((prev) => prev.map((h) => (h.id === id ? { ...h, color } : h)));
  }, []);

  return {
    highlights,
    counts,
    loading,
    refresh,
    remove,
    updateNote,
    updateColor,
  };
}
