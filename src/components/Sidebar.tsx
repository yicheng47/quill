import { useState, useRef, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Library, BookOpen, CheckCircle2, FolderClosed, BookA, Plus, MessageSquare, Globe, Pencil, Trash2, GripVertical } from "lucide-react";
import Button from "./ui/Button";
import QuillLogo from "./QuillLogo";
import type { Book } from "../hooks/useBooks";
import type { Collection } from "../hooks/useCollections";

interface SidebarProps {
  activeFilter: string;
  onFilterChange: (filter: string) => void;
  books: Book[];
  collections: {
    collections: Collection[];
    create: (name: string) => Promise<Collection>;
    rename: (id: string, name: string) => Promise<void>;
    remove: (id: string) => Promise<void>;
    reorder: (ids: string[]) => Promise<void>;
  };
  userName?: string;
  onOpenSettings?: () => void;
}

const SIDEBAR_MIN = 180;
const SIDEBAR_MAX = 400;
const SIDEBAR_DEFAULT = 224;
const STORAGE_KEY = "sidebar-width";

function getStoredWidth(): number {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored) {
    const n = parseInt(stored, 10);
    if (!isNaN(n) && n >= SIDEBAR_MIN && n <= SIDEBAR_MAX) return n;
  }
  return SIDEBAR_DEFAULT;
}

export default function Sidebar({ activeFilter, onFilterChange, books, collections: collectionsHook, userName, onOpenSettings }: SidebarProps) {
  const { t } = useTranslation();
  const [sidebarWidth, setSidebarWidth] = useState(getStoredWidth);
  const resizingRef = useRef(false);

  const libraryFilters = [
    { id: "all", label: t("sidebar.allBooks"), icon: Library },
    { id: "reading", label: t("sidebar.currentlyReading"), icon: BookOpen },
    { id: "finished", label: t("sidebar.finished"), icon: CheckCircle2 },
  ];
  const { collections, create, rename, remove, reorder } = collectionsHook;
  const [isCreating, setIsCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; collection: Collection } | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const contextMenuRef = useRef<HTMLDivElement>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dragOrder, setDragOrder] = useState<string[]>([]);
  const collectionListRef = useRef<HTMLDivElement>(null);

  const handlePointerDown = useCallback((e: React.PointerEvent, id: string) => {
    // Only start drag from grip handle
    if (!(e.target as HTMLElement).closest("[data-grip]")) return;
    e.preventDefault();
    const listEl = collectionListRef.current;
    if (!listEl) return;
    const items = Array.from(listEl.children) as HTMLElement[];
    const startY = e.clientY;
    const ids = collections.map((c) => c.id);
    const startIdx = ids.indexOf(id);
    const itemHeight = items[0]?.getBoundingClientRect().height ?? 36;

    setDragId(id);
    setDragOrder(ids);

    const onMove = (ev: PointerEvent) => {
      const dy = ev.clientY - startY;
      const offset = Math.round(dy / itemHeight);
      const newIdx = Math.max(0, Math.min(ids.length - 1, startIdx + offset));
      if (newIdx !== startIdx) {
        const newIds = [...ids];
        newIds.splice(startIdx, 1);
        newIds.splice(newIdx, 0, id);
        setDragOrder(newIds);
      } else {
        setDragOrder(ids);
      }
    };

    const onUp = () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      setDragId(null);
      setDragOrder((current) => {
        const original = collections.map((c) => c.id);
        if (current.join() !== original.join()) reorder(current);
        return current;
      });
    };

    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
  }, [collections, reorder]);

  const displayCollections = dragId ? dragOrder.map((id) => collections.find((c) => c.id === id)!).filter(Boolean) : collections;

  const getCount = (filterId: string) => {
    if (filterId === "all") return books.length;
    if (filterId === "reading") return books.filter((b) => b.status === "reading").length;
    if (filterId === "finished") return books.filter((b) => b.status === "finished").length;
    return 0;
  };

  const handleCreateCollection = async () => {
    const name = newName.trim();
    if (!name) return;
    await create(name);
    setNewName("");
    setIsCreating(false);
  };

  const handleRename = async () => {
    const name = renameValue.trim();
    if (renamingId && name) {
      await rename(renamingId, name);
    }
    setRenamingId(null);
    setRenameValue("");
  };

  const handleDelete = async (id: string) => {
    if (activeFilter === `collection:${id}`) onFilterChange("all");
    await remove(id);
    setContextMenu(null);
  };

  // Dismiss context menu on outside click
  useEffect(() => {
    if (!contextMenu) return;
    const handler = (e: MouseEvent) => {
      if (contextMenuRef.current && !contextMenuRef.current.contains(e.target as Node)) {
        setContextMenu(null);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [contextMenu]);

  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    resizingRef.current = true;
    const startX = e.clientX;
    const startWidth = sidebarWidth;
    const onMouseMove = (ev: MouseEvent) => {
      const newWidth = Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, startWidth + ev.clientX - startX));
      setSidebarWidth(newWidth);
    };
    const onMouseUp = () => {
      resizingRef.current = false;
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      setSidebarWidth((w) => {
        localStorage.setItem(STORAGE_KEY, String(w));
        return w;
      });
    };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  }, [sidebarWidth]);

  return (
    <aside style={{ width: sidebarWidth }} className="shrink-0 bg-bg-muted border-r border-border h-full flex flex-col gap-6 px-4 relative select-none overflow-hidden">
      <div data-tauri-drag-region className="absolute top-0 left-0 right-0 h-11" />
      <div className="flex items-center gap-2.5 pb-2 pt-11">
        <QuillLogo size={28} />
        <span className="text-[18px] font-semibold tracking-[0.5px] text-text-primary" style={{ fontFamily: "Georgia, 'Times New Roman', serif" }}>
          Quill
        </span>
      </div>

      <div className="flex flex-col gap-3">
        <h2 className="text-[12px] font-semibold uppercase tracking-[0.3px] text-text-muted">
          {t("sidebar.library")}
        </h2>
        <div className="flex flex-col gap-1">
          {libraryFilters.map((filter) => {
            const Icon = filter.icon;
            const isActive = activeFilter === filter.id;
            return (
              <button
                key={filter.id}
                onClick={() => onFilterChange(filter.id)}
                className={`flex items-center justify-between px-3 h-9 rounded-lg w-full cursor-pointer ${
                  isActive ? "bg-accent-bg" : "hover:bg-bg-input"
                }`}
              >
                <div className="flex items-center gap-2">
                  <Icon
                    size={16}
                    className={isActive ? "text-accent-text" : "text-text-muted"}
                  />
                  <span
                    className={`text-[14px] font-medium tracking-[-0.15px] ${
                      isActive ? "text-accent-text" : "text-text-secondary"
                    }`}
                  >
                    {filter.label}
                  </span>
                </div>
                <span className="text-[12px] font-medium text-text-muted">
                  {getCount(filter.id)}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="flex flex-col gap-3">
        <h2 className="text-[12px] font-semibold uppercase tracking-[0.3px] text-text-muted">
          {t("sidebar.tools")}
        </h2>
        <div className="flex flex-col gap-1">
          <button
            onClick={() => onFilterChange("vocab")}
            className={`flex items-center gap-2 px-3 h-9 rounded-lg w-full cursor-pointer ${
              activeFilter === "vocab" ? "bg-accent-bg" : "hover:bg-bg-input"
            }`}
          >
            <BookA size={16} className={activeFilter === "vocab" ? "text-accent-text" : "text-text-muted"} />
            <span className={`text-[14px] font-medium tracking-[-0.15px] ${
              activeFilter === "vocab" ? "text-accent-text" : "text-text-secondary"
            }`}>
              {t("sidebar.dictionary")}
            </span>
          </button>
          <button
            onClick={() => onFilterChange("chats")}
            className={`flex items-center gap-2 px-3 h-9 rounded-lg w-full cursor-pointer ${
              activeFilter === "chats" ? "bg-accent-bg" : "hover:bg-bg-input"
            }`}
          >
            <MessageSquare size={16} className={activeFilter === "chats" ? "text-accent-text" : "text-text-muted"} />
            <span className={`text-[14px] font-medium tracking-[-0.15px] ${
              activeFilter === "chats" ? "text-accent-text" : "text-text-secondary"
            }`}>
              {t("sidebar.chats")}
            </span>
          </button>
          <button
            onClick={() => onFilterChange("translations")}
            className={`flex items-center gap-2 px-3 h-9 rounded-lg w-full cursor-pointer ${
              activeFilter === "translations" ? "bg-accent-bg" : "hover:bg-bg-input"
            }`}
          >
            <Globe size={16} className={activeFilter === "translations" ? "text-accent-text" : "text-text-muted"} />
            <span className={`text-[14px] font-medium tracking-[-0.15px] ${
              activeFilter === "translations" ? "text-accent-text" : "text-text-secondary"
            }`}>
              {t("sidebar.translations")}
            </span>
          </button>
        </div>
      </div>

      <div className="flex flex-col gap-3 min-h-0 flex-1">
        <div className="flex items-center justify-between shrink-0">
          <h2 className="text-[12px] font-semibold uppercase tracking-[0.3px] text-text-muted">
            {t("sidebar.collections")}
          </h2>
          <Button
            variant="icon"
            size="sm"
            className="size-5"
            onClick={() => setIsCreating(true)}
          >
            <Plus size={16} />
          </Button>
        </div>

        {isCreating && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              handleCreateCollection();
            }}
            className="px-1"
          >
            <input
              autoFocus
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onBlur={() => {
                if (!newName.trim()) setIsCreating(false);
              }}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  setNewName("");
                  setIsCreating(false);
                }
              }}
              placeholder={t("sidebar.collectionPlaceholder")}
              className="w-full h-9 px-3 rounded-lg bg-bg-input text-[14px] text-text-primary placeholder:text-text-placeholder outline-none border border-accent"
            />
          </form>
        )}

        <div ref={collectionListRef} className="flex flex-col gap-1 overflow-y-auto min-h-0 scrollbar-none">
          {displayCollections.map((collection) => {
            const isActive = activeFilter === `collection:${collection.id}`;
            if (renamingId === collection.id) {
              return (
                <form
                  key={collection.id}
                  onSubmit={(e) => { e.preventDefault(); handleRename(); }}
                  className="px-1"
                >
                  <input
                    autoFocus
                    value={renameValue}
                    onChange={(e) => setRenameValue(e.target.value)}
                    onBlur={handleRename}
                    onKeyDown={(e) => {
                      if (e.key === "Escape") { setRenamingId(null); setRenameValue(""); }
                    }}
                    className="w-full h-9 px-3 rounded-lg bg-bg-input text-[14px] text-text-primary placeholder:text-text-placeholder outline-none border border-accent"
                  />
                </form>
              );
            }
            return (
              <div
                key={collection.id}
                onPointerDown={(e) => handlePointerDown(e, collection.id)}
                onClick={() => onFilterChange(`collection:${collection.id}`)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setContextMenu({ x: e.clientX, y: e.clientY, collection });
                }}
                className={`flex items-center justify-between px-1 pr-3 h-9 rounded-lg w-full cursor-pointer ${
                  isActive ? "bg-accent-bg" : "hover:bg-bg-input"
                } ${dragId === collection.id ? "opacity-50" : ""}`}
              >
                <div className="flex items-center gap-1">
                  <div data-grip className="flex items-center justify-center w-5 h-9 cursor-grab touch-none">
                    <GripVertical size={12} className="text-text-muted/40" />
                  </div>
                  <FolderClosed
                    size={16}
                    className={isActive ? "text-accent-text" : "text-text-muted"}
                  />
                  <span
                    className={`text-[14px] font-medium tracking-[-0.15px] ${
                      isActive ? "text-accent-text" : "text-text-secondary"
                    }`}
                  >
                    {collection.name}
                  </span>
                </div>
                <span className="text-[12px] font-medium text-text-muted">
                  {collection.book_count}
                </span>
              </div>
            );
          })}
        </div>
      </div>
      {/* User profile */}
      <div className="border-t border-border pt-3 pb-3">
        <button
          onClick={onOpenSettings}
          className="flex items-center gap-2.5 px-2 py-1.5 rounded-lg w-full cursor-pointer hover:bg-bg-input"
        >
          <div className="size-7 rounded-full bg-accent flex items-center justify-center text-[12px] font-semibold text-white shrink-0">
            {userName
              ? userName.split(" ").map((n) => n[0]).join("").toUpperCase().slice(0, 2)
              : "R"}
          </div>
          <div className="min-w-0">
            <p className="text-[13px] font-medium text-text-primary truncate">{userName || "Reader"}</p>
            <p className="text-[11px] text-text-muted">{t("settings.title")}</p>
          </div>
        </button>
      </div>
      {/* Collection context menu */}
      {contextMenu && (
        <div
          ref={contextMenuRef}
          className="fixed z-50 bg-bg-surface/95 border border-border/80 rounded-[10px] py-1 w-[180px] backdrop-blur-sm shadow-[0px_20px_25px_0px_rgba(0,0,0,0.15),0px_8px_10px_0px_rgba(0,0,0,0.15)]"
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          <button
            onClick={() => {
              setRenamingId(contextMenu.collection.id);
              setRenameValue(contextMenu.collection.name);
              setContextMenu(null);
            }}
            className="flex items-center gap-3 w-[calc(100%-8px)] mx-1 px-3 h-[31.5px] rounded-sm text-left cursor-pointer hover:bg-accent-bg transition-colors"
          >
            <Pencil size={14} className="text-text-muted" />
            <span className="text-[13px] font-medium text-text-primary tracking-[-0.08px]">
              {t("sidebar.renameCollection")}
            </span>
          </button>
          <div className="mx-3 my-1 h-px bg-border/80" />
          <button
            onClick={() => handleDelete(contextMenu.collection.id)}
            className="flex items-center gap-3 w-[calc(100%-8px)] mx-1 px-3 h-[31.5px] rounded-sm text-left cursor-pointer hover:bg-accent-bg transition-colors"
          >
            <Trash2 size={14} className="text-red-500" />
            <span className="text-[13px] font-medium text-red-500 tracking-[-0.08px]">
              {t("sidebar.deleteCollection")}
            </span>
          </button>
        </div>
      )}
      {/* Resize handle */}
      <div
        onMouseDown={handleResizeStart}
        className="absolute top-0 right-0 w-1 h-full cursor-col-resize hover:bg-accent/30 transition-colors"
      />
    </aside>
  );
}
