import { useEffect, useRef } from "react";
import { Trash2 } from "lucide-react";

const HIGHLIGHT_COLORS = [
  { name: "yellow", hex: "#FBBF24" },
  { name: "green", hex: "#34D399" },
  { name: "blue", hex: "#60A5FA" },
  { name: "pink", hex: "#F472B6" },
  { name: "purple", hex: "#A78BFA" },
];

interface HighlightToolbarProps {
  x: number;
  y: number;
  currentColor: string;
  onChangeColor: (color: string) => void;
  onDelete: () => void;
  onClose: () => void;
}

export default function HighlightToolbar({
  x,
  y,
  currentColor,
  onChangeColor,
  onDelete,
  onClose,
}: HighlightToolbarProps) {
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

  // Clamp position to viewport
  useEffect(() => {
    if (!ref.current) return;
    const rect = ref.current.getBoundingClientRect();
    const vw = window.innerWidth;
    if (rect.right > vw) {
      ref.current.style.left = `${x - rect.width}px`;
    }
    if (rect.left < 0) {
      ref.current.style.left = "8px";
    }
  }, [x]);

  return (
    <div
      ref={ref}
      className="fixed z-50 flex items-center gap-2 px-3 h-9 bg-bg-surface/95 backdrop-blur-sm rounded-full shadow-context"
      style={{ left: x, top: y - 44 }}
    >
      {HIGHLIGHT_COLORS.map((c) => (
        <div
          key={c.name}
          onClick={() => onChangeColor(c.name)}
          className="w-[14px] h-[14px] rounded-full cursor-pointer hover:scale-125 transition-transform relative flex items-center justify-center"
          style={{ backgroundColor: c.hex }}
        >
          {c.name === currentColor && (
            <svg width="8" height="8" viewBox="0 0 8 8" fill="none">
              <path d="M1.5 4L3.5 6L6.5 2" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          )}
        </div>
      ))}
      <div
        onClick={onDelete}
        className="ml-1 p-1 rounded-full cursor-pointer hover:bg-black/5 transition-colors"
      >
        <Trash2 size={14} className="text-[#9f9fa9]" />
      </div>
    </div>
  );
}
