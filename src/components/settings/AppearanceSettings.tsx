import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import Select from "../ui/Select";
import type { SettingsProps } from "./types";

export default function AppearanceSettings({ settings, loading, save, showSavedToast }: SettingsProps) {
  const { t } = useTranslation();
  const [theme, setTheme] = useState("system");

  useEffect(() => {
    if (loading) return;
    if (settings.theme) setTheme(settings.theme);
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
            localStorage.setItem("quill-theme", value);
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
    </div>
  );
}
