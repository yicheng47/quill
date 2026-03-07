import { useNavigate } from "react-router-dom";
import { Book } from "../data/mockBooks";

interface BookGridProps {
  books: Book[];
}

export default function BookGrid({ books }: BookGridProps) {
  const navigate = useNavigate();

  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-6">
      {books.map((book) => (
        <button
          key={book.id}
          onClick={() => navigate(`/reader/${book.id}`)}
          className="text-left cursor-pointer group"
        >
          <div className="relative bg-border rounded-lg overflow-hidden shadow-card aspect-[3/4]">
            <img
              src={book.cover}
              alt={book.title}
              className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-200"
            />
            {book.status === "finished" && (
              <div className="absolute top-2 right-2 bg-success text-white text-[12px] px-2 py-1 rounded-full">
                Finished
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
  );
}
