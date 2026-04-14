import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";

export interface DictionaryWord {
  id: string;
  book_id: string;
  word: string;
  definition: string;
  context_sentence: string | null;
  cfi: string | null;
  mastery: string;
  review_count: number;
  next_review_at: number | null;
  created_at: number;
  updated_at: number;
  book_title: string | null;
}

export function useDictionary(bookId: string) {
  const [words, setWords] = useState<DictionaryWord[]>([]);

  const refresh = useCallback(async () => {
    try {
      const result = await invoke<DictionaryWord[]>("list_vocab_words", { bookId });
      setWords(result);
    } catch (err) {
      console.error("Failed to load vocab words:", err);
    }
  }, [bookId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const add = useCallback(
    async (
      word: string,
      definition: string,
      contextSentence?: string,
      cfi?: string
    ) => {
      const dictionaryWord = await invoke<DictionaryWord>("add_vocab_word", {
        bookId,
        word,
        definition,
        contextSentence: contextSentence || null,
        cfi: cfi || null,
      });
      setWords((prev) => [dictionaryWord, ...prev]);
      return dictionaryWord;
    },
    [bookId]
  );

  const remove = useCallback(async (id: string) => {
    await invoke("remove_vocab_word", { id });
    setWords((prev) => prev.filter((w) => w.id !== id));
  }, []);

  const checkExists = useCallback(
    async (word: string): Promise<string | null> => {
      return invoke<string | null>("check_vocab_exists", { bookId, word });
    },
    [bookId]
  );

  return { words, refresh, add, remove, checkExists };
}

export function useAllDictionary() {
  const [words, setWords] = useState<DictionaryWord[]>([]);

  const refresh = useCallback(async () => {
    try {
      const result = await invoke<DictionaryWord[]>("list_all_vocab_words");
      setWords(result);
    } catch (err) {
      console.error("Failed to load all vocab words:", err);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const remove = useCallback(async (id: string) => {
    await invoke("remove_vocab_word", { id });
    setWords((prev) => prev.filter((w) => w.id !== id));
  }, []);

  return { words, refresh, remove };
}
