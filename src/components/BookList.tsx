import { useNavigate } from "react-router-dom";
import { Book } from "../data/mockBooks";
import { Check } from "lucide-react";

interface BookListProps {
  books: Book[];
}

export default function BookList({ books }: BookListProps) {
  const navigate = useNavigate();

  return (
    <div className="flex flex-col gap-4 p-page">
      {books.map((book) => (
        <button
          key={book.id}
          onClick={() => navigate(`/reader/${book.id}`)}
          className="flex items-start gap-4 p-4 border border-border rounded-lg text-left cursor-pointer hover:bg-bg-muted transition-colors"
        >
          {/* Cover */}
          <div className="relative w-[96px] h-[144px] shrink-0 rounded-lg overflow-hidden bg-border shadow-card">
            <img
              src={book.cover}
              alt={book.title}
              className="w-full h-full object-cover"
            />
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
            <p className="text-[12px] text-text-muted leading-4 mt-1 truncate">
              {book.description}
            </p>

            <div className="mt-auto">
              {book.status === "reading" ? (
                <div className="flex flex-col gap-1">
                  <div className="flex items-center justify-between">
                    <span className="text-[12px] text-text-secondary">
                      {book.progress}% complete
                    </span>
                    <span className="text-[12px] text-text-secondary">
                      {book.pages} pages
                    </span>
                  </div>
                  <div className="w-full h-1.5 bg-dark/20 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-dark rounded-full"
                      style={{ width: `${book.progress}%` }}
                    />
                  </div>
                </div>
              ) : book.status === "unread" ? (
                <p className="text-[12px] text-text-muted">
                  {book.pages} pages &middot; Not started
                </p>
              ) : (
                <p className="text-[12px] font-medium text-success-text">
                  Finished reading
                </p>
              )}
            </div>
          </div>
        </button>
      ))}
    </div>
  );
}
