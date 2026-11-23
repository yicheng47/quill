import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Languages } from "lucide-react";
import Select from "../ui/Select";
import Switch from "../ui/Switch";
import { SettingsGroup, SettingsOverline, SettingsRow } from "../ui/SettingsRow";
import type { SettingsProps } from "./types";
import { LANGUAGE_OPTIONS } from "./languageOptions";

export default function ToolsSettings({ settings, loading, save, saveBulk }: SettingsProps) {
  const { t } = useTranslation();
  const [lookupLanguage, setLookupLanguage] = useState("selection");
  const [showTranslation, setShowTranslation] = useState(false);
  const [lookupTranslationLanguage, setLookupTranslationLanguage] = useState("");
  const [translationLanguage, setTranslationLanguage] = useState("");

  useEffect(() => {
    if (loading) return;
    setLookupLanguage(settings.lookup_language || "selection");
    setLookupTranslationLanguage(
      settings.lookup_translation_language || settings.language || "en",
    );
    setShowTranslation(settings.show_translation === "true");
    setTranslationLanguage(settings.translation_language || settings.language || "en");
  }, [settings, loading]);

  if (loading) return null;

  const lookupLanguageOptions = [
    { value: "selection", label: t("settings.tools.sameAsSelection") },
    ...LANGUAGE_OPTIONS,
  ];

  return (
    <div className="flex flex-col gap-7">
      {/* LOOK UP & EXPLAIN */}
      <section className="flex flex-col gap-2.5">
        <SettingsOverline>{t("settings.tools.lookupExplainGroup")}</SettingsOverline>
        <SettingsGroup>
          <SettingsRow
            title={t("settings.tools.responseLanguage")}
            hint={t("settings.tools.responseLanguageHint")}
          >
            <Select
              className="w-[175px] shrink-0"
              icon={<Languages size={14} />}
              value={lookupLanguage}
              onChange={(lang) => {
                setLookupLanguage(lang);
                void saveBulk({ lookup_language: lang, explain_language: "lookup" });
              }}
              options={lookupLanguageOptions}
            />
          </SettingsRow>

          <SettingsRow
            title={t("settings.tools.briefTranslation")}
            hint={t("settings.tools.briefTranslationHint")}
          >
            <Switch
              aria-label={t("settings.tools.briefTranslation")}
              checked={showTranslation}
              onChange={(checked) => {
                setShowTranslation(checked);
                void save("show_translation", String(checked));
              }}
            />
          </SettingsRow>

          <SettingsRow title={t("settings.tools.glossTarget")}>
            <Select
              className="w-[150px] shrink-0"
              value={lookupTranslationLanguage}
              placeholder={t("settings.languageUnset")}
              onChange={(lang) => {
                setLookupTranslationLanguage(lang);
                void save("lookup_translation_language", lang);
              }}
              options={LANGUAGE_OPTIONS}
            />
          </SettingsRow>
        </SettingsGroup>
      </section>

      {/* TRANSLATE */}
      <section className="flex flex-col gap-2.5">
        <SettingsOverline>{t("settings.tools.translateGroup")}</SettingsOverline>
        <SettingsGroup>
          <SettingsRow
            title={t("settings.tools.translateTo")}
            hint={t("settings.tools.translateToHint")}
          >
            <Select
              className="w-[150px] shrink-0"
              value={translationLanguage}
              placeholder={t("settings.languageUnset")}
              onChange={(lang) => {
                setTranslationLanguage(lang);
                void save("translation_language", lang);
              }}
              options={LANGUAGE_OPTIONS}
            />
          </SettingsRow>
        </SettingsGroup>
      </section>
    </div>
  );
}
