import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { useTranslation } from "react-i18next";
import {
  ArrowUpDown,
  ArrowUpRight,
  BookOpen,
  ChevronDown,
  Languages,
  SearchX,
  Trash2,
  Volume2,
} from "lucide-react";
import type { Book } from "../hooks/useBooks";
import { useAllDictionary, type DictionaryWord } from "../hooks/useDictionary";
import { shortcutModSymbol } from "../lib/platformEnv";
import { openReaderWindow } from "../utils/openReaderWindow";
import { shouldSuppressSelectionClick } from "../utils/selection";
import {
  formatMonthHeading,
  formatShortDate,
  parseDefinition,
  speakWord,
  useSpeechAvailable,
} from "../utils/vocabParse";
import QuillLogo from "./QuillLogo";
import BookCover from "./ui/BookCover";
import { Menu, MenuItem } from "./ui/Menu";
import SearchField from "./ui/SearchField";

type WordSortMode = "newest" | "oldest" | "az";

interface WordsViewProps {
  booksById: ReadonlyMap<string, Book>;
  initialWordId?: string | null;
  navigationSeq?: number;
  searchInputRef?: RefObject<HTMLInputElement | null>;
  onNavigateToLibrary: () => void;
}

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function renderHighlightedSentence(sentence: string, word: string): ReactNode {
  const trimmed = word.trim();
  if (!trimmed) return sentence;
  const escaped = escapeRegExp(trimmed);
  const pattern = new RegExp(`(\\b${escaped}\\b|${escaped})`, "gi");
  const parts = sentence.split(pattern);
  if (parts.length <= 1) return sentence;
  const lower = trimmed.toLowerCase();
  return parts.map((part, idx) =>
    part.toLowerCase() === lower ? (
      <mark
        key={`${idx}-${part}`}
        className="px-1 py-0.5 rounded-[4px] bg-hl-violet text-text-primary font-semibold"
      >
        {part}
      </mark>
    ) : (
      <Fragment key={idx}>{part}</Fragment>
    ),
  );
}

export default function WordsView({
  booksById,
  initialWordId,
  navigationSeq,
  searchInputRef,
  onNavigateToLibrary,
}: WordsViewProps) {
  const { t, i18n } = useTranslation();
  const mod = shortcutModSymbol();
  const speechAvailable = useSpeechAvailable();

  const { words, loading, refresh, remove } = useAllDictionary();
  const [searchQuery, setSearchQuery] = useState("");
  const [bookFilter, setBookFilter] = useState<string | null>(null);
  const [sortMode, setSortMode] = useState<WordSortMode>("newest");
  const [selectedWordId, setSelectedWordId] = useState<string | null>(initialWordId ?? null);

  const [bookMenuOpen, setBookMenuOpen] = useState(false);
  const [sortMenuOpen, setSortMenuOpen] = useState(false);
  const [armedDeleteId, setArmedDeleteId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const bookPopoverRef = useRef<HTMLDivElement>(null);
  const sortPopoverRef = useRef<HTMLDivElement>(null);
  const deleteClusterRef = useRef<HTMLDivElement>(null);
  const disarmTimerRef = useRef<number | null>(null);
  const [refreshingTarget, setRefreshingTarget] = useState(false);
  const prevNavSeqRef = useRef(navigationSeq);
  const pendingRefreshSeqRef = useRef(0);
  const targetNavPendingRef = useRef(false);

  useEffect(() => {
    const isNewNavigation = prevNavSeqRef.current !== navigationSeq;
    prevNavSeqRef.current = navigationSeq;
    if (isNewNavigation) {
      if (initialWordId !== undefined && initialWordId !== null) {
        setSearchQuery("");
        setBookFilter(null);
        setSelectedWordId(initialWordId);
      }
      targetNavPendingRef.current = true;
      setRefreshingTarget(true);
      const seq = ++pendingRefreshSeqRef.current;
      void refresh().finally(() => {
        if (pendingRefreshSeqRef.current === seq) {
          targetNavPendingRef.current = false;
          setRefreshingTarget(false);
        }
      });
    } else if (initialWordId !== undefined && initialWordId !== null) {
      setSearchQuery("");
      setBookFilter(null);
      setSelectedWordId(initialWordId);
    }
  }, [initialWordId, navigationSeq, refresh]);

  useEffect(() => {
    const onFocus = () => {
      void refresh();
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refresh]);

  const disarmDelete = useCallback(() => {
    setArmedDeleteId(null);
    if (disarmTimerRef.current !== null) {
      window.clearTimeout(disarmTimerRef.current);
      disarmTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    return () => {
      if (disarmTimerRef.current !== null) {
        window.clearTimeout(disarmTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    disarmDelete();
  }, [selectedWordId, disarmDelete]);

  useEffect(() => {
    if (!bookMenuOpen && !sortMenuOpen && !armedDeleteId) return;
    const onPointerDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (bookMenuOpen && bookPopoverRef.current && !bookPopoverRef.current.contains(target)) {
        setBookMenuOpen(false);
      }
      if (sortMenuOpen && sortPopoverRef.current && !sortPopoverRef.current.contains(target)) {
        setSortMenuOpen(false);
      }
      if (armedDeleteId && deleteClusterRef.current && !deleteClusterRef.current.contains(target)) {
        disarmDelete();
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setBookMenuOpen(false);
        setSortMenuOpen(false);
        disarmDelete();
      }
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [bookMenuOpen, sortMenuOpen, armedDeleteId, disarmDelete]);

  const bookOptions = useMemo(() => {
    const map = new Map<string, { title: string; count: number }>();
    for (const w of words) {
      const resolvedTitle =
        booksById.get(w.book_id)?.title ?? w.book_title ?? t("common.unknownBook");
      const existing = map.get(w.book_id);
      if (existing) {
        existing.count += 1;
      } else {
        map.set(w.book_id, { title: resolvedTitle, count: 1 });
      }
    }
    return Array.from(map.entries())
      .map(([bookId, meta]) => ({ bookId, ...meta }))
      .sort((a, b) => b.count - a.count || a.title.localeCompare(b.title));
  }, [words, booksById, t]);

  useEffect(() => {
    if (bookFilter && !bookOptions.some((b) => b.bookId === bookFilter)) {
      setBookFilter(null);
    }
  }, [bookFilter, bookOptions]);

  const filteredWords = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return words.filter((w) => {
      if (bookFilter && w.book_id !== bookFilter) return false;
      if (q && !w.word.toLowerCase().startsWith(q)) return false;
      return true;
    });
  }, [words, bookFilter, searchQuery]);

  const sortedWords = useMemo(() => {
    const copy = [...filteredWords];
    if (sortMode === "newest") {
      return copy.sort((a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id));
    }
    if (sortMode === "oldest") {
      return copy.sort((a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id));
    }
    return copy.sort(
      (a, b) =>
        a.word.localeCompare(b.word, undefined, { sensitivity: "base" }) ||
        a.id.localeCompare(b.id),
    );
  }, [filteredWords, sortMode]);

  // Select the first visible word automatically once loaded, while preserving
  // a pending initialWordId during load or navigation refresh and keeping existing selection intact if search yields 0 matches.
  useEffect(() => {
    if (loading || refreshingTarget || targetNavPendingRef.current) return;
    if (selectedWordId === null && sortedWords.length > 0) {
      setSelectedWordId(sortedWords[0].id);
      return;
    }
    if (selectedWordId !== null && !words.some((w) => w.id === selectedWordId)) {
      setSelectedWordId(sortedWords[0]?.id ?? null);
    }
  }, [loading, refreshingTarget, selectedWordId, sortedWords, words]);

  const activeWord = useMemo<DictionaryWord | null>(() => {
    if (selectedWordId) {
      const matched = words.find((w) => w.id === selectedWordId);
      if (matched) return matched;
    }
    return sortedWords[0] ?? null;
  }, [words, selectedWordId, sortedWords]);

  const multiYear = useMemo(() => {
    const years = new Set<number>();
    for (const w of sortedWords) {
      years.add(new Date(w.created_at).getFullYear());
    }
    return years.size > 1;
  }, [sortedWords]);

  const groupedSections = useMemo(() => {
    if (sortMode === "az") {
      const map = new Map<string, DictionaryWord[]>();
      for (const w of sortedWords) {
        const ch = w.word.trim().charAt(0).toUpperCase();
        const key = /^[A-Z0-9]$/.test(ch) ? ch : ch || "#";
        const bucket = map.get(key);
        if (bucket) {
          bucket.push(w);
        } else {
          map.set(key, [w]);
        }
      }
      return Array.from(map.entries()).map(([key, items]) => ({
        key,
        heading: `${key} — ${items.length}`,
        items,
      }));
    }

    const currentYear = new Date().getFullYear();
    const map = new Map<string, { heading: string; items: DictionaryWord[] }>();
    for (const w of sortedWords) {
      const d = new Date(w.created_at);
      const year = d.getFullYear();
      const key = Number.isNaN(year) ? "unknown" : `${year}-${d.getMonth()}`;
      const existing = map.get(key);
      if (existing) {
        existing.items.push(w);
      } else {
        const heading = formatMonthHeading(
          w.created_at,
          i18n.language,
          multiYear || year !== currentYear,
        );
        map.set(key, { heading, items: [w] });
      }
    }
    return Array.from(map.entries()).map(([key, group]) => ({
      key,
      heading: group.heading,
      items: group.items,
    }));
  }, [sortedWords, sortMode, i18n.language, multiYear]);

  const handleDeleteClick = useCallback(
    async (wordId: string) => {
      if (deletingId) return;
      if (armedDeleteId !== wordId) {
        disarmDelete();
        setArmedDeleteId(wordId);
        disarmTimerRef.current = window.setTimeout(() => {
          setArmedDeleteId(null);
          disarmTimerRef.current = null;
        }, 3000);
        return;
      }

      disarmDelete();
      setDeletingId(wordId);
      const idx = sortedWords.findIndex((w) => w.id === wordId);
      const fallbackNext =
        (idx >= 0 ? sortedWords[idx + 1] ?? sortedWords[idx - 1] : null) ??
        words.find((w) => w.id !== wordId) ??
        null;
      try {
        await remove(wordId);
        setSelectedWordId(fallbackNext?.id ?? null);
      } catch (err) {
        console.error("Failed to remove saved word:", err);
      } finally {
        setDeletingId(null);
      }
    },
    [armedDeleteId, deletingId, disarmDelete, remove, sortedWords, words],
  );

  const isGloballyEmpty = !loading && words.length === 0;
  const sortLabel =
    sortMode === "newest"
      ? t("words.sortNewest")
      : sortMode === "oldest"
        ? t("words.sortOldest")
        : t("words.sortAZ");
  const activeBookFilterTitle =
    bookFilter ? bookOptions.find((b) => b.bookId === bookFilter)?.title ?? t("words.allBooks") : t("words.allBooks");

  const activeParsed = useMemo(
    () => (activeWord ? parseDefinition(activeWord.definition) : null),
    [activeWord],
  );
  const activeBookMeta = activeWord ? booksById.get(activeWord.book_id) ?? null : null;
  const activeBookTitle = activeWord
    ? activeBookMeta?.title ?? activeWord.book_title ?? t("common.unknownBook")
    : "";
  const activeBookAuthor = activeBookMeta?.author ?? "";

  return (
    <main className="flex-1 min-h-0 flex flex-col overflow-hidden px-10 pt-1 pb-6">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-4 pb-5 shrink-0">
        <div className="flex items-baseline gap-3 min-w-0">
          <h1 className="text-[28px] font-semibold tracking-[-0.5px] leading-[1.15] text-text-primary">
            {t("words.title")}
          </h1>
          <span className="font-mono text-[12.5px] text-text-tertiary shrink-0">
            {words.length === 0
              ? t("words.countZero")
              : t("words.summary", {
                  count: words.length,
                  booksLabel: t("common.booksCount", { count: bookOptions.length }),
                })}
          </span>
        </div>

        {!isGloballyEmpty && words.length > 0 && (
          <div className="flex flex-wrap items-center justify-end gap-2.5">
            <SearchField
              ref={searchInputRef}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onClear={() => setSearchQuery("")}
              placeholder={t("words.searchPlaceholder")}
              aria-label={t("words.searchPlaceholder")}
              shortcutHint={`${mod}F`}
              className="w-[210px] sm:w-[235px]"
            />

            {/* All books filter popover */}
            <div className="relative" ref={bookPopoverRef}>
              <button
                type="button"
                onClick={() => {
                  setBookMenuOpen((prev) => !prev);
                  setSortMenuOpen(false);
                }}
                aria-expanded={bookMenuOpen}
                aria-haspopup="menu"
                className={`h-10 px-3.5 rounded-full text-[13px] inline-flex items-center gap-2 cursor-pointer transition-colors focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-focus-ring ${
                  bookFilter
                    ? "bg-accent-tint border border-accent/35 text-accent-on-tint font-semibold"
                    : "dawn-glass text-text-primary font-medium hover:bg-surface-solid"
                }`}
              >
                <BookOpen
                  size={14}
                  className={bookFilter ? "text-accent-fg" : "text-text-secondary"}
                />
                <span className="truncate max-w-[160px]">{activeBookFilterTitle}</span>
                <ChevronDown size={14} className="text-text-tertiary shrink-0" />
              </button>

              {bookMenuOpen && (
                <div className="absolute right-0 top-[calc(100%+6px)] z-30 w-64">
                  <Menu role="menu" aria-label={t("words.bookFilterLabel")} className="max-h-80 overflow-y-auto">
                    <MenuItem
                      role="menuitemradio"
                      aria-checked={bookFilter === null}
                      active={bookFilter === null}
                      shortcut={String(words.length)}
                      onClick={() => {
                        setBookFilter(null);
                        setBookMenuOpen(false);
                      }}
                    >
                      {t("words.allBooks")}
                    </MenuItem>
                    {bookOptions.map((b) => (
                      <MenuItem
                        key={b.bookId}
                        role="menuitemradio"
                        aria-checked={bookFilter === b.bookId}
                        active={bookFilter === b.bookId}
                        shortcut={String(b.count)}
                        onClick={() => {
                          setBookFilter(b.bookId);
                          setBookMenuOpen(false);
                        }}
                      >
                        {b.title}
                      </MenuItem>
                    ))}
                  </Menu>
                </div>
              )}
            </div>

            {/* Sort popover */}
            <div className="relative" ref={sortPopoverRef}>
              <button
                type="button"
                onClick={() => {
                  setSortMenuOpen((prev) => !prev);
                  setBookMenuOpen(false);
                }}
                aria-expanded={sortMenuOpen}
                aria-haspopup="menu"
                aria-label={t("words.sortLabel")}
                className="h-10 px-3.5 rounded-full dawn-glass text-[13px] font-medium text-text-primary hover:bg-surface-solid inline-flex items-center gap-2 cursor-pointer transition-colors focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-focus-ring"
              >
                <ArrowUpDown size={14} className="text-text-secondary" />
                <span>{sortLabel}</span>
                <ChevronDown size={14} className="text-text-tertiary" />
              </button>

              {sortMenuOpen && (
                <div className="absolute right-0 top-[calc(100%+6px)] z-30 w-44">
                  <Menu role="menu" aria-label={t("words.sortLabel")}>
                    {(
                      [
                        { mode: "newest", label: t("words.sortNewest") },
                        { mode: "oldest", label: t("words.sortOldest") },
                        { mode: "az", label: t("words.sortAZ") },
                      ] as const
                    ).map((opt) => (
                      <MenuItem
                        key={opt.mode}
                        role="menuitemradio"
                        aria-checked={sortMode === opt.mode}
                        active={sortMode === opt.mode}
                        shortcut={sortMode === opt.mode ? "✓" : undefined}
                        onClick={() => {
                          setSortMode(opt.mode);
                          setSortMenuOpen(false);
                        }}
                      >
                        {opt.label}
                      </MenuItem>
                    ))}
                  </Menu>
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Body */}
      {isGloballyEmpty ? (
        <div className="flex-1 min-h-0 dawn-glass rounded-surface flex items-center justify-center p-8">
          <div className="max-w-[420px] flex flex-col items-center text-center">
            <div className="size-12 rounded-[14px] bg-accent-tint text-accent-fg flex items-center justify-center mb-4">
              <Languages size={22} />
            </div>
            <h2 className="text-[20px] font-semibold tracking-[-0.3px] text-text-primary mb-2">
              {t("words.emptyTitle")}
            </h2>
            <p className="text-[13.5px] leading-[1.55] text-text-secondary mb-6">
              {t("words.emptyBody")}
            </p>
            <button
              type="button"
              onClick={onNavigateToLibrary}
              className="h-10 px-5 rounded-control bg-accent hover:bg-accent-hover text-text-on-accent text-[13.5px] font-semibold inline-flex items-center gap-2 cursor-pointer transition-colors"
            >
              <BookOpen size={15} />
              <span>{t("words.emptyCta")}</span>
            </button>
          </div>
        </div>
      ) : loading && words.length === 0 ? (
        <div className="flex-1 min-h-0 dawn-glass rounded-surface flex items-center justify-center text-[13.5px] text-text-tertiary">
          {t("common.loading")}
        </div>
      ) : (
        <div className="flex-1 min-h-0 flex gap-4 overflow-hidden">
          {/* Left Word List (visible scrollbar — #322) */}
          <aside
            aria-label={t("words.listLabel")}
            className="w-[380px] xl:w-[440px] shrink-0 dawn-glass rounded-surface p-3 overflow-y-auto flex flex-col"
          >
            {sortedWords.length === 0 ? (
              <div className="flex-1 flex flex-col items-center justify-center text-center px-6 py-8">
                <div className="size-10 rounded-full bg-surface-inset border border-border-subtle flex items-center justify-center text-text-tertiary mb-3">
                  <SearchX size={18} />
                </div>
                <p className="text-[14.5px] font-semibold text-text-primary mb-1">
                  {searchQuery.trim()
                    ? t("words.noMatchTitle", { query: searchQuery.trim() })
                    : t("words.noMatchBookTitle")}
                </p>
                <p className="text-[12.5px] text-text-secondary leading-[1.45] mb-4">
                  {t("words.noMatchBody")}
                </p>
                <button
                  type="button"
                  onClick={() => {
                    setSearchQuery("");
                    setBookFilter(null);
                  }}
                  className="h-8 px-4 rounded-control bg-surface-chip border border-border-default hover:bg-surface-solid text-[12.5px] font-medium text-text-primary cursor-pointer transition-colors"
                >
                  {t("words.clearSearch")}
                </button>
              </div>
            ) : (
              <div className="flex flex-col gap-3">
                {groupedSections.map((group) => (
                  <div key={group.key}>
                    <div className="px-2.5 pt-1 pb-1.5 font-mono text-[11px] font-semibold tracking-[0.08em] uppercase text-text-tertiary">
                      {group.heading}
                    </div>
                    <div className="flex flex-col gap-0.5">
                      {group.items.map((w) => {
                        const selected = activeWord?.id === w.id;
                        const parsed = parseDefinition(w.definition);
                        const briefGloss = parsed.definition.split(/\n+/)[0]?.trim() ?? "";
                        const rowBookTitle =
                          booksById.get(w.book_id)?.title ??
                          w.book_title ??
                          t("common.unknownBook");

                        return (
                          <button
                            key={w.id}
                            type="button"
                            onClick={(e) => {
                              if (shouldSuppressSelectionClick(e)) return;
                              setSelectedWordId(w.id);
                            }}
                            aria-current={selected ? "true" : undefined}
                            className={`w-full px-3 py-2.5 rounded-[6px] text-left cursor-pointer transition-colors ${
                              selected
                                ? "bg-accent-tint text-accent-on-tint"
                                : "text-text-primary hover:bg-surface-hover"
                            }`}
                          >
                            {sortMode === "az" ? (
                              <>
                                <div className="flex items-baseline justify-between gap-2">
                                  <span
                                    className={`font-reading text-[16px] font-semibold truncate ${
                                      selected ? "text-accent-on-tint" : "text-text-primary"
                                    }`}
                                  >
                                    {w.word}
                                  </span>
                                  <span className="text-[11.5px] text-text-tertiary truncate max-w-[45%] shrink-0">
                                    {rowBookTitle}
                                  </span>
                                </div>
                                {(parsed.partOfSpeech || briefGloss) && (
                                  <p className="text-[12.5px] text-text-secondary truncate mt-0.5 select-text">
                                    {[parsed.partOfSpeech, briefGloss].filter(Boolean).join(" · ")}
                                  </p>
                                )}
                              </>
                            ) : (
                              <>
                                <div className="flex items-baseline gap-2 min-w-0">
                                  <span
                                    className={`font-reading text-[16px] font-semibold shrink-0 ${
                                      selected ? "text-accent-on-tint" : "text-text-primary"
                                    }`}
                                  >
                                    {w.word}
                                  </span>
                                  {briefGloss && (
                                    <span
                                      className={`text-[12.5px] truncate select-text ${
                                        selected ? "text-accent-on-tint/80" : "text-text-tertiary"
                                      }`}
                                    >
                                      {briefGloss}
                                    </span>
                                  )}
                                </div>
                                <p className="text-[12px] text-text-tertiary truncate mt-0.5">
                                  {rowBookTitle}
                                </p>
                              </>
                            )}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </aside>

          {/* Right Detail Pane */}
          <section className="flex-1 min-w-0 dawn-glass rounded-surface overflow-y-auto p-8">
            {activeWord && activeParsed ? (
              <div className="max-w-[740px]">
                <div className="flex items-start justify-between gap-4">
                  <h2 className="font-reading text-[44px] xl:text-[50px] font-semibold tracking-[-0.02em] leading-[1.08] text-text-primary select-text break-words">
                    {activeWord.word}
                  </h2>

                  <div
                    ref={deleteClusterRef}
                    className="flex items-center gap-2 shrink-0 pt-2"
                  >
                    <button
                      type="button"
                      disabled={deletingId === activeWord.id}
                      onClick={() => handleDeleteClick(activeWord.id)}
                      aria-label={t("words.deleteWord")}
                      className="size-9 rounded-control bg-surface-chip border border-border-default hover:bg-danger-tint hover:text-danger hover:border-danger/30 text-text-secondary flex items-center justify-center cursor-pointer transition-colors disabled:opacity-50"
                    >
                      <Trash2 size={15} />
                    </button>

                    {armedDeleteId === activeWord.id && (
                      <button
                        type="button"
                        disabled={deletingId === activeWord.id}
                        onClick={() => handleDeleteClick(activeWord.id)}
                        className="h-9 px-3.5 rounded-control bg-danger hover:bg-danger-hover text-text-on-accent text-[12.5px] font-semibold inline-flex items-center gap-1.5 cursor-pointer transition-colors disabled:opacity-60"
                      >
                        <Trash2 size={13} />
                        <span>{t("words.clickAgainToDelete")}</span>
                      </button>
                    )}
                  </div>
                </div>

                {(speechAvailable || activeParsed.pronunciation || activeParsed.partOfSpeech) && (
                  <div className="flex flex-wrap items-center gap-2.5 mt-3 mb-7">
                    {speechAvailable && (
                      <button
                        type="button"
                        onClick={() => speakWord(activeWord.word)}
                        aria-label={t("words.pronounce")}
                        className="size-8 rounded-control bg-surface-chip border border-border-default hover:bg-surface-solid text-text-secondary hover:text-text-primary inline-flex items-center justify-center cursor-pointer transition-colors"
                      >
                        <Volume2 size={15} />
                      </button>
                    )}
                    {activeParsed.pronunciation && (
                      <span className="font-mono text-[14px] text-text-secondary">
                        {activeParsed.pronunciation}
                      </span>
                    )}
                    {activeParsed.partOfSpeech && (
                      <span className="px-2.5 py-0.5 rounded-full bg-accent-tint text-accent-on-tint text-[12px] font-semibold">
                        {activeParsed.partOfSpeech}
                      </span>
                    )}
                  </div>
                )}

                {activeParsed.definition && (
                  <div className="mb-7 mt-5">
                    <h3 className="font-mono text-[11px] font-semibold tracking-[0.08em] uppercase text-text-tertiary mb-2">
                      {t("words.meaningHeading")}
                    </h3>
                    <p className="text-[15.5px] leading-[1.6] text-text-primary whitespace-pre-wrap select-text">
                      {activeParsed.definition}
                    </p>
                  </div>
                )}

                {activeWord.context_sentence && (
                  <div className="mb-7">
                    <h3 className="font-mono text-[11px] font-semibold tracking-[0.08em] uppercase text-text-tertiary mb-2.5">
                      {t("words.inContextHeading")}
                    </h3>
                    <div className="bg-paper rounded-[6px] border border-border-subtle p-5">
                      <p className="font-reading text-[16px] leading-[1.65] text-text-primary select-text">
                        {renderHighlightedSentence(activeWord.context_sentence, activeWord.word)}
                      </p>

                      <div className="mt-4 pt-3.5 border-t border-border-subtle flex flex-wrap items-center justify-between gap-3">
                        <div className="flex items-center gap-2.5 min-w-0">
                          <BookCover
                            title={activeBookTitle}
                            author={activeBookAuthor}
                            coverData={activeBookMeta?.cover_data}
                            coverPath={activeBookMeta?.cover_path}
                            radius="xs"
                            shadow={false}
                            className="w-[22px] h-8 shrink-0"
                          />
                          <span className="text-[12.5px] text-text-secondary truncate">
                            {[
                              activeBookTitle,
                              activeBookAuthor,
                              t("words.savedDate", {
                                date: formatShortDate(activeWord.created_at, i18n.language),
                              }),
                            ]
                              .filter(Boolean)
                              .join(" · ")}
                          </span>
                        </div>

                        <button
                          type="button"
                          onClick={() =>
                            openReaderWindow(activeWord.book_id, {
                              openVocab: true,
                              ...(activeWord.cfi ? { cfi: activeWord.cfi } : {}),
                            })
                          }
                          className="text-[12.5px] font-medium text-text-primary hover:text-accent-fg inline-flex items-center gap-1 cursor-pointer transition-colors shrink-0"
                        >
                          <ArrowUpRight size={14} />
                          <span>{t("words.goToPassage")}</span>
                        </button>
                      </div>
                    </div>
                  </div>
                )}

                {activeWord.context_explanation && (
                  <div>
                    <h3 className="font-mono text-[11px] font-semibold tracking-[0.08em] uppercase text-text-tertiary mb-2.5">
                      {t("words.inThisPassageHeading")}
                    </h3>
                    <div className="flex items-start gap-2.5">
                      <QuillLogo size={18} className="mt-0.5 shrink-0" />
                      <p className="text-[14.5px] leading-[1.6] text-text-primary whitespace-pre-wrap select-text">
                        {activeWord.context_explanation}
                      </p>
                    </div>
                  </div>
                )}
              </div>
            ) : null}
          </section>
        </div>
      )}
    </main>
  );
}
