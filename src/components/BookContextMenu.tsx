import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  BookOpen,
  BookOpenCheck,
  CircleCheck,
  CircleDashed,
  FolderPlus,
  FolderMinus,
  Pencil,
  Trash2,
  ChevronRight,
  Check,
} from "lucide-react";
import { useCollections } from "../hooks/useCollections";
import { useTranslation } from "react-i18next";

interface BookContextMenuProps {
  x: number;
  y: number;
  bookId: string;
  bookStatus: string;
  bookProgress: number;
  activeCollectionId?: string;
  onClose: () => void;
  onOpenBook: () => void;
  onMarkFinished: () => void;
  onMarkReading: () => void;
  onMarkUnread: () => void;
  onEditInfo: () => void;
  onDelete: () => void;
  onBooksChanged?: () => void;
}

export default function BookContextMenu({
  x,
  y,
  bookId,
  bookStatus,
  bookProgress,
  activeCollectionId,
  onClose,
  onOpenBook,
  onMarkFinished,
  onMarkReading,
  onMarkUnread,
  onEditInfo,
  onDelete,
  onBooksChanged,
}: BookContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const submenuRef = useRef<HTMLDivElement>(null);
  const hoverTimeoutRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  const [showCollections, setShowCollections] = useState(false);
  const [newName, setNewName] = useState("");
  const [creatingBusy, setCreatingBusy] = useState(false);
  const [memberIds, setMemberIds] = useState<Set<string>>(new Set());

  const {
    collections,
    create,
    addBook,
    removeBook,
    getBookCollections,
  } = useCollections();
  const { t } = useTranslation();

  useEffect(() => {
    let cancelled = false;
    void getBookCollections(bookId)
      .then((ids) => {
        if (!cancelled) setMemberIds(new Set(ids));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [bookId, getBookCollections]);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as Node;
      if (menuRef.current?.contains(target)) return;
      if (submenuRef.current?.contains(target)) return;
      onClose();
    };
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleEscape);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [onClose]);

  const [menuPos, setMenuPos] = useState<{ left: number; top: number }>({ left: x, top: y });
  useLayoutEffect(() => {
    if (!menuRef.current) return;
    const rect = menuRef.current.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const left = x + rect.width > vw - 8 ? Math.max(8, x - rect.width) : x;
    const top = y + rect.height > vh - 8 ? Math.max(8, y - rect.height) : y;
    setMenuPos({ left, top });
  }, [x, y]);

  const [submenuStyle, setSubmenuStyle] = useState<React.CSSProperties>({ left: x + 236, top: y });
  useLayoutEffect(() => {
    if (!showCollections || !menuRef.current) return;
    const rect = menuRef.current.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const subWidth = 254;
    const subHeight = submenuRef.current?.getBoundingClientRect().height ?? 240;
    const collectionBtn = menuRef.current.querySelector("[data-collection-trigger]");
    const btnRect = collectionBtn?.getBoundingClientRect();
    const rawTop = btnRect ? btnRect.top - 6 : rect.top;
    const top = Math.max(8, Math.min(rawTop, vh - subHeight - 8));
    const left =
      rect.right + 6 + subWidth > vw - 8
        ? Math.max(8, rect.left - subWidth - 6)
        : rect.right + 6;
    setSubmenuStyle({ left, top });
  }, [showCollections, menuPos, collections.length]);

  useEffect(() => {
    return () => {
      if (hoverTimeoutRef.current) clearTimeout(hoverTimeoutRef.current);
    };
  }, []);

  const handleToggleCollection = async (collectionId: string) => {
    const isMember = memberIds.has(collectionId);
    setMemberIds((prev) => {
      const next = new Set(prev);
      if (isMember) next.delete(collectionId);
      else next.add(collectionId);
      return next;
    });
    try {
      if (isMember) {
        await removeBook(collectionId, bookId);
      } else {
        await addBook(collectionId, bookId);
      }
      onBooksChanged?.();
    } catch (err) {
      console.error("Failed to toggle book collection:", err);
      setMemberIds((prev) => {
        const reverted = new Set(prev);
        if (isMember) reverted.add(collectionId);
        else reverted.delete(collectionId);
        return reverted;
      });
    }
  };

  const handleCreateAndAdd = async () => {
    const trimmed = newName.trim();
    if (!trimmed || creatingBusy) return;
    setCreatingBusy(true);
    try {
      const collection = await create(trimmed);
      await addBook(collection.id, bookId);
      setMemberIds((prev) => new Set([...prev, collection.id]));
      setNewName("");
      onBooksChanged?.();
    } catch (err) {
      console.error("Failed to create collection and add book:", err);
    } finally {
      setCreatingBusy(false);
    }
  };

  const currentReadingLabel =
    bookProgress > 0
      ? t("bookMenu.currentlyReadingProgress", { progress: bookProgress })
      : t("bookMenu.currentlyReading");

  return (
    <>
      <div
        ref={menuRef}
        role="menu"
        className="fixed z-50 w-[236px] p-1.5 rounded-[14px] bg-white/[0.96] border border-surface-glass-border backdrop-blur-[34px] shadow-[0_18px_44px_rgba(34,24,66,0.2)] flex flex-col gap-0.5"
        style={{ left: menuPos.left, top: menuPos.top }}
      >
        <button
          type="button"
          onClick={onOpenBook}
          className="flex items-center gap-2.5 w-full h-8 px-2.5 rounded-[8px] text-left cursor-pointer hover:bg-black/[0.04] transition-colors"
        >
          <BookOpen size={15} className="text-text-tertiary shrink-0" />
          <span className="flex-1 text-[13px] font-medium text-text-primary truncate">
            {t("bookMenu.openBook")}
          </span>
        </button>

        <div className="my-0.5 h-px bg-border-subtle" />

        {bookStatus === "reading" ? (
          <div className="flex items-center gap-2.5 w-full h-8 px-2.5 rounded-[8px] text-left cursor-default">
            <BookOpenCheck size={15} className="text-text-tertiary shrink-0" />
            <span className="flex-1 text-[13px] font-medium text-text-tertiary truncate">
              {currentReadingLabel}
            </span>
          </div>
        ) : (
          <button
            type="button"
            onClick={onMarkReading}
            className="flex items-center gap-2.5 w-full h-8 px-2.5 rounded-[8px] text-left cursor-pointer hover:bg-black/[0.04] transition-colors"
          >
            <BookOpenCheck size={15} className="text-text-tertiary shrink-0" />
            <span className="flex-1 text-[13px] font-medium text-text-primary truncate">
              {t("bookMenu.currentlyReading")}
            </span>
          </button>
        )}

        {bookStatus === "finished" ? (
          <div className="flex items-center gap-2.5 w-full h-8 px-2.5 rounded-[8px] text-left cursor-default">
            <CircleCheck size={15} className="text-text-tertiary shrink-0" />
            <span className="flex-1 text-[13px] font-medium text-text-tertiary truncate">
              {t("bookMenu.finished")}
            </span>
          </div>
        ) : (
          <button
            type="button"
            onClick={onMarkFinished}
            className="flex items-center gap-2.5 w-full h-8 px-2.5 rounded-[8px] text-left cursor-pointer hover:bg-black/[0.04] transition-colors"
          >
            <CircleCheck size={15} className="text-text-tertiary shrink-0" />
            <span className="flex-1 text-[13px] font-medium text-text-primary truncate">
              {t("bookMenu.markFinished")}
            </span>
          </button>
        )}

        {bookStatus === "unread" ? (
          <div className="flex items-center gap-2.5 w-full h-8 px-2.5 rounded-[8px] text-left cursor-default">
            <CircleDashed size={15} className="text-text-tertiary shrink-0" />
            <span className="flex-1 text-[13px] font-medium text-text-tertiary truncate">
              {t("bookMenu.notStarted")}
            </span>
          </div>
        ) : (
          <button
            type="button"
            onClick={onMarkUnread}
            className="flex items-center gap-2.5 w-full h-8 px-2.5 rounded-[8px] text-left cursor-pointer hover:bg-black/[0.04] transition-colors"
          >
            <CircleDashed size={15} className="text-text-tertiary shrink-0" />
            <span className="flex-1 text-[13px] font-medium text-text-primary truncate">
              {t("bookMenu.markUnread")}
            </span>
          </button>
        )}

        <div className="my-0.5 h-px bg-border-subtle" />

        <button
          type="button"
          onClick={onEditInfo}
          className="flex items-center gap-2.5 w-full h-8 px-2.5 rounded-[8px] text-left cursor-pointer hover:bg-black/[0.04] transition-colors"
        >
          <Pencil size={15} className="text-text-tertiary shrink-0" />
          <span className="flex-1 text-[13px] font-medium text-text-primary truncate">
            {t("bookMenu.editInfo")}
          </span>
        </button>

        <button
          type="button"
          data-collection-trigger
          onClick={() => setShowCollections((v) => !v)}
          onMouseEnter={() => {
            if (hoverTimeoutRef.current) clearTimeout(hoverTimeoutRef.current);
            setShowCollections(true);
          }}
          onMouseLeave={() => {
            hoverTimeoutRef.current = setTimeout(() => setShowCollections(false), 150);
          }}
          className={`flex items-center justify-between w-full h-8 px-2.5 rounded-[8px] text-left cursor-pointer transition-colors ${
            showCollections
              ? "bg-accent-tint text-accent-on-tint font-semibold"
              : "text-text-primary hover:bg-black/[0.04] font-medium"
          }`}
        >
          <span className="flex items-center gap-2.5 min-w-0">
            <FolderPlus
              size={15}
              className={showCollections ? "text-accent-on-tint" : "text-text-tertiary"}
            />
            <span className="text-[13px] truncate">{t("bookMenu.addToCollection")}</span>
          </span>
          <ChevronRight
            size={13}
            className={showCollections ? "text-accent-on-tint" : "text-text-tertiary"}
          />
        </button>

        {activeCollectionId && (
          <button
            type="button"
            onClick={async () => {
              await removeBook(activeCollectionId, bookId);
              onBooksChanged?.();
              onClose();
            }}
            className="flex items-center gap-2.5 w-full h-8 px-2.5 rounded-[8px] text-left cursor-pointer hover:bg-black/[0.04] transition-colors"
          >
            <FolderMinus size={15} className="text-text-tertiary shrink-0" />
            <span className="flex-1 text-[13px] font-medium text-text-primary truncate">
              {t("bookMenu.removeFromCollection")}
            </span>
          </button>
        )}

        <div className="my-0.5 h-px bg-border-subtle" />

        <button
          type="button"
          onClick={onDelete}
          className="flex items-center gap-2.5 w-full h-8 px-2.5 rounded-[8px] text-left cursor-pointer hover:bg-danger-tint transition-colors"
        >
          <Trash2 size={15} className="text-danger shrink-0" />
          <span className="flex-1 text-[13px] font-medium text-danger truncate">
            {t("bookMenu.deleteBook")}
          </span>
        </button>
      </div>

      {showCollections && (
        <div
          ref={submenuRef}
          className="fixed z-[51] w-[254px] p-1.5 rounded-[14px] bg-white/[0.96] border border-surface-glass-border backdrop-blur-[34px] shadow-[0_18px_44px_rgba(34,24,66,0.2)] flex flex-col gap-0.5"
          style={submenuStyle}
          onMouseEnter={() => {
            if (hoverTimeoutRef.current) clearTimeout(hoverTimeoutRef.current);
          }}
          onMouseLeave={() => {
            hoverTimeoutRef.current = setTimeout(() => setShowCollections(false), 150);
          }}
        >
          {collections.length === 0 ? (
            <div className="px-2.5 py-2 text-[12px] text-text-tertiary">
              {t("bookMenu.noCollections")}
            </div>
          ) : (
            <div className="max-h-[220px] overflow-y-auto flex flex-col gap-0.5">
              {collections.map((c) => {
                const checked = memberIds.has(c.id);
                return (
                  <button
                    key={c.id}
                    type="button"
                    role="menuitemcheckbox"
                    aria-checked={checked}
                    onClick={() => void handleToggleCollection(c.id)}
                    className="flex items-center gap-[9px] w-full h-[31px] px-2.5 rounded-[8px] text-left cursor-pointer hover:bg-black/[0.04] transition-colors"
                  >
                    <span
                      className={`size-4 rounded-[5px] shrink-0 flex items-center justify-center transition-colors ${
                        checked
                          ? "bg-accent text-white"
                          : "bg-surface-inset border border-border-default"
                      }`}
                    >
                      {checked && <Check size={10.5} strokeWidth={2.5} />}
                    </span>
                    <span
                      className={`flex-1 text-[13px] truncate ${
                        checked ? "font-semibold text-text-primary" : "font-medium text-text-primary"
                      }`}
                    >
                      {c.name}
                    </span>
                  </button>
                );
              })}
            </div>
          )}

          <div className="my-0.5 h-px bg-border-subtle" />

          <form
            onSubmit={(e) => {
              e.preventDefault();
              void handleCreateAndAdd();
            }}
            className="p-1.5 pt-1 flex flex-col gap-1.5"
          >
            <span className="font-mono text-[10px] font-semibold tracking-[0.6px] uppercase text-accent-on-tint">
              {t("bookMenu.newCollectionAndAdd")}
            </span>
            <div className="flex items-center gap-1.5">
              <input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    e.stopPropagation();
                    onClose();
                  }
                }}
                placeholder={t("bookMenu.collectionPlaceholder")}
                className="flex-1 min-w-0 h-[30px] px-[9px] rounded-[8px] bg-surface-solid border border-border-default focus:border-accent text-[12.5px] font-medium text-text-primary placeholder:text-text-tertiary outline-none"
              />
              <button
                type="submit"
                disabled={!newName.trim() || creatingBusy}
                aria-label={t("bookMenu.createAndAdd")}
                className="size-[30px] rounded-[8px] bg-accent hover:bg-accent-hover text-white flex items-center justify-center shrink-0 cursor-pointer transition-colors disabled:opacity-50"
              >
                <Check size={14} />
              </button>
            </div>
          </form>
        </div>
      )}
    </>
  );
}
