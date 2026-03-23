import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { convertFileSrc } from "@tauri-apps/api/core";
import { Check } from "lucide-react";
import type { Book } from "../hooks/useBooks";
import { deleteBook, markFinished, updateReadingProgress } from "../hooks/useBooks";
import BookContextMenu from "./BookContextMenu";

interface BookListProps {
  books: Book[];
  activeCollectionId?: string;
  onBooksChanged?: () => void;
}

export default function BookList({ books, activeCollectionId, onBooksChanged }: BookListProps) {
  const navigate = useNavigate();
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    book: Book;
  } | null>(null);

  const handleContextMenu = (e: React.MouseEvent, book: Book) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY, book });
  };

  return (
    <>
      <div className="flex flex-col gap-4 p-page">
        {books.map((book) => (
          <button
            key={book.id}
            onClick={() => navigate(`/reader/${book.id}`)}
            onContextMenu={(e) => handleContextMenu(e, book)}
            className="flex items-start gap-4 p-4 border border-border rounded-lg text-left cursor-pointer hover:bg-bg-muted transition-colors"
          >
            {/* Cover */}
            <div className="relative w-[96px] h-[144px] shrink-0 rounded-lg overflow-hidden bg-border shadow-card">
              {book.cover_path ? (
                <img
                  src={convertFileSrc(book.cover_path)}
                  alt={book.title}
                  className="w-full h-full object-cover"
                />
              ) : (
                <div className="w-full h-full flex items-center justify-center bg-bg-muted">
                  <span className="text-[10px] text-text-muted text-center px-1">
                    {book.title}
                  </span>
                </div>
              )}
              {book.status === "finished" && (
                <div className="absolute top-1 right-1 w-[22px] h-[20px] bg-success rounded-full flex items-center justify-center">
                  <Check size={12} className="text-white" strokeWidth={3} />
                </div>
              )}
            </div>

            {/* Info */}
            <div className="flex-1 min-w-0 h-[144px] flex flex-col">
              <h3 className="text-[18px] font-semibold text-text-primary tracking-[-0.44px] leading-[27px]">
                {book.title}
              </h3>
              <p className="text-[14px] text-text-secondary tracking-[-0.15px] leading-5">
                {book.author}
              </p>
              {book.description && (
                <p className="text-[12px] text-text-muted leading-4 mt-1 truncate">
                  {book.description}
                </p>
              )}

              <div className="mt-auto">
                <div className="flex flex-col gap-1">
                  <div className="flex items-center justify-between">
                    <span className="text-[12px] text-text-secondary">
                      {book.status === "finished"
                        ? "Finished"
                        : book.status === "reading"
                          ? `${book.progress}% complete`
                          : "Not started"}
                    </span>
                    {book.pages != null && (
                      <span className="text-[12px] text-text-secondary">
                        {book.pages} pages
                      </span>
                    )}
                  </div>
                  <div className="w-full h-1.5 bg-accent/20 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-accent rounded-full"
                      style={{ width: `${book.status === "finished" ? 100 : book.progress}%` }}
                    />
                  </div>
                </div>
              </div>
            </div>
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
            await updateReadingProgress(contextMenu.book.id, contextMenu.book.progress ?? 0);
            setContextMenu(null);
            onBooksChanged?.();
          }}
          onDelete={async () => {
            await deleteBook(contextMenu.book.id);
            setContextMenu(null);
            onBooksChanged?.();
          }}
          onBooksChanged={onBooksChanged}
        />
      )}
    </>
  );
}
