import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Check, Sparkles, Trash2 } from "lucide-react";

export const HIGHLIGHT_SWATCHES = [
  { name: "yellow", hex: "#F4C430" },
  { name: "green", hex: "#34C77B" },
  { name: "blue", hex: "#5B9CF6" },
  { name: "pink", hex: "#EC6FA3" },
  { name: "purple", hex: "#9B8AFB" },
] as const;

interface HighlightToolbarProps {
  x: number;
  y: number;
  currentColor: string;
  onChangeColor: (color: string) => void;
  onAsk?: () => void;
  onDelete: () => void;
  onClose: () => void;
}

export default function HighlightToolbar({
  x,
  y,
  currentColor,
  onChangeColor,
  onAsk,
  onDelete,
  onClose,
}: HighlightToolbarProps) {
  const { t } = useTranslation();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
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

  useEffect(() => {
    if (!ref.current) return;
    const rect = ref.current.getBoundingClientRect();
    const vw = window.innerWidth;
    const clampedLeft = Math.max(8, Math.min(x - rect.width / 2, vw - rect.width - 8));
    ref.current.style.left = `${clampedLeft}px`;
    if (rect.top < 8) {
      ref.current.style.top = `${y + 24}px`;
    }
  }, [x, y]);

  return (
    <div
      ref={ref}
      className="fixed z-50 flex items-center gap-2.5 px-3 h-[38px] bg-surface-solid border border-border-subtle rounded-full shadow-menu"
      style={{ left: x, top: Math.max(8, y - 46) }}
    >
      <div className="flex items-center gap-2">
        {HIGHLIGHT_SWATCHES.map((c) => {
          const isCurrent = c.name === currentColor;
          return (
            <button
              key={c.name}
              type="button"
              onClick={() => onChangeColor(c.name)}
              aria-label={c.name}
              aria-pressed={isCurrent}
              className={`size-[18px] rounded-full cursor-pointer hover:scale-115 transition-transform flex items-center justify-center ${
                isCurrent ? "ring-[1.5px] ring-text-primary" : ""
              }`}
              style={{ backgroundColor: c.hex }}
            >
              {isCurrent && <Check size={11} className="text-white" strokeWidth={2.5} />}
            </button>
          );
        })}
      </div>

      {onAsk && (
        <>
          <div className="w-px h-4 bg-border-subtle" />
          <button
            type="button"
            onClick={onAsk}
            className="inline-flex items-center gap-[5px] px-1 py-0.5 rounded-full text-[12.5px] font-medium text-accent-on-tint hover:bg-accent-tint cursor-pointer transition-colors"
          >
            <Sparkles size={13} />
            <span>{t("reader.ask")}</span>
          </button>
        </>
      )}

      <div className="w-px h-4 bg-border-subtle" />
      <button
        type="button"
        onClick={onDelete}
        aria-label={t("common.delete")}
        className="size-6 rounded-full flex items-center justify-center text-text-tertiary hover:text-danger hover:bg-danger-tint cursor-pointer transition-colors"
      >
        <Trash2 size={13.5} />
      </button>
    </div>
  );
}
