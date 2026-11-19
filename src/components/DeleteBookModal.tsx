import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Book } from "../hooks/useBooks";

interface DeleteBookModalProps {
  book: Book | null;
  onClose: () => void;
  onConfirm: (id: string) => Promise<void>;
}

export default function DeleteBookModal({ book, onClose, onConfirm }: DeleteBookModalProps) {
  const { t } = useTranslation();
  const [deleting, setDeleting] = useState(false);
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!book) return;
    cancelRef.current?.focus();
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [book, onClose]);

  if (!book) return null;

  const handleConfirm = async () => {
    if (deleting) return;
    setDeleting(true);
    try {
      await onConfirm(book.id);
      onClose();
    } catch (err) {
      console.error("Failed to delete book:", err);
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
        aria-labelledby="delete-book-title"
        className="w-full max-w-[400px] p-5 rounded-surface bg-surface-solid border border-border-subtle shadow-menu flex flex-col gap-3"
      >
        <h3
          id="delete-book-title"
          className="text-[16px] font-semibold text-text-primary tracking-[-0.3px]"
        >
          {t("deleteBookModal.title", { title: book.title })}
        </h3>
        <p className="text-[12.5px] text-text-secondary leading-[1.45]">
          {t("deleteBookModal.body")}
        </p>
        <div className="flex items-center justify-end gap-2 mt-1">
          <button
            ref={cancelRef}
            type="button"
            onClick={onClose}
            className="px-[13px] py-[7px] rounded-control bg-surface-chip border border-accent text-[13px] font-medium text-text-primary hover:bg-surface-inset cursor-pointer transition-colors focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-focus-ring"
          >
            {t("common.cancel")}
          </button>
          <button
            type="button"
            disabled={deleting}
            onClick={handleConfirm}
            className="px-3.5 py-[7px] rounded-control bg-danger hover:bg-danger-hover text-text-on-accent text-[13px] font-semibold cursor-pointer transition-colors disabled:opacity-50"
          >
            {t("deleteBookModal.confirm")}
          </button>
        </div>
      </div>
    </div>
  );
}
