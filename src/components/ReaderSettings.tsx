import { useState, useRef, useEffect } from "react";
import { Sun, Check } from "lucide-react";

const themes = [
  { id: "original", label: "Original", color: "bg-white border border-[#d4d4d8]" },
  { id: "paper", label: "Paper", color: "bg-[#fef3c6]" },
  { id: "quiet", label: "Quiet", color: "bg-text-muted" },
  { id: "night", label: "Night", color: "bg-text-primary" },
] as const;

const fonts = [
  { id: "system", label: "System", style: "font-['Inter'] font-medium" },
  { id: "georgia", label: "Georgia", style: "font-['Georgia']" },
  { id: "palatino", label: "Palatino", style: "font-['Palatino']" },
  { id: "inter", label: "Inter", style: "font-['Inter'] font-medium" },
  { id: "times", label: "Times New Roman", style: "font-['Times_New_Roman']" },
] as const;

interface ReaderSettingsProps {
  open: boolean;
  onClose: () => void;
  anchorRef: React.RefObject<HTMLElement | null>;
}

export default function ReaderSettings({ open, onClose, anchorRef }: ReaderSettingsProps) {
  const [activeTheme, setActiveTheme] = useState("original");
  const [activeFont, setActiveFont] = useState("system");
  const [fontSize, setFontSize] = useState<"small" | "large">("large");
  const [brightness, setBrightness] = useState(50);
  const popoverRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ top: 0, right: 0 });

  useEffect(() => {
    if (open && anchorRef.current) {
      const rect = anchorRef.current.getBoundingClientRect();
      setPosition({
        top: rect.bottom + 4,
        right: window.innerWidth - rect.right,
      });
    }
  }, [open, anchorRef]);

  useEffect(() => {
    if (!open) return;
    const handleClick = (e: MouseEvent) => {
      if (
        popoverRef.current &&
        !popoverRef.current.contains(e.target as Node) &&
        anchorRef.current &&
        !anchorRef.current.contains(e.target as Node)
      ) {
        onClose();
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open, onClose, anchorRef]);

  if (!open) return null;

  return (
    <div
      ref={popoverRef}
      className="fixed z-50 w-[280px] bg-bg-surface border border-border rounded-xl shadow-popover flex flex-col"
      style={{ top: position.top, right: position.right }}
    >
      {/* Font size toggle */}
      <div className="flex items-center h-[60px] px-4 border-b border-border-light">
        <button
          onClick={() => setFontSize("small")}
          className={`flex-1 flex items-center justify-center h-7 border-r border-border cursor-pointer ${
            fontSize === "small" ? "text-text-primary" : "text-text-muted"
          }`}
        >
          <span className="text-[14px] font-medium">A</span>
        </button>
        <button
          onClick={() => setFontSize("large")}
          className={`flex-1 flex items-center justify-center h-9 cursor-pointer ${
            fontSize === "large" ? "text-text-primary" : "text-text-muted"
          }`}
        >
          <span className="text-[20px] font-medium tracking-[-0.45px]">A</span>
        </button>
      </div>

      {/* Brightness slider */}
      <div className="flex items-center gap-3 h-[42px] px-4 border-b border-border-light">
        <Sun size={14} className="text-text-muted shrink-0" />
        <input
          type="range"
          min={0}
          max={100}
          value={brightness}
          onChange={(e) => setBrightness(Number(e.target.value))}
          className="flex-1 h-1 accent-text-muted cursor-pointer"
        />
        <Sun size={18} className="text-text-muted shrink-0" />
      </div>

      {/* Theme selector */}
      <div className="flex items-center justify-center gap-5 h-[78px] border-b border-border-light">
        {themes.map((theme) => (
          <button
            key={theme.id}
            onClick={() => setActiveTheme(theme.id)}
            className="flex flex-col items-center gap-1.5 cursor-pointer"
          >
            <div
              className={`size-8 rounded-full ${theme.color} flex items-center justify-center ${
                activeTheme === theme.id ? "ring-2 ring-link-light ring-offset-2" : ""
              }`}
            >
              {activeTheme === theme.id && (
                <Check
                  size={14}
                  className={theme.id === "night" || theme.id === "quiet" ? "text-white" : "text-link-light"}
                />
              )}
            </div>
            <span className="text-[10px] font-medium text-text-muted tracking-[0.12px]">
              {theme.label}
            </span>
          </button>
        ))}
      </div>

      {/* Font family list */}
      <div className="flex flex-col pt-1">
        {fonts.map((font) => (
          <button
            key={font.id}
            onClick={() => setActiveFont(font.id)}
            className="flex items-center justify-between h-9 px-4 hover:bg-bg-input cursor-pointer"
          >
            <span
              className={`text-[14px] ${font.style} ${
                activeFont === font.id ? "text-text-primary" : "text-text-secondary"
              }`}
            >
              {font.label}
            </span>
            {activeFont === font.id && (
              <Check size={16} className="text-link-light" />
            )}
          </button>
        ))}
      </div>
    </div>
  );
}
