import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Minus, Plus } from "lucide-react";
import Select from "../ui/Select";
import type { SettingsProps } from "./types";
import { applyAppZoom } from "../../lib/appZoom";
import {
  readAppZoom,
  STORAGE_APP_ZOOM,
  ZOOM_STEPS,
} from "../../lib/settings";

export default function AppearanceSettings({ settings, loading, save, showSavedToast }: SettingsProps) {
  const { t } = useTranslation();
  const [theme, setTheme] = useState("system");
  const [zoom, setZoom] = useState(readAppZoom);

  useEffect(() => {
    if (loading) return;
    if (settings.theme) setTheme(settings.theme);
  }, [settings, loading]);

  useEffect(() => {
    const handleStorage = (event: StorageEvent) => {
      if (event.key === STORAGE_APP_ZOOM) setZoom(readAppZoom());
    };
    window.addEventListener("storage", handleStorage);
    return () => window.removeEventListener("storage", handleStorage);
  }, []);

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

      <div className="flex items-center justify-between h-[73px]">
        <div>
          <p className="text-[14px] font-medium text-text-primary tracking-[-0.15px]">{t("settings.appearance.zoom")}</p>
          <p className="text-[12px] text-text-muted mt-0.5">{t("settings.appearance.zoomHint")}</p>
        </div>
        <div className="flex items-center h-8 shrink-0 rounded-[10px] border border-border bg-white dark:bg-bg-surface overflow-hidden">
          <button
            type="button"
            aria-label={t("settings.appearance.zoomOut")}
            disabled={zoom === ZOOM_STEPS[0]}
            onClick={() => {
              const next = ZOOM_STEPS[Math.max(0, ZOOM_STEPS.indexOf(zoom) - 1)];
              applyAppZoom(next);
              showSavedToast();
            }}
            className="size-8 flex items-center justify-center text-text-secondary hover:bg-bg-input cursor-pointer disabled:opacity-40 disabled:cursor-default disabled:hover:bg-transparent"
          >
            <Minus size={14} />
          </button>
          <span className="w-[58px] self-stretch flex items-center justify-center text-[13px] font-medium text-text-secondary tabular-nums border-x border-border">
            {t("settings.appearance.zoomLevel", { percent: Math.round(zoom * 100) })}
          </span>
          <button
            type="button"
            aria-label={t("settings.appearance.zoomIn")}
            disabled={zoom === ZOOM_STEPS[ZOOM_STEPS.length - 1]}
            onClick={() => {
              const next = ZOOM_STEPS[Math.min(ZOOM_STEPS.length - 1, ZOOM_STEPS.indexOf(zoom) + 1)];
              applyAppZoom(next);
              showSavedToast();
            }}
            className="size-8 flex items-center justify-center text-text-secondary hover:bg-bg-input cursor-pointer disabled:opacity-40 disabled:cursor-default disabled:hover:bg-transparent"
          >
            <Plus size={14} />
          </button>
        </div>
      </div>
    </div>
  );
}
