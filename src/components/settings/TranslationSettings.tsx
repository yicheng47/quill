import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import Select from "../ui/Select";
import type { SettingsProps } from "./types";
import { LANGUAGE_OPTIONS } from "./languageOptions";

export default function TranslationSettings({ settings, loading, save, showSavedToast }: SettingsProps) {
  const { t } = useTranslation();
  const [translationLanguage, setTranslationLanguage] = useState("");

  useEffect(() => {
    if (loading) return;
    setTranslationLanguage(settings.translation_language || "");
  }, [settings, loading]);

  return (
    <div>
      {/* Translation Language */}
      <div className="flex items-center justify-between h-[73px]">
        <div>
          <p className="text-[14px] font-medium text-text-primary tracking-[-0.15px]">
            {t("settings.translation.language")}
          </p>
          <p className="text-[12px] text-text-muted mt-0.5">
            {t("settings.translation.languageHint")}
          </p>
        </div>
        <Select
          className="w-[130px] shrink-0"
          value={translationLanguage}
          placeholder={t("settings.languageUnset")}
          onChange={(lang) => {
            setTranslationLanguage(lang);
            save("translation_language", lang);
            showSavedToast();
          }}
          options={LANGUAGE_OPTIONS}
        />
      </div>
    </div>
  );
}
