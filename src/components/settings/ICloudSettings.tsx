import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import Button from "../ui/Button";
import Toggle from "../ui/Toggle";
import type { SettingsProps } from "./types";

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export default function ICloudSettings(_props: SettingsProps) {
  const { t } = useTranslation();

  const [icloudAvailable, setIcloudAvailable] = useState(false);
  const [icloudEnabled, setIcloudEnabled] = useState(false);
  const [icloudHasExistingData, setIcloudHasExistingData] = useState(false);
  const [icloudLoading, setIcloudLoading] = useState(false);
  const [icloudError, setIcloudError] = useState<string | null>(null);
  const [icloudConfirm, setIcloudConfirm] = useState<"enable" | "disable" | null>(null);

  useEffect(() => {
    invoke<{ available: boolean; enabled: boolean; has_existing_data: boolean }>("icloud_status")
      .then((status) => {
        setIcloudAvailable(status.available);
        setIcloudEnabled(status.enabled);
        setIcloudHasExistingData(status.has_existing_data);
      })
      .catch(() => {});
  }, []);

  const handleIcloudToggle = () => {
    setIcloudConfirm(icloudEnabled ? "disable" : "enable");
  };

  const confirmIcloudToggle = async () => {
    const action = icloudConfirm;
    setIcloudConfirm(null);
    setIcloudLoading(true);
    setIcloudError(null);
    try {
      const minDelay = new Promise((r) => setTimeout(r, 1500));
      if (action === "disable") {
        await Promise.all([invoke("icloud_disable"), minDelay]);
        setIcloudEnabled(false);
      } else {
        await Promise.all([invoke("icloud_enable"), minDelay]);
        setIcloudEnabled(true);
      }
    } catch (err) {
      setIcloudError(err instanceof Error ? err.message : String(err));
    } finally {
      setIcloudLoading(false);
    }
  };

  return (
    <>
      <div>
        {/* Enable / Disable Toggle */}
        <div className="flex items-center justify-between h-[73px]">
          {icloudLoading ? (
            <div className="flex items-center gap-2">
              <Loader2 size={16} className="text-text-muted animate-spin" />
              <p className="text-[13px] text-text-muted">{t("settings.icloud.moving")}</p>
            </div>
          ) : (
            <>
              <div>
                <p className="text-[14px] font-medium text-text-primary tracking-[-0.15px]">
                  {t("settings.icloud.enable")}
                </p>
                <p className="text-[12px] text-text-muted mt-0.5">
                  {!icloudAvailable
                    ? t("settings.icloud.signIn")
                    : t("settings.icloud.enableSub")}
                </p>
              </div>
              <Toggle
                checked={icloudEnabled}
                onChange={handleIcloudToggle}
                disabled={!icloudAvailable}
              />
            </>
          )}
        </div>

        {/* Note */}
        <p className="text-[12px] text-text-muted leading-[1.5] mt-1">
          {t("settings.icloud.keysNote")}
        </p>

        {/* Error */}
        {icloudError && (
          <div className="flex items-center justify-between bg-[#fef2f2] dark:bg-red-950/30 border border-[#ffc9c9] dark:border-red-800 rounded-lg px-3.5 py-2 mt-3">
            <span className="text-[12px] text-[#e7000b] dark:text-red-400">
              {t("settings.icloud.error")}
            </span>
            <button
              type="button"
              className="text-[12px] font-medium text-[#e7000b] dark:text-red-400 underline cursor-pointer"
              onClick={handleIcloudToggle}
            >
              {t("settings.ai.retry")}
            </button>
          </div>
        )}
      </div>

      {/* Confirmation dialog */}
      {icloudConfirm && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40">
          <div className="bg-bg-surface rounded-xl shadow-lg w-[400px] p-6">
            <h3 className="text-[18px] font-semibold text-text-primary mb-2">
              {icloudConfirm === "enable"
                ? icloudHasExistingData
                  ? t("settings.icloud.confirmEnableExisting")
                  : t("settings.icloud.confirmEnable")
                : t("settings.icloud.confirmDisable")}
            </h3>
            <p className="text-[14px] text-text-secondary leading-5 mb-6">
              {icloudConfirm === "enable"
                ? icloudHasExistingData
                  ? t("settings.icloud.confirmEnableExistingMsg")
                  : t("settings.icloud.confirmEnableMsg")
                : t("settings.icloud.confirmDisableMsg")}
            </p>
            <div className="flex justify-end gap-3">
              <Button variant="ghost" size="md" onClick={() => setIcloudConfirm(null)}>
                {t("common.cancel")}
              </Button>
              <Button variant="primary" size="md" onClick={confirmIcloudToggle}>
                {icloudConfirm === "enable"
                  ? icloudHasExistingData ? t("settings.icloud.syncWithIcloud") : t("settings.icloud.moveToIcloud")
                  : t("settings.icloud.moveToLocal")}
              </Button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
