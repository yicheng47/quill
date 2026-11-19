import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import {
  ArrowUpDown,
  BookOpen,
  Check,
  ChevronDown,
  Copy,
  Highlighter,
  PenLine,
  SearchX,
  Sparkles,
  StickyNote,
  Trash2,
} from "lucide-react";
import type { Book } from "../hooks/useBooks";
import { useAllHighlights, type Highlight } from "../hooks/useBookmarks";
import { shortcutModSymbol } from "../lib/platformEnv";
import {
  getHighlightColorMeta,
  HIGHLIGHT_FILTER_COLORS,
  type HighlightSwatchColor,
} from "../utils/highlightColors";
import { sortHighlights, type HighlightSortMode } from "../utils/highlightSort";
import { openReaderWindow } from "../utils/openReaderWindow";
import { formatShortDate } from "../utils/vocabParse";
import BookCover from "./ui/BookCover";
import { Menu, MenuItem } from "./ui/Menu";
import SearchField from "./ui/SearchField";

interface HighlightsViewProps {
  booksById: ReadonlyMap<string, Book>;
  initialBookId?: string | null;
  initialHighlightId?: string | null;
  navigationSeq?: number;
  searchInputRef?: RefObject<HTMLInputElement | null>;
  onNavigateToLibrary: () => void;
}

export default function HighlightsView({
  booksById,
  initialBookId,
  initialHighlightId,
  navigationSeq,
  searchInputRef,
  onNavigateToLibrary,
}: HighlightsViewProps) {
  const { t, i18n } = useTranslation();
  const mod = shortcutModSymbol();

  const [selectedBookId, setSelectedBookId] = useState<string | null>(initialBookId ?? null);
  const [colorFilter, setColorFilter] = useState<HighlightSwatchColor | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [sortMode, setSortMode] = useState<HighlightSortMode>("newest");
  const [sortMenuOpen, setSortMenuOpen] = useState(false);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editNoteValue, setEditNoteValue] = useState("");
  const [savingNote, setSavingNote] = useState(false);

  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [activeHighlightId, setActiveHighlightId] = useState<string | null>(
    initialHighlightId ?? null,
  );
  const [revealSeq, setRevealSeq] = useState(0);

  const sortPopoverRef = useRef<HTMLDivElement>(null);
  const deletePopoverRef = useRef<HTMLDivElement>(null);
  const copiedTimerRef = useRef<number | null>(null);
  const lastScrolledKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (
      initialBookId === undefined &&
      initialHighlightId === undefined &&
      navigationSeq === undefined
    ) {
      return;
    }
    setColorFilter(null);
    setSearchQuery("");
    if (initialBookId !== undefined) {
      setSelectedBookId(initialBookId);
    }
    setActiveHighlightId(initialHighlightId ?? null);
    setRevealSeq((n) => n + 1);
  }, [initialBookId, initialHighlightId, navigationSeq]);

  useEffect(() => {
    return () => {
      if (copiedTimerRef.current !== null) {
        window.clearTimeout(copiedTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!sortMenuOpen) return;
    const onPointerDown = (e: MouseEvent) => {
      if (sortPopoverRef.current && !sortPopoverRef.current.contains(e.target as Node)) {
        setSortMenuOpen(false);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSortMenuOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [sortMenuOpen]);

  useEffect(() => {
    if (!confirmDeleteId) return;
    const onPointerDown = (e: MouseEvent) => {
      if (deletePopoverRef.current && !deletePopoverRef.current.contains(e.target as Node)) {
        setConfirmDeleteId(null);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setConfirmDeleteId(null);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [confirmDeleteId]);

  const { highlights, counts, loading, remove, updateNote, updateColor } = useAllHighlights(
    selectedBookId,
    searchQuery.trim() || undefined,
  );

  const countBookMap = useMemo(() => {
    const map = new Map<string, NonNullable<typeof counts>["books"][number]>();
    for (const b of counts?.books ?? []) {
      map.set(b.book_id, b);
    }
    return map;
  }, [counts]);

  const bookFormats = useMemo(() => {
    const map = new Map<string, string>();
    for (const [id, book] of booksById) {
      map.set(id, book.format);
    }
    return map;
  }, [booksById]);

  const bookOrder = useMemo(() => {
    const map = new Map<string, number>();
    (counts?.books ?? []).forEach((b, idx) => {
      map.set(b.book_id, idx);
    });
    return map;
  }, [counts?.books]);

  const selectedBookSummary = selectedBookId ? countBookMap.get(selectedBookId) ?? null : null;
  const selectedBookMeta = selectedBookId ? booksById.get(selectedBookId) ?? null : null;

  const filteredHighlights = useMemo(() => {
    const colorFiltered = colorFilter
      ? highlights.filter((h) => h.color.toLowerCase() === colorFilter)
      : highlights;
    return sortHighlights(colorFiltered, sortMode, { bookFormats, bookOrder });
  }, [highlights, colorFilter, sortMode, bookFormats, bookOrder]);

  useEffect(() => {
    const targetKey = activeHighlightId ? `${activeHighlightId}:${revealSeq}` : null;
    if (!targetKey || lastScrolledKeyRef.current === targetKey) return;
    const node = Array.from(document.querySelectorAll<HTMLElement>("[data-highlight-id]")).find(
      (el) => el.dataset.highlightId === activeHighlightId,
    );
    if (!node) return;
    lastScrolledKeyRef.current = targetKey;
    if (typeof node.scrollIntoView === "function") {
      node.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }, [activeHighlightId, filteredHighlights, revealSeq]);

  const startEdit = useCallback((h: Highlight) => {
    setConfirmDeleteId(null);
    setEditingId(h.id);
    setEditNoteValue(h.note ?? "");
  }, []);

  const cancelEdit = useCallback(() => {
    setEditingId(null);
    setEditNoteValue("");
  }, []);

  const saveEdit = useCallback(
    async (id: string) => {
      if (savingNote) return;
      setSavingNote(true);
      try {
        await updateNote(id, editNoteValue.trim());
        setEditingId(null);
      } catch (err) {
        console.error("Failed to save highlight note:", err);
      } finally {
        setSavingNote(false);
      }
    },
    [editNoteValue, savingNote, updateNote],
  );

  const handleCopy = useCallback(async (h: Highlight) => {
    const parts: string[] = [];
    if (h.text_content) parts.push(h.text_content);
    if (h.note) parts.push(`— ${h.note}`);
    const payload = parts.join("\n\n");
    if (!payload) return;
    try {
      await navigator.clipboard?.writeText(payload);
      setCopiedId(h.id);
      if (copiedTimerRef.current !== null) {
        window.clearTimeout(copiedTimerRef.current);
      }
      copiedTimerRef.current = window.setTimeout(() => {
        setCopiedId(null);
        copiedTimerRef.current = null;
      }, 1500);
    } catch (err) {
      console.error("Failed to copy highlight:", err);
    }
  }, []);

  const handleConfirmDelete = useCallback(
    async (id: string) => {
      if (deletingId) return;
      setDeletingId(id);
      try {
        await remove(id);
        setConfirmDeleteId(null);
        if (editingId === id) setEditingId(null);
        if (selectedBookId && highlights.length <= 1) {
          setSelectedBookId(null);
        }
      } catch (err) {
        console.error("Failed to remove highlight:", err);
      } finally {
        setDeletingId(null);
      }
    },
    [deletingId, editingId, highlights.length, remove, selectedBookId],
  );

  const handleRecolor = useCallback(
    async (id: string, color: HighlightSwatchColor) => {
      try {
        await updateColor(id, color);
      } catch (err) {
        console.error("Failed to recolor highlight:", err);
      }
    },
    [updateColor],
  );

  const totalCount = counts?.total ?? 0;
  const bookCount = counts?.book_count ?? 0;
  const isGloballyEmpty =
    !loading &&
    counts !== null &&
    counts.total === 0 &&
    !searchQuery.trim() &&
    colorFilter === null &&
    selectedBookId === null;

  const hasActiveFilter = Boolean(searchQuery.trim() || colorFilter !== null);

  const sortLabel =
    sortMode === "newest"
      ? t("highlights.sortNewest")
      : sortMode === "oldest"
        ? t("highlights.sortOldest")
        : t("highlights.sortChapter");

  const resolveBookTitle = (h: Highlight) =>
    booksById.get(h.book_id)?.title ??
    countBookMap.get(h.book_id)?.book_title ??
    h.book_title ??
    t("common.unknownBook");

  return (
    <main className="flex-1 min-h-0 flex flex-col overflow-hidden px-10 pt-1 pb-6">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-4 pb-5 shrink-0">
        <div className="flex items-baseline gap-3 min-w-0">
          <h1 className="text-[28px] font-semibold tracking-[-0.5px] leading-[1.15] text-text-primary">
            {t("highlights.title")}
          </h1>
          <span className="font-mono text-[12.5px] text-text-tertiary shrink-0">
            {totalCount === 0
              ? t("highlights.countZero")
              : t("highlights.summaryAll", {
                  count: totalCount,
                  booksLabel: t("common.booksCount", { count: bookCount }),
                })}
          </span>
        </div>

        {!isGloballyEmpty && (
          <div className="flex flex-wrap items-center justify-end gap-2.5">
            {/* Color filter pill */}
            <div
              role="group"
              aria-label={t("highlights.colorFilterLabel")}
              className="h-10 px-2 rounded-full dawn-glass inline-flex items-center gap-1.5"
            >
              <button
                type="button"
                onClick={() => setColorFilter(null)}
                aria-pressed={colorFilter === null}
                className={`h-7 px-3 rounded-full text-[13px] cursor-pointer transition-colors ${
                  colorFilter === null
                    ? "bg-accent-tint text-accent-on-tint font-semibold"
                    : "text-text-secondary hover:text-text-primary hover:bg-surface-hover"
                }`}
              >
                {t("highlights.colorAll")}
              </button>
              {HIGHLIGHT_FILTER_COLORS.map((c) => {
                const active = colorFilter === c.name;
                return (
                  <button
                    key={c.name}
                    type="button"
                    onClick={() =>
                      setColorFilter((prev) =>
                        prev === c.name ? null : (c.name as HighlightSwatchColor),
                      )
                    }
                    aria-label={t(c.i18nKey)}
                    aria-pressed={active}
                    className={`size-[22px] rounded-full cursor-pointer transition-transform border border-border-default ${c.swatchClass} ${
                      active
                        ? "ring-2 ring-accent ring-offset-2 ring-offset-surface-solid scale-105"
                        : "hover:scale-110"
                    }`}
                  />
                );
              })}
            </div>

            <SearchField
              ref={searchInputRef}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onClear={() => setSearchQuery("")}
              placeholder={t("highlights.searchPlaceholder")}
              aria-label={t("highlights.searchPlaceholder")}
              shortcutHint={`${mod}F`}
              className="w-[210px] sm:w-[235px]"
            />

            <div className="relative" ref={sortPopoverRef}>
              <button
                type="button"
                onClick={() => setSortMenuOpen((prev) => !prev)}
                aria-expanded={sortMenuOpen}
                aria-haspopup="menu"
                aria-label={t("highlights.sortLabel")}
                className="h-10 px-3.5 rounded-full dawn-glass text-[13px] font-medium text-text-primary hover:bg-surface-solid inline-flex items-center gap-2 cursor-pointer transition-colors focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-focus-ring"
              >
                <ArrowUpDown size={14} className="text-text-secondary" />
                <span>{sortLabel}</span>
                <ChevronDown size={14} className="text-text-tertiary" />
              </button>

              {sortMenuOpen && (
                <div className="absolute right-0 top-[calc(100%+6px)] z-30 w-52">
                  <Menu role="menu" aria-label={t("highlights.sortLabel")}>
                    {(
                      [
                        { mode: "newest", label: t("highlights.sortNewest") },
                        { mode: "oldest", label: t("highlights.sortOldest") },
                        { mode: "chapter", label: t("highlights.sortChapter") },
                      ] as const
                    ).map((opt) => (
                      <MenuItem
                        key={opt.mode}
                        role="menuitemradio"
                        aria-checked={sortMode === opt.mode}
                        active={sortMode === opt.mode}
                        onClick={() => {
                          setSortMode(opt.mode);
                          setSortMenuOpen(false);
                        }}
                        shortcut={sortMode === opt.mode ? "✓" : undefined}
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
            <div className="size-12 rounded-[14px] bg-accent-tint text-accent flex items-center justify-center mb-4">
              <Highlighter size={22} />
            </div>
            <h2 className="text-[20px] font-semibold tracking-[-0.3px] text-text-primary mb-2">
              {t("highlights.emptyTitle")}
            </h2>
            <p className="text-[13.5px] leading-[1.55] text-text-secondary mb-5">
              {t("highlights.emptyBody")}
            </p>
            <div className="flex items-center gap-2 mb-6" aria-hidden="true">
              <span className="w-7 h-1.5 rounded-full bg-hl-yellow border border-border-subtle" />
              <span className="w-7 h-1.5 rounded-full bg-hl-green border border-border-subtle" />
              <span className="w-7 h-1.5 rounded-full bg-hl-blue border border-border-subtle" />
              <span className="w-7 h-1.5 rounded-full bg-hl-pink border border-border-subtle" />
            </div>
            <button
              type="button"
              onClick={onNavigateToLibrary}
              className="h-10 px-5 rounded-control bg-accent hover:bg-accent-hover text-text-on-accent text-[13.5px] font-semibold inline-flex items-center gap-2 cursor-pointer transition-colors"
            >
              <BookOpen size={15} />
              <span>{t("highlights.emptyCta")}</span>
            </button>
          </div>
        </div>
      ) : (
        <div className="flex-1 min-h-0 flex gap-4 overflow-hidden">
          {/* Left Book Rail */}
          <aside
            aria-label={t("highlights.booksRail")}
            className="w-[290px] lg:w-[320px] shrink-0 dawn-glass rounded-surface p-2.5 overflow-y-auto flex flex-col gap-0.5"
          >
            <button
              type="button"
              onClick={() => setSelectedBookId(null)}
              aria-current={selectedBookId === null ? "true" : undefined}
              className={`w-full px-3 py-2.5 rounded-[6px] flex items-center gap-2.5 text-left cursor-pointer transition-colors ${
                selectedBookId === null
                  ? "bg-accent-tint text-accent-on-tint font-semibold"
                  : "text-text-primary hover:bg-surface-hover font-medium"
              }`}
            >
              <Highlighter
                size={15}
                className={selectedBookId === null ? "text-accent" : "text-text-tertiary"}
              />
              <span className="flex-1 min-w-0 truncate text-[13.5px]">
                {t("highlights.allHighlights")}
              </span>
              <span
                className={`font-mono text-[12px] shrink-0 ${
                  selectedBookId === null ? "text-accent" : "text-text-tertiary"
                }`}
              >
                {totalCount}
              </span>
            </button>

            {(counts?.books.length ?? 0) > 0 && (
              <div className="my-1.5 mx-1 h-px bg-border-subtle shrink-0" />
            )}

            {(counts?.books ?? []).map((b) => {
              const active = selectedBookId === b.book_id;
              const bookMeta = booksById.get(b.book_id);
              return (
                <button
                  key={b.book_id}
                  type="button"
                  onClick={() => setSelectedBookId(b.book_id)}
                  aria-current={active ? "true" : undefined}
                  className={`w-full px-2.5 py-2 rounded-[6px] flex items-center gap-2.5 text-left cursor-pointer transition-colors ${
                    active
                      ? "bg-accent-tint text-accent-on-tint font-semibold"
                      : "text-text-primary hover:bg-surface-hover"
                  }`}
                >
                  <BookCover
                    title={b.book_title}
                    author={bookMeta?.author ?? b.book_author}
                    coverData={bookMeta?.cover_data ?? b.cover_data}
                    coverPath={bookMeta?.cover_path ?? b.cover_path}
                    radius="xs"
                    shadow={false}
                    className="w-7 h-10 shrink-0"
                  />
                  <span className="flex-1 min-w-0 truncate text-[13.5px]">{b.book_title}</span>
                  <span
                    className={`font-mono text-[12px] shrink-0 ${
                      active ? "text-accent" : "text-text-tertiary"
                    }`}
                  >
                    {b.count}
                  </span>
                </button>
              );
            })}
          </aside>

          {/* Right Highlight Stream */}
          <section className="flex-1 min-w-0 dawn-glass rounded-surface overflow-y-auto p-6 flex flex-col">
            {selectedBookId && selectedBookSummary && (
              <div className="flex flex-wrap items-center justify-between gap-4 pb-5 mb-5 border-b border-border-subtle shrink-0">
                <div className="flex items-center gap-3.5 min-w-0">
                  <BookCover
                    title={selectedBookSummary.book_title}
                    author={selectedBookMeta?.author ?? selectedBookSummary.book_author}
                    coverData={selectedBookMeta?.cover_data ?? selectedBookSummary.cover_data}
                    coverPath={selectedBookMeta?.cover_path ?? selectedBookSummary.cover_path}
                    radius="xs"
                    className="w-11 h-[62px] shrink-0"
                  />
                  <div className="min-w-0">
                    <h2 className="text-[20px] font-semibold tracking-[-0.3px] text-text-primary truncate">
                      {selectedBookSummary.book_title}
                    </h2>
                    <p className="text-[13px] text-text-secondary truncate mt-0.5">
                      {[
                        selectedBookMeta?.author ?? selectedBookSummary.book_author,
                        t("highlights.bookHighlightsCount", { count: selectedBookSummary.count }),
                        t("library.percentRead", {
                          progress: Math.round(
                            selectedBookMeta?.progress ?? selectedBookSummary.book_progress ?? 0,
                          ),
                        }),
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </p>
                  </div>
                </div>

                <button
                  type="button"
                  onClick={() => openReaderWindow(selectedBookSummary.book_id)}
                  className="h-9 px-4 rounded-control bg-surface-chip border border-border-default hover:bg-surface-solid text-[13px] font-medium text-text-primary inline-flex items-center gap-2 cursor-pointer transition-colors shrink-0"
                >
                  <BookOpen size={14} className="text-text-secondary" />
                  <span>{t("highlights.openBook")}</span>
                </button>
              </div>
            )}

            {loading && highlights.length === 0 ? (
              <div className="flex-1 flex items-center justify-center text-[13.5px] text-text-tertiary">
                {t("common.loading")}
              </div>
            ) : filteredHighlights.length === 0 ? (
              <div className="flex-1 flex items-center justify-center p-8">
                <div className="max-w-[360px] flex flex-col items-center text-center">
                  <div className="size-10 rounded-full bg-surface-inset border border-border-subtle flex items-center justify-center text-text-tertiary mb-3">
                    <SearchX size={18} />
                  </div>
                  <p className="text-[15px] font-semibold text-text-primary mb-1">
                    {t("highlights.noMatchTitle")}
                  </p>
                  <p className="text-[13px] text-text-secondary mb-4">
                    {t("highlights.noMatchBody")}
                  </p>
                  {hasActiveFilter && (
                    <button
                      type="button"
                      onClick={() => {
                        setColorFilter(null);
                        setSearchQuery("");
                      }}
                      className="h-8 px-4 rounded-control bg-surface-chip border border-border-default hover:bg-surface-solid text-[12.5px] font-medium text-text-primary cursor-pointer transition-colors"
                    >
                      {t("highlights.clearFilters")}
                    </button>
                  )}
                </div>
              </div>
            ) : (
              <div className="flex flex-col gap-3">
                {filteredHighlights.map((h) => {
                  const colorMeta = getHighlightColorMeta(h.color);
                  const isEditing = editingId === h.id;
                  const isConfirmingDelete = confirmDeleteId === h.id;
                  const isActiveTarget = activeHighlightId === h.id;
                  const bookMeta = booksById.get(h.book_id);
                  const bookSummary = countBookMap.get(h.book_id);
                  const hBookTitle = resolveBookTitle(h);

                  return (
                    <article
                      key={h.id}
                      data-highlight-id={h.id}
                      className={`group relative rounded-[6px] border p-4 transition-all ${
                        isEditing || isActiveTarget
                          ? "border-accent/55 bg-surface-solid ring-2 ring-focus-ring"
                          : "border-border-subtle bg-surface-inset hover:border-accent/40 hover:bg-surface-solid"
                      }`}
                    >
                      {/* Top attribution / hover action row */}
                      <div className="flex items-center justify-between gap-3 mb-2.5 min-h-[26px]">
                        <div className="flex items-center gap-2 min-w-0">
                          {selectedBookId === null ? (
                            <>
                              <BookCover
                                title={hBookTitle}
                                author={bookMeta?.author ?? bookSummary?.book_author ?? h.book_author}
                                coverData={bookMeta?.cover_data ?? bookSummary?.cover_data}
                                coverPath={bookMeta?.cover_path ?? bookSummary?.cover_path}
                                radius="xs"
                                shadow={false}
                                className="w-[18px] h-[26px] shrink-0"
                              />
                              <button
                                type="button"
                                onClick={() => setSelectedBookId(h.book_id)}
                                className="text-[13px] font-semibold text-text-primary hover:text-accent truncate cursor-pointer text-left"
                              >
                                {hBookTitle}
                              </button>
                              <span className="font-mono text-[11px] text-text-tertiary shrink-0">
                                {formatShortDate(h.created_at, i18n.language)}
                              </span>
                            </>
                          ) : (
                            <span className="font-mono text-[11px] text-text-tertiary">
                              {formatShortDate(h.created_at, i18n.language)}
                              {isEditing
                                ? ` · ${t("highlights.highlightedIn", { color: t(colorMeta.i18nKey) })}`
                                : ""}
                            </span>
                          )}
                        </div>

                        {/* Hover / focus action pill */}
                        <div
                          className={`inline-flex items-center gap-1 px-2 py-1 rounded-full bg-surface-solid border border-border-default shadow-sm transition-opacity shrink-0 ${
                            isConfirmingDelete || copiedId === h.id
                              ? "opacity-100"
                              : "opacity-0 group-hover:opacity-100 focus-within:opacity-100"
                          }`}
                        >
                          {HIGHLIGHT_FILTER_COLORS.map((swatch) => {
                            const current = h.color.toLowerCase() === swatch.name;
                            return (
                              <button
                                key={swatch.name}
                                type="button"
                                onClick={() => handleRecolor(h.id, swatch.name as HighlightSwatchColor)}
                                aria-label={t("highlights.recolorTo", {
                                  color: t(swatch.i18nKey),
                                })}
                                aria-pressed={current}
                                className={`size-3.5 rounded-full cursor-pointer border border-border-default transition-transform ${swatch.swatchClass} ${
                                  current ? "ring-1.5 ring-text-primary scale-110" : "hover:scale-110"
                                }`}
                              />
                            );
                          })}

                          <span className="w-px h-3.5 bg-border-subtle mx-1" aria-hidden="true" />

                          <button
                            type="button"
                            onClick={() => startEdit(h)}
                            aria-label={t("highlights.editNote")}
                            className="px-2 py-0.5 rounded-full text-[11.5px] font-medium text-text-secondary hover:text-text-primary hover:bg-surface-hover inline-flex items-center gap-1 cursor-pointer"
                          >
                            <PenLine size={12} />
                            <span>{t("highlights.editNote")}</span>
                          </button>

                          <button
                            type="button"
                            onClick={() => handleCopy(h)}
                            aria-label={t("highlights.copy")}
                            className="px-2 py-0.5 rounded-full text-[11.5px] font-medium text-text-secondary hover:text-text-primary hover:bg-surface-hover inline-flex items-center gap-1 cursor-pointer"
                          >
                            {copiedId === h.id ? <Check size={12} /> : <Copy size={12} />}
                            <span>
                              {copiedId === h.id ? t("common.copied") : t("highlights.copy")}
                            </span>
                          </button>

                          <button
                            type="button"
                            onClick={() =>
                              openReaderWindow(h.book_id, {
                                cfi: h.cfi_range,
                                quote: h.text_content || undefined,
                                openChat: true,
                              })
                            }
                            aria-label={t("highlights.ask")}
                            className="px-2 py-0.5 rounded-full text-[11.5px] font-medium text-text-secondary hover:text-accent-on-tint hover:bg-accent-tint inline-flex items-center gap-1 cursor-pointer"
                          >
                            <Sparkles size={12} />
                            <span>{t("highlights.ask")}</span>
                          </button>

                          <button
                            type="button"
                            onClick={() =>
                              openReaderWindow(h.book_id, {
                                cfi: h.cfi_range,
                              })
                            }
                            aria-label={t("highlights.openInBook")}
                            className="px-2 py-0.5 rounded-full text-[11.5px] font-medium text-text-secondary hover:text-text-primary hover:bg-surface-hover inline-flex items-center gap-1 cursor-pointer"
                          >
                            <BookOpen size={12} />
                            <span>{t("highlights.open")}</span>
                          </button>

                          <button
                            type="button"
                            onClick={() =>
                              setConfirmDeleteId((prev) => (prev === h.id ? null : h.id))
                            }
                            aria-label={t("highlights.delete")}
                            className="p-1 rounded-full text-danger hover:bg-danger-tint cursor-pointer"
                          >
                            <Trash2 size={12} />
                          </button>
                        </div>
                      </div>

                      {/* Quote with colored accent bar */}
                      <div className={`border-l-[3px] pl-3.5 ${colorMeta.barClass}`}>
                        <p className="font-reading text-[16px] leading-[1.6] text-text-primary select-text">
                          {h.text_content || t("highlights.untitledPassage")}
                        </p>
                      </div>

                      {/* Inline Note Editor or Saved Note */}
                      {isEditing ? (
                        <div className="mt-3 rounded-[6px] border border-accent/60 bg-surface-solid p-3">
                          <textarea
                            autoFocus
                            rows={3}
                            value={editNoteValue}
                            onChange={(e) => setEditNoteValue(e.target.value)}
                            onKeyDown={(e) => {
                              if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                                e.preventDefault();
                                void saveEdit(h.id);
                              } else if (e.key === "Escape") {
                                e.preventDefault();
                                cancelEdit();
                              }
                            }}
                            placeholder={t("highlights.notePlaceholder")}
                            aria-label={t("highlights.notePlaceholder")}
                            className="w-full resize-none bg-transparent text-[13.5px] leading-[1.5] text-text-primary placeholder:text-text-tertiary outline-none"
                          />
                          <div className="mt-2 pt-2 border-t border-border-subtle flex items-center justify-between gap-2">
                            <span className="font-mono text-[11px] text-text-tertiary">
                              {t("highlights.noteShortcuts", { mod })}
                            </span>
                            <div className="flex items-center gap-2">
                              <button
                                type="button"
                                onClick={cancelEdit}
                                className="h-8 px-3.5 rounded-control bg-surface-chip border border-border-default hover:bg-surface-solid text-[12.5px] font-medium text-text-primary cursor-pointer"
                              >
                                {t("common.cancel")}
                              </button>
                              <button
                                type="button"
                                disabled={savingNote}
                                onClick={() => saveEdit(h.id)}
                                className="h-8 px-4 rounded-control bg-accent hover:bg-accent-hover text-text-on-accent text-[12.5px] font-semibold inline-flex items-center gap-1.5 cursor-pointer disabled:opacity-60"
                              >
                                <Check size={13} />
                                <span>{t("highlights.saveNote")}</span>
                              </button>
                            </div>
                          </div>
                        </div>
                      ) : (
                        h.note && (
                          <button
                            type="button"
                            onClick={() => startEdit(h)}
                            className="mt-2.5 w-full text-left px-3 py-2 rounded-[8px] bg-surface-hover hover:bg-border-subtle border border-border-subtle flex items-start gap-2 cursor-pointer transition-colors"
                          >
                            <StickyNote size={13} className="text-accent mt-0.5 shrink-0" />
                            <span className="text-[13px] leading-[1.45] text-text-secondary whitespace-pre-wrap">
                              {h.note}
                            </span>
                          </button>
                        )
                      )}

                      {/* Delete Confirmation Popover */}
                      {isConfirmingDelete && (
                        <div
                          ref={deletePopoverRef}
                          role="dialog"
                          aria-label={t("highlights.deleteTitle")}
                          className="absolute right-4 top-12 z-30 w-[300px] dawn-menu rounded-surface p-4 border border-border-default"
                        >
                          <div className="flex items-center gap-2 text-text-primary mb-1.5">
                            <Trash2 size={14} className="text-danger shrink-0" />
                            <h3 className="text-[13.5px] font-semibold">
                              {t("highlights.deleteTitle")}
                            </h3>
                          </div>
                          <p className="text-[12.5px] leading-[1.45] text-text-secondary mb-3.5">
                            {t("highlights.deleteBody", { title: hBookTitle })}
                          </p>
                          <div className="flex items-center justify-end gap-2">
                            <button
                              type="button"
                              onClick={() => setConfirmDeleteId(null)}
                              className="h-8 px-3.5 rounded-control bg-surface-chip border border-border-default hover:bg-surface-solid text-[12.5px] font-medium text-text-primary cursor-pointer"
                            >
                              {t("common.cancel")}
                            </button>
                            <button
                              type="button"
                              disabled={deletingId === h.id}
                              onClick={() => handleConfirmDelete(h.id)}
                              className="h-8 px-3.5 rounded-control bg-danger hover:bg-danger-hover text-text-on-accent text-[12.5px] font-semibold cursor-pointer disabled:opacity-60"
                            >
                              {t("highlights.remove")}
                            </button>
                          </div>
                        </div>
                      )}
                    </article>
                  );
                })}
              </div>
            )}
          </section>
        </div>
      )}
    </main>
  );
}
