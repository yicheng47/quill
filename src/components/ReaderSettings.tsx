import { useState, useRef, useEffect } from "react";
import { Sun, Check, ScrollText, BookOpen } from "lucide-react";
import Select from "./ui/Select";

const sliderClass =
  "w-full h-1 cursor-pointer appearance-none rounded-full bg-border [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3.5 [&::-webkit-slider-thumb]:h-3.5 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-bg-surface [&::-webkit-slider-thumb]:border [&::-webkit-slider-thumb]:border-border [&::-webkit-slider-thumb]:shadow-sm";

const themes = [
  { id: "original", label: "Original", color: "bg-white border border-[#d4d4d8]" },
  { id: "paper", label: "Paper", color: "bg-[#fef3c6]" },
  { id: "quiet", label: "Quiet", color: "bg-[#71717b]" },
  { id: "night", label: "Night", color: "bg-[#18181b] border border-[#3f3f46]" },
] as const;

const fonts = [
  { id: "system", label: "System", family: "Inter, system-ui, sans-serif" },
  { id: "georgia", label: "Georgia", family: "Georgia, serif" },
  { id: "palatino", label: "Palatino", family: "Palatino, serif" },
  { id: "inter", label: "Inter", family: "Inter, sans-serif" },
  { id: "times", label: "Times New Roman", family: "'Times New Roman', serif" },
] as const;

export type ReaderTheme = (typeof themes)[number]["id"];
export type ReaderFont = (typeof fonts)[number]["id"];

export type ReadingMode = "scrolling" | "paginated";

export interface ReaderSettingsState {
  theme: ReaderTheme;
  font: ReaderFont;
  fontSize: number; // px
  brightness: number; // 0-100
  readingMode: ReadingMode;
  lineSpacing: number; // multiplier, e.g. 1.5
  charSpacing: number; // percentage, 0 = normal
  wordSpacing: number; // percentage, 0 = normal
  margins: number; // pixels, 0 = none
}

interface ReaderSettingsProps {
  open: boolean;
  onClose: () => void;
  anchorRef: React.RefObject<HTMLElement | null>;
  settings: ReaderSettingsState;
  onSettingsChange: (settings: ReaderSettingsState) => void;
}

export function getFontFamily(fontId: ReaderFont): string {
  return fonts.find((f) => f.id === fontId)?.family ?? "Inter, system-ui, sans-serif";
}

export function getThemeStyles(themeId: ReaderTheme) {
  switch (themeId) {
    case "paper":
      return { body: "#fef3c6", text: "#1c1917" };
    case "quiet":
      return { body: "#71717b", text: "#fafafa" };
    case "night":
      return { body: "#18181b", text: "#d4d4d8" };
    default:
      return { body: "#ffffff", text: "#0a0a0a" };
  }
}

export function getDefaultReaderTheme(): ReaderTheme {
  return document.documentElement.classList.contains("dark") ? "night" : "original";
}

export default function ReaderSettings({ open, onClose, anchorRef, settings, onSettingsChange }: ReaderSettingsProps) {
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

  const update = (partial: Partial<ReaderSettingsState>) => {
    onSettingsChange({ ...settings, ...partial });
  };

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
          onClick={() => update({ fontSize: Math.max(12, settings.fontSize - 2) })}
          className="flex-1 flex items-center justify-center h-7 border-r border-border cursor-pointer text-text-primary hover:bg-bg-input"
        >
          <span className="text-[14px] font-medium">A-</span>
        </button>
        <span className="flex-1 flex items-center justify-center text-[14px] font-medium text-text-primary">
          {settings.fontSize}px
        </span>
        <button
          onClick={() => update({ fontSize: Math.min(28, settings.fontSize + 2) })}
          className="flex-1 flex items-center justify-center h-9 border-l border-border cursor-pointer text-text-primary hover:bg-bg-input"
        >
          <span className="text-[20px] font-medium tracking-[-0.45px]">A+</span>
        </button>
      </div>

      {/* Brightness slider */}
      <div className="flex items-center gap-3 h-[42px] px-4 border-b border-border-light">
        <Sun size={14} className="text-text-muted shrink-0" />
        <input
          type="range"
          min={0}
          max={100}
          value={settings.brightness}
          onChange={(e) => update({ brightness: Number(e.target.value) })}
          className={`flex-1 ${sliderClass}`}
        />
        <Sun size={18} className="text-text-muted shrink-0" />
      </div>

      {/* Theme selector */}
      <div className="flex items-center justify-center gap-5 h-[78px] border-b border-border-light">
        {themes.map((theme) => (
          <button
            key={theme.id}
            onClick={() => update({ theme: theme.id })}
            className="flex flex-col items-center gap-1.5 cursor-pointer"
          >
            <div
              className={`size-8 rounded-full ${theme.color} flex items-center justify-center ${
                settings.theme === theme.id ? "ring-2 ring-accent ring-offset-2 ring-offset-bg-surface" : ""
              }`}
            >
              {settings.theme === theme.id && (
                <Check
                  size={14}
                  className={theme.id === "night" || theme.id === "quiet" ? "text-white" : "text-accent"}
                />
              )}
            </div>
            <span className="text-[10px] font-medium text-text-muted tracking-[0.12px]">
              {theme.label}
            </span>
          </button>
        ))}
      </div>

      {/* Font family dropdown */}
      <div className="px-4 py-3 border-b border-border-light">
        <p className="text-[11px] font-medium text-text-muted tracking-[0.5px] uppercase mb-2">Font</p>
        <Select
          value={settings.font}
          onChange={(v) => update({ font: v as ReaderFont })}
          options={fonts.map((f) => ({ value: f.id, label: f.label }))}
        />
      </div>

      {/* Reading Mode */}
      <div className="px-4 py-3 border-b border-border-light">
        <p className="text-[11px] font-medium text-text-muted tracking-[0.5px] uppercase mb-2">Reading Mode</p>
        <div className="flex gap-2">
          <button
            onClick={() => update({ readingMode: "scrolling" })}
            className={`flex-1 flex flex-col items-center gap-1.5 py-2.5 rounded-lg border cursor-pointer transition-colors ${
              settings.readingMode === "scrolling"
                ? "border-accent bg-accent-bg text-accent"
                : "border-border bg-bg-surface text-text-primary hover:bg-bg-input"
            }`}
          >
            <ScrollText size={20} />
            <span className="text-[12px] font-medium">Scrolling</span>
          </button>
          <button
            onClick={() => update({ readingMode: "paginated" })}
            className={`flex-1 flex flex-col items-center gap-1.5 py-2.5 rounded-lg border cursor-pointer transition-colors ${
              settings.readingMode === "paginated"
                ? "border-accent bg-accent-bg text-accent"
                : "border-border bg-bg-surface text-text-primary hover:bg-bg-input"
            }`}
          >
            <BookOpen size={20} />
            <span className="text-[12px] font-medium">Page Turning</span>
          </button>
        </div>
      </div>

      {/* Layout section */}
      <div className="px-4 py-3 flex flex-col gap-4">
        <p className="text-[11px] font-medium text-text-muted tracking-[0.5px] uppercase">Layout</p>

        {/* Line Spacing */}
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between">
            <span className="text-[13px] font-medium text-text-primary">Line Spacing</span>
            <span className="text-[13px] text-text-muted">{settings.lineSpacing}</span>
          </div>
          <input
            type="range"
            min={1}
            max={3}
            step={0.1}
            value={settings.lineSpacing}
            onChange={(e) => update({ lineSpacing: Number(e.target.value) })}
            className={sliderClass}
          />
        </div>

        {/* Character Spacing */}
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between">
            <span className="text-[13px] font-medium text-text-primary">Character Spacing</span>
            <span className="text-[13px] text-text-muted">{settings.charSpacing}%</span>
          </div>
          <input
            type="range"
            min={-5}
            max={20}
            step={1}
            value={settings.charSpacing}
            onChange={(e) => update({ charSpacing: Number(e.target.value) })}
            className={sliderClass}
          />
        </div>

        {/* Word Spacing */}
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between">
            <span className="text-[13px] font-medium text-text-primary">Word Spacing</span>
            <span className="text-[13px] text-text-muted">{settings.wordSpacing}%</span>
          </div>
          <input
            type="range"
            min={-10}
            max={50}
            step={1}
            value={settings.wordSpacing}
            onChange={(e) => update({ wordSpacing: Number(e.target.value) })}
            className={sliderClass}
          />
        </div>

        {/* Margins */}
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between">
            <span className="text-[13px] font-medium text-text-primary">Margins</span>
            <span className="text-[13px] text-text-muted">{settings.margins}px</span>
          </div>
          <input
            type="range"
            min={0}
            max={120}
            step={1}
            value={settings.margins}
            onChange={(e) => update({ margins: Number(e.target.value) })}
            className={sliderClass}
          />
        </div>
      </div>
    </div>
  );
}
