import { useEffect, useRef } from "react";
import {
  BookOpen,
  ChevronRight,
  Copy,
  MessageSquare,
  Highlighter,
  Search,
  Share2,
  Bot,
} from "lucide-react";

interface MenuItem {
  icon: React.ReactNode;
  label: string;
  shortcut?: string;
  hasSubmenu?: boolean;
  onClick?: () => void;
}

interface ReaderContextMenuProps {
  x: number;
  y: number;
  selectedText: string;
  onClose: () => void;
  onCopy: () => void;
  onHighlight: () => void;
  onAddNote: () => void;
  onSearchInBook: () => void;
  onAskAI: () => void;
}

export default function ReaderContextMenu({
  x,
  y,
  selectedText,
  onClose,
  onCopy,
  onHighlight,
  onAddNote,
  onSearchInBook,
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

  const truncatedText =
    selectedText.length > 25
      ? selectedText.slice(0, 25) + "..."
      : selectedText;

  const groups: MenuItem[][] = [
    [
      {
        icon: <BookOpen size={16} className="text-text-muted" />,
        label: `Look Up "${truncatedText}"`,
        onClick: onClose,
      },
      {
        icon: <Copy size={16} className="text-text-muted" />,
        label: "Copy",
        shortcut: "⌘C",
        onClick: onCopy,
      },
    ],
    [
      {
        icon: <Highlighter size={16} className="text-text-muted" />,
        label: "Highlight",
        hasSubmenu: true,
        onClick: onHighlight,
      },
      {
        icon: <MessageSquare size={16} className="text-text-muted" />,
        label: "Add Note",
        onClick: onAddNote,
      },
    ],
    [
      {
        icon: <Search size={16} className="text-text-muted" />,
        label: "Search in Book",
        onClick: onSearchInBook,
      },
      {
        icon: <Bot size={16} className="text-text-muted" />,
        label: "Ask AI Assistant",
        onClick: onAskAI,
      },
    ],
    [
      {
        icon: <Share2 size={16} className="text-text-muted" />,
        label: "Share...",
        onClick: onClose,
      },
    ],
  ];

  return (
    <div
      ref={menuRef}
      className="fixed z-50 bg-white/95 border border-border/80 rounded-lg py-1 w-[296px] backdrop-blur-sm shadow-context"
      style={{ left: x, top: y }}
    >
      {groups.map((group, gi) => (
        <div key={gi}>
          {gi > 0 && (
            <div className="mx-3 my-1 h-px bg-border/80" />
          )}
          {group.map((item, ii) => (
            <button
              key={ii}
              onClick={item.onClick}
              className="flex items-center gap-3 w-[calc(100%-8px)] mx-1 px-3 h-[31.5px] rounded-sm text-left cursor-pointer hover:bg-bg-input transition-colors"
            >
              {item.icon}
              <span className="flex-1 text-[13px] font-medium text-[#27272a] tracking-[-0.08px] truncate">
                {item.label}
              </span>
              {item.shortcut && (
                <span className="text-[11px] font-medium text-[#9f9fa9] tracking-[0.06px]">
                  {item.shortcut}
                </span>
              )}
              {item.hasSubmenu && (
                <ChevronRight size={12} className="text-text-muted" />
              )}
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}
