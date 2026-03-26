import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import i18n from "../../i18n";
import Select from "../ui/Select";
import Toggle from "../ui/Toggle";
import type { SettingsProps } from "./types";

export default function GeneralSettings({ settings, loading, save, showSavedToast }: SettingsProps) {
  const { t } = useTranslation();
  const [displayName, setDisplayName] = useState("Reader");
  const [language, setLanguage] = useState("en");
  const [theme, setTheme] = useState("system");
  const [autoSave, setAutoSave] = useState(true);

  useEffect(() => {
    if (loading) return;
    if (settings.user_name) setDisplayName(settings.user_name);
    if (settings.language) setLanguage(settings.language);
    if (settings.theme) setTheme(settings.theme);
    if (settings.auto_save) setAutoSave(settings.auto_save === "true");
  }, [settings, loading]);

  const applyTheme = (value: string) => {
    const root = document.documentElement;
    if (value === "dark") root.classList.add("dark");
    else if (value === "light") root.classList.remove("dark");
    else {
      const dark = window.matchMedia("(prefers-color-scheme: dark)").matches;
      root.classList.toggle("dark", dark);
    }
  };

  return (
    <div>
      {/* Display Name */}
      <div className="flex items-center justify-between h-[73px]">
        <div>
          <p className="text-[14px] font-medium text-text-primary tracking-[-0.15px]">{t("settings.general.displayName")}</p>
          <p className="text-[12px] text-text-muted mt-0.5">{t("settings.general.displayNameHint")}</p>
        </div>
        <input
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          onBlur={() => { save("user_name", displayName); showSavedToast(); }}
          onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
          placeholder="Reader"
          className="w-[120px] shrink-0 h-8 bg-white dark:bg-bg-surface rounded-[10px] px-3 text-[13px] font-medium text-text-secondary text-center outline-none border border-border focus:border-accent transition-colors"
        />
      </div>
      <div className="h-px bg-black/10" />

      {/* Language */}
      <div className="flex items-center justify-between h-[73px]">
        <div>
          <p className="text-[14px] font-medium text-text-primary tracking-[-0.15px]">{t("settings.language")}</p>
          <p className="text-[12px] text-text-muted mt-0.5">{t("settings.general.languageHint")}</p>
        </div>
        <Select
          className="w-[130px] shrink-0"
          value={language}
          onChange={(lang) => {
            setLanguage(lang);
            save("language", lang);
            i18n.changeLanguage(lang);
            showSavedToast();
          }}
          options={[
            { value: "en", label: "English" },
            { value: "zh", label: "简体中文" },
          ]}
        />
      </div>
      <div className="h-px bg-black/10" />

      {/* Theme */}
      <div className="flex items-center justify-between h-[73px]">
        <div>
          <p className="text-[14px] font-medium text-text-primary tracking-[-0.15px]">{t("settings.appearance.theme")}</p>
          <p className="text-[12px] text-text-muted mt-0.5">{t("settings.general.themeHint")}</p>
        </div>
        <Select
          className="w-[130px] shrink-0"
          value={theme}
          onChange={(value) => {
            setTheme(value);
            save("theme", value);
            applyTheme(value);
            showSavedToast();
          }}
          options={[
            { value: "system", label: t("settings.appearance.system") },
            { value: "light", label: t("settings.appearance.light") },
            { value: "dark", label: t("settings.appearance.dark") },
          ]}
        />
      </div>
      <div className="h-px bg-black/10" />

      {/* Auto Save */}
      <div className="flex items-center justify-between h-[73px]">
        <div>
          <p className="text-[14px] font-medium text-text-primary tracking-[-0.15px]">{t("settings.reading.autoSave")}</p>
          <p className="text-[12px] text-text-muted mt-0.5">{t("settings.reading.autoSaveHint")}</p>
        </div>
        <Toggle
          checked={autoSave}
          onChange={(v) => {
            setAutoSave(v);
            save("auto_save", String(v));
            showSavedToast();
          }}
        />
      </div>
    </div>
  );
}
