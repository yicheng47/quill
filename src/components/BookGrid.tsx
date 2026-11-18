import { memo, useState } from "react";
import type { Book } from "../hooks/useBooks";
import { openReaderWindow } from "../utils/openReaderWindow";
import BookCover from "./ui/BookCover";
import { CloudDownloadBadge, DoneBadge, PercentBadge } from "./ui/Badge";
import {
  BookActionsOverlay,
  LoadMoreSentinel,
  type BookMenuTarget,
} from "./BookViewSupport";

interface BookGridProps {
  books: Book[];
  hasMore?: boolean;
  loadMore?: () => void;
  loadingMore?: boolean;
  activeCollectionId?: string;
  onBooksChanged?: () => void;
}

function BookGrid({
  books,
  hasMore,
  loadMore,
  loadingMore,
  activeCollectionId,
  onBooksChanged,
}: BookGridProps) {
  const [contextMenu, setContextMenu] = useState<BookMenuTarget | null>(null);
  const [editBook, setEditBook] = useState<Book | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Book | null>(null);

  const handleContextMenu = (e: React.MouseEvent, book: Book) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY, book });
  };

  return (
    <>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(185px,1fr))] gap-7 pt-2">
        {books.map((book) => (
          <button
            key={book.id}
            type="button"
            onClick={() => openReaderWindow(book.id)}
            onContextMenu={(e) => handleContextMenu(e, book)}
            className="text-left cursor-pointer group flex flex-col gap-2.5 focus-visible:outline-none"
          >
            <BookCover
              title={book.title}
              author={book.author}
              coverData={book.cover_data}
              coverPath={book.cover_path}
              className={`w-full aspect-[3/4] transition-shadow duration-200 group-hover:shadow-[var(--shadow-cover-hover)] group-focus-visible:ring-[3px] group-focus-visible:ring-focus-ring ${
                book.available === false ? "opacity-75" : ""
              }`}
            >
              {book.available === false ? (
                <div className="absolute inset-0 flex items-center justify-center">
                  <CloudDownloadBadge />
                </div>
              ) : (
                <div className="absolute inset-0 p-2.5 flex items-end justify-end pointer-events-none">
                  {book.status === "finished" ? (
                    <DoneBadge />
                  ) : book.status === "reading" ? (
                    <PercentBadge percent={book.progress} />
                  ) : null}
                </div>
              )}
            </BookCover>

            <div className="flex flex-col gap-0.5 min-w-0">
              <h3 className="text-[14px] font-medium text-text-primary leading-snug truncate">
                {book.title}
              </h3>
              <p className="text-[12.5px] text-text-tertiary leading-snug truncate">
                {book.author}
              </p>
            </div>
          </button>
        ))}
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

export default memo(BookGrid);
