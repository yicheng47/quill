import { useState, useEffect, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";

export interface ChatSummary {
  id: string;
  book_id: string;
  title: string;
  model: string | null;
  pinned: boolean;
  metadata: string | null;
  created_at: number;
  updated_at: number;
  book_title: string | null;
  message_count: number | null;
  last_message: string | null;
}

interface ChatPage {
  chats: ChatSummary[];
  next_cursor: string | null;
  total: number;
}

export interface ChatBookCount {
  book_id: string;
  book_title: string | null;
  count: number;
}

export interface ChatCounts {
  total: number;
  by_book: ChatBookCount[];
}

const byChatOrder = (a: ChatSummary, b: ChatSummary) => {
  if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
  if (a.updated_at !== b.updated_at) return b.updated_at - a.updated_at;
  return a.id.localeCompare(b.id);
};

export function useAllChats(search?: string, bookId?: string) {
  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const requestIdRef = useRef(0);

  const refresh = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    setLoading(true);
    setLoadingMore(false);
    try {
      const page = await invoke<ChatPage>("list_all_chats", {
        search: search || null,
        bookId: bookId || null,
        cursor: null,
        limit: null,
      });
      if (requestId !== requestIdRef.current) return;
      setChats(page.chats);
      setTotal(page.total);
      setCursor(page.next_cursor);
      setHasMore(page.next_cursor !== null);
    } catch (err) {
      if (requestId === requestIdRef.current) {
        console.error("Failed to load all chats:", err);
      }
    } finally {
      if (requestId === requestIdRef.current) {
        setLoading(false);
      }
    }
  }, [search, bookId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const loadMore = useCallback(async () => {
    if (!cursor || loading || loadingMore) return;
    const requestId = ++requestIdRef.current;
    setLoadingMore(true);
    try {
      const page = await invoke<ChatPage>("list_all_chats", {
        search: search || null,
        bookId: bookId || null,
        cursor,
        limit: null,
      });
      if (requestId !== requestIdRef.current) return;
      setChats((prev) => [...prev, ...page.chats]);
      setCursor(page.next_cursor);
      setHasMore(page.next_cursor !== null);
    } catch (err) {
      if (requestId === requestIdRef.current) {
        console.error("Failed to load more chats:", err);
      }
    } finally {
      if (requestId === requestIdRef.current) {
        setLoadingMore(false);
      }
    }
  }, [cursor, loading, loadingMore, search, bookId]);

  const removeLocal = useCallback((id: string) => {
    setChats((prev) => prev.filter((chat) => chat.id !== id));
    setTotal((value) => Math.max(0, value - 1));
  }, []);

  const patchChat = useCallback((id: string, partial: Partial<ChatSummary>) => {
    setChats((prev) => prev
      .map((chat) => chat.id === id ? { ...chat, ...partial } : chat)
      .sort(byChatOrder));
  }, []);

  return {
    chats,
    total,
    loading,
    loadingMore,
    hasMore,
    loadMore,
    refresh,
    removeLocal,
    patchChat,
  };
}

export function useChatCounts() {
  const [counts, setCounts] = useState<ChatCounts | null>(null);

  const refresh = useCallback(async () => {
    try {
      setCounts(await invoke<ChatCounts>("get_chat_counts"));
    } catch (err) {
      console.error("Failed to load chat counts:", err);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { counts, refresh };
}
