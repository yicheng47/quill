import { useEffect, useRef } from "react";
import Button from "./ui/Button";

interface SaveDialogProps {
  open: boolean;
  onCancel: () => void;
  onSave: () => void;
}

export default function SaveDialog({ open, onCancel, onSave }: SaveDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [open, onCancel]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-overlay">
      <div
        ref={dialogRef}
        className="bg-bg-surface rounded-xl shadow-lg w-[400px] p-6"
      >
        <h3 className="text-[18px] font-semibold text-text-primary mb-2">
          Save Settings?
        </h3>
        <p className="text-[14px] text-text-secondary leading-5 mb-6">
          This will save all your current settings including AI provider
          configuration, reading preferences, and appearance settings.
        </p>
        <div className="flex justify-end gap-3">
          <Button variant="ghost" size="md" onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="primary" size="md" onClick={onSave}>
            Save Settings
          </Button>
        </div>
      </div>
    </div>
  );
}
