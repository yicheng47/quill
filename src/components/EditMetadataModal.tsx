import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import Button from "./ui/Button";
import { updateBookMetadata } from "../hooks/useBooks";

interface EditMetadataModalProps {
  bookId: string;
  currentTitle: string;
  currentAuthor: string;
  onClose: () => void;
  onSaved: () => void;
}

export default function EditMetadataModal({
  bookId,
  currentTitle,
  currentAuthor,
  onClose,
  onSaved,
}: EditMetadataModalProps) {
  const { t } = useTranslation();
  const [title, setTitle] = useState(currentTitle);
  const [author, setAuthor] = useState(currentAuthor);
  const [saving, setSaving] = useState(false);

  const trimmedTitle = title.trim();
  const unchanged =
    trimmedTitle === currentTitle && author.trim() === currentAuthor;
  const canSave = trimmedTitle.length > 0 && !unchanged && !saving;

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [onClose]);

  const handleSave = async () => {
    if (!canSave) return;
    setSaving(true);
    try {
      await updateBookMetadata(bookId, trimmedTitle, author.trim());
      onSaved();
    } catch (err) {
      console.error("Failed to update metadata:", err);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-scrim backdrop-blur-[6px] p-4"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void handleSave();
        }}
        role="dialog"
        aria-modal="true"
        aria-labelledby="edit-book-info-title"
        className="w-full max-w-[380px] p-[22px] rounded-[24px] bg-surface-solid border border-border-subtle shadow-menu flex flex-col gap-4"
      >
        <h3
          id="edit-book-info-title"
          className="text-[17px] font-semibold text-text-primary tracking-[-0.3px]"
        >
          {t("editInfo.title")}
        </h3>

        <div className="flex flex-col gap-3.5">
          <div className="flex flex-col gap-1.5">
            <label className="text-[12.5px] font-medium text-text-secondary">
              {t("editInfo.bookTitle")}
            </label>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              autoFocus
              className="w-full h-9 px-3 rounded-[10px] bg-surface-inset border border-border-default focus:bg-surface-solid focus:border-accent text-[13.5px] text-text-primary outline-none transition-colors"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="text-[12.5px] font-medium text-text-secondary">
              {t("editInfo.bookAuthor")}
            </label>
            <input
              value={author}
              onChange={(e) => setAuthor(e.target.value)}
              className="w-full h-9 px-3 rounded-[10px] bg-surface-inset border border-border-default focus:bg-surface-solid focus:border-accent text-[13.5px] text-text-primary outline-none transition-colors"
            />
          </div>
        </div>

        <div className="flex justify-end gap-2 mt-1">
          <Button type="button" variant="secondary" size="sm" onClick={onClose}>
            {t("editInfo.cancel")}
          </Button>
          <Button type="submit" variant="primary" size="sm" disabled={!canSave}>
            {t("editInfo.save")}
          </Button>
        </div>
      </form>
    </div>
  );
}
