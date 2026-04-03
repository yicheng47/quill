import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import Button from "./ui/Button";
import Input from "./ui/Input";
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
      if (e.key === "Escape") onClose();
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
      className="fixed inset-0 z-50 flex items-center justify-center bg-overlay"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="bg-bg-surface rounded-xl shadow-lg w-[400px] p-6">
        <h3 className="text-[18px] font-semibold text-text-primary mb-5">
          {t("editInfo.title")}
        </h3>

        <div className="flex flex-col gap-4">
          <div>
            <label className="block text-[13px] font-medium text-text-secondary mb-1.5">
              {t("editInfo.bookTitle")}
            </label>
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              autoFocus
            />
          </div>
          <div>
            <label className="block text-[13px] font-medium text-text-secondary mb-1.5">
              {t("editInfo.bookAuthor")}
            </label>
            <Input
              value={author}
              onChange={(e) => setAuthor(e.target.value)}
            />
          </div>
        </div>

        <div className="flex justify-end gap-3 mt-6">
          <Button variant="ghost" size="md" onClick={onClose}>
            {t("editInfo.cancel")}
          </Button>
          <Button
            variant="primary"
            size="md"
            onClick={handleSave}
            disabled={!canSave}
          >
            {t("editInfo.save")}
          </Button>
        </div>
      </div>
    </div>
  );
}
