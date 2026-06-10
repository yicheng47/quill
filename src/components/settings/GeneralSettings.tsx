import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import i18n from "../../i18n";
import Select from "../ui/Select";
import Toggle from "../ui/Toggle";
import type { SettingsProps } from "./types";
import { LANGUAGE_OPTIONS } from "./languageOptions";

export default function GeneralSettings({ settings, loading, save, showSavedToast }: SettingsProps) {
  const { t } = useTranslation();
  const [displayName, setDisplayName] = useState("Reader");
  const [language, setLanguage] = useState("en");
  const [autoSave, setAutoSave] = useState(true);
  const [autoCheckUpdates, setAutoCheckUpdates] = useState(true);

  useEffect(() => {
    if (loading) return;
    if (settings.user_name) setDisplayName(settings.user_name);
    if (settings.language) setLanguage(settings.language);
    if (settings.auto_save) setAutoSave(settings.auto_save === "true");
    if (settings.auto_check_updates !== undefined) {
      setAutoCheckUpdates(settings.auto_check_updates !== "false");
    }
  }, [settings, loading]);

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

      {/* Interface Language */}
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
            localStorage.setItem("quill-language", lang);
            i18n.changeLanguage(lang);
            showSavedToast();
          }}
          options={LANGUAGE_OPTIONS}
        />
      </div>

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

      {/* Updates */}
      <div className="mt-8 mb-2 text-[11px] font-medium uppercase tracking-[0.5px] text-text-muted">
        {t("settings.updates.title")}
      </div>
      <div className="h-px bg-border-light" />
      <div className="flex items-center justify-between h-[73px]">
        <div>
          <p className="text-[14px] font-medium text-text-primary tracking-[-0.15px]">{t("settings.updates.autoCheck")}</p>
          <p className="text-[12px] text-text-muted mt-0.5">{t("settings.updates.autoCheckHint")}</p>
        </div>
        <Toggle
          checked={autoCheckUpdates}
          onChange={(v) => {
            setAutoCheckUpdates(v);
            save("auto_check_updates", String(v));
            showSavedToast();
          }}
        />
      </div>

      {/* Diagnostics — log triage entry point. Mirrors the Help menu's
          "Reveal Logs" item so the discoverability path doesn't depend
          on the user knowing about the menu. */}
      <div className="mt-8 mb-2 text-[11px] font-medium uppercase tracking-[0.5px] text-text-muted">
        {t("settings.diagnostics.title")}
      </div>
      <div className="h-px bg-border-light" />
      <div className="flex items-center justify-between h-[73px]">
        <div>
          <p className="text-[14px] font-medium text-text-primary tracking-[-0.15px]">{t("settings.diagnostics.revealLogs")}</p>
          <p className="text-[12px] text-text-muted mt-0.5">{t("settings.diagnostics.revealLogsHint")}</p>
        </div>
        <button
          type="button"
          onClick={() => {
            invoke("reveal_logs").catch(() => {});
          }}
          className="h-8 px-3 bg-white dark:bg-bg-surface rounded-[10px] text-[13px] font-medium text-text-secondary border border-border hover:border-accent transition-colors"
        >
          {t("settings.diagnostics.revealLogsButton")}
        </button>
      </div>
    </div>
  );
}
