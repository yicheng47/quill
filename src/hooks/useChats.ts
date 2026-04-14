import { useState, useEffect, useCallback } from "react";
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

export function useAllChats() {
  const [chats, setChats] = useState<ChatSummary[]>([]);

  const refresh = useCallback(async () => {
    try {
      const result = await invoke<ChatSummary[]>("list_all_chats");
      setChats(result);
    } catch (err) {
      console.error("Failed to load all chats:", err);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const remove = useCallback(async (id: string) => {
    await invoke("delete_chat", { chatId: id });
    setChats((prev) => prev.filter((c) => c.id !== id));
  }, []);

  return { chats, refresh, remove };
}
