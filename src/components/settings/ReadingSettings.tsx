import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Check } from "lucide-react";
import Select from "../ui/Select";
import { fonts, FONT_SIZE_MIN, FONT_SIZE_MAX, getDefaultReaderTheme, type ReaderTheme } from "../ReaderSettings";
import type { SettingsProps } from "./types";

const READER_THEME_OPTIONS: {
  value: ReaderTheme;
  labelKey: string;
  swatchClass: string;
  checkClass: string;
}[] = [
  {
    value: "original",
    labelKey: "readerSettings.themeOriginal",
    swatchClass: "bg-reader-original-bg border border-reader-original-border",
    checkClass: "text-accent",
  },
  {
    value: "paper",
    labelKey: "readerSettings.themeSepia",
    swatchClass: "bg-reader-paper-bg",
    checkClass: "text-accent",
  },
  {
    value: "quiet",
    labelKey: "readerSettings.themeGray",
    swatchClass: "bg-reader-quiet-bg",
    checkClass: "text-white",
  },
  {
    value: "dark",
    labelKey: "readerSettings.themeDark",
    swatchClass: "bg-reader-dark-bg border border-reader-dark-border",
    checkClass: "text-white",
  },
];

function NumberInput({ value, onChange, onBlur, suffix, min, max }: {
  value: number;
  onChange: (v: number) => void;
  onBlur: () => void;
  suffix?: string;
  min?: number;
  max?: number;
}) {
  return (
    <div className="flex items-center gap-1 shrink-0 w-[90px] justify-end">
      <input
        type="number"
        value={value}
        onChange={(e) => {
          const v = Number(e.target.value);
          if (min !== undefined && v < min) return;
          if (max !== undefined && v > max) return;
          onChange(v);
        }}
        onBlur={onBlur}
        onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
        className="w-[64px] h-8 bg-white dark:bg-bg-surface rounded-[10px] px-2 text-[13px] font-medium text-text-secondary text-center outline-none border border-border focus:border-accent transition-colors [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
      />
      <span className="text-[12px] text-text-muted w-[16px] text-left">{suffix}</span>
    </div>
  );
}

export default function ReadingSettings({ settings, loading, save, showSavedToast }: SettingsProps) {
  const { t } = useTranslation();
  const [readerTheme, setReaderTheme] = useState<ReaderTheme>(getDefaultReaderTheme());
  const [fontFamily, setFontFamily] = useState("georgia");
  const [fontSize, setFontSize] = useState(26);
  const [lineSpacing, setLineSpacing] = useState(1.8);
  const [wordSpacing, setWordSpacing] = useState(0);
  const [margins, setMargins] = useState(0);

  useEffect(() => {
    if (loading) return;
    setReaderTheme((settings.reader_theme as ReaderTheme) || getDefaultReaderTheme());
    if (settings.font_family) setFontFamily(settings.font_family);
    if (settings.font_size) setFontSize(parseInt(settings.font_size));
    if (settings.line_spacing) setLineSpacing(parseFloat(settings.line_spacing));
    if (settings.word_spacing) setWordSpacing(parseInt(settings.word_spacing));
    if (settings.margins) setMargins(parseInt(settings.margins));
  }, [settings, loading]);

  return (
    <div>
      {/* Theme */}
      <div className="flex items-center justify-between min-h-[88px] py-2">
        <div>
          <p className="text-[14px] font-medium text-text-primary tracking-[-0.15px]">{t("settings.layout.theme")}</p>
          <p className="text-[12px] text-text-muted mt-0.5">{t("settings.layout.themeHint")}</p>
        </div>
        <div className="grid grid-cols-4 gap-2 shrink-0">
          {READER_THEME_OPTIONS.map((theme) => (
            <button
              key={theme.value}
              type="button"
              onClick={() => {
                setReaderTheme(theme.value);
                save("reader_theme", theme.value);
                showSavedToast();
              }}
              className="w-[48px] flex flex-col items-center gap-1.5 cursor-pointer"
            >
              <span
                className={`size-8 rounded-full ${theme.swatchClass} flex items-center justify-center ${
                  readerTheme === theme.value ? "ring-2 ring-accent ring-offset-2 ring-offset-bg-surface" : ""
                }`}
              >
                {readerTheme === theme.value && <Check size={14} className={theme.checkClass} />}
              </span>
              <span className="text-[10px] font-medium text-text-muted leading-none">{t(theme.labelKey)}</span>
            </button>
          ))}
        </div>
      </div>
      {/* Font Family */}
      <div className="flex items-center justify-between h-[73px]">
        <div>
          <p className="text-[14px] font-medium text-text-primary tracking-[-0.15px]">{t("settings.layout.fontFamily")}</p>
          <p className="text-[12px] text-text-muted mt-0.5">{t("settings.layout.fontFamilyHint")}</p>
        </div>
        <Select
          className="w-[160px] shrink-0"
          value={fontFamily}
          onChange={(v) => { setFontFamily(v); save("font_family", v); showSavedToast(); }}
          options={fonts.map((f) => ({ value: f.id, label: f.label }))}
        />
      </div>
      {/* Font Size */}
      <div className="flex items-center justify-between h-[73px]">
        <div>
          <p className="text-[14px] font-medium text-text-primary tracking-[-0.15px]">{t("settings.layout.fontSize")}</p>
          <p className="text-[12px] text-text-muted mt-0.5">{t("settings.layout.fontSizeHint")}</p>
        </div>
        <NumberInput value={fontSize} onChange={setFontSize} onBlur={() => save("font_size", String(fontSize))} suffix="px" min={FONT_SIZE_MIN} max={FONT_SIZE_MAX} />
      </div>
      {/* Line Spacing */}
      <div className="flex items-center justify-between h-[73px]">
        <div>
          <p className="text-[14px] font-medium text-text-primary tracking-[-0.15px]">{t("settings.layout.lineSpacing")}</p>
          <p className="text-[12px] text-text-muted mt-0.5">{t("settings.layout.lineSpacingHint")}</p>
        </div>
        <NumberInput value={lineSpacing} onChange={setLineSpacing} onBlur={() => save("line_spacing", String(lineSpacing))} suffix="x" min={1} max={3} />
      </div>
      {/* Word Spacing */}
      <div className="flex items-center justify-between h-[73px]">
        <div>
          <p className="text-[14px] font-medium text-text-primary tracking-[-0.15px]">{t("settings.layout.wordSpacing")}</p>
          <p className="text-[12px] text-text-muted mt-0.5">{t("settings.layout.wordSpacingHint")}</p>
        </div>
        <NumberInput value={wordSpacing} onChange={setWordSpacing} onBlur={() => save("word_spacing", String(wordSpacing))} suffix="px" min={-4} max={16} />
      </div>
      {/* Margins */}
      <div className="flex items-center justify-between h-[73px]">
        <div>
          <p className="text-[14px] font-medium text-text-primary tracking-[-0.15px]">{t("settings.layout.margins")}</p>
          <p className="text-[12px] text-text-muted mt-0.5">{t("settings.layout.marginsHint")}</p>
        </div>
        <NumberInput value={margins} onChange={setMargins} onBlur={() => save("margins", String(margins))} suffix="%" min={0} max={30} />
      </div>
    </div>
  );
}
