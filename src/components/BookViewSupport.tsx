import { useEffect, useRef } from "react";
import { Loader2 } from "lucide-react";
import type { Book } from "../hooks/useBooks";
import { deleteBook, markFinished, updateBookStatus } from "../hooks/useBooks";
import { openReaderWindow } from "../utils/openReaderWindow";
import BookContextMenu from "./BookContextMenu";
import EditMetadataModal from "./EditMetadataModal";
import DeleteBookModal from "./DeleteBookModal";

export interface BookMenuTarget {
  x: number;
  y: number;
  book: Book;
}

interface BookActionsOverlayProps {
  contextMenu: BookMenuTarget | null;
  editBook: Book | null;
  deleteTarget: Book | null;
  activeCollectionId?: string;
  onCloseMenu: () => void;
  onEditBook: (book: Book | null) => void;
  onDeleteTarget: (book: Book | null) => void;
  onBooksChanged?: () => void;
}

export function BookActionsOverlay({
  contextMenu,
  editBook,
  deleteTarget,
  activeCollectionId,
  onCloseMenu,
  onEditBook,
  onDeleteTarget,
  onBooksChanged,
}: BookActionsOverlayProps) {
  return (
    <>
      {contextMenu && (
        <BookContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          bookId={contextMenu.book.id}
          bookStatus={contextMenu.book.status}
          bookProgress={contextMenu.book.progress}
          activeCollectionId={activeCollectionId}
          onClose={onCloseMenu}
          onOpenBook={() => {
            onCloseMenu();
            void openReaderWindow(contextMenu.book.id);
          }}
          onMarkFinished={async () => {
            await markFinished(contextMenu.book.id);
            onCloseMenu();
            onBooksChanged?.();
          }}
          onMarkReading={async () => {
            await updateBookStatus(contextMenu.book.id, "reading");
            onCloseMenu();
            onBooksChanged?.();
          }}
          onMarkUnread={async () => {
            await updateBookStatus(contextMenu.book.id, "unread");
            onCloseMenu();
            onBooksChanged?.();
          }}
          onEditInfo={() => {
            onEditBook(contextMenu.book);
            onCloseMenu();
          }}
          onDelete={() => {
            onDeleteTarget(contextMenu.book);
            onCloseMenu();
          }}
          onBooksChanged={onBooksChanged}
        />
      )}

      {editBook && (
        <EditMetadataModal
          bookId={editBook.id}
          currentTitle={editBook.title}
          currentAuthor={editBook.author}
          onClose={() => onEditBook(null)}
          onSaved={() => {
            onEditBook(null);
            onBooksChanged?.();
          }}
        />
      )}

      <DeleteBookModal
        book={deleteTarget}
        onClose={() => onDeleteTarget(null)}
        onConfirm={async (id) => {
          await deleteBook(id);
          onBooksChanged?.();
        }}
      />
    </>
  );
}

export function LoadMoreSentinel({
  loadMore,
  loadingMore,
}: {
  loadMore?: () => void;
  loadingMore?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el || !loadMore || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) loadMore();
      },
      { rootMargin: "200px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [loadMore]);

  return (
    <div ref={ref} className="flex justify-center py-4">
      {loadingMore && <Loader2 size={20} className="text-text-tertiary animate-spin" />}
    </div>
  );
}
