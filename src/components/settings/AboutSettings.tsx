import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { getVersion } from "@tauri-apps/api/app";
import { Loader2 } from "lucide-react";
import { useUpdate } from "../../contexts/UpdateContext";
import Button from "../ui/Button";
import Toggle from "../ui/Toggle";
import type { SettingsProps } from "./types";

export default function AboutSettings({ settings, loading, save, showSavedToast }: SettingsProps) {
  const { t } = useTranslation();
  const [version, setVersion] = useState("");
  const { status, update, progress, error, checkForUpdate, downloadAndInstall, restart } =
    useUpdate();
  const [autoCheck, setAutoCheck] = useState(true);

  useEffect(() => {
    getVersion().then(setVersion).catch(() => setVersion("unknown"));
  }, []);

  useEffect(() => {
    if (loading) return;
    if (settings.auto_check_updates !== undefined) {
      setAutoCheck(settings.auto_check_updates !== "false");
    }
  }, [settings, loading]);

  const renderStatusText = () => {
    switch (status) {
      case "checking":
        return (
          <p className="text-[12px] text-text-muted mt-0.5">
            {t("settings.about.checking")}
          </p>
        );
      case "available":
        return (
          <p className="text-[12px] text-accent-text mt-0.5">
            {t("settings.about.updateAvailable", { version: `v${update?.version}` })}
          </p>
        );
      case "downloading":
        return (
          <p className="text-[12px] text-text-muted mt-0.5">
            {t("settings.about.downloading")} {progress}%
          </p>
        );
      case "ready":
        return (
          <p className="text-[12px] text-success-text mt-0.5">
            {t("settings.about.readyToInstall")}
          </p>
        );
      case "error":
        return (
          <p className="text-[12px] text-text-muted mt-0.5">
            {error || t("settings.about.updateError")}
          </p>
        );
      default:
        return (
          <p className="text-[12px] text-text-muted mt-0.5">
            {t("settings.about.upToDate")}
          </p>
        );
    }
  };

  const renderStatusAction = () => {
    switch (status) {
      case "checking":
        return <Loader2 size={16} className="text-text-muted animate-spin shrink-0" />;
      case "available":
        return (
          <Button variant="primary" size="sm" onClick={downloadAndInstall}>
            {t("settings.about.downloadInstall")}
          </Button>
        );
      case "downloading":
        return null;
      case "ready":
        return (
          <Button variant="primary" size="sm" onClick={restart}>
            {t("settings.about.restartToUpdate")}
          </Button>
        );
      case "error":
        return (
          <Button variant="secondary" size="sm" onClick={checkForUpdate}>
            {t("settings.about.retry")}
          </Button>
        );
      default:
        return (
          <Button variant="secondary" size="sm" onClick={checkForUpdate}>
            {t("settings.about.checkNow")}
          </Button>
        );
    }
  };

  return (
    <div>
      {/* App identity */}
      <div className="flex items-center justify-between h-[73px]">
        <div>
          <p className="text-[14px] font-medium text-text-primary tracking-[-0.15px]">Quill</p>
          <p className="text-[12px] text-text-muted mt-0.5">{t("settings.about.description")}</p>
        </div>
        <span className="bg-bg-page dark:bg-bg-input text-text-secondary text-[12px] font-mono px-2 py-0.5 rounded-lg">
          v{version}
        </span>
      </div>
      <div className="h-px bg-black/10" />

      {/* Software update */}
      <div className="flex items-center justify-between min-h-[57px] py-2">
        <div>
          <p className="text-[14px] font-medium text-text-primary tracking-[-0.15px]">
            {t("settings.about.softwareUpdate")}
          </p>
          {renderStatusText()}
        </div>
        <div className="shrink-0 ml-4">{renderStatusAction()}</div>
      </div>

      {/* Download progress bar */}
      {status === "downloading" && (
        <div className="h-[3px] bg-bg-input rounded-full mb-2 overflow-hidden">
          <div
            className="h-full bg-accent rounded-full transition-all duration-300 ease-out"
            style={{ width: `${progress}%` }}
          />
        </div>
      )}
      <div className="h-px bg-black/10" />

      {/* Auto-check toggle */}
      <div className="flex items-center justify-between h-[73px]">
        <div>
          <p className="text-[14px] font-medium text-text-primary tracking-[-0.15px]">
            {t("settings.about.autoCheck")}
          </p>
          <p className="text-[12px] text-text-muted mt-0.5">
            {t("settings.about.autoCheckHint")}
          </p>
        </div>
        <Toggle
          checked={autoCheck}
          onChange={(v) => {
            setAutoCheck(v);
            save("auto_check_updates", String(v));
            showSavedToast();
          }}
        />
      </div>
    </div>
  );
}
