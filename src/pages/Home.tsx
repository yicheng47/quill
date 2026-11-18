import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import {
  Plus,
  FolderClosed,
  FolderOpen,
  ChevronDown,
  LayoutGrid,
  List,
  BookOpen,
  BookUp,
  SearchX,
} from "lucide-react";
import TopBar, { type MainRoute } from "../components/TopBar";
import CommandSearchModal from "../components/CommandSearchModal";
import ImportOverlays from "../components/ImportOverlays";
import CollectionsPopover from "../components/CollectionsPopover";
import DeleteCollectionModal from "../components/DeleteCollectionModal";
import AddBooksModal from "../components/AddBooksModal";
import BookGrid from "../components/BookGrid";
import BookList from "../components/BookList";
import DictionaryContent from "../components/DictionaryContent";
import ChatsContent from "../components/ChatsContent";
import SettingsModal, { type SettingsSection } from "../components/SettingsModal";
import SearchField from "../components/ui/SearchField";
import { SegmentedControl } from "../components/ui/Segment";
import { useBooks, importBookDialog } from "../hooks/useBooks";
import { useCollections, type Collection } from "../hooks/useCollections";
import { invoke, listen, listenCurrentWindow, onDragDrop } from "../platform";
import { shortcutModSymbol } from "../lib/platformEnv";

interface BookCounts {
  all: number;
  reading: number;
  finished: number;
  unread: number;
}

type StatusFilter = "all" | "reading" | "finished" | "unread";
type ViewMode = "grid" | "list";

const SUPPORTED_BOOK_EXT = /\.(epub|pdf)$/i;

function basenameFromPath(filePath: string): string {
  const parts = filePath.split(/[\\/]/);
  return parts[parts.length - 1] || filePath;
}

function normalizeSettingsSection(section?: string): SettingsSection {
  if (section === "lookup" || section === "translation" || section === "tools") {
    return "tools";
  }
  if (
    section === "general" ||
    section === "appearance" ||
    section === "reading" ||
    section === "ai" ||
    section === "librarySync" ||
    section === "mcp" ||
    section === "about"
  ) {
    return section;
  }
  return "general";
}

function subscribeAsync(register: (isActive: () => boolean) => Promise<() => void>): () => void {
  let active = true;
  let unlisten: (() => void) | undefined;
  void register(() => active)
    .then((fn) => {
      if (active) unlisten = fn;
      else fn();
    })
    .catch(() => {});
  return () => {
    active = false;
    unlisten?.();
    unlisten = undefined;
  };
}

export default function Home() {
  const { t } = useTranslation();
  const mod = shortcutModSymbol();

  const [activeRoute, setActiveRoute] = useState<MainRoute>("library");
  const [searchOpen, setSearchOpen] = useState(false);

  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [collectionFilter, setCollectionFilter] = useState<string>("all");
  const [viewMode, setViewMode] = useState<ViewMode>(() =>
    localStorage.getItem("quill-library-view") === "list" ? "list" : "grid",
  );
  const [searchQuery, setSearchQuery] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState<SettingsSection>("general");

  const [collectionsOpen, setCollectionsOpen] = useState(false);
  const [deleteCollectionTarget, setDeleteCollectionTarget] = useState<Collection | null>(null);
  const [addBooksOpen, setAddBooksOpen] = useState(false);

  const [isDragging, setIsDragging] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importingCount, setImportingCount] = useState(1);
  const [importingFileName, setImportingFileName] = useState<string | null>(null);
  const [importSlow, setImportSlow] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);

  const [bookCounts, setBookCounts] = useState<BookCounts>({
    all: 0,
    reading: 0,
    finished: 0,
    unread: 0,
  });
  const [totalBooksCount, setTotalBooksCount] = useState(0);
  const [bookCollectionsMap, setBookCollectionsMap] = useState<Map<string, Collection[]>>(
    () => new Map(),
  );

  const collectionsAnchorRef = useRef<HTMLButtonElement>(null);
  const filterInputRef = useRef<HTMLInputElement>(null);

  const collections = useCollections();
  const {
    collections: collectionList,
    refresh: refreshCollections,
    getBooksInCollection,
  } = collections;

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedSearch(searchQuery.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [searchQuery]);

  const activeCollection = useMemo(() => {
    if (collectionFilter === "all") return null;
    return collectionList.find((c) => c.id === collectionFilter) ?? null;
  }, [collectionFilter, collectionList]);

  const statusArg = statusFilter === "all" ? undefined : statusFilter;
  const activeCollectionId = collectionFilter === "all" ? undefined : collectionFilter;

  const { books, loading, loadingMore, hasMore, loadMore, refreshSilently, patchBook } =
    useBooks(statusArg, debouncedSearch || undefined, activeCollectionId);

  const fetchCounts = useCallback(async (colId?: string) => {
    try {
      const [scoped, overall] = await Promise.all([
        invoke<BookCounts>("get_book_counts", { collectionId: colId ?? null }),
        colId ? invoke<BookCounts>("get_book_counts", { collectionId: null }) : Promise.resolve(null),
      ]);
      setBookCounts(scoped);
      setTotalBooksCount(overall ? overall.all : scoped.all);
    } catch {
      // ignore initial count race
    }
  }, []);

  const refreshBookCollectionsMap = useCallback(async (cols: Collection[]) => {
    if (cols.length === 0) {
      setBookCollectionsMap(new Map());
      return;
    }
    try {
      const entries = await Promise.all(
        cols.map(async (c) => {
          const ids = await getBooksInCollection(c.id);
          return [c, ids] as const;
        }),
      );
      const map = new Map<string, Collection[]>();
      for (const [col, ids] of entries) {
        for (const id of ids) {
          const existing = map.get(id);
          if (existing) {
            existing.push(col);
          } else {
            map.set(id, [col]);
          }
        }
      }
      setBookCollectionsMap(map);
    } catch {
      // keep previous map on transient error
    }
  }, [getBooksInCollection]);

  useEffect(() => {
    void fetchCounts(activeCollectionId);
  }, [fetchCounts, activeCollectionId]);

  useEffect(() => {
    void refreshBookCollectionsMap(collectionList);
  }, [refreshBookCollectionsMap, collectionList]);

  const refreshAllSilently = useCallback(async () => {
    await Promise.all([
      refreshSilently(),
      refreshCollections(),
      fetchCounts(activeCollectionId),
    ]);
  }, [refreshSilently, refreshCollections, fetchCounts, activeCollectionId]);

  const refreshAllSilentlyRef = useRef(refreshAllSilently);
  refreshAllSilentlyRef.current = refreshAllSilently;

  const silentRefreshRef = useRef(refreshSilently);
  silentRefreshRef.current = refreshSilently;

  const activeCollectionIdRef = useRef(activeCollectionId);
  activeCollectionIdRef.current = activeCollectionId;

  const fetchCountsRef = useRef(fetchCounts);
  fetchCountsRef.current = fetchCounts;

  const collectionsRefreshRef = useRef(refreshCollections);
  collectionsRefreshRef.current = refreshCollections;

  const openSettings = useCallback((section?: SettingsSection | "updates") => {
    setSettingsSection(normalizeSettingsSection(section));
    setSettingsOpen(true);
  }, []);

  // Settings modal listeners
  useEffect(() => {
    const domHandler = (e: Event) => {
      const section = (e as CustomEvent<{ section?: string }>).detail?.section;
      openSettings(section as SettingsSection | "updates" | undefined);
    };
    window.addEventListener("open-settings", domHandler);

    const disposeIpc = subscribeAsync((isActive) =>
      listenCurrentWindow<string>("open-settings", (e) => {
        if (!isActive()) return;
        openSettings(e.payload as SettingsSection | "updates");
      }),
    );

    return () => {
      window.removeEventListener("open-settings", domHandler);
      disposeIpc();
    };
  }, [openSettings]);

  // Global keyboard shortcuts: Cmd+, Settings, Cmd+K Command Search, Cmd+F Inline Library Filter
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
      if (e.key === ",") {
        e.preventDefault();
        openSettings("general");
        return;
      }
      const lower = e.key.toLowerCase();
      if (lower === "k" && !e.shiftKey) {
        if (settingsOpen || addBooksOpen || Boolean(deleteCollectionTarget)) return;
        e.preventDefault();
        setCollectionsOpen(false);
        setSearchOpen((prev) => !prev);
        return;
      }
      if (lower === "f" && !e.shiftKey) {
        if (
          activeRoute === "library" &&
          !searchOpen &&
          !addBooksOpen &&
          !settingsOpen &&
          !deleteCollectionTarget
        ) {
          e.preventDefault();
          filterInputRef.current?.focus();
          filterInputRef.current?.select();
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [
    activeRoute,
    searchOpen,
    addBooksOpen,
    settingsOpen,
    deleteCollectionTarget,
    openSettings,
  ]);

  // Mark synced iCloud books available as soon as hydration finishes
  useEffect(() => {
    return subscribeAsync((isActive) =>
      listenCurrentWindow<string>("book-availability-changed", (e) => {
        if (!isActive()) return;
        patchBook(e.payload, { available: true });
      }),
    );
  }, [patchBook]);

  // Refresh after initial sync / MCP changes / ingested covers
  useEffect(() => {
    let mcpDebounce: ReturnType<typeof setTimeout> | undefined;
    let coversDebounce: ReturnType<typeof setTimeout> | undefined;

    const disposeSync = subscribeAsync((isActive) =>
      listen("sync-initial-tick-done", () => {
        if (!isActive()) return;
        void refreshAllSilentlyRef.current();
      }),
    );

    const disposeMcpBooks = subscribeAsync((isActive) =>
      listen("mcp:books-changed", () => {
        if (!isActive()) return;
        if (mcpDebounce) clearTimeout(mcpDebounce);
        mcpDebounce = setTimeout(() => {
          if (isActive()) void refreshAllSilentlyRef.current();
        }, 500);
      }),
    );

    const disposeMcpCols = subscribeAsync((isActive) =>
      listen("mcp:collections-changed", () => {
        if (!isActive()) return;
        void collectionsRefreshRef.current();
        void fetchCountsRef.current(activeCollectionIdRef.current);
      }),
    );

    const disposeCovers = subscribeAsync((isActive) =>
      listen("sync-covers-ingested", () => {
        if (!isActive()) return;
        if (coversDebounce) clearTimeout(coversDebounce);
        coversDebounce = setTimeout(() => {
          if (isActive()) void silentRefreshRef.current();
        }, 500);
      }),
    );

    return () => {
      disposeSync();
      disposeMcpBooks();
      disposeMcpCols();
      disposeCovers();
      if (mcpDebounce) clearTimeout(mcpDebounce);
      if (coversDebounce) clearTimeout(coversDebounce);
    };
  }, []);

  // Import slow & error timers
  useEffect(() => {
    if (!importing) {
      setImportSlow(false);
      return;
    }
    const timer = window.setTimeout(() => setImportSlow(true), 5000);
    return () => window.clearTimeout(timer);
  }, [importing]);

  useEffect(() => {
    if (!importError) return;
    const timer = window.setTimeout(() => setImportError(null), 10000);
    return () => window.clearTimeout(timer);
  }, [importError]);

  const importFiles = useCallback(async (paths: string[], targetCollectionId?: string) => {
    const valid = paths.filter((p) => SUPPORTED_BOOK_EXT.test(p));
    if (valid.length === 0) return;

    setImportError(null);
    setImportingCount(valid.length);
    setImportingFileName(basenameFromPath(valid[0]));
    setImporting(true);
    let anyImported = false;
    const errors: string[] = [];
    try {
      for (const filePath of valid) {
        const name = basenameFromPath(filePath);
        setImportingFileName(name);
        try {
          const book = await importBookDialog.importFile(filePath);
          anyImported = true;
          if (targetCollectionId) {
            await invoke("add_book_to_collection", {
              collectionId: targetCollectionId,
              bookId: book.id,
            });
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          errors.push(valid.length > 1 ? `${name}: ${msg}` : msg);
          console.error(`Failed to import ${name}:`, err);
        }
      }
      if (errors.length > 0) {
        setImportError(errors.join(" · "));
      }
    } finally {
      setImporting(false);
      setImportingFileName(null);
      if (anyImported) {
        await refreshAllSilentlyRef.current();
      }
    }
  }, []);

  const handleImport = useCallback(async (targetCollectionId?: string) => {
    setImportError(null);
    try {
      const filePath = await importBookDialog.pickFile();
      if (!filePath) return;
      await importFiles([filePath], targetCollectionId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setImportError(msg);
      console.error("Failed to pick book to import:", err);
    }
  }, [importFiles]);

  // Drag-and-drop file import
  useEffect(() => {
    return subscribeAsync((isActive) =>
      onDragDrop((event) => {
        if (!isActive()) return;
        if (event.type === "enter" || event.type === "over") {
          setIsDragging(true);
        } else if (event.type === "drop") {
          setIsDragging(false);
          void importFiles(event.paths, activeCollectionIdRef.current);
        } else {
          setIsDragging(false);
        }
      }),
    );
  }, [importFiles]);

  // OS file-open associations (.epub / .pdf double-click)
  useEffect(() => {
    return subscribeAsync((isActive) =>
      listen<string[]>("file-open", (event) => {
        if (!isActive()) return;
        void importFiles(event.payload, undefined);
      }),
    );
  }, [importFiles]);

  const handleViewModeChange = (mode: ViewMode) => {
    setViewMode(mode);
    localStorage.setItem("quill-library-view", mode);
  };

  const handleDeleteCollection = async (id: string) => {
    await collections.remove(id);
    if (collectionFilter === id) {
      setCollectionFilter("all");
      await Promise.all([refreshCollections(), fetchCounts(undefined)]);
    } else {
      await refreshAllSilently();
    }
  };

  const handleAddBooksConfirm = async (collectionId: string, bookIds: string[]) => {
    await collections.addBooks(collectionId, bookIds);
    await refreshAllSilently();
  };

  const statusOptions: Array<{ value: StatusFilter; label: string; count: number }> = [
    { value: "all", label: t("library.filter.all"), count: bookCounts.all },
    { value: "reading", label: t("library.filter.reading"), count: bookCounts.reading },
    { value: "finished", label: t("library.filter.finished"), count: bookCounts.finished },
    { value: "unread", label: t("library.filter.unread"), count: bookCounts.unread },
  ];

  const isCollectionEmpty =
    !loading &&
    books.length === 0 &&
    Boolean(activeCollection) &&
    statusFilter === "all" &&
    !debouncedSearch;

  const isLibraryEmpty =
    !loading &&
    books.length === 0 &&
    !activeCollection &&
    statusFilter === "all" &&
    !debouncedSearch &&
    totalBooksCount === 0;

  const isNoSearchMatch = !loading && books.length === 0 && debouncedSearch.length > 0;
  const isFilteredEmpty = !loading && books.length === 0 && !isCollectionEmpty && !isLibraryEmpty && !isNoSearchMatch;

  return (
    <div className="h-screen dawn-atmosphere flex flex-col overflow-hidden text-text-primary">
      <TopBar
        activeRoute={activeRoute}
        onRouteChange={setActiveRoute}
        searchOpen={searchOpen}
        onOpenSearch={() => {
          setCollectionsOpen(false);
          setSearchOpen(true);
        }}
        importing={importing}
        onImport={() => void handleImport(activeRoute === "library" ? activeCollectionId : undefined)}
        settingsOpen={settingsOpen}
        onOpenSettings={openSettings}
      />

      {activeRoute === "library" && (
        <main className="flex-1 min-h-0 overflow-y-auto px-10 pt-1 pb-10">
          {/* Library Header */}
          <div className="flex flex-wrap items-center justify-between gap-4 pb-6">
            <div className="flex items-baseline gap-3 min-w-0">
              <h1 className="text-[28px] font-semibold tracking-[-0.5px] leading-[1.15] text-text-primary truncate max-w-[360px]">
                {activeCollection ? activeCollection.name : t("library.title")}
              </h1>
              <span className="font-mono text-[12.5px] text-text-tertiary shrink-0">
                {activeCollection
                  ? t("library.collectionCount", { count: bookCounts.all })
                  : t("library.bookCount", { count: totalBooksCount })}
              </span>
            </div>

            <div className="flex flex-wrap items-center justify-end gap-2.5">
              {activeCollection && (
                <button
                  type="button"
                  onClick={() => setAddBooksOpen(true)}
                  className="h-10 px-4 rounded-full bg-accent-tint hover:bg-violet-200/80 text-accent-on-tint text-[13px] font-semibold inline-flex items-center gap-1.5 cursor-pointer transition-colors"
                >
                  <Plus size={14} strokeWidth={2.2} />
                  <span>{t("collections.addBooksButton")}</span>
                </button>
              )}

              <SearchField
                ref={filterInputRef}
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onClear={() => setSearchQuery("")}
                placeholder={t("library.searchPlaceholder")}
                aria-label={t("library.searchPlaceholder")}
                shortcutHint={`${mod}F`}
                className="w-[210px] sm:w-[235px]"
              />

              <SegmentedControl
                value={statusFilter}
                onChange={setStatusFilter}
                options={statusOptions}
              />

              <div className="relative">
                <button
                  ref={collectionsAnchorRef}
                  type="button"
                  onClick={() => setCollectionsOpen((prev) => !prev)}
                  aria-expanded={collectionsOpen}
                  aria-haspopup="dialog"
                  className={`h-10 px-3.5 rounded-full inline-flex items-center gap-2 text-[13px] cursor-pointer transition-colors focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-focus-ring ${
                    activeCollection
                      ? "bg-accent-tint border border-violet-300/60 text-accent-on-tint font-semibold"
                      : "dawn-glass text-text-primary font-medium hover:bg-surface-solid"
                  }`}
                >
                  {activeCollection ? (
                    <FolderOpen size={14} className="shrink-0" />
                  ) : (
                    <FolderClosed size={14} className="text-text-secondary shrink-0" />
                  )}
                  <span className="max-w-[160px] truncate">
                    {activeCollection ? activeCollection.name : t("collections.allCollections")}
                  </span>
                  <ChevronDown
                    size={13}
                    className={`shrink-0 transition-transform ${collectionsOpen ? "rotate-180" : ""} ${
                      activeCollection ? "text-accent-on-tint" : "text-text-tertiary"
                    }`}
                  />
                </button>

                <CollectionsPopover
                  open={collectionsOpen}
                  onClose={() => setCollectionsOpen(false)}
                  anchorRef={collectionsAnchorRef}
                  activeFilter={collectionFilter}
                  onSelectFilter={setCollectionFilter}
                  totalBooksCount={totalBooksCount}
                  collections={collections.collections}
                  onCreate={collections.create}
                  onRename={collections.rename}
                  onRequestDelete={(col) => setDeleteCollectionTarget(col)}
                  onReorder={collections.reorder}
                />
              </div>

              <div
                role="group"
                aria-label={t("library.viewMode")}
                className="dawn-glass h-10 p-1 rounded-full inline-flex items-center gap-0.5"
              >
                <button
                  type="button"
                  onClick={() => handleViewModeChange("grid")}
                  aria-label={t("library.gridView")}
                  aria-pressed={viewMode === "grid"}
                  className={`size-8 rounded-full flex items-center justify-center cursor-pointer transition-colors ${
                    viewMode === "grid"
                      ? "bg-accent-tint text-accent-on-tint"
                      : "text-text-tertiary hover:text-text-primary"
                  }`}
                >
                  <LayoutGrid size={15} />
                </button>
                <button
                  type="button"
                  onClick={() => handleViewModeChange("list")}
                  aria-label={t("library.listView")}
                  aria-pressed={viewMode === "list"}
                  className={`size-8 rounded-full flex items-center justify-center cursor-pointer transition-colors ${
                    viewMode === "list"
                      ? "bg-accent-tint text-accent-on-tint"
                      : "text-text-tertiary hover:text-text-primary"
                  }`}
                >
                  <List size={15} />
                </button>
              </div>
            </div>
          </div>

          {/* Content / Empty States */}
          {loading ? (
            <div className="flex items-center justify-center py-24 text-text-tertiary text-[14px]">
              {t("library.loading")}
            </div>
          ) : isCollectionEmpty && activeCollection ? (
            <div className="flex items-center justify-center py-20">
              <div className="dawn-glass rounded-[24px] p-8 max-w-[440px] w-full flex flex-col items-center text-center gap-3.5">
                <div className="size-14 rounded-[18px] bg-accent-tint flex items-center justify-center text-accent-on-tint">
                  <FolderOpen size={24} />
                </div>
                <h2 className="text-[18px] font-semibold text-text-primary tracking-[-0.2px]">
                  {t("collections.emptyStateTitle", { name: activeCollection.name })}
                </h2>
                <p className="text-[13px] text-text-secondary leading-[1.5]">
                  {t("collections.emptyStateSub")}
                </p>
                <div className="pt-2 flex flex-wrap items-center justify-center gap-2.5">
                  <button
                    type="button"
                    onClick={() => setAddBooksOpen(true)}
                    className="px-4 py-2 rounded-full bg-accent hover:bg-accent-hover text-white text-[13px] font-semibold cursor-pointer transition-colors"
                  >
                    {t("collections.addFromLibrary")}
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleImport(activeCollection.id)}
                    className="px-4 py-2 rounded-full bg-surface-chip border border-border-default hover:bg-surface-solid text-[13px] font-medium text-text-primary cursor-pointer transition-colors inline-flex items-center gap-1.5"
                  >
                    <BookUp size={14} className="text-text-secondary" />
                    <span>{t("collections.importFile")}</span>
                  </button>
                </div>
              </div>
            </div>
          ) : isLibraryEmpty ? (
            <div className="flex items-center justify-center py-20">
              <div className="dawn-glass rounded-[24px] p-8 max-w-[440px] w-full flex flex-col items-center text-center gap-3.5">
                <div className="size-14 rounded-[18px] bg-accent-tint flex items-center justify-center text-accent-on-tint">
                  <BookOpen size={24} />
                </div>
                <h2 className="text-[18px] font-semibold text-text-primary tracking-[-0.2px]">
                  {t("library.emptyTitle")}
                </h2>
                <p className="text-[13px] text-text-secondary leading-[1.5]">
                  {t("library.emptySub")}
                </p>
                <div className="pt-2">
                  <button
                    type="button"
                    onClick={() => void handleImport()}
                    className="px-4 py-2 rounded-full bg-accent hover:bg-accent-hover text-white text-[13px] font-semibold cursor-pointer transition-colors inline-flex items-center gap-1.5"
                  >
                    <Plus size={15} />
                    <span>{t("library.importBook")}</span>
                  </button>
                </div>
              </div>
            </div>
          ) : isNoSearchMatch ? (
            <div className="flex items-center justify-center py-20">
              <div className="dawn-glass rounded-[24px] p-8 max-w-[440px] w-full flex flex-col items-center text-center gap-3">
                <div className="size-12 rounded-[16px] bg-surface-inset flex items-center justify-center text-text-tertiary">
                  <SearchX size={22} />
                </div>
                <h2 className="text-[16px] font-semibold text-text-primary">
                  {t("library.noMatchTitle", { query: debouncedSearch })}
                </h2>
                <p className="text-[13px] text-text-secondary leading-[1.5]">
                  {t("library.noMatchSub")}
                </p>
                <div className="pt-1.5">
                  <button
                    type="button"
                    onClick={() => setSearchQuery("")}
                    className="px-4 py-1.5 rounded-full bg-surface-chip border border-border-default hover:bg-surface-solid text-[12.5px] font-medium text-text-primary cursor-pointer transition-colors"
                  >
                    {t("library.clearSearch")}
                  </button>
                </div>
              </div>
            </div>
          ) : isFilteredEmpty ? (
            <div className="flex items-center justify-center py-20">
              <div className="dawn-glass rounded-[24px] p-8 max-w-[420px] w-full flex flex-col items-center text-center gap-3">
                <h2 className="text-[16px] font-semibold text-text-primary">
                  {t("library.noFilteredBooks", {
                    filter: t(`library.filter.${statusFilter}`),
                  })}
                </h2>
                <button
                  type="button"
                  onClick={() => setStatusFilter("all")}
                  className="px-4 py-1.5 rounded-full bg-surface-chip border border-border-default hover:bg-surface-solid text-[12.5px] font-medium text-text-primary cursor-pointer transition-colors"
                >
                  {t("library.showAllBooks")}
                </button>
              </div>
            </div>
          ) : viewMode === "grid" ? (
            <BookGrid
              books={books}
              hasMore={hasMore}
              loadMore={loadMore}
              loadingMore={loadingMore}
              activeCollectionId={activeCollectionId}
              onBooksChanged={() => void refreshAllSilently()}
            />
          ) : (
            <BookList
              books={books}
              bookCollectionsMap={bookCollectionsMap}
              hasMore={hasMore}
              loadMore={loadMore}
              loadingMore={loadingMore}
              activeCollectionId={activeCollectionId}
              onBooksChanged={() => void refreshAllSilently()}
              onBookAvailable={(bookId) => patchBook(bookId, { available: true })}
            />
          )}
        </main>
      )}

      {activeRoute === "words" && (
        <div className="flex-1 min-h-0 flex overflow-hidden">
          <DictionaryContent />
        </div>
      )}

      {activeRoute === "chats" && (
        <div className="flex-1 min-h-0 flex overflow-hidden">
          <ChatsContent />
        </div>
      )}

      <CommandSearchModal open={searchOpen} onClose={() => setSearchOpen(false)} />

      <ImportOverlays
        isDragging={isDragging}
        importing={importing}
        importingCount={importingCount}
        importingFileName={importingFileName}
        importSlow={importSlow}
        importError={importError}
        onDismissError={() => setImportError(null)}
      />

      <DeleteCollectionModal
        collection={deleteCollectionTarget}
        onClose={() => setDeleteCollectionTarget(null)}
        onConfirm={handleDeleteCollection}
      />

      <AddBooksModal
        open={addBooksOpen}
        collection={activeCollection}
        onClose={() => setAddBooksOpen(false)}
        onConfirm={handleAddBooksConfirm}
      />

      <SettingsModal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        initialSection={settingsSection}
      />
    </div>
  );
}
