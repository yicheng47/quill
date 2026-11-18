import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Bookmark,
  BookmarkCheck,
  BookmarkPlus,
  Search,
  Sparkles,
  Trash2,
} from "lucide-react";
import { useBookmarks, useHighlights } from "../hooks/useBookmarks";
import { HIGHLIGHT_SWATCHES } from "./HighlightToolbar";
import { timeAgo } from "../utils/timeAgo";

interface BookmarksPanelProps {
  bookId: string;
  bookTitle?: string;
  currentCfi?: string | null;
  highlightVersion?: number;
  onNavigate?: (cfi: string) => void;
  onAsk?: (text: string, cfi?: string) => void;
  onRemoveHighlight?: (cfiRange: string) => void;
  getCurrentCfi?: () => string | null;
  getCurrentLabel?: () => string;
  getPageFromCfi?: (cfi: string) => number | null;
}

type Tab = "highlights" | "bookmarks";

function swatchHexFor(color: string): string {
  return HIGHLIGHT_SWATCHES.find((c) => c.name === color)?.hex ?? HIGHLIGHT_SWATCHES[0].hex;
}

export default function BookmarksPanel({
  bookId,
  bookTitle,
  currentCfi,
  highlightVersion,
  onNavigate,
  onAsk,
  onRemoveHighlight,
  getCurrentCfi,
  getCurrentLabel,
  getPageFromCfi,
}: BookmarksPanelProps) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<Tab>("highlights");
  const [colorFilter, setColorFilter] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [justSaved, setJustSaved] = useState(false);
  const savedTimerRef = useRef<number | null>(null);

  const { bookmarks, add: addBookmark, remove: removeBookmark } = useBookmarks(bookId);
  const {
    highlights,
    refresh: refreshHighlights,
    remove: removeHighlight,
  } = useHighlights(bookId);

  useEffect(() => {
    if (highlightVersion !== undefined && highlightVersion > 0) {
      void refreshHighlights();
    }
  }, [highlightVersion, refreshHighlights]);

  useEffect(() => {
    return () => {
      if (savedTimerRef.current !== null) {
        window.clearTimeout(savedTimerRef.current);
      }
    };
  }, []);

  const handleAddBookmark = async () => {
    const cfi = getCurrentCfi?.();
    if (!cfi) return;
    const label = getCurrentLabel?.() || t("common.bookmark");
    await addBookmark(cfi, label);
    setJustSaved(true);
    if (savedTimerRef.current !== null) {
      window.clearTimeout(savedTimerRef.current);
    }
    savedTimerRef.current = window.setTimeout(() => {
      setJustSaved(false);
      savedTimerRef.current = null;
    }, 2000);
  };

  const isCurrentBookmarked =
    justSaved || (currentCfi != null && bookmarks.some((b) => b.cfi === currentCfi));

  const filteredHighlights = highlights.filter((h) => {
    if (colorFilter && h.color !== colorFilter) return false;
    if (search) {
      const q = search.toLowerCase();
      const inText = h.text_content?.toLowerCase().includes(q) ?? false;
      const inNote = h.note?.toLowerCase().includes(q) ?? false;
      if (!inText && !inNote) return false;
    }
    return true;
  });

  return (
    <div className="@container/panel flex flex-col h-full min-w-0 dawn-glass rounded-[24px] p-4 @[340px]/panel:p-5 gap-3.5">
      {/* Header: segmented tabs + Bookmark action pill */}
      <div className="flex flex-wrap items-center justify-between gap-2 shrink-0">
        <div
          role="tablist"
          aria-label={t("bookmarks.tab.highlights")}
          className="inline-flex items-center p-[3px] gap-0.5 rounded-full bg-border-subtle max-w-full"
        >
          <button
            type="button"
            role="tab"
            aria-selected={tab === "highlights"}
            onClick={() => setTab("highlights")}
            className={`inline-flex items-center gap-1.5 px-2.5 @[340px]/panel:px-3 py-[5px] rounded-full text-[12.5px] cursor-pointer transition-all ${
              tab === "highlights"
                ? "bg-surface-solid text-text-primary font-semibold shadow-[0_1px_2px_rgba(21,21,26,0.08)]"
                : "text-text-secondary font-medium hover:text-text-primary"
            }`}
          >
            <span>{t("bookmarks.tab.highlights")}</span>
            <span
              className={`font-mono text-[11px] font-normal ${
                tab === "highlights" ? "text-accent-on-tint" : "text-text-tertiary"
              }`}
            >
              {highlights.length}
            </span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "bookmarks"}
            onClick={() => setTab("bookmarks")}
            className={`inline-flex items-center gap-1.5 px-2.5 @[340px]/panel:px-3 py-[5px] rounded-full text-[12.5px] cursor-pointer transition-all ${
              tab === "bookmarks"
                ? "bg-surface-solid text-text-primary font-semibold shadow-[0_1px_2px_rgba(21,21,26,0.08)]"
                : "text-text-secondary font-medium hover:text-text-primary"
            }`}
          >
            <span>{t("bookmarks.tab.bookmarks")}</span>
            <span
              className={`font-mono text-[11px] font-normal ${
                tab === "bookmarks" ? "text-accent-on-tint" : "text-text-tertiary"
              }`}
            >
              {bookmarks.length}
            </span>
          </button>
        </div>

        <button
          type="button"
          onClick={handleAddBookmark}
          className={`inline-flex items-center gap-1.5 h-7 px-[11px] rounded-control text-[12px] cursor-pointer transition-colors shrink-0 ${
            isCurrentBookmarked
              ? "bg-accent-tint text-accent-on-tint font-semibold"
              : "bg-surface-solid border border-border-default text-text-primary font-medium hover:bg-surface-inset"
          }`}
        >
          {isCurrentBookmarked ? (
            <>
              <BookmarkCheck size={13.5} />
              <span>{t("bookmarks.saved")}</span>
            </>
          ) : (
            <>
              <BookmarkPlus size={13.5} />
              <span>{t("bookmarks.addBookmark")}</span>
            </>
          )}
        </button>
      </div>

      {/* Highlights tab */}
      {tab === "highlights" && (
        <>
          <div className="flex flex-wrap items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={() => setColorFilter(null)}
              aria-pressed={colorFilter === null}
              className={`h-6 px-2.5 rounded-full text-[12px] cursor-pointer transition-colors shrink-0 ${
                colorFilter === null
                  ? "bg-accent-tint text-accent-on-tint font-semibold"
                  : "bg-surface-inset border border-border-subtle text-text-secondary font-medium hover:bg-surface-solid"
              }`}
            >
              {t("bookmarks.highlightsAll")}
            </button>
            <div className="flex items-center gap-1.5 shrink-0">
              {HIGHLIGHT_SWATCHES.map((c) => {
                const selected = colorFilter === c.name;
                return (
                  <button
                    key={c.name}
                    type="button"
                    aria-label={c.name}
                    aria-pressed={selected}
                    onClick={() => setColorFilter(selected ? null : c.name)}
                    className={`size-3.5 rounded-full cursor-pointer transition-transform ${
                      selected
                        ? "ring-2 ring-offset-1 ring-offset-surface-solid ring-accent scale-110"
                        : "hover:scale-110"
                    }`}
                    style={{ backgroundColor: c.hex }}
                  />
                );
              })}
            </div>
            <div className="flex-1 min-w-[88px] h-[30px] px-2.5 rounded-full bg-surface-inset border border-border-subtle flex items-center gap-1.5 focus-within:border-accent">
              <Search size={12.5} className="text-text-tertiary shrink-0" />
              <input
                type="text"
                placeholder={t("bookmarks.filterPlaceholder")}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                onKeyDown={(e) => e.stopPropagation()}
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
                className="flex-1 min-w-0 text-[12px] text-text-primary bg-transparent outline-none placeholder:text-text-disabled"
              />
            </div>
          </div>

          <div className="flex-1 min-h-0 overflow-y-auto flex flex-col gap-2.5 pr-0.5">
            {filteredHighlights.length === 0 ? (
              <p className="text-[13px] text-text-tertiary text-center mt-8 px-4">
                {highlights.length === 0
                  ? t("bookmarks.highlightsEmpty")
                  : t("bookmarks.highlightsNoMatch")}
              </p>
            ) : (
              filteredHighlights.map((highlight) => {
                const page = getPageFromCfi?.(highlight.cfi_range) ?? null;
                const metaParts = [
                  page != null ? t("bookmarks.shortPage", { page }) : null,
                  timeAgo(highlight.created_at),
                ].filter(Boolean);
                return (
                  <div
                    key={highlight.id}
                    role="button"
                    tabIndex={0}
                    onClick={() => onNavigate?.(highlight.cfi_range)}
                    onKeyDown={(e) => {
                      if (e.target !== e.currentTarget) return;
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        onNavigate?.(highlight.cfi_range);
                      }
                    }}
                    className="group w-full text-left p-3.5 rounded-[14px] bg-surface-inset border border-border-subtle hover:bg-surface-solid hover:border-accent/35 transition-colors cursor-pointer"
                  >
                    <div
                      className="pl-3 py-0.5 border-l-[3px] flex flex-col gap-2"
                      style={{ borderLeftColor: swatchHexFor(highlight.color) }}
                    >
                      {highlight.text_content && (
                        <p className="font-reading text-[13.5px] text-text-primary leading-[1.55] line-clamp-3">
                          {highlight.text_content}
                        </p>
                      )}
                      {highlight.note && (
                        <p className="text-[12px] text-text-secondary leading-relaxed line-clamp-2">
                          {highlight.note}
                        </p>
                      )}
                      <div className="flex items-center justify-between gap-2 min-h-[20px]">
                        <span className="font-mono text-[11px] text-text-tertiary truncate">
                          {metaParts.join(" · ")}
                        </span>
                        <div className="flex items-center gap-1.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity shrink-0">
                          {onAsk && highlight.text_content && (
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                onAsk(highlight.text_content!, highlight.cfi_range);
                              }}
                              className="inline-flex items-center gap-1 px-2 py-[3px] rounded-full bg-surface-inset border border-border-subtle text-[11px] font-medium text-text-secondary hover:bg-accent-tint hover:text-accent-on-tint hover:border-accent/35 cursor-pointer transition-colors"
                            >
                              <Sparkles size={11} />
                              <span>{t("reader.ask")}</span>
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={async (e) => {
                              e.stopPropagation();
                              await removeHighlight(highlight.id);
                              onRemoveHighlight?.(highlight.cfi_range);
                            }}
                            className="inline-flex items-center gap-1 px-2 py-[3px] rounded-full bg-surface-inset border border-border-subtle text-[11px] font-medium text-text-secondary hover:bg-danger-tint hover:text-danger cursor-pointer transition-colors"
                          >
                            <Trash2 size={11} />
                            <span>{t("common.delete")}</span>
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })
            )}
          </div>

          <div className="border-t border-border-subtle pt-2.5 shrink-0">
            <p className="text-[12px] text-text-tertiary text-center truncate">
              {bookTitle
                ? t("bookmarks.highlightCountInBook", {
                    count: filteredHighlights.length,
                    title: bookTitle,
                  })
                : t("bookmarks.highlightCount", { count: filteredHighlights.length })}
            </p>
          </div>
        </>
      )}

      {/* Bookmarks tab */}
      {tab === "bookmarks" && (
        <>
          <div className="flex-1 min-h-0 overflow-y-auto flex flex-col gap-2.5 pr-0.5">
            {bookmarks.length === 0 ? (
              <p className="text-[13px] text-text-tertiary text-center mt-8 px-4">
                {t("bookmarks.empty")}
              </p>
            ) : (
              bookmarks.map((bookmark) => {
                const page = getPageFromCfi?.(bookmark.cfi) ?? null;
                const metaParts = [
                  page != null ? t("bookmarks.page", { page }) : null,
                  timeAgo(bookmark.created_at),
                ].filter(Boolean);
                return (
                  <div
                    key={bookmark.id}
                    role="button"
                    tabIndex={0}
                    onClick={() => onNavigate?.(bookmark.cfi)}
                    onKeyDown={(e) => {
                      if (e.target !== e.currentTarget) return;
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        onNavigate?.(bookmark.cfi);
                      }
                    }}
                    className="group w-full text-left p-3.5 rounded-[14px] bg-surface-inset border border-border-subtle hover:bg-surface-solid hover:border-accent/35 transition-colors flex items-start gap-3 cursor-pointer"
                  >
                    <div className="size-7 rounded-[8px] bg-surface-solid text-text-secondary group-hover:bg-accent-tint group-hover:text-accent-on-tint flex items-center justify-center shrink-0 transition-colors">
                      <Bookmark size={14} />
                    </div>
                    <div className="min-w-0 flex-1 flex flex-col gap-1">
                      <span className="text-[13.5px] font-semibold text-text-primary leading-[18px] truncate">
                        {bookmark.label || t("common.bookmark")}
                      </span>
                      <span className="font-mono text-[11px] text-text-tertiary">
                        {metaParts.join(" · ")}
                      </span>
                    </div>
                    <button
                      type="button"
                      aria-label={t("common.delete")}
                      onClick={(e) => {
                        e.stopPropagation();
                        void removeBookmark(bookmark.id);
                      }}
                      className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 p-1 rounded-control text-text-tertiary hover:text-danger hover:bg-danger-tint transition-all cursor-pointer shrink-0"
                    >
                      <Trash2 size={13.5} />
                    </button>
                  </div>
                );
              })
            )}
          </div>

          <div className="border-t border-border-subtle pt-2.5 shrink-0">
            <p className="text-[12px] text-text-tertiary text-center truncate">
              {bookTitle
                ? t("bookmarks.bookmarkCountInBook", {
                    count: bookmarks.length,
                    title: bookTitle,
                  })
                : t("bookmarks.count", { count: bookmarks.length })}
            </p>
          </div>
        </>
      )}
    </div>
  );
}
