import { useState, useEffect, useRef, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Search, X } from "lucide-react";
import { invoke } from "../platform";
import type { Book } from "../hooks/useBooks";
import BookCover from "./ui/BookCover";
import { openReaderWindow } from "../utils/openReaderWindow";
import { shortcutModSymbol } from "../lib/platformEnv";

interface BookPage {
  books: Book[];
  next_cursor: string | null;
  total: number;
}

interface CommandSearchModalProps {
  open: boolean;
  onClose: () => void;
}

export default function CommandSearchModal({ open, onClose }: CommandSearchModalProps) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [books, setBooks] = useState<Book[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const requestSeqRef = useRef(0);
  const mod = shortcutModSymbol();

  useEffect(() => {
    if (!open) {
      setQuery("");
      setActiveIndex(0);
      return;
    }
    const raf = requestAnimationFrame(() => {
      inputRef.current?.focus();
    });
    return () => cancelAnimationFrame(raf);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const seq = ++requestSeqRef.current;
    const trimmed = query.trim();
    setLoading(true);
    const timer = window.setTimeout(
      async () => {
        try {
          const page = await invoke<BookPage>("list_books", {
            filter: null,
            search: trimmed || null,
            collectionId: null,
            cursor: null,
            limit: 30,
          });
          if (requestSeqRef.current !== seq) return;
          setBooks(page.books);
          setTotal(page.total);
          setActiveIndex(0);
        } catch (err) {
          console.error("Command search failed:", err);
        } finally {
          if (requestSeqRef.current === seq) {
            setLoading(false);
          }
        }
      },
      trimmed ? 100 : 0,
    );
    return () => window.clearTimeout(timer);
  }, [open, query]);

  useEffect(() => {
    if (!open || books.length === 0) return;
    itemRefs.current[activeIndex]?.scrollIntoView?.({ block: "nearest" });
  }, [open, activeIndex, books.length]);

  const handleOpenBook = useCallback(
    (book: Book) => {
      onClose();
      void openReaderWindow(book.id);
    },
    [onClose],
  );

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActiveIndex((idx) => (books.length === 0 ? 0 : (idx + 1) % books.length));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setActiveIndex((idx) =>
          books.length === 0 ? 0 : (idx - 1 + books.length) % books.length,
        );
        return;
      }
      if (e.key === "Enter" && books[activeIndex]) {
        e.preventDefault();
        handleOpenBook(books[activeIndex]);
      }
    };
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [open, books, activeIndex, handleOpenBook, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 bg-[#15151A]/26 backdrop-blur-[6px] flex justify-center items-start pt-[92px] px-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t("commandSearch.ariaLabel")}
        className="w-full max-w-[680px] rounded-[22px] bg-white/[0.92] border border-surface-glass-border backdrop-blur-[36px] shadow-[0_24px_56px_rgba(30,22,56,0.24)] overflow-hidden flex flex-col"
      >
        <div className="h-[58px] px-5 flex items-center justify-between gap-3 border-b border-border-subtle">
          <div className="flex-1 min-w-0 flex items-center gap-3">
            <Search size={18} className="text-accent shrink-0" />
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
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

        <div className="px-5 py-2.5 flex items-center gap-2 border-b border-border-subtle">
          <span className="inline-flex items-center gap-1.5 px-[11px] py-1 rounded-full bg-accent-tint text-accent-on-tint text-[12px] font-semibold">
            <span>{t("commandSearch.scopeBooks")}</span>
            <span className="font-mono text-[10.5px] font-normal">{total}</span>
          </span>
        </div>

        <div className="p-2.5 max-h-[380px] overflow-y-auto flex flex-col gap-0.5">
          {loading && books.length === 0 ? (
            <div className="py-10 text-center text-[13px] text-text-tertiary">
              {t("library.loading")}
            </div>
          ) : books.length === 0 ? (
            <div className="py-10 text-center text-[13px] text-text-tertiary">
              {query.trim()
                ? t("library.noMatchTitle", { query: query.trim() })
                : t("commandSearch.emptyBooks")}
            </div>
          ) : (
            <div>
              <div className="px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.9px] text-text-tertiary">
                {t("commandSearch.groupBooks")}
              </div>
              {books.map((book, idx) => {
                const isSelected = idx === activeIndex;
                const statusText =
                  book.status === "finished"
                    ? t("library.status.finished")
                    : book.status === "reading"
                      ? t("commandSearch.percentRead", { progress: book.progress })
                      : t("library.status.unread");
                return (
                  <button
                    key={book.id}
                    ref={(el) => {
                      itemRefs.current[idx] = el;
                    }}
                    type="button"
                    onMouseEnter={() => setActiveIndex(idx)}
                    onClick={() => handleOpenBook(book)}
                    className={`w-full flex items-center justify-between gap-3 px-2.5 py-2 rounded-[12px] text-left cursor-pointer transition-colors ${
                      isSelected ? "bg-accent-tint" : "hover:bg-black/[0.04]"
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
                            isSelected ? "text-violet-700" : "text-text-tertiary"
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
                        <span className="px-[7px] py-[3px] rounded-[6px] bg-white/70 font-mono text-[10.5px] font-semibold text-accent-on-tint">
                          {t("commandSearch.openHint")}
                        </span>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
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
          </div>
          <span className="font-mono text-[11px] text-text-tertiary">
            {t("commandSearch.hintShortcut", { mod })}
          </span>
        </div>
      </div>
    </div>
  );
}
