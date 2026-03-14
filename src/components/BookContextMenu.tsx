import { useEffect, useRef, useState } from "react";
import {
  BookOpen,
  CheckCircle2,
  FolderPlus,
  Trash2,
  ChevronRight,
  Plus,
  Check,
} from "lucide-react";
import { useCollections } from "../hooks/useCollections";

interface BookContextMenuProps {
  x: number;
  y: number;
  bookId: string;
  bookStatus: string;
  onClose: () => void;
  onMarkFinished: () => void;
  onDelete: () => void;
  onBooksChanged?: () => void;
}

export default function BookContextMenu({
  x,
  y,
  bookId,
  bookStatus,
  onClose,
  onMarkFinished,
  onDelete,
  onBooksChanged,
}: BookContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [showCollections, setShowCollections] = useState(false);
  const [newName, setNewName] = useState("");
  const [creatingNew, setCreatingNew] = useState(false);
  const { collections, create, addBook } = useCollections();
  const hoverTimeoutRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const submenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (
        menuRef.current && !menuRef.current.contains(e.target as Node) &&
        submenuRef.current && !submenuRef.current.contains(e.target as Node)
      ) {
        onClose();
      }
    };
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleEscape);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [onClose]);

  // Clamp main menu position to viewport
  useEffect(() => {
    if (!menuRef.current) return;
    const rect = menuRef.current.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    if (rect.right > vw) {
      menuRef.current.style.left = `${x - rect.width}px`;
    }
    if (rect.bottom > vh) {
      menuRef.current.style.top = `${y - rect.height}px`;
    }
  }, [x, y]);

  useEffect(() => {
    return () => {
      if (hoverTimeoutRef.current) clearTimeout(hoverTimeoutRef.current);
    };
  }, []);

  const statusLabel =
    bookStatus === "reading"
      ? "Currently Reading"
      : bookStatus === "finished"
        ? "Finished"
        : "Not Started";

  const handleAddToCollection = async (collectionId: string) => {
    await addBook(collectionId, bookId);
    onBooksChanged?.();
    onClose();
  };

  const handleCreateAndAdd = async () => {
    const trimmed = newName.trim();
    if (!trimmed) return;
    const collection = await create(trimmed);
    await addBook(collection.id, bookId);
    onBooksChanged?.();
    onClose();
  };

  // Compute submenu position
  const [submenuStyle, setSubmenuStyle] = useState<React.CSSProperties>({ left: x + 200, top: y });
  useEffect(() => {
    if (!showCollections || !menuRef.current) return;
    const rect = menuRef.current.getBoundingClientRect();
    const vw = window.innerWidth;
    const collectionBtn = menuRef.current.querySelector("[data-collection-trigger]");
    const btnRect = collectionBtn?.getBoundingClientRect();
    const top = btnRect ? btnRect.top : rect.top;
    if (rect.right + 200 > vw) {
      setSubmenuStyle({ left: rect.left - 200, top });
    } else {
      setSubmenuStyle({ left: rect.right, top });
    }
  }, [showCollections, x, y]);

  return (
    <>
      <div
        ref={menuRef}
        className="fixed z-50 bg-white/95 border border-border/80 rounded-[10px] py-1 w-[200px] backdrop-blur-sm shadow-[0px_20px_25px_0px_rgba(0,0,0,0.15),0px_8px_10px_0px_rgba(0,0,0,0.15)]"
        style={{ left: x, top: y }}
      >
        {/* Status indicator */}
        <button
          className="flex items-center gap-3 w-[calc(100%-8px)] mx-1 px-3 h-[31.5px] rounded-sm text-left cursor-default"
        >
          <BookOpen size={16} className="text-text-muted" />
          <span className="flex-1 text-[13px] font-medium text-[#9f9fa9] tracking-[-0.08px]">
            {statusLabel}
          </span>
        </button>

        {/* Mark as Finished */}
        <button
          onClick={onMarkFinished}
          className="flex items-center gap-3 w-[calc(100%-8px)] mx-1 px-3 h-[31.5px] rounded-sm text-left cursor-pointer hover:bg-bg-input transition-colors"
        >
          <CheckCircle2 size={16} className="text-text-muted" />
          <span className="flex-1 text-[13px] font-medium text-[#27272a] tracking-[-0.08px]">
            Mark as Finished
          </span>
        </button>

        <div className="mx-3 my-1 h-px bg-border/80" />

        {/* Add to Collection - hover trigger */}
        <button
          data-collection-trigger
          onMouseEnter={() => {
            if (hoverTimeoutRef.current) clearTimeout(hoverTimeoutRef.current);
            setShowCollections(true);
          }}
          onMouseLeave={() => {
            hoverTimeoutRef.current = setTimeout(() => setShowCollections(false), 150);
          }}
          className={`flex items-center gap-3 w-[calc(100%-8px)] mx-1 px-3 h-[31.5px] rounded-sm text-left cursor-pointer transition-colors ${showCollections ? "bg-bg-input" : "hover:bg-bg-input"}`}
        >
          <FolderPlus size={16} className="text-text-muted" />
          <span className="flex-1 text-[13px] font-medium text-[#27272a] tracking-[-0.08px]">
            Add to Collection
          </span>
          <ChevronRight size={12} className="text-text-muted" />
        </button>

        <div className="mx-3 my-1 h-px bg-border/80" />

        {/* Delete Book */}
        <button
          onClick={onDelete}
          className="flex items-center gap-3 w-[calc(100%-8px)] mx-1 px-3 h-[31.5px] rounded-sm text-left cursor-pointer hover:bg-bg-input transition-colors"
        >
          <Trash2 size={16} className="text-[#e7000b]" />
          <span className="flex-1 text-[13px] font-medium text-[#e7000b] tracking-[-0.08px]">
            Delete Book
          </span>
        </button>
      </div>

      {/* Collection submenu */}
      {showCollections && (
        <div
          ref={submenuRef}
          className="fixed z-[51] bg-white/95 border border-border/80 rounded-[10px] py-1 w-[200px] backdrop-blur-sm shadow-[0px_20px_25px_0px_rgba(0,0,0,0.15),0px_8px_10px_0px_rgba(0,0,0,0.15)]"
          style={submenuStyle}
          onMouseEnter={() => {
            if (hoverTimeoutRef.current) clearTimeout(hoverTimeoutRef.current);
          }}
          onMouseLeave={() => {
            hoverTimeoutRef.current = setTimeout(() => setShowCollections(false), 150);
          }}
        >
          {collections.length === 0 && !creatingNew && (
            <div className="px-4 py-2 text-[12px] text-text-muted">
              No collections yet
            </div>
          )}
          {collections.map((c) => (
            <button
              key={c.id}
              onClick={() => handleAddToCollection(c.id)}
              className="flex items-center gap-3 w-[calc(100%-8px)] mx-1 px-3 h-[31.5px] rounded-sm text-left cursor-pointer hover:bg-bg-input transition-colors"
            >
              <span className="flex-1 text-[13px] font-medium text-[#27272a] tracking-[-0.08px] truncate">
                {c.name}
              </span>
            </button>
          ))}

          <div className="mx-3 my-1 h-px bg-border/80" />

          {/* Create new collection */}
          {creatingNew ? (
            <div className="flex items-center gap-1 mx-1 px-2 h-[31.5px]">
              <input
                autoFocus
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleCreateAndAdd();
                  if (e.key === "Escape") setCreatingNew(false);
                }}
                placeholder="Collection name"
                className="flex-1 min-w-0 text-[13px] bg-transparent outline-none placeholder:text-text-muted"
              />
              <button
                onClick={handleCreateAndAdd}
                className="p-1 rounded hover:bg-bg-input transition-colors"
              >
                <Check size={14} className="text-text-muted" />
              </button>
            </div>
          ) : (
            <button
              onClick={() => setCreatingNew(true)}
              className="flex items-center gap-3 w-[calc(100%-8px)] mx-1 px-3 h-[31.5px] rounded-sm text-left cursor-pointer hover:bg-bg-input transition-colors"
            >
              <Plus size={16} className="text-text-muted" />
              <span className="flex-1 text-[13px] font-medium text-[#27272a] tracking-[-0.08px]">
                New Collection
              </span>
            </button>
          )}
        </div>
      )}
    </>
  );
}
