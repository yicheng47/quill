import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";

export interface VocabWord {
  id: string;
  book_id: string;
  word: string;
  definition: string;
  context_sentence: string | null;
  cfi: string | null;
  mastery: string;
  review_count: number;
  next_review_at: string | null;
  created_at: string;
  updated_at: string;
  book_title: string | null;
}

export function useVocab(bookId: string) {
  const [words, setWords] = useState<VocabWord[]>([]);

  const refresh = useCallback(async () => {
    try {
      const result = await invoke<VocabWord[]>("list_vocab_words", { bookId });
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
      const vocabWord = await invoke<VocabWord>("add_vocab_word", {
        bookId,
        word,
        definition,
        contextSentence: contextSentence || null,
        cfi: cfi || null,
      });
      setWords((prev) => [vocabWord, ...prev]);
      return vocabWord;
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

export function useAllVocab() {
  const [words, setWords] = useState<VocabWord[]>([]);

  const refresh = useCallback(async () => {
    try {
      const result = await invoke<VocabWord[]>("list_all_vocab_words");
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
