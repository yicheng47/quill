import { useState, useEffect, useRef } from "react";
import {
  ChevronRight,
  Copy,
  Highlighter,
  Bot,
} from "lucide-react";

const HIGHLIGHT_COLORS = [
  { name: "yellow", color: "#FBBF24" },
  { name: "green", color: "#34D399" },
  { name: "blue", color: "#60A5FA" },
  { name: "pink", color: "#F472B6" },
  { name: "purple", color: "#A78BFA" },
];

interface ReaderContextMenuProps {
  x: number;
  y: number;
  onClose: () => void;
  onCopy: () => void;
  onHighlight: (color: string) => void;
  onAskAI: () => void;
}

export default function ReaderContextMenu({
  x,
  y,
  onClose,
  onCopy,
  onHighlight,
  onAskAI,
}: ReaderContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [showColors, setShowColors] = useState(false);

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

      {/* Highlight with color submenu */}
      <div className="relative">
        <button
          onMouseEnter={() => setShowColors(true)}
          onClick={() => setShowColors((v) => !v)}
          className="flex items-center gap-3 w-[calc(100%-8px)] mx-1 px-3 h-[31.5px] rounded-sm text-left cursor-pointer hover:bg-bg-input transition-colors"
        >
          <Highlighter size={16} className="text-text-muted" />
          <span className="flex-1 text-[13px] font-medium text-[#27272a] tracking-[-0.08px]">
            Highlight
          </span>
          <ChevronRight size={12} className="text-text-muted" />
        </button>

        {showColors && (
          <div
            className="absolute left-full top-0 ml-1 bg-white/95 border border-border/80 rounded-lg py-2 px-2 backdrop-blur-sm shadow-context flex gap-1.5"
            onMouseLeave={() => setShowColors(false)}
          >
            {HIGHLIGHT_COLORS.map((c) => (
              <button
                key={c.name}
                onClick={() => onHighlight(c.name)}
                className="w-6 h-6 rounded-full cursor-pointer hover:scale-110 transition-transform ring-1 ring-black/10"
                style={{ backgroundColor: c.color }}
                title={c.name}
              />
            ))}
          </div>
        )}
      </div>

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
