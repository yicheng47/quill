import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";

export interface SavedTranslation {
  id: string;
  book_id: string;
  source_text: string;
  translated_text: string;
  target_language: string;
  cfi: string | null;
  created_at: string;
  book_title?: string | null;
}

export function useTranslations(bookId: string) {
  const [translations, setTranslations] = useState<SavedTranslation[]>([]);

  const refresh = useCallback(async () => {
    try {
      const result = await invoke<SavedTranslation[]>("list_translations", {
        bookId,
      });
      setTranslations(result);
    } catch (err) {
      console.error("Failed to load translations:", err);
    }
  }, [bookId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const remove = useCallback(async (id: string) => {
    await invoke("remove_saved_translation", { id });
    setTranslations((prev) => prev.filter((t) => t.id !== id));
  }, []);

  return { translations, refresh, remove };
}

export function useAllTranslations() {
  const [translations, setTranslations] = useState<SavedTranslation[]>([]);

  const refresh = useCallback(async () => {
    try {
      const result = await invoke<SavedTranslation[]>("list_translations", {
        bookId: null,
      });
      setTranslations(result);
    } catch (err) {
      console.error("Failed to load all translations:", err);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const remove = useCallback(async (id: string) => {
    await invoke("remove_saved_translation", { id });
    setTranslations((prev) => prev.filter((t) => t.id !== id));
  }, []);

  return { translations, refresh, remove };
}
