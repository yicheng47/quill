import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Type } from "lucide-react";
import Select from "../ui/Select";
import Stepper from "../ui/Stepper";
import Switch from "../ui/Switch";
import { SegmentedControl } from "../ui/Segment";
import { SettingsGroup, SettingsOverline, SettingsRow } from "../ui/SettingsRow";
import {
  fonts,
  FONT_SIZE_MIN,
  FONT_SIZE_MAX,
  LINE_SPACING_MIN,
  LINE_SPACING_MAX,
  LINE_SPACING_STEP,
  CHAR_SPACING_MIN,
  CHAR_SPACING_MAX,
  WORD_SPACING_MIN,
  WORD_SPACING_MAX,
  MARGIN_PRESETS,
  nearestMarginPreset,
  getDefaultReaderTheme,
  type MarginPresetId,
  type ReaderTheme,
} from "../ReaderSettings";
import type { SettingsProps } from "./types";

const READER_THEME_OPTIONS: {
  value: ReaderTheme;
  labelKey: string;
  bg: string;
  text: string;
}[] = [
  {
    value: "original",
    labelKey: "readerSettings.themeOriginal",
    bg: "#FDFCFA",
    text: "#15151A",
  },
  {
    value: "paper",
    labelKey: "readerSettings.themeSepia",
    bg: "#F4ECD8",
    text: "#15151A",
  },
  {
    value: "quiet",
    labelKey: "readerSettings.themeGray",
    bg: "#E4E4E8",
    text: "#15151A",
  },
  {
    value: "dark",
    labelKey: "readerSettings.themeDark",
    bg: "#1E1D24",
    text: "#E8E6F0",
  },
];

function formatLineSpacing(val: number): string {
  const rounded = Math.round(val * 100) / 100;
  return Number.isInteger(rounded) ? rounded.toFixed(1) : String(rounded);
}

export default function ReadingSettings({ settings, loading, save }: SettingsProps) {
  const { t } = useTranslation();
  const [readerTheme, setReaderTheme] = useState<ReaderTheme>(getDefaultReaderTheme());
  const [fontFamily, setFontFamily] = useState("georgia");
  const [fontSize, setFontSize] = useState(26);
  const [lineSpacing, setLineSpacing] = useState(1.8);
  const [charSpacing, setCharSpacing] = useState(0);
  const [wordSpacing, setWordSpacing] = useState(0);
  const [margins, setMargins] = useState(0);
  const [autoSave, setAutoSave] = useState(true);

  useEffect(() => {
    if (loading) return;
    setReaderTheme((settings.reader_theme as ReaderTheme) || getDefaultReaderTheme());
    if (settings.font_family) setFontFamily(settings.font_family);
    if (settings.font_size) {
      const parsed = Number.parseInt(settings.font_size, 10);
      if (Number.isFinite(parsed)) {
        setFontSize(Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, parsed)));
      }
    }
    if (settings.line_spacing) {
      const parsed = Number.parseFloat(settings.line_spacing);
      if (Number.isFinite(parsed)) {
        setLineSpacing(Math.min(LINE_SPACING_MAX, Math.max(LINE_SPACING_MIN, parsed)));
      }
    }
    if (settings.char_spacing) {
      const parsed = Number.parseInt(settings.char_spacing, 10);
      if (Number.isFinite(parsed)) {
        setCharSpacing(Math.min(CHAR_SPACING_MAX, Math.max(CHAR_SPACING_MIN, parsed)));
      }
    }
    if (settings.word_spacing) {
      const parsed = Number.parseInt(settings.word_spacing, 10);
      if (Number.isFinite(parsed)) {
        setWordSpacing(Math.min(WORD_SPACING_MAX, Math.max(WORD_SPACING_MIN, parsed)));
      }
    }
    if (settings.margins !== undefined) {
      const parsed = Number.parseInt(settings.margins, 10);
      if (Number.isFinite(parsed)) {
        setMargins(parsed);
      }
    }
    setAutoSave(settings.auto_save !== "false");
  }, [settings, loading]);

  const marginPreset = nearestMarginPreset(margins);

  return (
    <div className="flex flex-col gap-7">
      <section className="flex flex-col gap-2.5">
        <SettingsOverline>{t("settings.reading.defaultLayoutGroup")}</SettingsOverline>
        <SettingsGroup>
          {/* Page theme */}
          <SettingsRow title={t("settings.reading.pageTheme")}>
            <div className="flex items-center gap-2 shrink-0">
              {READER_THEME_OPTIONS.map((theme) => {
                const selected = readerTheme === theme.value;
                return (
                  <button
                    key={theme.value}
                    type="button"
                    aria-pressed={selected}
                    onClick={() => {
                      setReaderTheme(theme.value);
                      void save("reader_theme", theme.value);
                    }}
                    className="w-14 flex flex-col items-center gap-1 cursor-pointer group focus-visible:outline-none"
                  >
                    <span
                      style={{ backgroundColor: theme.bg, color: theme.text }}
                      className={`size-[30px] rounded-full flex items-center justify-center font-reading text-[11px] transition-shadow group-focus-visible:ring-[3px] group-focus-visible:ring-focus-ring ${
                        selected
                          ? "border-2 border-accent"
                          : "border border-border-default"
                      }`}
                    >
                      Aa
                    </span>
                    <span
                      className={`text-[11px] leading-none ${
                        selected
                          ? "font-semibold text-accent-on-tint"
                          : "font-normal text-text-tertiary"
                      }`}
                    >
                      {t(theme.labelKey)}
                    </span>
                  </button>
                );
              })}
            </div>
          </SettingsRow>

          {/* Font */}
          <SettingsRow title={t("readerSettings.font")}>
            <Select
              className="w-[180px] shrink-0"
              icon={<Type size={14} />}
              value={fontFamily}
              onChange={(v) => {
                setFontFamily(v);
                void save("font_family", v);
              }}
              options={fonts.map((f) => ({ value: f.id, label: f.label }))}
            />
          </SettingsRow>

          {/* Font size */}
          <SettingsRow
            title={t("settings.layout.fontSize")}
            hint={t("settings.reading.fontSizeRange", { min: FONT_SIZE_MIN, max: FONT_SIZE_MAX })}
          >
            <Stepper
              valueLabel={`${fontSize} px`}
              decrementLabel={t("settings.reading.decreaseFontSize")}
              incrementLabel={t("settings.reading.increaseFontSize")}
              disableDecrement={fontSize <= FONT_SIZE_MIN}
              disableIncrement={fontSize >= FONT_SIZE_MAX}
              onDecrement={() => {
                const next = Math.max(FONT_SIZE_MIN, fontSize - 1);
                setFontSize(next);
                void save("font_size", String(next));
              }}
              onIncrement={() => {
                const next = Math.min(FONT_SIZE_MAX, fontSize + 1);
                setFontSize(next);
                void save("font_size", String(next));
              }}
            />
          </SettingsRow>

          {/* Line spacing */}
          <SettingsRow title={t("settings.layout.lineSpacing")}>
            <Stepper
              valueLabel={formatLineSpacing(lineSpacing)}
              decrementLabel={t("settings.reading.decreaseLineSpacing")}
              incrementLabel={t("settings.reading.increaseLineSpacing")}
              disableDecrement={lineSpacing <= LINE_SPACING_MIN}
              disableIncrement={lineSpacing >= LINE_SPACING_MAX}
              onDecrement={() => {
                const next = Math.max(
                  LINE_SPACING_MIN,
                  Math.round((lineSpacing - LINE_SPACING_STEP) * 100) / 100,
                );
                setLineSpacing(next);
                void save("line_spacing", String(next));
              }}
              onIncrement={() => {
                const next = Math.min(
                  LINE_SPACING_MAX,
                  Math.round((lineSpacing + LINE_SPACING_STEP) * 100) / 100,
                );
                setLineSpacing(next);
                void save("line_spacing", String(next));
              }}
            />
          </SettingsRow>

          {/* Character spacing */}
          <SettingsRow title={t("settings.layout.charSpacing")}>
            <Stepper
              valueLabel={charSpacing === 0 ? "0" : `${charSpacing}%`}
              decrementLabel={t("settings.reading.decreaseCharSpacing")}
              incrementLabel={t("settings.reading.increaseCharSpacing")}
              disableDecrement={charSpacing <= CHAR_SPACING_MIN}
              disableIncrement={charSpacing >= CHAR_SPACING_MAX}
              onDecrement={() => {
                const next = Math.max(CHAR_SPACING_MIN, charSpacing - 1);
                setCharSpacing(next);
                void save("char_spacing", String(next));
              }}
              onIncrement={() => {
                const next = Math.min(CHAR_SPACING_MAX, charSpacing + 1);
                setCharSpacing(next);
                void save("char_spacing", String(next));
              }}
            />
          </SettingsRow>

          {/* Word spacing */}
          <SettingsRow title={t("settings.layout.wordSpacing")}>
            <Stepper
              valueLabel={wordSpacing === 0 ? "0" : `${wordSpacing}%`}
              decrementLabel={t("settings.reading.decreaseWordSpacing")}
              incrementLabel={t("settings.reading.increaseWordSpacing")}
              disableDecrement={wordSpacing <= WORD_SPACING_MIN}
              disableIncrement={wordSpacing >= WORD_SPACING_MAX}
              onDecrement={() => {
                const next = Math.max(WORD_SPACING_MIN, wordSpacing - 1);
                setWordSpacing(next);
                void save("word_spacing", String(next));
              }}
              onIncrement={() => {
                const next = Math.min(WORD_SPACING_MAX, wordSpacing + 1);
                setWordSpacing(next);
                void save("word_spacing", String(next));
              }}
            />
          </SettingsRow>

          {/* Margins */}
          <SettingsRow title={t("settings.layout.margins")}>
            <SegmentedControl<MarginPresetId>
              value={marginPreset}
              onChange={(presetId) => {
                const preset = MARGIN_PRESETS.find((item) => item.id === presetId);
                if (!preset) return;
                setMargins(preset.value);
                void save("margins", String(preset.value));
              }}
              options={[
                { value: "narrow", label: t("settings.reading.marginsNarrow") },
                { value: "normal", label: t("settings.reading.marginsNormal") },
                { value: "wide", label: t("settings.reading.marginsWide") },
              ]}
            />
          </SettingsRow>
        </SettingsGroup>
      </section>

      <section className="flex flex-col gap-2.5">
        <SettingsOverline>{t("settings.reading.progressGroup")}</SettingsOverline>
        <SettingsGroup>
          <SettingsRow
            title={t("settings.reading.autoSave")}
            hint={t("settings.reading.autoSaveHint")}
          >
            <Switch
              aria-label={t("settings.reading.autoSave")}
              checked={autoSave}
              onChange={(v) => {
                setAutoSave(v);
                void save("auto_save", String(v));
              }}
            />
          </SettingsRow>
        </SettingsGroup>
      </section>
    </div>
  );
}
