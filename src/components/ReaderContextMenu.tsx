import { useEffect, useRef } from "react";
import {
  Copy,
  WandSparkles,
  Quote,
  Sparkles,
  Highlighter,
  Languages,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { HIGHLIGHT_SWATCHES } from "./HighlightToolbar";
import { shortcutModSymbol } from "../lib/platformEnv";

interface ReaderContextMenuProps {
  x: number;
  y: number;
  text: string;
  onClose: () => void;
  onCopy: () => void;
  onExplain: () => void;
  onQuote: () => void;
  onLookup: () => void;
  onTranslate: () => void;
  onHighlight?: (color: string) => void;
}

const MENU_ROW_CLASS =
  "group flex items-center gap-2.5 w-full px-2.5 py-2 rounded-[8px] text-left cursor-pointer text-text-primary hover:bg-surface-tint hover:text-accent-on-tint transition-colors";

export default function ReaderContextMenu({
  x,
  y,
  text,
  onClose,
  onCopy,
  onExplain,
  onQuote,
  onLookup,
  onTranslate,
  onHighlight,
}: ReaderContextMenuProps) {
  const { t } = useTranslation();
  const wordCount = text.trim().split(/\s+/).length;
  const showLookup = wordCount <= 5;
  const menuRef = useRef<HTMLDivElement>(null);
  const mod = shortcutModSymbol();

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
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
    if (!menuRef.current) return;
    const rect = menuRef.current.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left = x;
    let top = y;
    if (left + rect.width > vw - 12) left = x - rect.width;
    if (left < 12) left = 12;
    if (top + rect.height > vh - 12) top = y - rect.height;
    if (top < 12) top = 12;
    menuRef.current.style.left = `${left}px`;
    menuRef.current.style.top = `${top}px`;
  }, [x, y]);

  return (
    <div
      ref={menuRef}
      role="menu"
      className="fixed z-50 w-[252px] reader-popover rounded-surface p-1.5 flex flex-col gap-0.5"
      style={{ left: x, top: y }}
    >
      {showLookup && (
        <button type="button" role="menuitem" onClick={onLookup} className={MENU_ROW_CLASS}>
          <Sparkles size={15} className="text-text-secondary group-hover:text-accent-on-tint shrink-0" />
          <span className="flex-1 text-[13.5px] font-medium truncate">
            {t("contextMenu.lookUp")}
          </span>
        </button>
      )}

      <button type="button" role="menuitem" onClick={onExplain} className={MENU_ROW_CLASS}>
        <WandSparkles size={15} className="text-text-secondary group-hover:text-accent-on-tint shrink-0" />
        <span className="flex-1 text-[13.5px] truncate">{t("contextMenu.explain")}</span>
      </button>

      <button type="button" role="menuitem" onClick={onQuote} className={MENU_ROW_CLASS}>
        <Quote size={15} className="text-text-secondary group-hover:text-accent-on-tint shrink-0" />
        <span className="flex-1 text-[13.5px] truncate">{t("contextMenu.quote")}</span>
      </button>

      <button type="button" role="menuitem" onClick={onTranslate} className={MENU_ROW_CLASS}>
        <Languages size={15} className="text-text-secondary group-hover:text-accent-on-tint shrink-0" />
        <span className="flex-1 text-[13.5px] truncate">{t("contextMenu.translate")}</span>
      </button>

      {onHighlight && (
        <>
          <div className="my-[3px] mx-2 h-px bg-border-subtle" />
          <div className="flex items-center justify-between gap-2 px-2.5 py-2 rounded-[8px]">
            <div className="flex items-center gap-2.5 min-w-0">
              <Highlighter size={15} className="text-text-secondary shrink-0" />
              <span className="text-[13.5px] text-text-primary truncate">
                {t("contextMenu.highlight")}
              </span>
            </div>
            <div className="flex items-center gap-1.5 shrink-0">
              {HIGHLIGHT_SWATCHES.map((c) => (
                <button
                  key={c.name}
                  type="button"
                  aria-label={t(`highlights.color.${c.name === "purple" ? "violet" : c.name}`)}
                  onClick={(e) => {
                    e.stopPropagation();
                    onHighlight(c.name);
                  }}
                  className="size-[14px] rounded-full cursor-pointer hover:scale-125 transition-transform"
                  style={{ backgroundColor: c.hex }}
                />
              ))}
            </div>
          </div>
          <div className="my-[3px] mx-2 h-px bg-border-subtle" />
        </>
      )}

      <button type="button" role="menuitem" onClick={onCopy} className={MENU_ROW_CLASS}>
        <Copy size={15} className="text-text-secondary group-hover:text-accent-on-tint shrink-0" />
        <span className="flex-1 text-[13.5px] truncate">{t("contextMenu.copy")}</span>
        <span className="font-mono text-[11px] text-text-tertiary shrink-0">{mod}C</span>
      </button>
    </div>
  );
}
