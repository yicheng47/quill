import { useState, useRef, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Sun, ScrollText, BookOpen, File, Files, Type } from "lucide-react";
import Select from "./ui/Select";
import Stepper from "./ui/Stepper";

const themes = [
  {
    id: "original",
    bg: "#FDFCFA",
    aaColor: "#15151A",
  },
  {
    id: "paper",
    bg: "#F4ECD8",
    aaColor: "#2B2116",
  },
  {
    id: "quiet",
    bg: "#E4E4E8",
    aaColor: "#15151A",
  },
  {
    id: "dark",
    bg: "#161412",
    aaColor: "#DBD2C4",
  },
] as const;

export const FONT_SIZE_MIN = 12;
export const FONT_SIZE_MAX = 48;

export const LINE_SPACING_MIN = 1;
export const LINE_SPACING_MAX = 3;
export const LINE_SPACING_STEP = 0.05;

export const CHAR_SPACING_MIN = -5;
export const CHAR_SPACING_MAX = 20;

export const WORD_SPACING_MIN = -10;
export const WORD_SPACING_MAX = 50;

export const MARGIN_PRESETS = [
  { id: "narrow", value: 0 },
  { id: "normal", value: 60 },
  { id: "wide", value: 120 },
] as const;

export type MarginPresetId = (typeof MARGIN_PRESETS)[number]["id"];

export function nearestMarginPreset(margins: number): MarginPresetId {
  if (margins <= 30) return "narrow";
  if (margins <= 90) return "normal";
  return "wide";
}

export const fonts = [
  { id: "literata", label: "Literata", family: "'Literata Variable', 'Literata', Georgia, serif" },
  { id: "system", label: "System", family: "Inter, system-ui, sans-serif" },
  { id: "georgia", label: "Georgia", family: "Georgia, serif" },
  { id: "palatino", label: "Palatino", family: "Palatino, serif" },
  { id: "inter", label: "Inter", family: "Inter, sans-serif" },
  { id: "times", label: "Times New Roman", family: "'Times New Roman', serif" },
] as const;

export type ReaderTheme = (typeof themes)[number]["id"];
export type ReaderFont = (typeof fonts)[number]["id"];

export type ReadingMode = "scrolling" | "paginated";
export type PageColumns = 1 | 2;

export interface ReaderSettingsState {
  theme: ReaderTheme;
  font: ReaderFont;
  fontSize: number; // px
  brightness: number; // 0-100
  readingMode: ReadingMode;
  pageColumns: PageColumns; // 1 = single page, 2 = two pages side by side
  lineSpacing: number; // multiplier, e.g. 1.75
  charSpacing: number; // percentage, 0 = normal
  wordSpacing: number; // percentage, 0 = normal
  margins: number; // pixels, 0 = none
}

export function nudgeFontSize(fontSize: number, direction: 1 | -1): number {
  return Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, fontSize + direction * 2));
}

export function nudgeLineSpacing(lineSpacing: number, direction: 1 | -1): number {
  const next = Math.round((lineSpacing + direction * LINE_SPACING_STEP) * 20) / 20;
  return Math.min(LINE_SPACING_MAX, Math.max(LINE_SPACING_MIN, next));
}

export function nudgeIntRange(value: number, delta: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value + delta)));
}

export function getStoredReaderSettings(
  settings: ReaderSettingsState,
  hasFontSizeOverride: boolean,
): Partial<ReaderSettingsState> {
  const storedSettings: Partial<ReaderSettingsState> = { ...settings };
  if (!hasFontSizeOverride) delete storedSettings.fontSize;
  return storedSettings;
}

interface ReaderSettingsProps {
  open: boolean;
  onClose: () => void;
  anchorRef: React.RefObject<HTMLElement | null>;
  settings: ReaderSettingsState;
  onSettingsChange: (settings: ReaderSettingsState) => void;
  bookFormat?: "epub" | "pdf";
}

export function getFontFamily(fontId: ReaderFont): string {
  return fonts.find((f) => f.id === fontId)?.family ?? "'Literata Variable', 'Literata', Georgia, serif";
}

export function getThemeStyles(themeId: ReaderTheme) {
  switch (themeId) {
    case "paper":
      return { body: "#F4ECD8", text: "#2B2116", border: "#E4D8BE", overline: "#7A6A55" };
    case "quiet":
      return { body: "#E4E4E8", text: "#15151A", border: "#D4D4DA", overline: "#6E6E7A" };
    case "dark":
      return { body: "#161412", text: "#DBD2C4", border: "rgba(255, 243, 227, 0.1)", overline: "#8C8378" };
    default:
      return { body: "#FDFCFA", text: "#15151A", border: "rgba(255, 255, 255, 0.9)", overline: "#6E6E7A" };
  }
}

export function getDefaultReaderTheme(): ReaderTheme {
  return document.documentElement.classList.contains("dark") ? "dark" : "original";
}

const EPUB_POPOVER_WIDTH = 316;
const PDF_POPOVER_WIDTH = 296;
const POPOVER_VIEWPORT_MARGIN = 12;

export default function ReaderSettings({
  open,
  onClose,
  anchorRef,
  settings,
  onSettingsChange,
  bookFormat,
}: ReaderSettingsProps) {
  const { t } = useTranslation();
  const popoverRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ top: 0, right: 0 });
  const isPdf = bookFormat === "pdf";

  useEffect(() => {
    if (!open) return;
    const popoverWidth = isPdf ? PDF_POPOVER_WIDTH : EPUB_POPOVER_WIDTH;
    const updatePosition = () => {
      if (!anchorRef.current) return;
      const rect = anchorRef.current.getBoundingClientRect();
      const effectiveWidth = Math.min(
        popoverWidth,
        Math.max(0, window.innerWidth - POPOVER_VIEWPORT_MARGIN * 2),
      );
      const maxRight = Math.max(
        POPOVER_VIEWPORT_MARGIN,
        window.innerWidth - effectiveWidth - POPOVER_VIEWPORT_MARGIN,
      );
      setPosition({
        top: rect.bottom + 8,
        right: Math.min(maxRight, Math.max(POPOVER_VIEWPORT_MARGIN, window.innerWidth - rect.right)),
      });
    };
    updatePosition();
    window.addEventListener("resize", updatePosition);
    return () => {
      window.removeEventListener("resize", updatePosition);
    };
  }, [open, anchorRef, isPdf]);

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
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleEscape);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [open, onClose, anchorRef]);

  const update = (partial: Partial<ReaderSettingsState>) => {
    onSettingsChange({ ...settings, ...partial });
  };

  const themeLabels: Record<ReaderTheme, string> = {
    original: t("readerSettings.themeOriginal"),
    paper: t("readerSettings.themeSepia"),
    quiet: t("readerSettings.themeGray"),
    dark: t("readerSettings.themeDark"),
  };

  const marginLabels: Record<MarginPresetId, string> = {
    narrow: t("readerSettings.marginNarrow"),
    normal: t("readerSettings.marginNormal"),
    wide: t("readerSettings.marginWide"),
  };

  if (!open) return null;

  const activeMarginPreset = nearestMarginPreset(settings.margins);

  return (
    <div
      ref={popoverRef}
      role="dialog"
      aria-label={t("readerSettings.typography")}
      className={`no-drag fixed z-50 ${
        isPdf ? "w-[296px] p-4" : "w-[316px] p-[18px]"
      } max-w-[calc(100vw-24px)] max-h-[calc(100vh-88px)] overflow-y-auto reader-popover rounded-surface flex flex-col gap-3.5`}
      style={{ top: position.top, right: position.right }}
    >
      {/* Font size bar — EPUB only */}
      {!isPdf && (
        <div className="grid grid-cols-[1fr_92px_1fr] h-10 rounded-[6px] bg-surface-inset border border-border-subtle overflow-hidden shrink-0">
          <button
            type="button"
            onClick={() => update({ fontSize: nudgeFontSize(settings.fontSize, -1) })}
            aria-label={t("readerSettings.decreaseFontSize")}
            disabled={settings.fontSize <= FONT_SIZE_MIN}
            className="flex items-center justify-center border-r border-border-subtle cursor-pointer text-[13.5px] font-semibold text-text-primary hover:bg-border-subtle transition-colors disabled:opacity-40 disabled:pointer-events-none focus-visible:outline-offset-[-3px]"
          >
            A−
          </button>
          <span className="flex items-center justify-center font-mono text-[12.5px] font-medium text-text-secondary select-none">
            {settings.fontSize} px
          </span>
          <button
            type="button"
            onClick={() => update({ fontSize: nudgeFontSize(settings.fontSize, 1) })}
            aria-label={t("readerSettings.increaseFontSize")}
            disabled={settings.fontSize >= FONT_SIZE_MAX}
            className="flex items-center justify-center border-l border-border-subtle cursor-pointer text-[17px] font-semibold text-text-primary hover:bg-border-subtle transition-colors disabled:opacity-40 disabled:pointer-events-none focus-visible:outline-offset-[-3px]"
          >
            A+
          </button>
        </div>
      )}

      {/* Brightness slider — EPUB and PDF */}
      <div className="flex items-center gap-2.5 h-4 shrink-0">
        <Sun size={13} className="text-text-tertiary shrink-0" />
        <input
          type="range"
          min={0}
          max={100}
          value={settings.brightness}
          aria-label={t("readerSettings.brightness")}
          onChange={(e) => update({ brightness: Number(e.target.value) })}
          className="flex-1 h-1 cursor-pointer appearance-none rounded-full [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:size-3.5 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-surface-solid [&::-webkit-slider-thumb]:border [&::-webkit-slider-thumb]:border-border-default [&::-webkit-slider-thumb]:shadow-xs"
          style={{
            background: `linear-gradient(to right, var(--color-accent) ${settings.brightness}%, var(--color-track) ${settings.brightness}%)`,
          }}
        />
        <Sun size={16} className="text-text-secondary shrink-0" />
      </div>

      {/* Theme swatches — EPUB and PDF */}
      <div className={`grid grid-cols-4 gap-1 shrink-0 ${isPdf ? "" : "px-1 py-0.5"}`}>
        {themes.map((theme) => {
          const selected = settings.theme === theme.id;
          return (
            <button
              key={theme.id}
              type="button"
              onClick={() => update({ theme: theme.id })}
              aria-pressed={selected}
              className="flex flex-col items-center gap-1 cursor-pointer group"
            >
              <span
                className={`${
                  isPdf ? "size-[30px]" : "size-[34px]"
                } rounded-full flex items-center justify-center transition-all ${
                  selected
                    ? "border-2 border-accent"
                    : "border border-border-default group-hover:border-border-strong"
                }`}
                style={{ backgroundColor: theme.bg }}
              >
                <span
                  className={`font-reading leading-none ${isPdf ? "text-[11px]" : "text-[12px]"}`}
                  style={{ color: theme.aaColor }}
                >
                  Aa
                </span>
              </span>
              <span
                className={`${isPdf ? "text-[10.5px]" : "text-[11px]"} leading-[14px] ${
                  selected
                    ? "font-semibold text-accent-on-tint"
                    : "font-normal text-text-tertiary"
                }`}
              >
                {themeLabels[theme.id]}
              </span>
            </button>
          );
        })}
      </div>

      <div className="h-px bg-border-subtle shrink-0" />

      {/* Font family — EPUB only */}
      {!isPdf && (
        <div className="flex items-center justify-between gap-3 shrink-0">
          <span className="text-[13px] font-medium text-text-primary">
            {t("readerSettings.font")}
          </span>
          <Select
            appearance="dawn"
            className="w-[152px]"
            icon={<Type size={14} />}
            value={settings.font}
            onChange={(v) => update({ font: v as ReaderFont })}
            options={fonts.map((f) => ({ value: f.id, label: f.label }))}
          />
        </div>
      )}

      {/* Reading mode — EPUB and PDF */}
      <div className="flex flex-col gap-2 shrink-0">
        <p className="text-[10.5px] font-semibold text-text-tertiary tracking-[0.8px] uppercase">
          {t("readerSettings.readingMode")}
        </p>
        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={() => update({ readingMode: "scrolling" })}
            aria-pressed={settings.readingMode === "scrolling"}
            className={`flex items-center justify-center gap-[7px] h-[34px] px-2.5 rounded-[6px] border cursor-pointer transition-colors ${
              settings.readingMode === "scrolling"
                ? "bg-accent-tint border-accent/35 text-accent-on-tint font-semibold"
                : "bg-surface-inset border-border-subtle text-text-secondary font-medium hover:bg-surface-solid"
            }`}
          >
            <ScrollText size={14} />
            <span className="text-[12.5px]">{t("readerSettings.scrolling")}</span>
          </button>
          <button
            type="button"
            onClick={() => update({ readingMode: "paginated" })}
            aria-pressed={settings.readingMode === "paginated"}
            className={`flex items-center justify-center gap-[7px] h-[34px] px-2.5 rounded-[6px] border cursor-pointer transition-colors ${
              settings.readingMode === "paginated"
                ? "bg-accent-tint border-accent/35 text-accent-on-tint font-semibold"
                : "bg-surface-inset border-border-subtle text-text-secondary font-medium hover:bg-surface-solid"
            }`}
          >
            <BookOpen size={14} />
            <span className="text-[12.5px]">{t("readerSettings.pageTurning")}</span>
          </button>
        </div>
      </div>

      {/* Page Layout — PDF only */}
      {isPdf && (
        <div className="flex flex-col gap-2 shrink-0">
          <p className="text-[10.5px] font-semibold text-text-tertiary tracking-[0.8px] uppercase">
            {t("readerSettings.pageLayout")}
          </p>
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => update({ pageColumns: 1 })}
              aria-pressed={settings.pageColumns === 1}
              className={`flex items-center justify-center gap-1.5 h-8 px-2.5 rounded-[6px] border cursor-pointer transition-colors ${
                settings.pageColumns === 1
                  ? "bg-accent-tint border-accent/35 text-accent-on-tint font-semibold"
                  : "bg-surface-inset border-border-subtle text-text-secondary font-medium hover:bg-surface-solid"
              }`}
            >
              <File size={14} />
              <span className="text-[12px]">{t("readerSettings.singlePage")}</span>
            </button>
            <button
              type="button"
              onClick={() => update({ pageColumns: 2 })}
              aria-pressed={settings.pageColumns === 2}
              className={`flex items-center justify-center gap-1.5 h-8 px-2.5 rounded-[6px] border cursor-pointer transition-colors ${
                settings.pageColumns === 2
                  ? "bg-accent-tint border-accent/35 text-accent-on-tint font-semibold"
                  : "bg-surface-inset border-border-subtle text-text-secondary font-medium hover:bg-surface-solid"
              }`}
            >
              <Files size={14} />
              <span className="text-[12px]">{t("readerSettings.twoPages")}</span>
            </button>
          </div>
        </div>
      )}

      {/* Spacing & Margins — EPUB only */}
      {!isPdf && (
        <>
          <div className="h-px bg-border-subtle shrink-0" />
          <div className="flex flex-col gap-2.5 shrink-0">
            <p className="text-[10.5px] font-semibold text-text-tertiary tracking-[0.8px] uppercase">
              {t("readerSettings.spacingAndMargins")}
            </p>

            <div className="flex items-center justify-between gap-2">
              <span className="text-[12.5px] text-text-secondary">
                {t("readerSettings.lineSpacing")}
              </span>
              <Stepper
                valueLabel={String(settings.lineSpacing)}
                onDecrement={() => update({ lineSpacing: nudgeLineSpacing(settings.lineSpacing, -1) })}
                onIncrement={() => update({ lineSpacing: nudgeLineSpacing(settings.lineSpacing, 1) })}
                disableDecrement={settings.lineSpacing <= LINE_SPACING_MIN}
                disableIncrement={settings.lineSpacing >= LINE_SPACING_MAX}
                decrementLabel={`${t("common.decrease")} ${t("readerSettings.lineSpacing")}`}
                incrementLabel={`${t("common.increase")} ${t("readerSettings.lineSpacing")}`}
              />
            </div>

            <div className="flex items-center justify-between gap-2">
              <span className="text-[12.5px] text-text-secondary">
                {t("readerSettings.charSpacing")}
              </span>
              <Stepper
                valueLabel={`${settings.charSpacing}%`}
                onDecrement={() =>
                  update({ charSpacing: nudgeIntRange(settings.charSpacing, -1, CHAR_SPACING_MIN, CHAR_SPACING_MAX) })
                }
                onIncrement={() =>
                  update({ charSpacing: nudgeIntRange(settings.charSpacing, 1, CHAR_SPACING_MIN, CHAR_SPACING_MAX) })
                }
                disableDecrement={settings.charSpacing <= CHAR_SPACING_MIN}
                disableIncrement={settings.charSpacing >= CHAR_SPACING_MAX}
                decrementLabel={`${t("common.decrease")} ${t("readerSettings.charSpacing")}`}
                incrementLabel={`${t("common.increase")} ${t("readerSettings.charSpacing")}`}
              />
            </div>

            <div className="flex items-center justify-between gap-2">
              <span className="text-[12.5px] text-text-secondary">
                {t("readerSettings.wordSpacing")}
              </span>
              <Stepper
                valueLabel={`${settings.wordSpacing}%`}
                onDecrement={() =>
                  update({ wordSpacing: nudgeIntRange(settings.wordSpacing, -1, WORD_SPACING_MIN, WORD_SPACING_MAX) })
                }
                onIncrement={() =>
                  update({ wordSpacing: nudgeIntRange(settings.wordSpacing, 1, WORD_SPACING_MIN, WORD_SPACING_MAX) })
                }
                disableDecrement={settings.wordSpacing <= WORD_SPACING_MIN}
                disableIncrement={settings.wordSpacing >= WORD_SPACING_MAX}
                decrementLabel={`${t("common.decrease")} ${t("readerSettings.wordSpacing")}`}
                incrementLabel={`${t("common.increase")} ${t("readerSettings.wordSpacing")}`}
              />
            </div>

            <div
              role="group"
              aria-label={t("readerSettings.margins")}
              className="grid grid-cols-3 p-[3px] gap-0.5 rounded-full bg-border-subtle"
            >
              {MARGIN_PRESETS.map((preset) => {
                const selected = activeMarginPreset === preset.id;
                return (
                  <button
                    key={preset.id}
                    type="button"
                    onClick={() => update({ margins: preset.value })}
                    aria-pressed={selected}
                    className={`py-[5px] rounded-full text-[12px] cursor-pointer transition-colors ${
                      selected
                        ? "bg-surface-solid text-text-primary font-semibold shadow-xs"
                        : "text-text-secondary font-medium hover:text-text-primary"
                    }`}
                  >
                    {marginLabels[preset.id]}
                  </button>
                );
              })}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
