import { useState, useMemo } from "react";
import { Search, Grid3x3, List, Settings } from "lucide-react";
import { useNavigate } from "react-router-dom";
import Sidebar from "../components/Sidebar";
import BookGrid from "../components/BookGrid";
import BookList from "../components/BookList";
import Button from "../components/ui/Button";
import Input from "../components/ui/Input";
import { mockBooks } from "../data/mockBooks";

export default function Home() {
  const [activeFilter, setActiveFilter] = useState("all");
  const [viewMode, setViewMode] = useState<"grid" | "list">("grid");
  const [searchQuery, setSearchQuery] = useState("");
  const navigate = useNavigate();

  const filteredBooks = useMemo(() => {
    let books = mockBooks;

    if (activeFilter === "reading") {
      books = books.filter((b) => b.status === "reading");
    } else if (activeFilter === "finished") {
      books = books.filter((b) => b.status === "finished");
    } else if (activeFilter !== "all") {
      books = books.filter((b) => b.genre === activeFilter);
    }

    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      books = books.filter(
        (b) =>
          b.title.toLowerCase().includes(q) ||
          b.author.toLowerCase().includes(q)
      );
    }

    return books;
  }, [activeFilter, searchQuery]);

  const title =
    activeFilter === "all"
      ? "All Books"
      : activeFilter === "reading"
        ? "Currently Reading"
        : activeFilter === "finished"
          ? "Finished"
          : activeFilter;

  return (
    <div className="flex h-screen bg-bg-surface">
      <Sidebar activeFilter={activeFilter} onFilterChange={setActiveFilter} />

      <main className="flex-1 flex flex-col min-w-0">
        <div className="border-b border-border px-page pt-page pb-section">
          <div className="flex items-center justify-between mb-4">
            <h1 className="text-[24px] font-semibold text-text-primary tracking-[0.07px]">
              {title}
            </h1>
            <div className="flex items-center gap-0">
              <Button
                variant="icon"
                size="md"
                active={viewMode === "grid"}
                onClick={() => setViewMode("grid")}
              >
                <Grid3x3 size={16} />
              </Button>
              <Button
                variant="icon"
                size="md"
                active={viewMode === "list"}
                onClick={() => setViewMode("list")}
              >
                <List size={16} />
              </Button>
              <div className="w-px h-6 bg-border mx-2" />
              <Button
                variant="icon"
                size="md"
                onClick={() => navigate("/settings")}
              >
                <Settings size={16} />
              </Button>
            </div>
          </div>

          <Input
            icon={<Search size={16} />}
            placeholder="Search books..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-[448px]"
          />
        </div>

        <div className="flex-1 overflow-auto p-page">
          {viewMode === "grid" ? (
            <BookGrid books={filteredBooks} />
          ) : (
            <BookList books={filteredBooks} />
          )}
        </div>
      </main>
    </div>
  );
}
