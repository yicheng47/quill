import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, CloudDownload } from "lucide-react";
import type { Book } from "../hooks/useBooks";
import type { Collection } from "../hooks/useCollections";
import { checkBookAvailable } from "../hooks/useBooks";
import { openReaderWindow } from "../utils/openReaderWindow";
import BookCover from "./ui/BookCover";
import {
  BookActionsOverlay,
  LoadMoreSentinel,
  type BookMenuTarget,
} from "./BookViewSupport";

const ICLOUD_POLL_INTERVAL_MS = 2000;
const ICLOUD_POLL_TIMEOUT_MS = 60_000;

interface BookListProps {
  books: Book[];
  bookCollectionsMap?: Map<string, Collection[]>;
  hasMore?: boolean;
  loadMore?: () => void;
  loadingMore?: boolean;
  activeCollectionId?: string;
  onBooksChanged?: () => void;
  onBookAvailable?: (bookId: string) => void;
}

export default function BookList({
  books,
  bookCollectionsMap,
  hasMore,
  loadMore,
  loadingMore,
  activeCollectionId,
  onBooksChanged,
  onBookAvailable,
}: BookListProps) {
  const { t } = useTranslation();
  const [contextMenu, setContextMenu] = useState<BookMenuTarget | null>(null);
  const [editBook, setEditBook] = useState<Book | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Book | null>(null);
  const [downloadingIds, setDownloadingIds] = useState<Set<string>>(new Set());
  const mountedRef = useRef(true);
  const activeDownloadsRef = useRef<Set<string>>(new Set());
  const pendingTimersRef = useRef<Set<number>>(new Set());

  useEffect(() => {
    mountedRef.current = true;
    const timers = pendingTimersRef.current;
    const activeDownloads = activeDownloadsRef.current;
    return () => {
      mountedRef.current = false;
      for (const timer of timers) {
        window.clearTimeout(timer);
      }
      timers.clear();
      activeDownloads.clear();
    };
  }, []);

  const handleContextMenu = (e: React.MouseEvent, book: Book) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY, book });
  };

  const waitPollInterval = () =>
    new Promise<void>((resolve) => {
      const timer = window.setTimeout(() => {
        pendingTimersRef.current.delete(timer);
        resolve();
      }, ICLOUD_POLL_INTERVAL_MS);
      pendingTimersRef.current.add(timer);
    });

  const handleDownloadFromICloud = async (bookId: string) => {
    if (activeDownloadsRef.current.has(bookId)) return;
    activeDownloadsRef.current.add(bookId);
    setDownloadingIds((prev) => new Set(prev).add(bookId));
    const startedAt = Date.now();
    try {
      while (mountedRef.current) {
        const available = await checkBookAvailable(bookId);
        if (!mountedRef.current) return;
        if (available) {
          onBookAvailable?.(bookId);
          return;
        }
        if (Date.now() - startedAt >= ICLOUD_POLL_TIMEOUT_MS) {
          return;
        }
        await waitPollInterval();
      }
    } catch (err) {
      console.error("Failed to download book from iCloud:", err);
    } finally {
      activeDownloadsRef.current.delete(bookId);
      if (mountedRef.current) {
        setDownloadingIds((prev) => {
          const next = new Set(prev);
          next.delete(bookId);
          return next;
        });
      }
    }
  };

  return (
    <>
      <div className="dawn-glass rounded-[24px] px-5 py-3.5 flex flex-col gap-1">
        {books.map((book) => {
          const isICloud = book.available === false;
          const isFinished = book.status === "finished" && !isICloud;
          const isDownloading = downloadingIds.has(book.id);
          const collections = bookCollectionsMap?.get(book.id) ?? [];
          const pct =
            book.status === "finished"
              ? 100
              : book.status === "reading"
                ? Math.max(0, Math.min(100, book.progress))
                : 0;

          return (
              <div
                key={book.id}
                role="button"
                tabIndex={0}
                onClick={() => openReaderWindow(book.id)}
                onKeyDown={(e) => {
                  if (e.target !== e.currentTarget) return;
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    void openReaderWindow(book.id);
                  }
                }}
              onContextMenu={(e) => handleContextMenu(e, book)}
              className={`w-full min-h-[122px] px-3.5 py-3 rounded-[14px] border border-border-subtle flex items-center gap-[18px] text-left cursor-pointer transition-colors focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-focus-ring ${
                isICloud ? "bg-surface-inset hover:bg-white/80" : "hover:bg-white/55"
              }`}
            >
              <BookCover
                title={book.title}
                author={book.author}
                coverData={book.cover_data}
                coverPath={book.cover_path}
                shadow={false}
                className={`w-[66px] h-[98px] shrink-0 ${isICloud ? "opacity-72" : ""}`}
              >
                {isICloud ? (
                  <div className="absolute inset-0 flex items-center justify-center">
                    <span className="size-[30px] rounded-full bg-[#15151A]/70 flex items-center justify-center text-white">
                      <CloudDownload size={15} />
                    </span>
                  </div>
                ) : isFinished ? (
                  <span className="absolute top-1.5 right-1.5 size-5 rounded-full bg-success flex items-center justify-center text-white">
                    <Check size={11} strokeWidth={2.5} />
                  </span>
                ) : null}
              </BookCover>

              <div className="flex-1 min-w-0 self-stretch flex flex-col justify-between py-0.5">
                <div className="flex flex-col gap-[3px]">
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-2.5 min-w-0 flex-1">
                      <h3 className="text-[16px] font-semibold text-text-primary tracking-[-0.25px] truncate">
                        {book.title}
                      </h3>
                      {collections.map((c) => (
                        <span
                          key={c.id}
                          className="inline-flex items-center px-[9px] py-[2px] rounded-full bg-surface-chip border border-border-subtle text-[11px] font-medium text-text-secondary shrink-0 max-w-[160px] truncate"
                        >
                          {c.name}
                        </span>
                      ))}
                    </div>

                    {isICloud ? (
                      <button
                        type="button"
                        disabled={isDownloading}
                        onClick={(e) => {
                          e.stopPropagation();
                          void handleDownloadFromICloud(book.id);
                        }}
                        onKeyDown={(e) => {
                          e.stopPropagation();
                        }}
                        className="inline-flex items-center gap-1.5 px-[11px] py-1 rounded-control bg-accent-tint hover:bg-accent-tint-hover text-accent-on-tint text-[11.5px] font-semibold shrink-0 cursor-pointer transition-colors disabled:opacity-60"
                      >
                        <CloudDownload size={12.5} />
                        <span>
                          {isDownloading
                            ? t("library.downloadingFromICloud")
                            : t("library.downloadFromICloud")}
                        </span>
                      </button>
                    ) : (
                      book.pages != null &&
                      book.pages > 0 && (
                        <span className="font-mono text-[11.5px] text-text-tertiary shrink-0">
                          {t("library.pages", { count: book.pages })}
                        </span>
                      )
                    )}
                  </div>

                  <p className="text-[13px] text-text-secondary truncate">{book.author}</p>
                  {book.description && (
                    <p className="text-[12.5px] text-text-tertiary truncate">{book.description}</p>
                  )}
                </div>

                <div className="flex items-center gap-3 w-full max-w-[420px] pt-2">
                  <div className="w-[260px] max-w-[60%] h-[5px] rounded-[3px] bg-track overflow-hidden shrink-0">
                    <div
                      className={`h-full rounded-[3px] transition-[width] duration-200 ${
                        isFinished ? "bg-success" : "bg-progress"
                      }`}
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                  <span
                    className={`font-mono text-[11.5px] truncate ${
                      isFinished ? "text-success" : "text-text-secondary"
                    }`}
                  >
                    {isFinished
                      ? t("library.status.finished")
                      : isICloud
                        ? book.status === "finished"
                          ? t("library.status.finished")
                          : book.status === "reading"
                            ? t("library.progressInICloud", { progress: book.progress })
                            : t("library.notStarted")
                        : book.status === "reading"
                          ? t("library.percentComplete", { progress: book.progress })
                          : t("library.notStarted")}
                  </span>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      <BookActionsOverlay
        contextMenu={contextMenu}
        editBook={editBook}
        deleteTarget={deleteTarget}
        activeCollectionId={activeCollectionId}
        onCloseMenu={() => setContextMenu(null)}
        onEditBook={setEditBook}
        onDeleteTarget={setDeleteTarget}
        onBooksChanged={onBooksChanged}
      />

      {hasMore && <LoadMoreSentinel loadMore={loadMore} loadingMore={loadingMore} />}
    </>
  );
}
