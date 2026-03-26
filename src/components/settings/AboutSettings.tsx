import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { getVersion } from "@tauri-apps/api/app";

export default function AboutSettings() {
  const { t } = useTranslation();
  const [version, setVersion] = useState("");

  useEffect(() => {
    getVersion().then(setVersion).catch(() => setVersion("unknown"));
  }, []);

  return (
    <div className="space-y-0">
      {/* Version */}
      <div className="py-3 border-b border-border">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-[14px] font-medium text-text-primary">Quill</p>
            <p className="text-[12px] text-text-muted mt-0.5">{t("settings.about.description")}</p>
          </div>
          <span className="text-[13px] text-text-muted tabular-nums">v{version}</span>
        </div>
      </div>
    </div>
  );
}
