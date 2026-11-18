import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Check } from "lucide-react";
import Stepper from "../ui/Stepper";
import { SettingsGroup, SettingsOverline, SettingsRow } from "../ui/SettingsRow";
import { applyAppZoom } from "../../lib/appZoom";
import {
  readAppZoom,
  STORAGE_APP_ZOOM,
  ZOOM_STEPS,
} from "../../lib/settings";
import {
  getThemeSelectionState,
  selectAndSaveAppTheme,
  subscribeThemeSelection,
  type AppTheme,
} from "../../lib/theme";
import type { SettingsProps } from "./types";

export default function AppearanceSettings({ save }: Partial<SettingsProps> = {}) {
  const { t } = useTranslation();
  const [zoom, setZoom] = useState(readAppZoom);
  const [selectionState, setSelectionState] = useState(() => getThemeSelectionState());

  useEffect(() => {
    setSelectionState(getThemeSelectionState());
    return subscribeThemeSelection(() => {
      setSelectionState(getThemeSelectionState());
    });
  }, []);

  useEffect(() => {
    const handleStorage = (event: StorageEvent) => {
      if (event.key === STORAGE_APP_ZOOM) setZoom(readAppZoom());
    };
    window.addEventListener("storage", handleStorage);
    return () => window.removeEventListener("storage", handleStorage);
  }, []);

  const zoomIndex = ZOOM_STEPS.indexOf(zoom);
  const canZoomOut = zoomIndex > 0;
  const canZoomIn = zoomIndex !== -1 && zoomIndex < ZOOM_STEPS.length - 1;

  const cards: Array<{ id: AppTheme; label: string }> = [
    { id: "system", label: t("settings.appearance.system") },
    { id: "light", label: t("settings.appearance.light") },
    { id: "dark", label: t("settings.appearance.dark") },
  ];

  const handleSelectTheme = (next: AppTheme) => {
    void selectAndSaveAppTheme(next, save);
  };

  return (
    <div className="flex flex-col gap-7">
      <section className="flex flex-col gap-2.5">
        <SettingsOverline>{t("settings.appearance.themeGroup")}</SettingsOverline>

        <div className="grid grid-cols-3 gap-4">
          {cards.map((card) => {
            const active = card.id === selectionState.activeTheme;
            return (
              <button
                key={card.id}
                type="button"
                aria-pressed={active}
                data-theme-card={card.id}
                onClick={() => handleSelectTheme(card.id)}
                className={`rounded-[14px] p-2 flex flex-col gap-2.5 bg-surface-inset text-left transition-colors ${
                  active
                    ? "border-2 border-accent cursor-default"
                    : "border border-border-subtle hover:border-border-default cursor-pointer"
                }`}
              >
                {/* Miniature window preview */}
                <div
                  className="h-[116px] w-full rounded-[8px] relative overflow-hidden border border-border-subtle"
                  style={
                    card.id === "dark"
                      ? {
                          background:
                            "linear-gradient(135deg, var(--color-preview-night-start) 0%, var(--color-preview-night-end) 100%)",
                        }
                      : {
                          background:
                            "radial-gradient(circle at 90% 10%, var(--color-bg-glow-peach, transparent), transparent 60%), linear-gradient(135deg, var(--color-bg-start) 0%, var(--color-bg-end) 100%)",
                        }
                  }
                >
                  {card.id === "system" && (
                    <div
                      className="absolute right-0 top-0 bottom-0 w-1/2"
                      style={{
                        background:
                          "linear-gradient(135deg, var(--color-preview-night-start) 0%, var(--color-preview-night-end) 100%)",
                      }}
                    />
                  )}

                  {/* Top nav pill */}
                  <div
                    className={`absolute top-2.5 left-1/2 -translate-x-1/2 w-[76px] h-3 rounded-full ${
                      card.id === "dark" ? "bg-preview-night-surface" : "bg-preview-pill-light"
                    }`}
                  />

                  {/* Bento tiles */}
                  <div className="absolute inset-x-3.5 bottom-3.5 top-8 flex gap-2.5">
                    <div
                      className={`flex-1 rounded-[8px] relative ${
                        card.id === "dark" ? "bg-preview-night-surface" : "bg-preview-tile-light"
                      }`}
                    >
                      <div
                        className={`absolute left-2.5 bottom-2.5 w-10 h-2.5 rounded-full ${
                          card.id === "dark" ? "bg-preview-night-accent" : "bg-accent"
                        }`}
                      />
                    </div>
                    <div
                      className={`w-[38%] rounded-[8px] ${
                        card.id === "dark" || card.id === "system"
                          ? "bg-preview-night-surface"
                          : "bg-preview-tile-light"
                      }`}
                    />
                  </div>
                </div>

                <div className="px-1 pb-0.5 flex items-center justify-between">
                  <span
                    className={`text-[13.5px] text-text-primary ${
                      active ? "font-semibold" : "font-medium"
                    }`}
                  >
                    {card.label}
                  </span>
                  {active && (
                    <span className="size-[18px] rounded-full bg-accent flex items-center justify-center text-text-on-accent shrink-0">
                      <Check size={11} strokeWidth={2.5} />
                    </span>
                  )}
                </div>
              </button>
            );
          })}
        </div>

        <p className="text-[12.5px] text-text-tertiary leading-[1.45]">
          {t("settings.appearance.themeNote")}
        </p>

        {selectionState.saveError && (
          <p role="alert" className="text-[12.5px] text-danger leading-[1.4]">
            {t("settings.appearance.saveError")}
          </p>
        )}
      </section>

      <section className="flex flex-col gap-2.5">
        <SettingsOverline>{t("settings.appearance.scaleGroup")}</SettingsOverline>
        <SettingsGroup>
          <SettingsRow
            title={t("settings.appearance.zoom")}
            hint={t("settings.appearance.zoomHint")}
          >
            <Stepper
              valueLabel={t("settings.appearance.zoomLevel", { percent: Math.round(zoom * 100) })}
              decrementLabel={t("settings.appearance.zoomOut")}
              incrementLabel={t("settings.appearance.zoomIn")}
              disableDecrement={!canZoomOut}
              disableIncrement={!canZoomIn}
              onDecrement={() => {
                if (!canZoomOut) return;
                const next = ZOOM_STEPS[zoomIndex - 1];
                setZoom(next);
                applyAppZoom(next);
              }}
              onIncrement={() => {
                if (!canZoomIn) return;
                const next = ZOOM_STEPS[zoomIndex + 1];
                setZoom(next);
                applyAppZoom(next);
              }}
            />
          </SettingsRow>
        </SettingsGroup>
      </section>
    </div>
  );
}
