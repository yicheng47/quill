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
import { invoke } from "../platform";
import type { Book } from "../hooks/useBooks";
import { useAllDictionary, type DictionaryWord } from "../hooks/useDictionary";
import { shortcutModSymbol } from "../lib/platformEnv";
import { openReaderWindow } from "../utils/openReaderWindow";
import { shouldSuppressSelectionClick } from "../utils/selection";
import {
  formatMonthHeading,
  formatPronunciation,
  formatShortDate,
  parseSavedVocabDefinition,
  speakWord,
  splitHighlightedForms,
  useSpeechAvailable,
  type ParsedSavedVocabDefinition,
} from "../utils/vocabParse";
import { getVocabGroupKey, getVocabSortKey, matchesVocabSearch } from "../utils/pinyin";
import {
  resolveBriefGloss,
  type DictionarySenseGroup,
  type LookupDictionaryResult,
} from "../types/dictionary";
import { DICT_HTML_PROSE } from "./lookup-prose";
import QuillLogo from "./QuillLogo";
import BookCover from "./ui/BookCover";
import { Menu, MenuItem } from "./ui/Menu";
import SearchField from "./ui/SearchField";

type WordSortMode = "newest" | "oldest" | "az";

const DETAIL_INITIAL_SENSES = 4;

interface VocabGroup {
  key: string;
  lemma: string;
  encounters: DictionaryWord[];
  totalEncounterCount: number;
  latestCreatedAt: number;
  oldestCreatedAt: number;
  bookIds: Set<string>;
  parsedFallback: ParsedSavedVocabDefinition;
}

const HANZI_RE = /[\u3400-\u4dbf\u4e00-\u9fff]/;
const LATIN_RE = /[A-Za-z]/;

function resolveFallbackBriefGloss(
  fallbackGloss: string | null,
  showTranslation: boolean,
  targetLanguage: string,
): string | null {
  if (!showTranslation || !fallbackGloss?.trim()) return null;
  const trimmed = fallbackGloss.trim();
  const target = targetLanguage.trim().toLowerCase();
  if (target.startsWith("zh")) {
    return HANZI_RE.test(trimmed) ? trimmed : null;
  }
  if (target.startsWith("en")) {
    return LATIN_RE.test(trimmed) && !HANZI_RE.test(trimmed) ? trimmed : null;
  }
  return trimmed;
}

interface WordsViewProps {
  booksById: ReadonlyMap<string, Book>;
  initialWordId?: string | null;
  navigationSeq?: number;
  searchInputRef?: RefObject<HTMLInputElement | null>;
  onNavigateToLibrary: () => void;
}

function renderHighlightedSentence(sentence: string, forms: ReadonlyArray<string>): ReactNode {
  const segments = splitHighlightedForms(sentence, forms);
  if (segments.length <= 1 && !segments[0]?.highlight) return sentence;
  return segments.map((seg, idx) =>
    seg.highlight ? (
      <mark
        key={`${idx}-${seg.text}`}
        className="px-1 py-0.5 rounded-[4px] bg-hl-violet text-text-primary font-semibold"
      >
        {seg.text}
      </mark>
    ) : (
      <Fragment key={idx}>{seg.text}</Fragment>
    ),
  );
}

function sliceSenseGroups(
  groups: DictionarySenseGroup[],
  limit: number | null,
): { visibleGroups: DictionarySenseGroup[]; hiddenCount: number } {
  let total = 0;
  for (const g of groups) total += g.defs.length;
  if (limit === null || total <= limit) {
    return { visibleGroups: groups, hiddenCount: 0 };
  }
  const visibleGroups: DictionarySenseGroup[] = [];
  let remaining = limit;
  for (const g of groups) {
    if (remaining <= 0) break;
    const take = g.defs.slice(0, remaining);
    if (take.length > 0) {
      visibleGroups.push({ pos: g.pos, defs: take });
      remaining -= take.length;
    }
  }
  return { visibleGroups, hiddenCount: total - limit };
}

function buildVocabGroups(rows: DictionaryWord[]): VocabGroup[] {
  const map = new Map<string, DictionaryWord[]>();
  for (const row of rows) {
    const key = row.word.trim().toLowerCase();
    if (!key) continue;
    const list = map.get(key);
    if (list) {
      list.push(row);
    } else {
      map.set(key, [row]);
    }
  }

  const groups: VocabGroup[] = [];
  for (const [key, list] of map.entries()) {
    const encounters = [...list].sort(
      (a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id),
    );
    const newest = encounters[0];
    const oldest = encounters[encounters.length - 1];
    const bookIds = new Set(encounters.map((e) => e.book_id));
    groups.push({
      key,
      lemma: newest.word.trim(),
      encounters,
      totalEncounterCount: encounters.length,
      latestCreatedAt: newest.created_at,
      oldestCreatedAt: oldest.created_at,
      bookIds,
      parsedFallback: parseSavedVocabDefinition(newest.definition),
    });
  }
  return groups;
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

  const { words, loading, refresh, remove, removeLemma } = useAllDictionary();
  const [searchQuery, setSearchQuery] = useState("");
  const [bookFilter, setBookFilter] = useState<string | null>(null);
  const [sortMode, setSortMode] = useState<WordSortMode>("newest");
  const [selectedGroupKey, setSelectedGroupKey] = useState<string | null>(null);
  const [pendingInitialWordId, setPendingInitialWordId] = useState<string | null>(
    initialWordId ?? null,
  );

  const [bookMenuOpen, setBookMenuOpen] = useState(false);
  const [sortMenuOpen, setSortMenuOpen] = useState(false);
  const [armedDeleteKey, setArmedDeleteKey] = useState<string | null>(null);
  const [deletingKey, setDeletingKey] = useState<string | null>(null);
  const [deletingEncounterId, setDeletingEncounterId] = useState<string | null>(null);

  const [prefs, setPrefs] = useState({
    showTranslation: false,
    glossTarget: "en",
    showAllMatches: true,
  });
  const [liveDictState, setLiveDictState] = useState<{
    lemma: string;
    result: LookupDictionaryResult | null;
  } | null>(null);
  const [activeDictIdx, setActiveDictIdx] = useState(0);
  const [expandedSenses, setExpandedSenses] = useState(false);

  const bookPopoverRef = useRef<HTMLDivElement>(null);
  const sortPopoverRef = useRef<HTMLDivElement>(null);
  const deleteClusterRef = useRef<HTMLDivElement>(null);
  const disarmTimerRef = useRef<number | null>(null);
  const [refreshingTarget, setRefreshingTarget] = useState(false);
  const prevNavSeqRef = useRef(navigationSeq);
  const pendingRefreshSeqRef = useRef(0);
  const targetNavPendingRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    invoke<Record<string, string>>("get_all_settings")
      .then((map) => {
        if (cancelled || !map || typeof map !== "object") return;
        setPrefs({
          showTranslation: map.show_translation === "true",
          glossTarget: map.lookup_translation_language || map.language || "en",
          showAllMatches: map.dictionary_show_all_matches !== "false",
        });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const isNewNavigation = prevNavSeqRef.current !== navigationSeq;
    prevNavSeqRef.current = navigationSeq;
    if (isNewNavigation) {
      if (initialWordId !== undefined && initialWordId !== null) {
        setSearchQuery("");
        setBookFilter(null);
        setPendingInitialWordId(initialWordId);
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
      setPendingInitialWordId(initialWordId);
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
    setArmedDeleteKey(null);
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
  }, [selectedGroupKey, disarmDelete]);

  useEffect(() => {
    if (!bookMenuOpen && !sortMenuOpen && !armedDeleteKey) return;
    const onPointerDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (bookMenuOpen && bookPopoverRef.current && !bookPopoverRef.current.contains(target)) {
        setBookMenuOpen(false);
      }
      if (sortMenuOpen && sortPopoverRef.current && !sortPopoverRef.current.contains(target)) {
        setSortMenuOpen(false);
      }
      if (armedDeleteKey && deleteClusterRef.current && !deleteClusterRef.current.contains(target)) {
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
  }, [bookMenuOpen, sortMenuOpen, armedDeleteKey, disarmDelete]);

  const allGroups = useMemo(() => buildVocabGroups(words), [words]);

  // Resolve pending initialWordId (encounter id or lemma) to a canonical group key once loaded
  useEffect(() => {
    if (!pendingInitialWordId || words.length === 0) return;
    const byId = words.find((w) => w.id === pendingInitialWordId);
    if (byId) {
      setSelectedGroupKey(byId.word.trim().toLowerCase());
      setPendingInitialWordId(null);
      return;
    }
    const lowerTarget = pendingInitialWordId.trim().toLowerCase();
    if (allGroups.some((g) => g.key === lowerTarget)) {
      setSelectedGroupKey(lowerTarget);
      setPendingInitialWordId(null);
    }
  }, [pendingInitialWordId, words, allGroups]);

  const bookOptions = useMemo(() => {
    const map = new Map<string, { title: string; count: number }>();
    for (const g of allGroups) {
      for (const bid of g.bookIds) {
        const sample = g.encounters.find((e) => e.book_id === bid);
        const resolvedTitle =
          booksById.get(bid)?.title ?? sample?.book_title ?? t("common.unknownBook");
        const existing = map.get(bid);
        if (existing) {
          existing.count += 1;
        } else {
          map.set(bid, { title: resolvedTitle, count: 1 });
        }
      }
    }
    return Array.from(map.entries())
      .map(([bookId, meta]) => ({ bookId, ...meta }))
      .sort((a, b) => b.count - a.count || a.title.localeCompare(b.title));
  }, [allGroups, booksById, t]);

  useEffect(() => {
    if (bookFilter && !bookOptions.some((b) => b.bookId === bookFilter)) {
      setBookFilter(null);
    }
  }, [bookFilter, bookOptions]);

  const filteredGroups = useMemo(() => {
    const q = searchQuery.trim();
    const scoped: VocabGroup[] = [];
    for (const g of allGroups) {
      if (bookFilter && !g.bookIds.has(bookFilter)) continue;
      if (
        q &&
        !matchesVocabSearch(
          g.lemma,
          q,
          g.parsedFallback.gloss,
          g.parsedFallback.definition,
        )
      ) {
        continue;
      }
      if (bookFilter) {
        const bookEncounters = g.encounters.filter((e) => e.book_id === bookFilter);
        if (bookEncounters.length === 0) continue;
        scoped.push({
          ...g,
          encounters: bookEncounters,
          latestCreatedAt: bookEncounters[0].created_at,
          oldestCreatedAt: bookEncounters[bookEncounters.length - 1].created_at,
        });
      } else {
        scoped.push(g);
      }
    }
    return scoped;
  }, [allGroups, bookFilter, searchQuery]);

  const sortedGroups = useMemo(() => {
    const copy = [...filteredGroups];
    if (sortMode === "newest") {
      return copy.sort((a, b) => b.latestCreatedAt - a.latestCreatedAt || a.key.localeCompare(b.key));
    }
    if (sortMode === "oldest") {
      return copy.sort((a, b) => a.oldestCreatedAt - b.oldestCreatedAt || a.key.localeCompare(b.key));
    }
    return copy.sort(
      (a, b) => getVocabSortKey(a.lemma).localeCompare(getVocabSortKey(b.lemma)),
    );
  }, [filteredGroups, sortMode]);

  useEffect(() => {
    if (loading || refreshingTarget || targetNavPendingRef.current || pendingInitialWordId) return;
    if (selectedGroupKey === null && sortedGroups.length > 0) {
      setSelectedGroupKey(sortedGroups[0].key);
      return;
    }
    if (selectedGroupKey !== null && !allGroups.some((g) => g.key === selectedGroupKey)) {
      setSelectedGroupKey(sortedGroups[0]?.key ?? null);
    }
  }, [loading, refreshingTarget, pendingInitialWordId, selectedGroupKey, sortedGroups, allGroups]);

  const activeGroup = useMemo<VocabGroup | null>(() => {
    if (selectedGroupKey) {
      const matched =
        filteredGroups.find((g) => g.key === selectedGroupKey) ??
        allGroups.find((g) => g.key === selectedGroupKey);
      if (matched) return matched;
    }
    return sortedGroups[0] ?? null;
  }, [filteredGroups, allGroups, selectedGroupKey, sortedGroups]);

  // Query live offline dictionary when selected lemma changes
  const activeLemma = activeGroup?.lemma ?? null;
  useEffect(() => {
    if (!activeLemma) {
      setLiveDictState(null);
      return;
    }
    let cancelled = false;
    setActiveDictIdx(0);
    setExpandedSenses(false);
    invoke<LookupDictionaryResult | null>("lookup_dictionary", { term: activeLemma })
      .then((res) => {
        if (cancelled) return;
        const valid = res && typeof res === "object" && Array.isArray(res.matches) ? res : null;
        setLiveDictState({ lemma: activeLemma, result: valid });
      })
      .catch(() => {
        if (!cancelled) setLiveDictState({ lemma: activeLemma, result: null });
      });
    return () => {
      cancelled = true;
    };
  }, [activeLemma]);

  const liveDict =
    activeLemma && liveDictState?.lemma === activeLemma ? liveDictState.result : null;

  const multiYear = useMemo(() => {
    const years = new Set<number>();
    for (const g of sortedGroups) {
      const ts = sortMode === "oldest" ? g.oldestCreatedAt : g.latestCreatedAt;
      years.add(new Date(ts).getFullYear());
    }
    return years.size > 1;
  }, [sortedGroups, sortMode]);

  const groupedSections = useMemo(() => {
    if (sortMode === "az") {
      const map = new Map<string, VocabGroup[]>();
      for (const g of sortedGroups) {
        const key = getVocabGroupKey(g.lemma);
        const bucket = map.get(key);
        if (bucket) {
          bucket.push(g);
        } else {
          map.set(key, [g]);
        }
      }
      return Array.from(map.entries()).map(([key, items]) => ({
        key,
        isAlpha: true,
        heading: key,
        items,
      }));
    }

    const currentYear = new Date().getFullYear();
    const map = new Map<string, { heading: string; items: VocabGroup[] }>();
    for (const g of sortedGroups) {
      const ts = sortMode === "oldest" ? g.oldestCreatedAt : g.latestCreatedAt;
      const d = new Date(ts);
      const year = d.getFullYear();
      const key = Number.isNaN(year) ? "unknown" : `${year}-${d.getMonth()}`;
      const existing = map.get(key);
      if (existing) {
        existing.items.push(g);
      } else {
        const heading = formatMonthHeading(
          ts,
          i18n.language,
          multiYear || year !== currentYear,
        );
        map.set(key, { heading, items: [g] });
      }
    }
    return Array.from(map.entries()).map(([key, group]) => ({
      key,
      isAlpha: false,
      heading: group.heading,
      items: group.items,
    }));
  }, [sortedGroups, sortMode, i18n.language, multiYear]);

  const handleDeleteGroupClick = useCallback(
    async (group: VocabGroup) => {
      if (deletingKey) return;
      if (armedDeleteKey !== group.key) {
        disarmDelete();
        setArmedDeleteKey(group.key);
        disarmTimerRef.current = window.setTimeout(() => {
          setArmedDeleteKey(null);
          disarmTimerRef.current = null;
        }, 3000);
        return;
      }

      disarmDelete();
      setDeletingKey(group.key);
      const idx = sortedGroups.findIndex((g) => g.key === group.key);
      const fallbackNext =
        (idx >= 0 ? sortedGroups[idx + 1] ?? sortedGroups[idx - 1] : null) ??
        allGroups.find((g) => g.key !== group.key) ??
        null;
      try {
        await removeLemma(group.lemma);
        setSelectedGroupKey(fallbackNext?.key ?? null);
      } catch (err) {
        console.error("Failed to remove saved vocab entry:", err);
      } finally {
        setDeletingKey(null);
      }
    },
    [armedDeleteKey, deletingKey, disarmDelete, removeLemma, sortedGroups, allGroups],
  );

  const handleDeleteEncounter = useCallback(
    async (encounterId: string) => {
      if (deletingEncounterId) return;
      setDeletingEncounterId(encounterId);
      try {
        await remove(encounterId);
      } catch (err) {
        console.error("Failed to remove saved encounter:", err);
      } finally {
        setDeletingEncounterId(null);
      }
    },
    [deletingEncounterId, remove],
  );

  const isGloballyEmpty = !loading && words.length === 0;
  const sortLabel =
    sortMode === "newest"
      ? t("words.sortNewest")
      : sortMode === "oldest"
        ? t("words.sortOldest")
        : t("words.sortAZ");
  const activeBookFilterTitle = bookFilter
    ? bookOptions.find((b) => b.bookId === bookFilter)?.title ?? t("words.allBooks")
    : t("words.allBooks");

  const liveMatches = liveDict?.matches ?? [];
  const activeLiveMatch = liveMatches[activeDictIdx] ?? liveMatches[0] ?? null;
  const showDetailSwitcher = liveMatches.length > 1 && prefs.showAllMatches;

  const detailPronunciation = activeGroup
    ? formatPronunciation(
        activeLiveMatch?.pronunciation ?? activeGroup.parsedFallback.pronunciation,
        liveDict?.lang || activeGroup.lemma,
      )
    : null;

  const detailPos =
    activeLiveMatch?.senses?.[0]?.pos || activeGroup?.parsedFallback.partOfSpeech || null;

  const detailBriefGloss = activeGroup
    ? activeLiveMatch
      ? resolveBriefGloss(
          activeLiveMatch,
          prefs.showTranslation,
          prefs.glossTarget,
          liveDict?.lang ?? "",
        )
      : resolveFallbackBriefGloss(
          activeGroup.parsedFallback.gloss,
          prefs.showTranslation,
          prefs.glossTarget,
        )
    : null;

  const highlightForms = useMemo(() => {
    if (!activeGroup) return [];
    const forms = [activeGroup.lemma];
    if (liveDict?.forms) {
      for (const f of liveDict.forms) {
        if (f.trim()) forms.push(f.trim());
      }
    }
    return forms;
  }, [activeGroup, liveDict]);

  const detailSenseSlice =
    activeLiveMatch?.senses && activeLiveMatch.senses.length > 0
      ? sliceSenseGroups(activeLiveMatch.senses, expandedSenses ? null : DETAIL_INITIAL_SENSES)
      : null;

  return (
    <main className="flex-1 min-h-0 flex flex-col overflow-hidden px-10 pt-1 pb-6">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-4 pb-5 shrink-0">
        <div className="flex items-baseline gap-3 min-w-0">
          <h1 className="text-[28px] font-semibold tracking-[-0.5px] leading-[1.15] text-text-primary">
            {t("words.title")}
          </h1>
          <span className="font-mono text-[12.5px] text-text-tertiary shrink-0">
            {allGroups.length === 0
              ? t("words.countZero")
              : words.length > allGroups.length
                ? t("words.summaryWithPassages", {
                    count: allGroups.length,
                    passages: words.length,
                    booksLabel: t("common.booksCount", { count: bookOptions.length }),
                  })
                : t("words.summary", {
                    count: allGroups.length,
                    booksLabel: t("common.booksCount", { count: bookOptions.length }),
                  })}
          </span>
        </div>

        {!isGloballyEmpty && allGroups.length > 0 && (
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
                  <Menu
                    role="menu"
                    aria-label={t("words.bookFilterLabel")}
                    className="max-h-80 overflow-y-auto"
                  >
                    <MenuItem
                      role="menuitemradio"
                      aria-checked={bookFilter === null}
                      active={bookFilter === null}
                      shortcut={String(allGroups.length)}
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
          {/* Left Vocab List */}
          <aside
            aria-label={t("words.listLabel")}
            className="w-[380px] xl:w-[440px] shrink-0 dawn-glass rounded-surface p-3 overflow-y-auto flex flex-col"
          >
            {sortedGroups.length === 0 ? (
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
                {groupedSections.map((section) => (
                  <div key={section.key}>
                    {section.isAlpha ? (
                      <div className="px-2.5 pt-1 pb-1.5 flex items-center gap-2">
                        <span className="font-mono text-[11px] font-semibold tracking-[0.08em] uppercase text-accent-on-tint">
                          {section.heading}
                        </span>
                        <span className="flex-1 h-px bg-border-subtle" />
                        <span className="font-mono text-[10.5px] text-text-tertiary">
                          {section.items.length}
                        </span>
                      </div>
                    ) : (
                      <div className="px-2.5 pt-1 pb-1.5 font-mono text-[11px] font-semibold tracking-[0.08em] uppercase text-text-tertiary">
                        {section.heading}
                      </div>
                    )}
                    <div className="flex flex-col gap-0.5">
                      {section.items.map((g) => {
                        const selected = activeGroup?.key === g.key;
                        const parsed = g.parsedFallback;
                        const briefGloss =
                          resolveFallbackBriefGloss(
                            parsed.gloss,
                            prefs.showTranslation,
                            prefs.glossTarget,
                          ) ||
                          parsed.definition.split(/\n+/)[0]?.trim() ||
                          "";
                        const latest = g.encounters[0];
                        const primaryBookTitle =
                          booksById.get(latest.book_id)?.title ??
                          latest.book_title ??
                          t("common.unknownBook");
                        const extraBooks = g.bookIds.size - 1;
                        const rowBookLabel =
                          extraBooks > 0
                            ? `${primaryBookTitle} +${extraBooks}`
                            : primaryBookTitle;

                        return (
                          <button
                            key={g.key}
                            type="button"
                            onClick={(e) => {
                              if (shouldSuppressSelectionClick(e)) return;
                              setSelectedGroupKey(g.key);
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
                                  <div className="flex items-baseline gap-1.5 min-w-0">
                                    <span
                                      className={`font-reading text-[16px] font-semibold truncate ${
                                        selected ? "text-accent-on-tint" : "text-text-primary"
                                      }`}
                                    >
                                      {g.lemma}
                                    </span>
                                    {g.encounters.length > 1 && (
                                      <span
                                        data-testid={`vocab-count-badge-${g.key}`}
                                        className="px-1.5 py-0.5 rounded-full bg-surface-inset border border-border-subtle font-mono text-[10px] font-semibold leading-none text-text-tertiary shrink-0"
                                      >
                                        ×{g.encounters.length}
                                      </span>
                                    )}
                                  </div>
                                  <span className="text-[11.5px] text-text-tertiary truncate max-w-[45%] shrink-0">
                                    {rowBookLabel}
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
                                    {g.lemma}
                                  </span>
                                  {g.encounters.length > 1 && (
                                    <span
                                      data-testid={`vocab-count-badge-${g.key}`}
                                      className="px-1.5 py-0.5 rounded-full bg-surface-inset border border-border-subtle font-mono text-[10px] font-semibold leading-none text-text-tertiary shrink-0"
                                    >
                                      ×{g.encounters.length}
                                    </span>
                                  )}
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
                                  {rowBookLabel}
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
            {activeGroup ? (
              <div className="max-w-[740px]">
                {/* Lemma heading + whole-entry 2-click Delete */}
                <div className="flex items-start justify-between gap-4">
                  <h2 className="font-reading text-[44px] xl:text-[50px] font-semibold tracking-[-0.02em] leading-[1.08] text-text-primary select-text break-words">
                    {activeGroup.lemma}
                  </h2>

                  <div ref={deleteClusterRef} className="flex items-center gap-2 shrink-0 pt-2">
                    <button
                      type="button"
                      disabled={deletingKey === activeGroup.key}
                      onClick={() => handleDeleteGroupClick(activeGroup)}
                      aria-label={t("words.deleteWord")}
                      className="size-9 rounded-control bg-surface-chip border border-border-default hover:bg-danger-tint hover:text-danger hover:border-danger/30 text-text-secondary flex items-center justify-center cursor-pointer transition-colors disabled:opacity-50"
                    >
                      <Trash2 size={15} />
                    </button>

                    {armedDeleteKey === activeGroup.key && (
                      <button
                        type="button"
                        disabled={deletingKey === activeGroup.key}
                        onClick={() => handleDeleteGroupClick(activeGroup)}
                        className="h-9 px-3.5 rounded-control bg-danger hover:bg-danger-hover text-text-on-accent text-[12.5px] font-semibold inline-flex items-center gap-1.5 cursor-pointer transition-colors disabled:opacity-60"
                      >
                        <Trash2 size={13} />
                        <span>
                          {activeGroup.totalEncounterCount > activeGroup.encounters.length
                            ? t("words.deleteAllAcrossBooks", {
                                count: activeGroup.totalEncounterCount,
                              })
                            : t("words.clickAgainToDelete")}
                        </span>
                      </button>
                    )}
                  </div>
                </div>

                {/* Pronunciation, TTS & POS row */}
                {(speechAvailable || detailPronunciation || detailPos) && (
                  <div className="flex flex-wrap items-center gap-2.5 mt-3 mb-2">
                    {speechAvailable && (
                      <button
                        type="button"
                        onClick={() => speakWord(activeGroup.lemma)}
                        aria-label={t("words.pronounce")}
                        className="size-8 rounded-control bg-surface-chip border border-border-default hover:bg-surface-solid text-text-secondary hover:text-text-primary inline-flex items-center justify-center cursor-pointer transition-colors"
                      >
                        <Volume2 size={15} />
                      </button>
                    )}
                    {detailPronunciation && (
                      <span className="font-mono text-[14px] text-text-secondary">
                        {detailPronunciation}
                      </span>
                    )}
                    {detailPos && (
                      <span className="px-2.5 py-0.5 rounded-full bg-accent-tint text-accent-on-tint text-[12px] font-semibold">
                        {detailPos}
                      </span>
                    )}
                  </div>
                )}

                {detailBriefGloss && (
                  <p className="text-[15px] font-medium text-accent-on-tint mt-1.5 mb-6 select-text">
                    {detailBriefGloss}
                  </p>
                )}

                {/* DICTIONARY section */}
                {(activeLiveMatch || activeGroup.parsedFallback.definition) && (
                  <div className="mb-7 mt-5">
                    <div className="flex items-center justify-between gap-3 mb-2.5">
                      <h3 className="font-mono text-[11px] font-semibold tracking-[0.08em] uppercase text-text-tertiary">
                        {t("words.dictionaryHeading")}
                      </h3>
                      {showDetailSwitcher && (
                        <div
                          role="tablist"
                          aria-label={t("lookup.dictionarySource")}
                          className="inline-flex items-center gap-0.5 p-0.5 rounded-control bg-surface-inset border border-border-subtle"
                        >
                          {liveMatches.map((match, idx) => {
                            const active = idx === activeDictIdx;
                            return (
                              <button
                                key={match.dictId}
                                type="button"
                                role="tab"
                                aria-selected={active}
                                onClick={() => {
                                  setActiveDictIdx(idx);
                                  setExpandedSenses(false);
                                }}
                                className={`px-[8px] py-[2px] rounded-[6px] text-[11px] leading-snug cursor-pointer transition-colors ${
                                  active
                                    ? "bg-surface-solid font-semibold text-text-primary shadow-xs"
                                    : "font-medium text-text-tertiary hover:text-text-secondary"
                                }`}
                              >
                                {match.dictName}
                              </button>
                            );
                          })}
                        </div>
                      )}
                    </div>

                    {activeLiveMatch ? (
                      detailSenseSlice ? (
                        <div className="flex flex-col gap-3">
                          {detailSenseSlice.visibleGroups.map((group, groupIdx) => (
                            <div key={`${group.pos}-${groupIdx}`} className="flex flex-col gap-1.5">
                              {group.pos && (
                                <div>
                                  <span className="inline-block px-2 py-0.5 rounded-full bg-accent-tint text-accent-on-tint text-[11.5px] font-semibold leading-none">
                                    {group.pos}
                                  </span>
                                </div>
                              )}
                              <ol className="list-decimal pl-5 m-0 flex flex-col gap-1.5 text-[15px] leading-[1.6] text-text-primary">
                                {group.defs.map((def, defIdx) => (
                                  <li key={defIdx} className="select-text">
                                    {def}
                                  </li>
                                ))}
                              </ol>
                            </div>
                          ))}
                          {(detailSenseSlice.hiddenCount > 0 || expandedSenses) && (
                            <button
                              type="button"
                              onClick={() => setExpandedSenses((prev) => !prev)}
                              className="self-start text-[12.5px] font-medium text-accent-on-tint hover:underline cursor-pointer"
                            >
                              {expandedSenses
                                ? t("words.showLessSenses")
                                : t("words.showMoreSenses", {
                                    count: detailSenseSlice.hiddenCount,
                                  })}
                            </button>
                          )}
                        </div>
                      ) : activeLiveMatch.html ? (
                        <div
                          className={`${DICT_HTML_PROSE} text-[14.5px] select-text`}
                          dangerouslySetInnerHTML={{ __html: activeLiveMatch.html }}
                        />
                      ) : activeLiveMatch.plainText ? (
                        <p className="text-[15px] leading-[1.6] text-text-primary whitespace-pre-wrap select-text">
                          {activeLiveMatch.plainText}
                        </p>
                      ) : null
                    ) : (
                      <p className="text-[15.5px] leading-[1.6] text-text-primary whitespace-pre-wrap select-text">
                        {activeGroup.parsedFallback.definition}
                      </p>
                    )}
                  </div>
                )}

                {/* IN YOUR READING · N bound encounter cards */}
                {activeGroup.encounters.length > 0 && (
                  <div className="mb-4">
                    <h3 className="font-mono text-[11px] font-semibold tracking-[0.08em] uppercase text-text-tertiary mb-3">
                      {t("words.inYourReadingHeading", {
                        count: activeGroup.encounters.length,
                      })}
                    </h3>
                    <div className="flex flex-col gap-3.5">
                      {activeGroup.encounters.map((enc) => {
                        const bookMeta = booksById.get(enc.book_id) ?? null;
                        const encBookTitle =
                          bookMeta?.title ?? enc.book_title ?? t("common.unknownBook");
                        const encBookAuthor = bookMeta?.author ?? "";
                        return (
                          <div
                            key={enc.id}
                            data-testid={`vocab-encounter-${enc.id}`}
                            className="bg-paper rounded-[6px] border border-border-subtle p-[18px] flex flex-col gap-3.5"
                          >
                            {enc.context_sentence && (
                              <p className="font-reading text-[16px] leading-[1.65] text-text-primary select-text">
                                {renderHighlightedSentence(enc.context_sentence, highlightForms)}
                              </p>
                            )}

                            <div
                              className={`flex flex-wrap items-center justify-between gap-3 ${
                                enc.context_sentence ? "pt-3 border-t border-border-subtle" : ""
                              }`}
                            >
                              <div className="flex items-center gap-2.5 min-w-0">
                                <BookCover
                                  title={encBookTitle}
                                  author={encBookAuthor}
                                  coverData={bookMeta?.cover_data}
                                  coverPath={bookMeta?.cover_path}
                                  radius="xs"
                                  shadow={false}
                                  className="w-[22px] h-8 shrink-0"
                                />
                                <span className="text-[12.5px] text-text-secondary truncate">
                                  {[
                                    encBookTitle,
                                    encBookAuthor,
                                    t("words.savedDate", {
                                      date: formatShortDate(enc.created_at, i18n.language),
                                    }),
                                  ]
                                    .filter(Boolean)
                                    .join(" · ")}
                                </span>
                              </div>

                              <div className="flex items-center gap-2 shrink-0">
                                <button
                                  type="button"
                                  onClick={() =>
                                    openReaderWindow(enc.book_id, {
                                      openVocab: true,
                                      ...(enc.cfi ? { cfi: enc.cfi } : {}),
                                    })
                                  }
                                  className="text-[12.5px] font-medium text-text-primary hover:text-accent-fg inline-flex items-center gap-1 cursor-pointer transition-colors"
                                >
                                  <ArrowUpRight size={14} />
                                  <span>{t("words.goToPassage")}</span>
                                </button>
                                {activeGroup.totalEncounterCount > 1 && (
                                  <button
                                    type="button"
                                    disabled={deletingEncounterId === enc.id}
                                    onClick={() => handleDeleteEncounter(enc.id)}
                                    aria-label={t("words.deleteEncounter")}
                                    className="size-7 rounded-control flex items-center justify-center text-text-tertiary hover:text-danger hover:bg-danger-tint cursor-pointer transition-colors disabled:opacity-50"
                                  >
                                    <Trash2 size={13} />
                                  </button>
                                )}
                              </div>
                            </div>

                            {enc.context_explanation && (
                              <div className="rounded-[6px] bg-surface-tint px-3.5 py-2.5 flex items-start gap-2.5">
                                <QuillLogo size={16} className="mt-0.5 shrink-0" />
                                <p className="text-[13.5px] leading-[1.55] text-text-primary whitespace-pre-wrap select-text">
                                  {enc.context_explanation}
                                </p>
                              </div>
                            )}
                          </div>
                        );
                      })}
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
