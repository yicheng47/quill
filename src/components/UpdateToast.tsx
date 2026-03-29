import { useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { X } from "lucide-react";
import { useUpdate } from "../contexts/UpdateContext";

interface UpdateToastProps {
  onOpenSettings: () => void;
}

export default function UpdateToast({ onOpenSettings }: UpdateToastProps) {
  const { t } = useTranslation();
  const { status, update } = useUpdate();
  const [dismissed, setDismissed] = useState(false);
  const [visible, setVisible] = useState(false);

  const shouldShow = status === "available" && !dismissed;

  useEffect(() => {
    if (shouldShow) {
      // Small delay for enter animation
      requestAnimationFrame(() => setVisible(true));

      // Auto-dismiss after 30s
      const timer = setTimeout(() => {
        setVisible(false);
        setTimeout(() => setDismissed(true), 200);
      }, 30000);
      return () => clearTimeout(timer);
    } else {
      setVisible(false);
    }
  }, [shouldShow]);

  const dismiss = useCallback(() => {
    setVisible(false);
    setTimeout(() => setDismissed(true), 200);
  }, []);

  const handleUpdate = useCallback(() => {
    dismiss();
    onOpenSettings();
  }, [dismiss, onOpenSettings]);

  if (!shouldShow) return null;

  const version = update?.version ?? "";

  return (
    <div
      className={`fixed top-5 left-1/2 -translate-x-1/2 z-50 bg-white dark:bg-bg-surface border border-border rounded-[14px] shadow-popover flex items-center gap-3 pl-4 pr-3 py-2.5 transition-all duration-200 ${
        visible
          ? "opacity-100 translate-y-0"
          : "opacity-0 -translate-y-2"
      }`}
    >
      {/* Accent dot with glow */}
      <div className="relative shrink-0 size-2">
        <div className="absolute -inset-[3px] rounded-full bg-purple/17" />
        <div className="absolute inset-0 rounded-full bg-purple" />
      </div>

      {/* Text */}
      <span className="text-[13px] text-text-secondary tracking-[-0.08px] whitespace-nowrap">
        {t("update.toast.available", { version: `v${version}` })}
      </span>

      {/* Update button */}
      <button
        onClick={handleUpdate}
        className="text-[13px] font-medium text-accent-text hover:bg-accent-bg px-2.5 py-1 rounded-lg cursor-pointer transition-colors whitespace-nowrap"
      >
        {t("update.toast.update")}
      </button>

      {/* Dismiss */}
      <button
        onClick={dismiss}
        className="shrink-0 size-6 flex items-center justify-center rounded-lg hover:bg-bg-input cursor-pointer transition-colors"
      >
        <X size={14} className="text-text-muted" />
      </button>
    </div>
  );
}
