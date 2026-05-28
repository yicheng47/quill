import { useState, useEffect, useRef, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Search, LayoutGrid, List, Plus, Upload, BookOpen, Loader, AlertCircle, X } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import Sidebar from "../components/Sidebar";
import BookGrid from "../components/BookGrid";
import BookList from "../components/BookList";
import DictionaryContent from "../components/DictionaryContent";
import ChatsContent from "../components/ChatsContent";
import TranslationsContent from "../components/TranslationsContent";
import SettingsModal from "../components/SettingsModal";
import Button from "../components/ui/Button";
import Input from "../components/ui/Input";
import { useBooks, importBookDialog } from "../hooks/useBooks";
import { useCollections } from "../hooks/useCollections";

function formatError(err: unknown): string {
  if (typeof err === "string") return err;
  if (err instanceof Error) return err.message;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

export default function Home() {
  const { t } = useTranslation();
  const [activeFilter, setActiveFilter] = useState("all");
  const [viewMode, setViewMode] = useState<"grid" | "list">("grid");
  const [searchQuery, setSearchQuery] = useState("");
  const [isDragging, setIsDragging] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importSlow, setImportSlow] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [syncProgress, setSyncProgress] = useState<{ applied: number; total: number } | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState<"general" | "reading" | "ai" | "lookup" | "librarySync" | "about">("general");
  const [userName, setUserName] = useState("");
  const collections = useCollections();

  // Load user name
  useEffect(() => {
    invoke<Record<string, string>>("get_all_settings")
      .then((s) => setUserName(s.user_name ?? ""))
      .catch(() => {});
  }, []);

  // Listen for open-settings events (DOM from same window, storage from reader windows)
  useEffect(() => {
    const handler = (e: Event) => {
      const section = (e as CustomEvent).detail ?? "general";
      setSettingsSection(section);
      setSettingsOpen(true);
    };
    window.addEventListener("open-settings", handler);

    // Cross-window: reader uses emitTo("main", ...) — must use webview-specific listener
    const unlisten = getCurrentWebview().listen<string>("open-settings", (event) => {
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

  const isCollectionFilter = activeFilter.startsWith("collection:");
  const statusFilter = !isCollectionFilter && activeFilter !== "all" ? activeFilter : undefined;
  const collectionId = isCollectionFilter ? activeFilter.replace("collection:", "") : undefined;
  const searchParam = searchQuery || undefined;

  const { books, loading, hasMore, loadMore, loadingMore, refresh } = useBooks(statusFilter, searchParam, collectionId);

  // Book counts for sidebar badges — lightweight, no book data loaded.
  const [bookCounts, setBookCounts] = useState({ all: 0, reading: 0, finished: 0 });
  const refreshCounts = useCallback(async () => {
    try {
      const counts = await invoke<{ all: number; reading: number; finished: number }>("get_book_counts");
      setBookCounts(counts);
    } catch (err) {
      console.error("Failed to load book counts:", err);
    }
  }, []);
  useEffect(() => { refreshCounts(); }, [refreshCounts]);

  // Keep stable refs for refresh functions so the drag-drop effect doesn't re-register
  const refreshRef = useRef(refresh);
  const countsRefreshRef = useRef(refreshCounts);
  const collectionsRefreshRef = useRef(collections.refresh);
  useEffect(() => { refreshRef.current = refresh; }, [refresh]);
  useEffect(() => { countsRefreshRef.current = refreshCounts; }, [refreshCounts]);
  useEffect(() => { collectionsRefreshRef.current = collections.refresh; }, [collections.refresh]);

  // Auto-dismiss import error after 10s
  useEffect(() => {
    if (!importError) return;
    const timer = setTimeout(() => setImportError(null), 10000);
    return () => clearTimeout(timer);
  }, [importError]);

  // After 5s of any import, hint that things are slower than usual so the
  // user knows the app hasn't frozen. Healthy imports finish in 1–5s; past
  // that, either pdf.js is stalled (PDF_METADATA_TIMEOUT_MS) or the Rust
  // EPUB path is grinding on a large file.
  useEffect(() => {
    if (!importing) {
      setImportSlow(false);
      return;
    }
    const timer = setTimeout(() => setImportSlow(true), 5000);
    return () => clearTimeout(timer);
  }, [importing]);

  useEffect(() => {
    const unlistenTick = listen("sync-initial-tick-done", () => {
      setSyncProgress(null);
      refreshRef.current();
      countsRefreshRef.current();
      collectionsRefreshRef.current();
    });
    const unlistenProgress = listen<{ applied: number; total: number }>("sync-progress", (e) => {
      setSyncProgress(e.payload);
    });
    return () => {
      unlistenTick.then((fn) => fn());
      unlistenProgress.then((fn) => fn());
    };
  }, []);

  // Refresh when MCP subprocess writes to the library.
  // Debounced: bulk MCP imports fire hundreds of events in quick
  // succession; without the delay each one triggers a full book list
  // reload, which can OOM/freeze the webview.
  useEffect(() => {
    let mcpDebounce: ReturnType<typeof setTimeout> | null = null;
    const unlistenBooks = listen("mcp:books-changed", () => {
      if (mcpDebounce) clearTimeout(mcpDebounce);
      mcpDebounce = setTimeout(() => {
        refreshRef.current();
        countsRefreshRef.current();
        collectionsRefreshRef.current();
      }, 500);
    });
    const unlistenCollections = listen("mcp:collections-changed", () => {
      collectionsRefreshRef.current();
      refreshRef.current();
      countsRefreshRef.current();
    });
    return () => {
      if (mcpDebounce) clearTimeout(mcpDebounce);
      unlistenBooks.then((fn) => fn());
      unlistenCollections.then((fn) => fn());
    };
  }, []);

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
                await importBookDialog.importFile(filePath);
              } catch (err) {
                console.error("Failed to import dropped book:", err);
                setImportError(`${filePath.split("/").pop()}: ${formatError(err)}`);
              }
            }
            refreshRef.current();
            countsRefreshRef.current();
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

  // Listen for files opened via dock icon drop or file association
  useEffect(() => {
    const unlisten = listen<string[]>("file-open", async (event) => {
      const paths = event.payload;
      if (paths.length === 0) return;
      setImporting(true);
      try {
        for (const filePath of paths) {
          try {
            await importBookDialog.importFile(filePath);
          } catch (err) {
            console.error("Failed to import file-open book:", err);
            setImportError(`${filePath.split("/").pop()}: ${formatError(err)}`);
          }
        }
        refreshRef.current();
        countsRefreshRef.current();
      } finally {
        setImporting(false);
      }
    });
    return () => { unlisten.then((fn) => fn()); };
  }, []);

  const displayBooks = books;

  const handleImport = async () => {
    let selected: string | null = null;
    try {
      selected = await importBookDialog.pickFile();
      if (!selected) return;
      setImporting(true);
      try {
        const book = await importBookDialog.importFile(selected);
        if (book) {
          refresh();
          refreshCounts();
        }
      } finally {
        setImporting(false);
      }
    } catch (err) {
      console.error("Failed to import book:", err);
      const name = selected ? selected.split("/").pop() : null;
      setImportError(name ? `${name}: ${formatError(err)}` : formatError(err));
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
        bookCounts={bookCounts}
        collections={collections}
        userName={userName}
        onOpenSettings={() => setSettingsOpen(true)}
        syncProgress={syncProgress}
      />

      {activeFilter === "vocab" ? (
        <DictionaryContent />
      ) : activeFilter === "chats" ? (
        <ChatsContent />
      ) : activeFilter === "translations" ? (
        <TranslationsContent />
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
              <BookGrid books={displayBooks} hasMore={hasMore} loadMore={loadMore} loadingMore={loadingMore} activeCollectionId={isCollectionFilter ? activeFilter.replace("collection:", "") : undefined} onBooksChanged={() => { refresh(); refreshCounts(); collections.refresh();}} />
            ) : (
              <BookList books={displayBooks} hasMore={hasMore} loadMore={loadMore} loadingMore={loadingMore} activeCollectionId={isCollectionFilter ? activeFilter.replace("collection:", "") : undefined} onBooksChanged={() => { refresh(); refreshCounts(); collections.refresh();}} />
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
            {importSlow && (
              <p className="max-w-[320px] text-center text-[13px] text-text-muted">
                {t("home.importingSlow")}
              </p>
            )}
          </div>
        </div>
      )}

      {importError && (
        <div className="fixed top-5 left-1/2 -translate-x-1/2 z-[60] max-w-[600px] bg-white dark:bg-bg-surface border border-border rounded-[14px] shadow-popover flex items-start gap-3 pl-4 pr-3 py-3">
          <AlertCircle size={16} className="shrink-0 mt-0.5 text-red-500" />
          <div className="flex-1 min-w-0">
            <p className="text-[13px] font-medium text-text-primary tracking-[-0.08px]">
              {t("home.importError")}
            </p>
            <p className="text-[12px] text-text-secondary mt-0.5 break-words">
              {importError}
            </p>
          </div>
          <button
            onClick={() => setImportError(null)}
            className="shrink-0 size-6 flex items-center justify-center rounded-lg hover:bg-bg-input cursor-pointer transition-colors"
          >
            <X size={14} className="text-text-muted" />
          </button>
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
