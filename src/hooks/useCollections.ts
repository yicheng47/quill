import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";

export interface Collection {
  id: string;
  name: string;
  book_count: number;
  sort_order: number;
  created_at: number;
  updated_at: number;
}

export function useCollections() {
  const [collections, setCollections] = useState<Collection[]>([]);

  const refresh = useCallback(async () => {
    try {
      const result = await invoke<Collection[]>("list_collections");
      setCollections(result);
    } catch (err) {
      console.error("Failed to load collections:", err);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const create = useCallback(async (name: string) => {
    const collection = await invoke<Collection>("create_collection", { name });
    setCollections((prev) => [...prev, collection]);
    return collection;
  }, []);

  const rename = useCallback(async (id: string, name: string) => {
    await invoke("rename_collection", { id, name });
    setCollections((prev) => prev.map((c) => c.id === id ? { ...c, name } : c));
  }, []);

  const remove = useCallback(async (id: string) => {
    await invoke("delete_collection", { id });
    setCollections((prev) => prev.filter((c) => c.id !== id));
  }, []);

  const addBook = useCallback(async (collectionId: string, bookId: string) => {
    await invoke("add_book_to_collection", { collectionId, bookId });
    refresh();
  }, [refresh]);

  const removeBook = useCallback(async (collectionId: string, bookId: string) => {
    await invoke("remove_book_from_collection", { collectionId, bookId });
    refresh();
  }, [refresh]);

  const reorder = useCallback(async (ids: string[]) => {
    await invoke("reorder_collections", { ids });
    setCollections((prev) => {
      const map = new Map(prev.map((c) => [c.id, c]));
      return ids.map((id, i) => ({ ...map.get(id)!, sort_order: i }));
    });
  }, []);

  return { collections, refresh, create, rename, remove, reorder, addBook, removeBook };
}
