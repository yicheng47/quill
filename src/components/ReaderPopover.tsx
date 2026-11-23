import { useEffect, useRef, useState, type ReactNode } from "react";
import { X } from "lucide-react";
import { useTranslation } from "react-i18next";

interface ReaderPopoverProps {
  x: number;
  y: number;
  widthClass: string;
  title: string;
  icon: ReactNode;
  headerExtra?: ReactNode;
  headerRight?: ReactNode;
  footer?: ReactNode;
  suppressDismiss?: boolean;
  onClose: () => void;
  children: ReactNode;
}

export default function ReaderPopover({
  x,
  y,
  widthClass,
  title,
  icon,
  headerExtra,
  headerRight,
  footer,
  suppressDismiss = false,
  onClose,
  children,
}: ReaderPopoverProps) {
  const { t } = useTranslation();
  const popoverRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });

  useEffect(() => {
    const el = popoverRef.current;
    if (!el) return;
    const clamp = () => {
      const rect = el.getBoundingClientRect();
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      let left = x;
      let top = y;
      if (left + rect.width > vw - 16) left = vw - rect.width - 16;
      if (left < 16) left = 16;
      if (top + rect.height > vh - 16) top = y - rect.height - 8;
      if (top < 16) top = 16;
      setPos({ left, top });
    };
    clamp();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(clamp);
    observer.observe(el);
    return () => observer.disconnect();
  }, [x, y]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !suppressDismiss) {
        onClose();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose, suppressDismiss]);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const id = requestAnimationFrame(() => {
      document.addEventListener("mousedown", handler);
    });
    return () => {
      cancelAnimationFrame(id);
      document.removeEventListener("mousedown", handler);
    };
  }, [onClose]);

  return (
    <>
      <div className="fixed inset-0 z-40" onClick={onClose} />
      <div
        ref={popoverRef}
        role="dialog"
        aria-label={title}
        className={`fixed z-50 ${widthClass} max-w-[calc(100vw-32px)] reader-popover rounded-surface overflow-hidden`}
        style={{ left: pos.left, top: pos.top }}
      >
        <div className="flex items-center justify-between gap-2 px-4 py-3 bg-surface-tint border-b border-border-subtle">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-accent-on-tint shrink-0 inline-flex">{icon}</span>
            <span className="text-[13.5px] font-semibold text-accent-on-tint truncate">
              {title}
            </span>
            {headerExtra}
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            {headerRight}
            <button
              type="button"
              onClick={onClose}
              aria-label={t("common.dismiss")}
              className="size-6 rounded-control flex items-center justify-center text-text-tertiary hover:text-text-primary hover:bg-border-subtle cursor-pointer transition-colors shrink-0"
            >
              <X size={14} />
            </button>
          </div>
        </div>

        {children}

        {footer && (
          <div className="flex items-center justify-between gap-3 px-4 py-2.5 border-t border-border-subtle">
            {footer}
          </div>
        )}
      </div>
    </>
  );
}
