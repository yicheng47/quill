import { useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import type { Book } from "../hooks/useBooks";
import { openReaderWindow } from "../utils/openReaderWindow";
import { deleteBook, markFinished, updateBookStatus } from "../hooks/useBooks";
import BookContextMenu from "./BookContextMenu";
import EditMetadataModal from "./EditMetadataModal";
import { useTranslation } from "react-i18next";
import { CloudDownload } from "lucide-react";

function CoverImage({ src, alt, title }: { src: string; alt: string; title: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <div className="w-full h-full flex items-center justify-center bg-bg-muted">
        <span className="text-[14px] text-text-muted text-center px-4">{title}</span>
      </div>
    );
  }
  return (
    <img
      src={src}
      alt={alt}
      className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-200"
      onError={() => setFailed(true)}
    />
  );
}

interface BookGridProps {
  books: Book[];
  activeCollectionId?: string;
  onBooksChanged?: () => void;
}

export default function BookGrid({ books, activeCollectionId, onBooksChanged }: BookGridProps) {
  const { t } = useTranslation();
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    book: Book;
  } | null>(null);
  const [editBook, setEditBook] = useState<Book | null>(null);

  const handleContextMenu = (e: React.MouseEvent, book: Book) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY, book });
  };

  return (
    <>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-6">
        {books.map((book) => (
          <button
            key={book.id}
            onClick={() => book.available !== false && openReaderWindow(book.id)}
            onContextMenu={(e) => handleContextMenu(e, book)}
            className={`text-left cursor-pointer group ${book.available === false ? "opacity-60" : ""}`}
          >
            <div className="relative bg-border rounded-lg overflow-hidden shadow-card aspect-[3/4]">
              {book.cover_path ? (
                <CoverImage src={convertFileSrc(book.cover_path)} alt={book.title} title={book.title} />
              ) : (
                <div className="w-full h-full flex items-center justify-center bg-bg-muted">
                  <span className="text-[14px] text-text-muted text-center px-4">
                    {book.title}
                  </span>
                </div>
              )}
              {book.available === false && (
                <div className="absolute inset-0 flex items-center justify-center bg-black/30">
                  <CloudDownload size={32} className="text-white" />
                </div>
              )}
              {book.status === "finished" && book.available !== false && (
                <div className="absolute top-2 right-2 bg-success text-white text-[12px] px-2 py-1 rounded-full">
                  {t("bookGrid.finished")}
                </div>
              )}
            </div>
            <h3 className="mt-3 text-[14px] font-semibold text-text-primary tracking-[-0.15px] truncate">
              {book.title}
            </h3>
            <p className="text-[12px] text-text-secondary truncate">{book.author}</p>
          </button>
        ))}
      </div>

      {contextMenu && (
        <BookContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          bookId={contextMenu.book.id}
          bookStatus={contextMenu.book.status}
          activeCollectionId={activeCollectionId}
          onClose={() => setContextMenu(null)}
          onMarkFinished={async () => {
            await markFinished(contextMenu.book.id);
            setContextMenu(null);
            onBooksChanged?.();
          }}
          onMarkReading={async () => {
            await updateBookStatus(contextMenu.book.id, "reading");
            setContextMenu(null);
            onBooksChanged?.();
          }}
          onMarkUnread={async () => {
            await updateBookStatus(contextMenu.book.id, "unread");
            setContextMenu(null);
            onBooksChanged?.();
          }}
          onEditInfo={() => {
            setEditBook(contextMenu.book);
            setContextMenu(null);
          }}
          onDelete={async () => {
            await deleteBook(contextMenu.book.id);
            setContextMenu(null);
            onBooksChanged?.();
          }}
          onBooksChanged={onBooksChanged}
        />
      )}

      {editBook && (
        <EditMetadataModal
          bookId={editBook.id}
          currentTitle={editBook.title}
          currentAuthor={editBook.author}
          onClose={() => setEditBook(null)}
          onSaved={() => {
            setEditBook(null);
            onBooksChanged?.();
          }}
        />
      )}
    </>
  );
}
