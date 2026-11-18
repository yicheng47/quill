import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Languages, Search, Sparkles, X } from "lucide-react";
import { invoke } from "../platform";
import type { Book } from "../hooks/useBooks";
import type { Highlight } from "../hooks/useBookmarks";
import type { DictionaryWord } from "../hooks/useDictionary";
import type { ChatSummary } from "../hooks/useChats";
import type { MainNavigateOptions, MainRoute } from "./TopBar";
import BookCover from "./ui/BookCover";
import { openReaderWindow } from "../utils/openReaderWindow";
import { getHighlightColorMeta } from "../utils/highlightColors";
import { formatShortDate, parseDefinition } from "../utils/vocabParse";
import { parseChatMessageContextCfi } from "../hooks/useAiChat";
import { shortcutModSymbol } from "../lib/platformEnv";

interface BookPage {
  books: Book[];
  next_cursor: string | null;
  total: number;
}

interface ChatPage {
  chats: ChatSummary[];
  next_cursor: string | null;
  total: number;
}

export type CommandSearchScope = "all" | "books" | "highlights" | "words" | "chats";

type SearchHit =
  | { kind: "book"; key: string; book: Book }
  | { kind: "highlight"; key: string; highlight: Highlight }
  | { kind: "word"; key: string; word: DictionaryWord }
  | { kind: "chat"; key: string; chat: ChatSummary };

const SCOPE_ORDER: CommandSearchScope[] = ["all", "books", "highlights", "words", "chats"];

async function resolveFirstChatContextCfi(chatId: string): Promise<string | undefined> {
  try {
    const msgs = await invoke<Array<{ metadata?: string | null }>>("list_chat_messages", {
      chatId,
    });
    if (!Array.isArray(msgs)) return undefined;
    for (const msg of msgs) {
      const cfi = parseChatMessageContextCfi(msg.metadata);
      if (cfi) return cfi;
    }
  } catch {
    // Open the chat thread even if message lookup fails.
  }
  return undefined;
}

function buildSearchGroups(
  scope: CommandSearchScope,
  books: Book[],
  highlights: Highlight[],
  words: DictionaryWord[],
  chats: ChatSummary[],
  t: (key: string) => string,
): Array<{ id: string; title: string; items: SearchHit[] }> {
  const result: Array<{ id: string; title: string; items: SearchHit[] }> = [];

  if (scope === "all") {
    const bookSlice = books.slice(0, 5).map(
      (book): SearchHit => ({ kind: "book", key: `book:${book.id}`, book }),
    );
    if (bookSlice.length > 0) {
      result.push({ id: "books", title: t("commandSearch.groupBooks"), items: bookSlice });
    }

    const hlSlice = highlights.slice(0, 4).map(
      (highlight): SearchHit => ({
        kind: "highlight",
        key: `hl:${highlight.id}`,
        highlight,
      }),
    );
    if (hlSlice.length > 0) {
      result.push({
        id: "highlights",
        title: t("commandSearch.groupHighlights"),
        items: hlSlice,
      });
    }

    const wordSlice = words.slice(0, 3).map(
      (word): SearchHit => ({ kind: "word", key: `word:${word.id}`, word }),
    );
    const chatSlice = chats.slice(0, 3).map(
      (chat): SearchHit => ({ kind: "chat", key: `chat:${chat.id}`, chat }),
    );
    const combined = [...wordSlice, ...chatSlice];
    if (combined.length > 0) {
      result.push({
        id: "words-chats",
        title: t("commandSearch.groupWordsAndChats"),
        items: combined,
      });
    }
    return result;
  }

  if (scope === "books" && books.length > 0) {
    result.push({
      id: "books",
      title: t("commandSearch.groupBooks"),
      items: books.map((book) => ({ kind: "book", key: `book:${book.id}`, book })),
    });
  } else if (scope === "highlights" && highlights.length > 0) {
    result.push({
      id: "highlights",
      title: t("commandSearch.groupHighlights"),
      items: highlights.slice(0, 30).map((highlight) => ({
        kind: "highlight",
        key: `hl:${highlight.id}`,
        highlight,
      })),
    });
  } else if (scope === "words" && words.length > 0) {
    result.push({
      id: "words",
      title: t("commandSearch.groupWords"),
      items: words.slice(0, 30).map((word) => ({
        kind: "word",
        key: `word:${word.id}`,
        word,
      })),
    });
  } else if (scope === "chats" && chats.length > 0) {
    result.push({
      id: "chats",
      title: t("commandSearch.groupChats"),
      items: chats.map((chat) => ({ kind: "chat", key: `chat:${chat.id}`, chat })),
    });
  }

  return result;
}

interface CommandSearchModalProps {
  open: boolean;
  onClose: () => void;
  onNavigate?: (route: MainRoute, options?: MainNavigateOptions) => void;
  initialScope?: CommandSearchScope;
}

export default function CommandSearchModal({
  open,
  onClose,
  onNavigate,
  initialScope = "all",
}: CommandSearchModalProps) {
  const { t, i18n } = useTranslation();
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<CommandSearchScope>(initialScope);
  const [books, setBooks] = useState<Book[]>([]);
  const [booksTotal, setBooksTotal] = useState(0);
  const [highlights, setHighlights] = useState<Highlight[]>([]);
  const [words, setWords] = useState<DictionaryWord[]>([]);
  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [chatsTotal, setChatsTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [resultsQuery, setResultsQuery] = useState<string | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const requestSeqRef = useRef(0);
  const searchTimerRef = useRef<number | null>(null);
  const dispatchedQueryRef = useRef<{ query: string; seq: number } | null>(null);
  const pendingActivationRef = useRef<{ query: string; inReader: boolean } | null>(null);
  const openRef = useRef(open);
  openRef.current = open;
  const queryRef = useRef(query);
  queryRef.current = query;
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const loadingRef = useRef(loading);
  loadingRef.current = loading;
  const resultsQueryRef = useRef<string | null>(resultsQuery);
  resultsQueryRef.current = resultsQuery;
  const mod = shortcutModSymbol();

  const handleActivate = useCallback(
    (hit: SearchHit, inReader: boolean) => {
      onClose();
      switch (hit.kind) {
        case "book":
          void openReaderWindow(hit.book.id);
          return;
        case "highlight":
          if (inReader || !onNavigate) {
            void openReaderWindow(hit.highlight.book_id, {
              cfi: hit.highlight.cfi_range,
            });
          } else {
            onNavigate("highlights", {
              bookId: hit.highlight.book_id,
              highlightId: hit.highlight.id,
            });
          }
          return;
        case "word":
          if (inReader || !onNavigate) {
            void openReaderWindow(hit.word.book_id, {
              openVocab: true,
              cfi: hit.word.cfi ?? undefined,
            });
          } else {
            onNavigate("words", { wordId: hit.word.id });
          }
          return;
        case "chat":
          if (inReader || !onNavigate) {
            void resolveFirstChatContextCfi(hit.chat.id).then((cfi) =>
              openReaderWindow(hit.chat.book_id, {
                openChat: true,
                chatId: hit.chat.id,
                ...(cfi ? { cfi } : {}),
              }),
            );
          } else {
            onNavigate("chats", { chatId: hit.chat.id });
          }
          return;
      }
    },
    [onClose, onNavigate],
  );

  const executeSearch = useCallback(
    async (seq: number, trimmed: string) => {
      dispatchedQueryRef.current = { query: trimmed, seq };
      loadingRef.current = true;
      setLoading(true);
      try {
        const [bookRes, hlRes, vocabRes, chatRes] = await Promise.all([
          invoke<BookPage>("list_books", {
            filter: null,
            search: trimmed || null,
            collectionId: null,
            cursor: null,
            limit: 30,
          }).catch(() => null),
          invoke<Highlight[]>("list_all_highlights", {
            bookId: null,
            search: trimmed || null,
            sort: null,
          }).catch(() => null),
          invoke<DictionaryWord[]>("list_all_vocab_words").catch(() => null),
          invoke<ChatPage>("list_all_chats", {
            search: trimmed || null,
            bookId: null,
            cursor: null,
            limit: 30,
          }).catch(() => null),
        ]);
        if (!openRef.current || requestSeqRef.current !== seq) return;

        const nextBooks = Array.isArray(bookRes?.books) ? bookRes.books : [];
        const nextBooksTotal =
          typeof bookRes?.total === "number" ? bookRes.total : nextBooks.length;
        const nextHighlights = Array.isArray(hlRes) ? hlRes : [];
        const rawWords = Array.isArray(vocabRes) ? vocabRes : [];
        const lower = trimmed.toLowerCase();
        const nextWords = lower
          ? rawWords.filter(
              (w) =>
                w.word.toLowerCase().includes(lower) ||
                w.definition.toLowerCase().includes(lower) ||
                (w.context_sentence?.toLowerCase().includes(lower) ?? false) ||
                (w.context_explanation?.toLowerCase().includes(lower) ?? false) ||
                (w.book_title?.toLowerCase().includes(lower) ?? false),
            )
          : rawWords;
        const nextChats = Array.isArray(chatRes?.chats) ? chatRes.chats : [];
        const nextChatsTotal =
          typeof chatRes?.total === "number" ? chatRes.total : nextChats.length;

        setBooks(nextBooks);
        setBooksTotal(nextBooksTotal);
        setHighlights(nextHighlights);
        setWords(nextWords);
        setChats(nextChats);
        setChatsTotal(nextChatsTotal);
        resultsQueryRef.current = trimmed;
        setResultsQuery(trimmed);
        setActiveIndex(0);
        loadingRef.current = false;
        setLoading(false);

        const pending = pendingActivationRef.current;
        if (pending && pending.query === trimmed) {
          pendingActivationRef.current = null;
          const freshItems = buildSearchGroups(
            scopeRef.current,
            nextBooks,
            nextHighlights,
            nextWords,
            nextChats,
            t,
          ).flatMap((g) => g.items);
          if (freshItems[0]) {
            handleActivate(freshItems[0], pending.inReader);
          }
        }
      } catch (err) {
        console.error("Command search failed:", err);
      } finally {
        if (requestSeqRef.current === seq) {
          loadingRef.current = false;
          setLoading(false);
        }
      }
    },
    [handleActivate, t],
  );

  useEffect(() => {
    if (!open) {
      if (searchTimerRef.current !== null) {
        window.clearTimeout(searchTimerRef.current);
        searchTimerRef.current = null;
      }
      requestSeqRef.current += 1;
      dispatchedQueryRef.current = null;
      pendingActivationRef.current = null;
      queryRef.current = "";
      scopeRef.current = initialScope;
      resultsQueryRef.current = null;
      loadingRef.current = false;
      setQuery("");
      setScope(initialScope);
      setBooks([]);
      setBooksTotal(0);
      setHighlights([]);
      setWords([]);
      setChats([]);
      setChatsTotal(0);
      setResultsQuery(null);
      setLoading(false);
      setActiveIndex(0);
      return;
    }
    scopeRef.current = initialScope;
    setScope(initialScope);
    setActiveIndex(0);
    const raf = requestAnimationFrame(() => {
      inputRef.current?.focus();
    });
    return () => cancelAnimationFrame(raf);
  }, [open, initialScope]);

  useEffect(() => {
    if (!open) return;
    const trimmed = query.trim();
    if (
      dispatchedQueryRef.current?.query === trimmed &&
      dispatchedQueryRef.current.seq === requestSeqRef.current
    ) {
      return;
    }
    const seq = ++requestSeqRef.current;
    pendingActivationRef.current = null;
    loadingRef.current = true;
    setLoading(true);
    if (searchTimerRef.current !== null) {
      window.clearTimeout(searchTimerRef.current);
      searchTimerRef.current = null;
    }
    const run = () => {
      searchTimerRef.current = null;
      void executeSearch(seq, trimmed);
    };
    searchTimerRef.current = window.setTimeout(run, trimmed ? 100 : 0);
    return () => {
      if (searchTimerRef.current !== null) {
        window.clearTimeout(searchTimerRef.current);
        searchTimerRef.current = null;
      }
    };
  }, [open, query, executeSearch]);

  const counts = useMemo(() => {
    const hTotal = highlights.length;
    const wTotal = words.length;
    return {
      all: booksTotal + hTotal + wTotal + chatsTotal,
      books: booksTotal,
      highlights: hTotal,
      words: wTotal,
      chats: chatsTotal,
    };
  }, [booksTotal, highlights.length, words.length, chatsTotal]);

  const groups = useMemo(
    () => buildSearchGroups(scope, books, highlights, words, chats, t),
    [scope, books, highlights, words, chats, t],
  );

  const flatItems = useMemo(() => groups.flatMap((g) => g.items), [groups]);

  useEffect(() => {
    if (activeIndex >= flatItems.length && flatItems.length > 0) {
      setActiveIndex(0);
    }
  }, [activeIndex, flatItems.length]);

  useEffect(() => {
    if (!open || flatItems.length === 0) return;
    itemRefs.current[activeIndex]?.scrollIntoView?.({ block: "nearest" });
  }, [open, activeIndex, flatItems.length]);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        pendingActivationRef.current = null;
        onClose();
        return;
      }
      if (e.key === "Tab") {
        e.preventDefault();
        pendingActivationRef.current = null;
        const idx = SCOPE_ORDER.indexOf(scopeRef.current);
        const delta = e.shiftKey ? -1 : 1;
        const nextScope =
          SCOPE_ORDER[(idx + delta + SCOPE_ORDER.length) % SCOPE_ORDER.length];
        scopeRef.current = nextScope;
        setScope(nextScope);
        setActiveIndex(0);
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        pendingActivationRef.current = null;
        setActiveIndex((idx) => (flatItems.length === 0 ? 0 : (idx + 1) % flatItems.length));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        pendingActivationRef.current = null;
        setActiveIndex((idx) =>
          flatItems.length === 0 ? 0 : (idx - 1 + flatItems.length) % flatItems.length,
        );
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        const inReader = Boolean(e.metaKey || e.ctrlKey);
        const currentTrimmed = queryRef.current.trim();
        const settled = !loadingRef.current && resultsQueryRef.current === currentTrimmed;
        if (settled) {
          if (flatItems[activeIndex]) {
            handleActivate(flatItems[activeIndex], inReader);
          }
          return;
        }
        pendingActivationRef.current = { query: currentTrimmed, inReader };
        if (dispatchedQueryRef.current?.query !== currentTrimmed) {
          if (searchTimerRef.current !== null) {
            window.clearTimeout(searchTimerRef.current);
            searchTimerRef.current = null;
          }
          const nextSeq = ++requestSeqRef.current;
          void executeSearch(nextSeq, currentTrimmed);
        }
      }
    };
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [open, flatItems, activeIndex, handleActivate, executeSearch, onClose]);

  if (!open) return null;

  const scopeLabels: Array<{ id: CommandSearchScope; label: string; count: number }> = [
    { id: "all", label: t("commandSearch.scopeAll"), count: counts.all },
    { id: "books", label: t("commandSearch.scopeBooks"), count: counts.books },
    { id: "highlights", label: t("commandSearch.scopeHighlights"), count: counts.highlights },
    { id: "words", label: t("commandSearch.scopeWords"), count: counts.words },
    { id: "chats", label: t("commandSearch.scopeChats"), count: counts.chats },
  ];

  const trimmed = query.trim();
  const isStaleResults = resultsQuery !== trimmed;
  const emptyLabel = trimmed
    ? t("commandSearch.noMatch", { query: trimmed })
    : scope === "books"
      ? t("commandSearch.emptyBooks")
      : scope === "highlights"
        ? t("commandSearch.emptyHighlights")
        : scope === "words"
          ? t("commandSearch.emptyWords")
          : scope === "chats"
            ? t("commandSearch.emptyChats")
            : t("commandSearch.emptyAll");

  let runningIndex = -1;

  return (
    <div
      className="fixed inset-0 z-50 bg-scrim backdrop-blur-[6px] flex justify-center items-start pt-[92px] px-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t("commandSearch.ariaLabel")}
        className="w-full max-w-[680px] rounded-[22px] bg-surface-popover border border-surface-glass-border backdrop-blur-[36px] shadow-[var(--shadow-modal)] overflow-hidden flex flex-col"
      >
        <div className="h-[58px] px-5 flex items-center justify-between gap-3 border-b border-border-subtle">
          <div className="flex-1 min-w-0 flex items-center gap-3">
            <Search size={18} className="text-accent shrink-0" />
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={(e) => {
                const next = e.target.value;
                queryRef.current = next;
                pendingActivationRef.current = null;
                setQuery(next);
              }}
              placeholder={t("commandSearch.placeholder")}
              spellCheck={false}
              autoCorrect="off"
              autoCapitalize="off"
              className="flex-1 min-w-0 bg-transparent text-[16px] font-medium text-text-primary placeholder:text-text-tertiary outline-none"
            />
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {query.length > 0 && (
              <button
                type="button"
                aria-label={t("common.clear")}
                onClick={() => {
                  queryRef.current = "";
                  pendingActivationRef.current = null;
                  setQuery("");
                  inputRef.current?.focus();
                }}
                className="size-[22px] rounded-full bg-track flex items-center justify-center text-text-secondary hover:bg-border-default cursor-pointer transition-colors"
              >
                <X size={12} />
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              className="px-[7px] py-[3px] rounded-[6px] bg-surface-inset border border-border-subtle font-mono text-[10.5px] font-semibold text-text-tertiary hover:text-text-primary cursor-pointer"
            >
              ESC
            </button>
          </div>
        </div>

        <div
          role="tablist"
          aria-label={t("commandSearch.scopesLabel")}
          className="px-5 py-2.5 flex items-center gap-2 border-b border-border-subtle flex-wrap"
        >
          {scopeLabels.map((item) => {
            const active = scope === item.id;
            return (
              <button
                key={item.id}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => {
                  scopeRef.current = item.id;
                  pendingActivationRef.current = null;
                  setScope(item.id);
                  setActiveIndex(0);
                  inputRef.current?.focus();
                }}
                className={`inline-flex items-center gap-1.5 px-[11px] py-1 rounded-full text-[12px] cursor-pointer transition-colors ${
                  active
                    ? "bg-accent-tint text-accent-on-tint font-semibold"
                    : "bg-surface-inset border border-border-subtle text-text-secondary font-medium hover:bg-surface-chip"
                }`}
              >
                <span>{item.label}</span>
                <span
                  className={`font-mono text-[10.5px] font-normal ${
                    active ? "text-accent-on-tint" : "text-text-tertiary"
                  }`}
                >
                  {item.count}
                </span>
              </button>
            );
          })}
        </div>

        <div
          className={`p-2.5 max-h-[384px] overflow-y-auto flex flex-col gap-2.5 transition-opacity ${
            isStaleResults ? "opacity-55 pointer-events-none" : ""
          }`}
        >
          {(loading || isStaleResults) && flatItems.length === 0 ? (
            <div className="py-10 text-center text-[13px] text-text-tertiary">
              {t("library.loading")}
            </div>
          ) : flatItems.length === 0 ? (
            <div className="py-10 text-center text-[13px] text-text-tertiary">
              {emptyLabel}
            </div>
          ) : (
            groups.map((group) => (
              <div key={group.id} className="flex flex-col gap-0.5">
                <div className="px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.9px] text-text-tertiary">
                  {group.title}
                </div>
                {group.items.map((hit) => {
                  runningIndex += 1;
                  const idx = runningIndex;
                  const isSelected = idx === activeIndex;

                  if (hit.kind === "book") {
                    const { book } = hit;
                    const statusText =
                      book.status === "finished"
                        ? t("library.status.finished")
                        : book.status === "reading"
                          ? t("commandSearch.percentRead", { progress: book.progress })
                          : t("library.status.unread");
                    return (
                      <button
                        key={hit.key}
                        ref={(el) => {
                          itemRefs.current[idx] = el;
                        }}
                        type="button"
                        onMouseEnter={() => setActiveIndex(idx)}
                        onClick={(e) => handleActivate(hit, Boolean(e.metaKey || e.ctrlKey))}
                        className={`w-full flex items-center justify-between gap-3 px-2.5 py-2 rounded-[12px] text-left cursor-pointer transition-colors ${
                          isSelected ? "bg-accent-tint" : "hover:bg-surface-hover"
                        }`}
                      >
                        <div className="flex items-center gap-3 min-w-0 flex-1">
                          <BookCover
                            title={book.title}
                            author={book.author}
                            coverData={book.cover_data}
                            coverPath={book.cover_path}
                            radius="xs"
                            shadow={false}
                            className="w-7 h-10 shrink-0"
                          />
                          <div className="min-w-0 flex-1 flex flex-col gap-0.5">
                            <span
                              className={`text-[13.5px] font-semibold truncate ${
                                isSelected ? "text-accent-on-tint" : "text-text-primary"
                              }`}
                            >
                              {book.title}
                            </span>
                            <span
                              className={`text-[12px] truncate ${
                                isSelected ? "text-accent-on-tint/80" : "text-text-tertiary"
                              }`}
                            >
                              {book.author}
                            </span>
                          </div>
                        </div>

                        <div className="flex items-center gap-2 shrink-0">
                          <span
                            className={`font-mono text-[11px] ${
                              isSelected ? "text-accent-on-tint" : "text-text-tertiary"
                            }`}
                          >
                            {statusText}
                          </span>
                          {isSelected && (
                            <span className="px-[7px] py-[3px] rounded-[6px] bg-surface-chip font-mono text-[10.5px] font-semibold text-accent-on-tint">
                              {t("commandSearch.openHint")} ↵
                            </span>
                          )}
                        </div>
                      </button>
                    );
                  }

                  if (hit.kind === "highlight") {
                    const { highlight } = hit;
                    const colorMeta = getHighlightColorMeta(highlight.color);
                    const snippet =
                      highlight.text_content?.trim() ||
                      highlight.note?.trim() ||
                      t("highlights.untitledPassage");
                    return (
                      <button
                        key={hit.key}
                        ref={(el) => {
                          itemRefs.current[idx] = el;
                        }}
                        type="button"
                        onMouseEnter={() => setActiveIndex(idx)}
                        onClick={(e) => handleActivate(hit, Boolean(e.metaKey || e.ctrlKey))}
                        className={`w-full flex items-center justify-between gap-3 px-2.5 py-2.5 rounded-[12px] text-left cursor-pointer transition-colors ${
                          isSelected ? "bg-accent-tint" : "hover:bg-surface-hover"
                        }`}
                      >
                        <div className="flex items-center gap-3 min-w-0 flex-1">
                          <span className={`w-1 h-8 rounded-full shrink-0 ${colorMeta.bgClass}`} />
                          <div className="min-w-0 flex-1 flex flex-col gap-0.5">
                            <span
                              className={`font-reading text-[13px] truncate ${
                                isSelected ? "text-accent-on-tint" : "text-text-primary"
                              }`}
                            >
                              &ldquo;{snippet}&rdquo;
                            </span>
                            <span
                              className={`text-[11.5px] truncate ${
                                isSelected ? "text-accent-on-tint/80" : "text-text-tertiary"
                              }`}
                            >
                              {highlight.book_title || t("common.unknownBook")}
                              {highlight.note ? ` · ${highlight.note}` : ""}
                            </span>
                          </div>
                        </div>
                        {isSelected && (
                          <span className="px-[7px] py-[3px] rounded-[6px] bg-surface-chip font-mono text-[10.5px] font-semibold text-accent-on-tint shrink-0">
                            {t("commandSearch.openHint")} ↵
                          </span>
                        )}
                      </button>
                    );
                  }

                  if (hit.kind === "word") {
                    const { word } = hit;
                    const parsed = parseDefinition(word.definition);
                    const defSnippet = parsed.partOfSpeech
                      ? `${parsed.partOfSpeech} · ${parsed.definition}`
                      : parsed.definition;
                    return (
                      <button
                        key={hit.key}
                        ref={(el) => {
                          itemRefs.current[idx] = el;
                        }}
                        type="button"
                        onMouseEnter={() => setActiveIndex(idx)}
                        onClick={(e) => handleActivate(hit, Boolean(e.metaKey || e.ctrlKey))}
                        className={`w-full flex items-center justify-between gap-3 px-2.5 py-2 rounded-[12px] text-left cursor-pointer transition-colors ${
                          isSelected ? "bg-accent-tint" : "hover:bg-surface-hover"
                        }`}
                      >
                        <div className="flex items-center gap-2.5 min-w-0 flex-1">
                          <span className="size-7 rounded-[8px] bg-surface-inset border border-border-subtle flex items-center justify-center text-text-secondary shrink-0">
                            <Languages size={14} />
                          </span>
                          <div className="min-w-0 flex-1 flex flex-col gap-0.5">
                            <span
                              className={`text-[13.5px] font-semibold truncate ${
                                isSelected ? "text-accent-on-tint" : "text-text-primary"
                              }`}
                            >
                              {word.word}
                            </span>
                            <span
                              className={`text-[12px] truncate ${
                                isSelected ? "text-accent-on-tint/80" : "text-text-tertiary"
                              }`}
                            >
                              {defSnippet}
                            </span>
                          </div>
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          <span
                            className={`font-mono text-[11px] ${
                              isSelected ? "text-accent-on-tint" : "text-text-tertiary"
                            }`}
                          >
                            {t("commandSearch.tagWords")}
                          </span>
                          {isSelected && (
                            <span className="px-[7px] py-[3px] rounded-[6px] bg-surface-chip font-mono text-[10.5px] font-semibold text-accent-on-tint">
                              {t("commandSearch.openHint")} ↵
                            </span>
                          )}
                        </div>
                      </button>
                    );
                  }

                  const { chat } = hit;
                  const msgCount = chat.message_count ?? 0;
                  const chatMeta = [
                    chat.book_title || t("common.unknownBook"),
                    msgCount > 0 ? t("commandSearch.messagesCount", { count: msgCount }) : null,
                    formatShortDate(chat.updated_at, i18n.language),
                  ]
                    .filter(Boolean)
                    .join(" · ");
                  return (
                    <button
                      key={hit.key}
                      ref={(el) => {
                        itemRefs.current[idx] = el;
                      }}
                      type="button"
                      onMouseEnter={() => setActiveIndex(idx)}
                      onClick={(e) => handleActivate(hit, Boolean(e.metaKey || e.ctrlKey))}
                      className={`w-full flex items-center justify-between gap-3 px-2.5 py-2 rounded-[12px] text-left cursor-pointer transition-colors ${
                        isSelected ? "bg-accent-tint" : "hover:bg-surface-hover"
                      }`}
                    >
                      <div className="flex items-center gap-2.5 min-w-0 flex-1">
                        <span className="size-7 rounded-[8px] bg-accent-tint flex items-center justify-center text-accent-on-tint shrink-0">
                          <Sparkles size={14} />
                        </span>
                        <div className="min-w-0 flex-1 flex flex-col gap-0.5">
                          <span
                            className={`text-[13.5px] font-semibold truncate ${
                              isSelected ? "text-accent-on-tint" : "text-text-primary"
                            }`}
                          >
                            {chat.title}
                          </span>
                          <span
                            className={`text-[12px] truncate ${
                              isSelected ? "text-accent-on-tint/80" : "text-text-tertiary"
                            }`}
                          >
                            {chatMeta}
                          </span>
                        </div>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <span
                          className={`font-mono text-[11px] ${
                            isSelected ? "text-accent-on-tint" : "text-text-tertiary"
                          }`}
                        >
                          {t("commandSearch.tagChat")}
                        </span>
                        {isSelected && (
                          <span className="px-[7px] py-[3px] rounded-[6px] bg-surface-chip font-mono text-[10.5px] font-semibold text-accent-on-tint">
                            {t("commandSearch.openHint")} ↵
                          </span>
                        )}
                      </div>
                    </button>
                  );
                })}
              </div>
            ))
          )}
        </div>

        <div className="h-10 px-5 bg-surface-inset border-t border-border-subtle flex items-center justify-between text-[11.5px] shrink-0">
          <div className="flex items-center gap-4">
            <span className="inline-flex items-center gap-1.5">
              <kbd className="font-mono text-[11px] font-semibold text-text-secondary">↑↓</kbd>
              <span className="text-text-tertiary">{t("commandSearch.hintNavigate")}</span>
            </span>
            <span className="inline-flex items-center gap-1.5">
              <kbd className="font-mono text-[11px] font-semibold text-text-secondary">↵</kbd>
              <span className="text-text-tertiary">{t("commandSearch.hintOpen")}</span>
            </span>
            <span className="inline-flex items-center gap-1.5">
              <kbd className="font-mono text-[11px] font-semibold text-text-secondary">
                {mod}↵
              </kbd>
              <span className="text-text-tertiary">{t("commandSearch.hintOpenInReader")}</span>
            </span>
            <span className="inline-flex items-center gap-1.5">
              <kbd className="font-mono text-[11px] font-semibold text-text-secondary">Tab</kbd>
              <span className="text-text-tertiary">{t("commandSearch.hintSwitchScope")}</span>
            </span>
          </div>
          <span className="font-mono text-[11px] text-text-tertiary">
            {t("commandSearch.hintShortcut", { mod })}
          </span>
        </div>
      </div>
    </div>
  );
}
