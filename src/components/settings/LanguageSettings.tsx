import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import i18n from "../../i18n";
import Select from "../ui/Select";
import type { SettingsProps } from "./types";

export default function LanguageSettings({ settings, loading, save, showSavedToast }: SettingsProps) {
  const { t } = useTranslation();
  const [language, setLanguage] = useState("en");
  const [nativeLanguage, setNativeLanguage] = useState("en");

  useEffect(() => {
    if (loading) return;
    if (settings.language) setLanguage(settings.language);
    if (settings.native_language) setNativeLanguage(settings.native_language);
  }, [settings, loading]);

  return (
    <div>
      {/* System Language */}
      <div className="flex items-center justify-between h-[73px]">
        <div>
          <p className="text-[14px] font-medium text-text-primary tracking-[-0.15px]">
            {t("settings.language")}
          </p>
          <p className="text-[12px] text-text-muted mt-0.5">
            {t("settings.general.languageHint")}
          </p>
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
          options={[
            { value: "en", label: "English" },
            { value: "zh", label: "简体中文" },
          ]}
        />
      </div>
      <div className="h-px bg-black/10" />

      {/* Native Language */}
      <div className="flex items-center justify-between h-[73px]">
        <div>
          <p className="text-[14px] font-medium text-text-primary tracking-[-0.15px]">
            {t("settings.lookup.nativeLanguage")}
          </p>
          <p className="text-[12px] text-text-muted mt-0.5">
            {t("settings.lookup.nativeLanguageHint")}
          </p>
        </div>
        <Select
          className="w-[130px] shrink-0"
          value={nativeLanguage}
          onChange={(lang) => {
            setNativeLanguage(lang);
            save("native_language", lang);
            showSavedToast();
          }}
          options={[
            { value: "en", label: "English" },
            { value: "zh", label: "简体中文" },
            { value: "ja", label: "日本語" },
            { value: "ko", label: "한국어" },
            { value: "es", label: "Español" },
            { value: "fr", label: "Français" },
            { value: "de", label: "Deutsch" },
          ]}
        />
      </div>
    </div>
  );
}
