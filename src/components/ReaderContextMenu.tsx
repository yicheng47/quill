import { useEffect, useRef } from "react";
import {
  Copy,
  Bot,
} from "lucide-react";

interface ReaderContextMenuProps {
  x: number;
  y: number;
  onClose: () => void;
  onCopy: () => void;
  onAskAI: () => void;
}

export default function ReaderContextMenu({
  x,
  y,
  onClose,
  onCopy,
  onAskAI,
}: ReaderContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);

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

  // Clamp menu position so it stays within viewport
  useEffect(() => {
    if (!menuRef.current) return;
    const rect = menuRef.current.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    if (rect.right > vw) {
      menuRef.current.style.left = `${x - rect.width}px`;
    }
    if (rect.bottom > vh) {
      menuRef.current.style.top = `${y - rect.height}px`;
    }
  }, [x, y]);

  return (
    <div
      ref={menuRef}
      className="fixed z-50 bg-white/95 border border-border/80 rounded-lg py-1 w-[240px] backdrop-blur-sm shadow-context"
      style={{ left: x, top: y }}
    >
      {/* Copy */}
      <button
        onClick={onCopy}
        className="flex items-center gap-3 w-[calc(100%-8px)] mx-1 px-3 h-[31.5px] rounded-sm text-left cursor-pointer hover:bg-bg-input transition-colors"
      >
        <Copy size={16} className="text-text-muted" />
        <span className="flex-1 text-[13px] font-medium text-[#27272a] tracking-[-0.08px]">
          Copy
        </span>
        <span className="text-[11px] font-medium text-[#9f9fa9] tracking-[0.06px]">
          ⌘C
        </span>
      </button>

      <div className="mx-3 my-1 h-px bg-border/80" />

      {/* Ask AI Assistant */}
      <button
        onClick={onAskAI}
        className="flex items-center gap-3 w-[calc(100%-8px)] mx-1 px-3 h-[31.5px] rounded-sm text-left cursor-pointer hover:bg-bg-input transition-colors"
      >
        <Bot size={16} className="text-text-muted" />
        <span className="flex-1 text-[13px] font-medium text-[#27272a] tracking-[-0.08px]">
          Ask AI Assistant
        </span>
      </button>
    </div>
  );
}
