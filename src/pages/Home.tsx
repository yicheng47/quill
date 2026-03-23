import { useState, useEffect, useRef, useCallback } from "react";
import { Search, LayoutGrid, List, Settings, Plus, Upload, BookOpen } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import Sidebar from "../components/Sidebar";
import BookGrid from "../components/BookGrid";
import BookList from "../components/BookList";
import DictionaryContent from "../components/DictionaryContent";
import ChatsContent from "../components/ChatsContent";
import Button from "../components/ui/Button";
import Input from "../components/ui/Input";
import { useBooks, importBookDialog, type Book } from "../hooks/useBooks";
import { useCollections } from "../hooks/useCollections";

export default function Home() {
  const [activeFilter, setActiveFilter] = useState("all");
  const [viewMode, setViewMode] = useState<"grid" | "list">("grid");
  const [searchQuery, setSearchQuery] = useState("");
  const [isDragging, setIsDragging] = useState(false);
  const collections = useCollections();
  const navigate = useNavigate();

  // For collection filters, we need to fetch the book IDs in the collection
  // then filter client-side
  const isCollectionFilter = activeFilter.startsWith("collection:");
  const statusFilter = !isCollectionFilter && activeFilter !== "all" ? activeFilter : undefined;
  const searchParam = searchQuery || undefined;

  const { books, loading, refresh } = useBooks(statusFilter, searchParam);
  const allBooks = useBooks();

  // Collection-filtered books
  const [collectionBookIds, setCollectionBookIds] = useState<string[]>([]);
  const refreshCollectionBooks = useCallback(() => {
    if (!isCollectionFilter) return;
    const collectionId = activeFilter.replace("collection:", "");
    invoke<string[]>("list_books_in_collection", { collectionId })
      .then(setCollectionBookIds)
      .catch(() => setCollectionBookIds([]));
  }, [activeFilter, isCollectionFilter]);

  useEffect(() => {
    if (!isCollectionFilter) {
      setCollectionBookIds([]);
      return;
    }
    refreshCollectionBooks();
  }, [activeFilter, isCollectionFilter, refreshCollectionBooks]);

  // Keep stable refs for refresh functions so the drag-drop effect doesn't re-register
  const refreshRef = useRef(refresh);
  const allBooksRefreshRef = useRef(allBooks.refresh);
  useEffect(() => { refreshRef.current = refresh; }, [refresh]);
  useEffect(() => { allBooksRefreshRef.current = allBooks.refresh; }, [allBooks.refresh]);

  // Listen for Tauri file drag-and-drop events
  useEffect(() => {
    let cancelled = false;
    const unlisten = getCurrentWebview().onDragDropEvent(async (event) => {
      if (cancelled) return;
      if (event.payload.type === "over" || event.payload.type === "enter") {
        setIsDragging(true);
      } else if (event.payload.type === "drop") {
        setIsDragging(false);
        const books = event.payload.paths.filter((p) =>
          p.toLowerCase().endsWith(".epub") || p.toLowerCase().endsWith(".pdf")
        );
        for (const filePath of books) {
          try {
            if (filePath.toLowerCase().endsWith(".pdf")) {
              const { extractPdfMetadata } = await import("../utils/pdfMetadata");
              const meta = await extractPdfMetadata(filePath);
              await invoke<Book>("import_pdf", {
                sourcePath: filePath,
                title: meta.title,
                author: meta.author,
                description: meta.description,
                pages: meta.pages,
                coverData: meta.coverData ? Array.from(meta.coverData) : null,
              });
            } else {
              await invoke<Book>("import_book", { filePath });
            }
          } catch (err) {
            console.error("Failed to import dropped book:", err);
          }
        }
        if (books.length > 0) {
          refreshRef.current();
          allBooksRefreshRef.current();
        }
      } else {
        setIsDragging(false);
      }
    });
    return () => {
      cancelled = true;
      unlisten.then((fn) => fn());
    };
  }, []);

  const displayBooks = isCollectionFilter
    ? allBooks.books.filter((b) => collectionBookIds.includes(b.id))
    : books;

  const handleImport = async () => {
    try {
      const book = await importBookDialog();
      if (book) {
        refresh();
        allBooks.refresh();
      }
    } catch (err) {
      console.error("Failed to import book:", err);
    }
  };

  const title =
    activeFilter === "all"
      ? "All Books"
      : activeFilter === "reading"
        ? "Currently Reading"
        : activeFilter === "finished"
          ? "Finished"
          : isCollectionFilter
            ? "Collection"
            : activeFilter;

  return (
    <div className="relative flex h-screen bg-bg-surface">
      <Sidebar
        activeFilter={activeFilter}
        onFilterChange={setActiveFilter}
        books={allBooks.books}
        collections={collections}
      />

      {activeFilter === "vocab" ? (
        <DictionaryContent />
      ) : activeFilter === "chats" ? (
        <ChatsContent />
      ) : (
        <main className="flex-1 flex flex-col min-w-0">
          <div className="border-b border-border px-page pb-section relative">
            <div data-tauri-drag-region className="absolute top-0 left-0 right-0 h-11" />
            <div className="pt-11 flex items-center justify-between mb-4">
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
                  <LayoutGrid size={16} />
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

          <div className="flex-1 overflow-auto p-page pb-20">
            {loading ? (
              <p className="text-text-muted text-[14px]">Loading...</p>
            ) : displayBooks.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-full gap-4">
                <p className="text-text-muted text-[14px]">
                  {searchQuery
                    ? "No results found"
                    : isCollectionFilter
                      ? "No books in this collection"
                      : activeFilter !== "all"
                        ? `No ${activeFilter} books`
                        : "No books yet — import an EPUB or PDF to get started"}
                </p>
                {activeFilter === "all" && !searchQuery && (
                  <Button variant="primary" size="md" onClick={handleImport}>
                    <Plus size={16} />
                    Import Book
                  </Button>
                )}
              </div>
            ) : viewMode === "grid" ? (
              <BookGrid books={displayBooks} activeCollectionId={isCollectionFilter ? activeFilter.replace("collection:", "") : undefined} onBooksChanged={() => { refresh(); allBooks.refresh(); collections.refresh(); refreshCollectionBooks(); }} />
            ) : (
              <BookList books={displayBooks} activeCollectionId={isCollectionFilter ? activeFilter.replace("collection:", "") : undefined} onBooksChanged={() => { refresh(); allBooks.refresh(); collections.refresh(); refreshCollectionBooks(); }} />
            )}
          </div>

          <button
            onClick={handleImport}
            className="shrink-0 mx-page mb-page rounded-lg border border-dashed border-text-muted/40 py-4 flex items-center justify-center gap-2 text-[14px] text-text-secondary hover:border-accent hover:text-accent transition-colors cursor-pointer"
          >
            <Upload size={16} />
            Drop files or click to import more books
          </button>
        </main>
      )}

      {isDragging && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-overlay backdrop-blur-sm">
          <div className="flex flex-col items-center gap-4 rounded-xl border-2 border-dashed border-accent bg-bg-surface px-16 py-12 shadow-popover">
            <div className="flex h-14 w-14 items-center justify-center rounded-full bg-accent-bg">
              <BookOpen size={28} className="text-accent" />
            </div>
            <p className="text-[18px] font-semibold text-text-primary">
              Drop to add to your library
            </p>
            <p className="text-[14px] text-text-muted">EPUB & PDF</p>
          </div>
        </div>
      )}
    </div>
  );
}
