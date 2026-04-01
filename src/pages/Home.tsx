import { useState, useEffect, useRef, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Search, LayoutGrid, List, Plus, Upload, BookOpen, Loader } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { listen } from "@tauri-apps/api/event";
import Sidebar from "../components/Sidebar";
import BookGrid from "../components/BookGrid";
import BookList from "../components/BookList";
import DictionaryContent from "../components/DictionaryContent";
import ChatsContent from "../components/ChatsContent";
import SettingsModal from "../components/SettingsModal";
import Button from "../components/ui/Button";
import Input from "../components/ui/Input";
import { useBooks, importBookDialog, type Book } from "../hooks/useBooks";
import { useCollections } from "../hooks/useCollections";

export default function Home() {
  const { t } = useTranslation();
  const [activeFilter, setActiveFilter] = useState("all");
  const [viewMode, setViewMode] = useState<"grid" | "list">("grid");
  const [searchQuery, setSearchQuery] = useState("");
  const [isDragging, setIsDragging] = useState(false);
  const [importing, setImporting] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState<"general" | "reading" | "ai" | "lookup" | "icloud" | "about">("general");
  const [userName, setUserName] = useState("");
  const collections = useCollections();

  // Load user name
  useEffect(() => {
    invoke<Record<string, string>>("get_all_settings")
      .then((s) => setUserName(s.user_name ?? ""))
      .catch(() => {});
  }, []);

  // Listen for open-settings events from UpdateToast and reader windows
  useEffect(() => {
    const handler = (e: Event) => {
      const section = (e as CustomEvent).detail ?? "general";
      setSettingsSection(section);
      setSettingsOpen(true);
    };
    window.addEventListener("open-settings", handler);

    // Also listen for Tauri events from other windows (e.g. reader)
    const unlisten = listen<string>("open-settings", (event) => {
      setSettingsSection((event.payload as typeof settingsSection) || "general");
      setSettingsOpen(true);
    });

    return () => {
      window.removeEventListener("open-settings", handler);
      unlisten.then((fn) => fn());
    };
  }, []);

  // Cmd+, to open settings
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === ",") {
        e.preventDefault();
        setSettingsOpen(true);
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, []);

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
        if (books.length > 0) {
          setImporting(true);
          try {
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
            refreshRef.current();
            allBooksRefreshRef.current();
          } finally {
            setImporting(false);
          }
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
      const selected = await importBookDialog.pickFile();
      if (!selected) return;
      setImporting(true);
      try {
        const book = await importBookDialog.importFile(selected);
        if (book) {
          refresh();
          allBooks.refresh();
        }
      } finally {
        setImporting(false);
      }
    } catch (err) {
      console.error("Failed to import book:", err);
    }
  };

  const title =
    activeFilter === "all"
      ? t("home.title.all")
      : activeFilter === "reading"
        ? t("home.title.reading")
        : activeFilter === "finished"
          ? t("home.title.finished")
          : isCollectionFilter
            ? t("home.title.collection")
            : activeFilter;

  return (
    <div className="relative flex h-screen bg-bg-surface">
      <Sidebar
        activeFilter={activeFilter}
        onFilterChange={setActiveFilter}
        books={allBooks.books}
        collections={collections}
        userName={userName}
        onOpenSettings={() => setSettingsOpen(true)}
      />

      {activeFilter === "vocab" ? (
        <DictionaryContent />
      ) : activeFilter === "chats" ? (
        <ChatsContent />
      ) : (
        <main className="flex-1 flex flex-col min-w-0">
          <div className="border-b border-border px-page pb-section relative select-none">
            <div data-tauri-drag-region className="absolute top-0 left-0 right-0 h-11" />
            <div className="pt-11 flex items-center justify-between mb-4">
              <h1 className="text-[24px] font-semibold text-text-primary tracking-[0.07px]">
                {title}
              </h1>
              <div data-tauri-drag-region className="flex items-center gap-0">
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
              </div>
            </div>

            <Input
              icon={<Search size={16} />}
              placeholder={t("home.search")}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-[448px]"
            />
          </div>

          <div className="flex-1 overflow-auto p-page pb-20">
            {loading ? (
              <p className="text-text-muted text-[14px]">{t("home.loading")}</p>
            ) : displayBooks.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-full gap-4">
                <p className="text-text-muted text-[14px]">
                  {searchQuery
                    ? t("home.noResults")
                    : isCollectionFilter
                      ? t("home.noCollectionBooks")
                      : activeFilter !== "all"
                        ? t("home.noFilteredBooks", { filter: activeFilter })
                        : t("home.empty")}
                </p>
                {activeFilter === "all" && !searchQuery && (
                  <Button variant="primary" size="md" onClick={handleImport}>
                    <Plus size={16} />
                    {t("home.importBook")}
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
            {t("home.dropHint")}
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
              {t("home.dropOverlay")}
            </p>
            <p className="text-[14px] text-text-muted">{t("home.dropFormats")}</p>
          </div>
        </div>
      )}

      {importing && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-overlay backdrop-blur-sm">
          <div className="flex flex-col items-center gap-4 rounded-xl border border-border bg-bg-surface px-16 py-12 shadow-popover">
            <Loader size={28} className="text-accent animate-spin" />
            <p className="text-[18px] font-semibold text-text-primary">
              {t("home.importing")}
            </p>
          </div>
        </div>
      )}

      <SettingsModal
        open={settingsOpen}
        onClose={() => {
          setSettingsOpen(false);
          setSettingsSection("general");
          // Reload user name in case it changed
          invoke<Record<string, string>>("get_all_settings")
            .then((s) => setUserName(s.user_name ?? ""))
            .catch(() => {});
        }}
        initialSection={settingsSection}
      />
    </div>
  );
}
