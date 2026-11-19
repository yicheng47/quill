import { useState, useRef, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import {
  Library,
  GripVertical,
  FolderClosed,
  FolderOpen,
  FolderPlus,
  Pencil,
  Trash2,
  Plus,
  Check,
} from "lucide-react";
import type { Collection } from "../hooks/useCollections";

interface CollectionsPopoverProps {
  open: boolean;
  onClose: () => void;
  anchorRef: React.RefObject<HTMLElement | null>;
  activeFilter: string;
  onSelectFilter: (filter: string) => void;
  totalBooksCount: number;
  collections: Collection[];
  onCreate: (name: string) => Promise<Collection>;
  onRename: (id: string, name: string) => Promise<void>;
  onRequestDelete: (collection: Collection) => void;
  onReorder: (ids: string[]) => Promise<void>;
}

export default function CollectionsPopover({
  open,
  onClose,
  anchorRef,
  activeFilter,
  onSelectFilter,
  totalBooksCount,
  collections,
  onCreate,
  onRename,
  onRequestDelete,
  onReorder,
}: CollectionsPopoverProps) {
  const { t } = useTranslation();
  const popoverRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const newInputRef = useRef<HTMLInputElement>(null);

  const [isCreating, setIsCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [creatingBusy, setCreatingBusy] = useState(false);

  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [renamingBusy, setRenamingBusy] = useState(false);

  const [dragId, setDragId] = useState<string | null>(null);
  const [dragOrder, setDragOrder] = useState<string[]>([]);

  useEffect(() => {
    if (!open) {
      setIsCreating(false);
      setNewName("");
      setRenamingId(null);
      setRenameValue("");
      return;
    }
    const handleOutside = (e: MouseEvent) => {
      const target = e.target as Node;
      if (popoverRef.current?.contains(target)) return;
      if (anchorRef.current?.contains(target)) return;
      onClose();
    };
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (renamingId !== null) {
        e.stopPropagation();
        setRenamingId(null);
        setRenameValue("");
        return;
      }
      if (isCreating) {
        e.stopPropagation();
        setIsCreating(false);
        setNewName("");
        return;
      }
      e.stopPropagation();
      onClose();
    };
    document.addEventListener("mousedown", handleOutside);
    document.addEventListener("keydown", handleEsc);
    return () => {
      document.removeEventListener("mousedown", handleOutside);
      document.removeEventListener("keydown", handleEsc);
    };
  }, [open, onClose, anchorRef, renamingId, isCreating]);

  useEffect(() => {
    if (renamingId) {
      renameInputRef.current?.focus();
      renameInputRef.current?.select();
    }
  }, [renamingId]);

  useEffect(() => {
    if (isCreating) {
      newInputRef.current?.focus();
    }
  }, [isCreating]);

  const handlePointerDown = useCallback(
    (e: React.PointerEvent, id: string) => {
      if (!(e.target as HTMLElement).closest("[data-grip]")) return;
      e.preventDefault();
      const listEl = listRef.current;
      if (!listEl) return;
      const items = Array.from(listEl.children) as HTMLElement[];
      const startY = e.clientY;
      const ids = collections.map((c) => c.id);
      const startIdx = ids.indexOf(id);
      const itemHeight = Math.max(24, items[0]?.getBoundingClientRect().height ?? 36);

      setDragId(id);
      setDragOrder(ids);

      const onMove = (ev: PointerEvent) => {
        const dy = ev.clientY - startY;
        const offset = Math.round(dy / itemHeight);
        const newIdx = Math.max(0, Math.min(ids.length - 1, startIdx + offset));
        if (newIdx !== startIdx) {
          const nextIds = [...ids];
          nextIds.splice(startIdx, 1);
          nextIds.splice(newIdx, 0, id);
          setDragOrder(nextIds);
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
          if (current.length === original.length && current.join() !== original.join()) {
            void onReorder(current);
          }
          return current;
        });
      };

      document.addEventListener("pointermove", onMove);
      document.addEventListener("pointerup", onUp);
    },
    [collections, onReorder],
  );

  if (!open) return null;

  const displayCollections = dragId
    ? dragOrder
        .map((id) => collections.find((c) => c.id === id))
        .filter((c): c is Collection => Boolean(c))
    : collections;

  const activeCollectionId = activeFilter && activeFilter !== "all" ? activeFilter : null;

  const handleCreateSubmit = async () => {
    const trimmed = newName.trim();
    if (!trimmed || creatingBusy) return;
    setCreatingBusy(true);
    try {
      const created = await onCreate(trimmed);
      setNewName("");
      setIsCreating(false);
      onSelectFilter(created.id);
      onClose();
    } catch (err) {
      console.error("Failed to create collection:", err);
    } finally {
      setCreatingBusy(false);
    }
  };

  const handleRenameSubmit = async () => {
    const id = renamingId;
    const trimmed = renameValue.trim();
    if (!id || renamingBusy) return;
    if (!trimmed) {
      setRenamingId(null);
      setRenameValue("");
      return;
    }
    setRenamingBusy(true);
    try {
      await onRename(id, trimmed);
      setRenamingId(null);
      setRenameValue("");
    } catch (err) {
      console.error("Failed to rename collection:", err);
    } finally {
      setRenamingBusy(false);
    }
  };

  const allSelected = !activeCollectionId;

  return (
    <div
      ref={popoverRef}
      role="dialog"
      aria-label={t("collections.popoverLabel")}
      className="absolute right-0 top-full mt-2 w-[348px] max-w-[calc(100vw-32px)] rounded-surface bg-surface-popover border border-surface-glass-border backdrop-blur-[34px] shadow-[var(--shadow-menu)] overflow-hidden z-40 flex flex-col"
    >
      <div className="px-2 pt-2 pb-1.5 flex flex-col gap-0.5">
        <button
          type="button"
          onClick={() => {
            onSelectFilter("all");
            onClose();
          }}
          className={`w-full flex items-center justify-between px-2.5 py-2 rounded-[6px] cursor-pointer transition-colors ${
            allSelected
              ? "bg-accent-tint text-accent-on-tint font-semibold"
              : "text-text-primary hover:bg-surface-hover"
          }`}
        >
          <span className="flex items-center gap-2.5 min-w-0">
            <Library
              size={15}
              className={allSelected ? "text-accent-on-tint" : "text-text-secondary"}
            />
            <span className="text-[13.5px] font-medium truncate">
              {t("collections.allBooks")}
            </span>
          </span>
          <span
            className={`font-mono text-[11.5px] shrink-0 ${
              allSelected ? "text-accent-on-tint" : "text-text-tertiary"
            }`}
          >
            {totalBooksCount}
          </span>
        </button>
      </div>

      <div className="h-px bg-border-subtle" />

      <div className="p-2 flex flex-col gap-0.5">
        <div className="px-2.5 pt-0.5 pb-1 flex items-center justify-between">
          <span className="text-[10.5px] font-semibold uppercase tracking-[0.9px] text-text-tertiary">
            {t("collections.sectionTitle")}
          </span>
          {collections.length > 1 && (
            <span className="text-[11px] text-text-tertiary">
              {t("collections.dragToReorder")}
            </span>
          )}
        </div>

        {displayCollections.length === 0 ? (
          <p className="px-2.5 py-3 text-[12.5px] text-text-tertiary text-center">
            {t("collections.emptyList")}
          </p>
        ) : (
          <div ref={listRef} className="max-h-[260px] overflow-y-auto flex flex-col gap-0.5">
            {displayCollections.map((collection) => {
              const isActive = activeCollectionId === collection.id;
              if (renamingId === collection.id) {
                return (
                  <div key={collection.id} className="px-1 py-1 flex flex-col gap-1.5">
                    <form
                      onSubmit={(e) => {
                        e.preventDefault();
                        void handleRenameSubmit();
                      }}
                      className="flex items-center gap-1.5"
                    >
                      <input
                        ref={renameInputRef}
                        value={renameValue}
                        onChange={(e) => setRenameValue(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Escape") {
                            e.stopPropagation();
                            setRenamingId(null);
                            setRenameValue("");
                          }
                        }}
                        aria-label={t("collections.renameInputLabel")}
                        className="flex-1 min-w-0 h-[34px] px-2.5 rounded-[6px] bg-surface-inset border border-accent text-[13px] font-medium text-text-primary outline-none"
                      />
                      <button
                        type="submit"
                        onMouseDown={(e) => e.preventDefault()}
                        disabled={renamingBusy || !renameValue.trim()}
                        aria-label={t("common.save")}
                        className="size-8 rounded-[8px] bg-accent hover:bg-accent-hover text-text-on-accent flex items-center justify-center shrink-0 cursor-pointer disabled:opacity-50"
                      >
                        <Check size={14} />
                      </button>
                    </form>
                    <p className="text-[11.5px] text-text-tertiary px-0.5">
                      {t("collections.renameHint")}
                    </p>
                  </div>
                );
              }

              return (
                <div
                  key={collection.id}
                  onPointerDown={(e) => handlePointerDown(e, collection.id)}
                  onClick={() => {
                    onSelectFilter(collection.id);
                    onClose();
                  }}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.target !== e.currentTarget) return;
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      onSelectFilter(collection.id);
                      onClose();
                    }
                  }}
                  className={`group w-full flex items-center justify-between px-2.5 py-2 rounded-[6px] cursor-pointer transition-colors ${
                    isActive
                      ? "bg-accent-tint text-accent-on-tint"
                      : "hover:bg-surface-hover text-text-primary"
                  } ${dragId === collection.id ? "opacity-50" : ""}`}
                >
                  <div className="flex items-center gap-2 min-w-0 flex-1">
                    <span
                      data-grip
                      onClick={(e) => e.stopPropagation()}
                      aria-label={t("collections.dragHandle")}
                      className={`inline-flex items-center justify-center cursor-grab touch-none shrink-0 ${
                        isActive ? "text-accent-on-tint" : "text-text-disabled"
                      }`}
                    >
                      <GripVertical size={13} />
                    </span>
                    {isActive ? (
                      <FolderOpen size={15} className="text-accent-on-tint shrink-0" />
                    ) : (
                      <FolderClosed size={15} className="text-text-secondary shrink-0" />
                    )}
                    <span
                      className={`text-[13.5px] truncate ${
                        isActive ? "font-semibold text-accent-on-tint" : "font-medium text-text-primary"
                      }`}
                    >
                      {collection.name}
                    </span>
                  </div>

                  <div className="flex items-center gap-1.5 shrink-0">
                    <button
                      type="button"
                      aria-label={t("collections.renameAction", { name: collection.name })}
                      onClick={(e) => {
                        e.stopPropagation();
                        setRenamingId(collection.id);
                        setRenameValue(collection.name);
                      }}
                      className={`p-1 rounded-[6px] cursor-pointer transition-opacity ${
                        isActive
                          ? "text-accent-on-tint hover:bg-surface-hover opacity-100"
                          : "text-text-tertiary hover:text-text-primary hover:bg-surface-hover opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                      }`}
                    >
                      <Pencil size={12.5} />
                    </button>
                    <button
                      type="button"
                      aria-label={t("collections.deleteAction", { name: collection.name })}
                      onClick={(e) => {
                        e.stopPropagation();
                        onClose();
                        onRequestDelete(collection);
                      }}
                      className={`p-1 rounded-[6px] cursor-pointer transition-opacity ${
                        isActive
                          ? "text-accent-on-tint hover:bg-surface-hover opacity-100"
                          : "text-text-tertiary hover:text-danger hover:bg-danger-tint opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                      }`}
                    >
                      <Trash2 size={12.5} />
                    </button>
                    <span
                      className={`font-mono text-[11.5px] pl-0.5 ${
                        isActive ? "text-accent-on-tint" : "text-text-tertiary"
                      }`}
                    >
                      {collection.book_count}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="h-px bg-border-subtle" />

      {isCreating ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void handleCreateSubmit();
          }}
          className="p-3 bg-surface-inset flex flex-col gap-2.5"
        >
          <div className="flex items-center justify-between">
            <span className="font-mono text-[10.5px] font-semibold tracking-[0.7px] text-accent-on-tint uppercase">
              {t("collections.newFormLabel")}
            </span>
            <span className="font-mono text-[10.5px] text-text-tertiary">
              {t("collections.newFormHint")}
            </span>
          </div>
          <div className="h-9 px-[11px] rounded-[6px] bg-surface-solid border border-accent flex items-center gap-2">
            <FolderPlus size={14.5} className="text-accent-fg shrink-0" />
            <input
              ref={newInputRef}
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.stopPropagation();
                  setIsCreating(false);
                  setNewName("");
                }
              }}
              placeholder={t("collections.placeholder")}
              className="flex-1 min-w-0 bg-transparent text-[13.5px] font-medium text-text-primary placeholder:text-text-tertiary outline-none"
            />
          </div>
          <div className="flex items-center justify-end gap-1.5">
            <button
              type="button"
              onClick={() => {
                setIsCreating(false);
                setNewName("");
              }}
              className="px-3 py-1.5 rounded-control bg-surface-chip border border-border-default hover:bg-surface-solid text-[12px] font-medium text-text-primary cursor-pointer transition-colors"
            >
              {t("common.cancel")}
            </button>
            <button
              type="submit"
              disabled={!newName.trim() || creatingBusy}
              className="px-3.5 py-1.5 rounded-control bg-accent hover:bg-accent-hover text-text-on-accent text-[12px] font-semibold inline-flex items-center gap-1.5 cursor-pointer transition-colors disabled:opacity-50"
            >
              <Plus size={13} />
              <span>{t("collections.createButton")}</span>
            </button>
          </div>
        </form>
      ) : (
        <div className="p-2">
          <button
            type="button"
            onClick={() => setIsCreating(true)}
            className="w-full flex items-center gap-2 px-2.5 py-2 rounded-[8px] bg-accent-tint hover:bg-accent-tint-hover text-accent-on-tint text-[13px] font-semibold cursor-pointer transition-colors"
          >
            <Plus size={14} />
            <span>{t("collections.newTrigger")}</span>
          </button>
        </div>
      )}
    </div>
  );
}
