import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { X, Check } from "lucide-react";
import { invoke } from "../platform";
import type { Book } from "../hooks/useBooks";
import type { Collection } from "../hooks/useCollections";
import SearchField from "./ui/SearchField";
import BookCover from "./ui/BookCover";
import { LoadMoreSentinel } from "./BookViewSupport";
import { shortcutModSymbol } from "../lib/platformEnv";

const PICKER_PAGE_SIZE = 100;
const MIN_ELIGIBLE_BUFFER = 20;

interface BookPage {
  books: Book[];
  next_cursor: string | null;
  total: number;
}

interface AddBooksModalProps {
  open: boolean;
  collection: Collection | null;
  onClose: () => void;
  onConfirm: (collectionId: string, bookIds: string[]) => Promise<void>;
}

export default function AddBooksModal({
  open,
  collection,
  onClose,
  onConfirm,
}: AddBooksModalProps) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [books, setBooks] = useState<Book[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [existingIds, setExistingIds] = useState<Set<string>>(new Set());
  const [existingIdsLoaded, setExistingIdsLoaded] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [retrySeq, setRetrySeq] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const requestSeqRef = useRef(0);
  const loadingMoreRef = useRef(false);
  const mod = shortcutModSymbol();

  useEffect(() => {
    if (!open || !collection) {
      setQuery("");
      setSelectedIds(new Set());
      setExistingIds(new Set());
      setExistingIdsLoaded(false);
      setBooks([]);
      setNextCursor(null);
      setLoadingMore(false);
      setLoadError(null);
      setRetrySeq(0);
      loadingMoreRef.current = false;
      return;
    }

    let cancelled = false;
    setExistingIdsLoaded(false);
    void invoke<string[]>("list_books_in_collection", { collectionId: collection.id })
      .then((ids) => {
        if (!cancelled) {
          setExistingIds(new Set(ids));
          setExistingIdsLoaded(true);
        }
      })
      .catch(() => {
        if (!cancelled) setExistingIdsLoaded(true);
      });

    const raf = requestAnimationFrame(() => searchRef.current?.focus());
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
    };
  }, [open, collection]);

  useEffect(() => {
    if (!open || !collection) return;
    const seq = ++requestSeqRef.current;
    const trimmed = query.trim();
    loadingMoreRef.current = false;
    setLoading(true);
    setLoadingMore(false);
    setLoadError(null);
    setNextCursor(null);
    const timer = window.setTimeout(
      async () => {
        try {
          const page = await invoke<BookPage>("list_books", {
            filter: null,
            search: trimmed || null,
            collectionId: null,
            cursor: null,
            limit: PICKER_PAGE_SIZE,
          });
          if (requestSeqRef.current !== seq) return;
          setBooks(page.books);
          setNextCursor(page.next_cursor);
          setLoadError(null);
        } catch (err) {
          if (requestSeqRef.current !== seq) return;
          const msg = err instanceof Error ? err.message : String(err);
          setLoadError(msg);
          console.error("Failed to list books for picker:", err);
        } finally {
          if (requestSeqRef.current === seq) {
            setLoading(false);
          }
        }
      },
      trimmed ? 120 : 0,
    );
    return () => window.clearTimeout(timer);
  }, [open, collection, query, retrySeq]);

  const loadMore = useCallback(async () => {
    if (!open || !collection || !nextCursor || loading || loadingMoreRef.current) return;
    const seq = requestSeqRef.current;
    const cursorToFetch = nextCursor;
    const trimmed = query.trim();
    loadingMoreRef.current = true;
    setLoadingMore(true);
    setLoadError(null);
    try {
      const page = await invoke<BookPage>("list_books", {
        filter: null,
        search: trimmed || null,
        collectionId: null,
        cursor: cursorToFetch,
        limit: PICKER_PAGE_SIZE,
      });
      if (requestSeqRef.current !== seq) return;
      setBooks((prev) => {
        const seen = new Set(prev.map((b) => b.id));
        const next = [...prev];
        for (const book of page.books) {
          if (!seen.has(book.id)) {
            seen.add(book.id);
            next.push(book);
          }
        }
        return next;
      });
      setNextCursor(page.next_cursor);
      setLoadError(null);
    } catch (err) {
      if (requestSeqRef.current !== seq) return;
      const msg = err instanceof Error ? err.message : String(err);
      setLoadError(msg);
      console.error("Failed to load more books for picker:", err);
    } finally {
      if (requestSeqRef.current === seq) {
        loadingMoreRef.current = false;
        setLoadingMore(false);
      }
    }
  }, [open, collection, nextCursor, loading, query]);

  const candidateBooks = useMemo(
    () => books.filter((b) => !existingIds.has(b.id)),
    [books, existingIds],
  );

  // Advance automatically past pages saturated with existing members, stopping
  // immediately on any load failure until the user explicitly retries or changes query.
  useEffect(() => {
    if (
      open &&
      collection &&
      existingIdsLoaded &&
      !loading &&
      !loadingMore &&
      !loadError &&
      nextCursor !== null &&
      candidateBooks.length < MIN_ELIGIBLE_BUFFER
    ) {
      void loadMore();
    }
  }, [
    open,
    collection,
    existingIdsLoaded,
    loading,
    loadingMore,
    loadError,
    nextCursor,
    candidateBooks.length,
    loadMore,
  ]);

  const handleSentinelLoadMore = useCallback(() => {
    if (loadError) return;
    void loadMore();
  }, [loadError, loadMore]);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "f") {
        e.preventDefault();
        e.stopPropagation();
        searchRef.current?.focus();
        searchRef.current?.select();
      }
    };
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [open, onClose]);

  if (!open || !collection) return null;

  const isLoadingInitial =
    !loadError &&
    (!existingIdsLoaded ||
      (loading && candidateBooks.length === 0) ||
      (candidateBooks.length === 0 && nextCursor !== null));

  const handleRetry = () => {
    setLoadError(null);
    if (nextCursor !== null) {
      void loadMore();
    } else {
      setRetrySeq((n) => n + 1);
    }
  };

  const toggleBook = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleConfirm = async () => {
    if (selectedIds.size === 0 || submitting) return;
    setSubmitting(true);
    try {
      await onConfirm(collection.id, Array.from(selectedIds));
      onClose();
    } catch (err) {
      console.error("Failed to add books to collection:", err);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-scrim backdrop-blur-[6px] flex items-center justify-center p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="add-books-modal-title"
        className="w-full max-w-[440px] max-h-[80vh] rounded-[24px] bg-surface-solid border border-border-subtle shadow-menu overflow-hidden flex flex-col"
      >
        <div className="px-5 pt-[18px] pb-3.5 border-b border-border-subtle flex flex-col gap-3 shrink-0">
          <div className="flex items-center justify-between gap-2">
            <h3
              id="add-books-modal-title"
              className="text-[15.5px] font-semibold text-text-primary tracking-[-0.3px] truncate"
            >
              {t("collections.pickerTitle", { name: collection.name })}
            </h3>
            <button
              type="button"
              aria-label={t("common.cancel")}
              onClick={onClose}
              className="size-7 rounded-control flex items-center justify-center text-text-tertiary hover:text-text-primary hover:bg-surface-hover cursor-pointer transition-colors shrink-0"
            >
              <X size={16} />
            </button>
          </div>
          <SearchField
            ref={searchRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onClear={() => setQuery("")}
            placeholder={t("collections.pickerSearchPlaceholder")}
            shortcutHint={`${mod}F`}
            className="w-full"
          />
        </div>

        <div className="p-2.5 flex-1 min-h-[200px] overflow-y-auto flex flex-col gap-0.5">
          {isLoadingInitial ? (
            <div className="py-10 text-center text-[13px] text-text-tertiary">
              {t("library.loading")}
            </div>
          ) : candidateBooks.length === 0 && loadError ? (
            <div
              role="alert"
              className="py-10 px-4 flex flex-col items-center text-center gap-2.5"
            >
              <p className="text-[13px] text-danger">{t("collections.pickerLoadError")}</p>
              <button
                type="button"
                onClick={handleRetry}
                className="px-3.5 py-1.5 rounded-control bg-accent-tint hover:bg-accent-tint-hover text-[12px] font-semibold text-accent-on-tint cursor-pointer transition-colors"
              >
                {t("collections.pickerRetry")}
              </button>
            </div>
          ) : candidateBooks.length === 0 ? (
            <div className="py-10 text-center text-[13px] text-text-tertiary px-4">
              {query.trim()
                ? t("library.noMatchTitle", { query: query.trim() })
                : t("collections.pickerNoEligibleBooks")}
            </div>
          ) : (
            <>
              {candidateBooks.map((book) => {
                const selected = selectedIds.has(book.id);
                return (
                  <button
                    key={book.id}
                    type="button"
                    role="checkbox"
                    aria-checked={selected}
                    onClick={() => toggleBook(book.id)}
                    className={`w-full px-2.5 py-[7px] rounded-[10px] flex items-center justify-between gap-2.5 text-left cursor-pointer transition-colors ${
                      selected ? "bg-accent-tint" : "hover:bg-surface-hover"
                    }`}
                  >
                    <div className="flex items-center gap-2.5 min-w-0 flex-1">
                      <BookCover
                        title={book.title}
                        author={book.author}
                        coverData={book.cover_data}
                        coverPath={book.cover_path}
                        radius="xs"
                        shadow={false}
                        className="w-6 h-[34px] shrink-0"
                      />
                      <div className="min-w-0 flex-1 flex flex-col gap-px">
                        <span
                          className={`text-[13px] truncate ${
                            selected
                              ? "font-semibold text-accent-on-tint"
                              : "font-medium text-text-primary"
                          }`}
                        >
                          {book.title}
                        </span>
                        <span
                          className={`text-[11.5px] truncate ${
                            selected ? "text-accent-on-tint/80" : "text-text-tertiary"
                          }`}
                        >
                          {book.author}
                        </span>
                      </div>
                    </div>
                    <span
                      className={`size-[18px] rounded-[6px] shrink-0 flex items-center justify-center transition-colors ${
                        selected
                          ? "bg-accent text-text-on-accent"
                          : "bg-surface-inset border border-border-default"
                      }`}
                    >
                      {selected && <Check size={11} strokeWidth={2.5} />}
                    </span>
                  </button>
                );
              })}
              {nextCursor !== null && loadError && (
                <div
                  role="alert"
                  className="pt-2 pb-1 px-2 flex items-center justify-center gap-2.5"
                >
                  <span className="text-[12px] text-danger">{t("collections.pickerLoadError")}</span>
                  <button
                    type="button"
                    onClick={handleRetry}
                    className="px-3 py-1 rounded-control bg-accent-tint hover:bg-accent-tint-hover text-[12px] font-semibold text-accent-on-tint cursor-pointer transition-colors"
                  >
                    {t("collections.pickerRetry")}
                  </button>
                </div>
              )}
              {nextCursor !== null && !loadError && (
                <div className="pt-1 flex flex-col items-center">
                  <LoadMoreSentinel loadMore={handleSentinelLoadMore} loadingMore={loadingMore} />
                  {!loadingMore && (
                    <button
                      type="button"
                      onClick={() => void loadMore()}
                      className="px-3 py-1 rounded-control text-[12px] font-medium text-accent-on-tint hover:bg-accent-tint cursor-pointer transition-colors"
                    >
                      {t("collections.pickerLoadMore")}
                    </button>
                  )}
                </div>
              )}
            </>
          )}
        </div>

        <div className="px-[18px] py-3 bg-surface-inset border-t border-border-subtle flex items-center justify-between shrink-0">
          <span className="font-mono text-[11.5px] font-semibold text-accent-on-tint">
            {t("collections.pickerSelected", { count: selectedIds.size })}
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-[13px] py-[7px] rounded-control bg-surface-chip border border-border-default hover:bg-surface-solid text-[12.5px] font-medium text-text-primary cursor-pointer transition-colors"
            >
              {t("common.cancel")}
            </button>
            <button
              type="button"
              disabled={selectedIds.size === 0 || submitting}
              onClick={handleConfirm}
              className="px-3.5 py-[7px] rounded-control bg-accent hover:bg-accent-hover text-text-on-accent text-[12.5px] font-semibold cursor-pointer transition-colors disabled:opacity-50"
            >
              {t("collections.pickerAddCount", { count: selectedIds.size })}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
