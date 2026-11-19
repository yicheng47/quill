import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { FolderX } from "lucide-react";
import type { Collection } from "../hooks/useCollections";

interface DeleteCollectionModalProps {
  collection: Collection | null;
  onClose: () => void;
  onConfirm: (id: string) => Promise<void>;
}

export default function DeleteCollectionModal({
  collection,
  onClose,
  onConfirm,
}: DeleteCollectionModalProps) {
  const { t } = useTranslation();
  const [deleting, setDeleting] = useState(false);
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!collection) return;
    cancelRef.current?.focus();
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [collection, onClose]);

  if (!collection) return null;

  const handleConfirm = async () => {
    if (deleting) return;
    setDeleting(true);
    try {
      await onConfirm(collection.id);
      onClose();
    } catch (err) {
      console.error("Failed to delete collection:", err);
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-scrim backdrop-blur-[6px] flex items-center justify-center p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="delete-collection-title"
        className="w-full max-w-[460px] p-[22px] rounded-surface bg-surface-solid border border-border-subtle shadow-menu flex flex-col gap-3.5"
      >
        <div className="flex items-center gap-2.5">
          <div className="size-8 rounded-[10px] bg-danger-tint flex items-center justify-center text-danger shrink-0">
            <FolderX size={15} />
          </div>
          <h3
            id="delete-collection-title"
            className="text-[16px] font-semibold text-text-primary tracking-[-0.3px] truncate"
          >
            {t("collections.deleteTitle", { name: collection.name })}
          </h3>
        </div>

        <p className="text-[13px] text-text-secondary leading-[1.5]">
          {t("collections.deleteBody", { count: collection.book_count })}
        </p>

        <div className="flex items-center justify-end gap-2">
          <button
            ref={cancelRef}
            type="button"
            onClick={onClose}
            className="px-[15px] py-2 rounded-control bg-surface-chip border border-accent text-[13px] font-medium text-text-primary hover:bg-surface-inset cursor-pointer transition-colors focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-focus-ring"
          >
            {t("common.cancel")}
          </button>
          <button
            type="button"
            disabled={deleting}
            onClick={handleConfirm}
            className="px-4 py-2 rounded-control bg-danger hover:bg-danger-hover text-text-on-accent text-[13px] font-semibold cursor-pointer transition-colors disabled:opacity-50"
          >
            {t("collections.deleteConfirm")}
          </button>
        </div>
      </div>
    </div>
  );
}
