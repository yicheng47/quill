import { useState, useEffect, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronRight, Sparkles, X } from "lucide-react";
import Toggle from "../ui/Toggle";
import Select from "../ui/Select";
import type { SettingsProps } from "./types";
import { LANGUAGE_OPTIONS } from "./languageOptions";

const SAMPLE_TRANSLATIONS: Record<string, string> = {
  en: "interfaces",
  zh: "界面；接口",
};

type ToolSection = "lookup" | "explain" | "translate";

function AccordionHeader({
  title,
  subtitle,
  open,
  onClick,
}: {
  title: string;
  subtitle: string;
  open: boolean;
  onClick: () => void;
}) {
  const Icon = open ? ChevronDown : ChevronRight;

  return (
    <button
      type="button"
      onClick={onClick}
      aria-expanded={open}
      className="w-full min-h-[55px] flex items-center justify-between gap-3 pt-3.5 pb-2.5 text-left cursor-pointer"
    >
      <div className="min-w-0 flex-1">
        <p className="text-[12px] font-semibold text-text-muted uppercase tracking-[0.3px]">
          {title}
        </p>
        <p className="text-[12px] text-text-placeholder leading-[18px] truncate">
          {subtitle}
        </p>
      </div>
      <Icon size={16} className="shrink-0 text-text-placeholder" />
    </button>
  );
}

function SettingsRow({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children: ReactNode;
}) {
  return (
    <div className="w-full flex items-center justify-between gap-4 min-h-[50px] px-1 py-1.5">
      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-medium text-text-primary tracking-[-0.15px]">
          {title}
        </p>
        <p className="text-[11px] text-text-placeholder leading-[17px] truncate">
          {subtitle}
        </p>
      </div>
      {children}
    </div>
  );
}

function AccordionBody({ open, children }: { open: boolean; children: ReactNode }) {
  return (
    <div
      aria-hidden={!open}
      className={`grid transition-[grid-template-rows,opacity,visibility] duration-200 ease-out ${
        open ? "grid-rows-[1fr] opacity-100 visible" : "grid-rows-[0fr] opacity-0 invisible"
      } w-full min-w-0`}
    >
      <div className="w-full min-w-0 overflow-hidden">
        {children}
      </div>
    </div>
  );
}

export default function ToolsSettings({ settings, loading, save, showSavedToast }: SettingsProps) {
  const { t } = useTranslation();
  const [lookupLanguage, setLookupLanguage] = useState("en");
  const [showTranslation, setShowTranslation] = useState(false);
  const [lookupTranslationLanguage, setLookupTranslationLanguage] = useState("");
  const [explainLanguage, setExplainLanguage] = useState("lookup");
  const [translationLanguage, setTranslationLanguage] = useState("");
  const [openSections, setOpenSections] = useState<Record<ToolSection, boolean>>({
    lookup: true,
    explain: false,
    translate: false,
  });

  useEffect(() => {
    if (loading) return;
    setLookupLanguage(settings.lookup_language || "selection");
    setLookupTranslationLanguage(settings.lookup_translation_language || settings.language || "en");
    setShowTranslation(settings.show_translation === "true");
    setExplainLanguage(settings.explain_language || "lookup");
    setTranslationLanguage(settings.translation_language || settings.language || "en");
  }, [settings, loading]);

  if (loading) return null;

  const shouldShowTranslation =
    showTranslation && lookupTranslationLanguage !== "" && lookupTranslationLanguage !== lookupLanguage;
  const lookupLanguageOptions = [
    { value: "selection", label: t("settings.tools.sameAsSelection") },
    ...LANGUAGE_OPTIONS,
  ];
  const explainLanguageOptions = [
    { value: "lookup", label: t("settings.tools.sameAsLookup") },
    ...LANGUAGE_OPTIONS,
  ];
  const sections: { id: ToolSection; title: string; subtitle: string }[] = [
    { id: "lookup", title: t("settings.tools.lookup"), subtitle: t("settings.tools.lookupSub") },
    { id: "explain", title: t("settings.tools.explain"), subtitle: t("settings.tools.explainSub") },
    { id: "translate", title: t("settings.tools.translate"), subtitle: t("settings.tools.translateSub") },
  ];
  const toggleSection = (section: ToolSection) => {
    setOpenSections((current) => ({
      ...current,
      [section]: !current[section],
    }));
  };

  return (
    <div className="w-full min-w-0 pb-10">
      <div className="w-full min-w-0">
        {sections.map((section, index) => {
          const open = openSections[section.id];

          return (
            <div key={section.id} className="w-full min-w-0">
              {index > 0 && <div className="h-px bg-border-light" />}
              <div className="w-full min-w-0">
                <AccordionHeader
                  title={section.title}
                  subtitle={section.subtitle}
                  open={open}
                  onClick={() => toggleSection(section.id)}
                />
                <AccordionBody open={open}>
                  {section.id === "lookup" && (
                  <div className="w-full min-w-0 flex flex-col gap-1 pb-3">
                    <SettingsRow
                      title={t("settings.tools.lookupLanguage")}
                      subtitle={t("settings.tools.lookupLanguageHint")}
                    >
                      <Select
                        className="w-[175px] shrink-0"
                        value={lookupLanguage}
                        onChange={(lang) => {
                          setLookupLanguage(lang);
                          save("lookup_language", lang);
                          showSavedToast();
                        }}
                        options={lookupLanguageOptions}
                      />
                    </SettingsRow>
                    <SettingsRow
                      title={t("settings.tools.briefTranslation")}
                      subtitle={t("settings.tools.briefTranslationHint")}
                    >
                      <Toggle
                        checked={showTranslation}
                        onChange={(checked) => {
                          setShowTranslation(checked);
                          save("show_translation", String(checked));
                          showSavedToast();
                        }}
                      />
                    </SettingsRow>
                    <SettingsRow
                      title={t("settings.tools.glossTarget")}
                      subtitle={t("settings.tools.glossTargetHint")}
                    >
                      <Select
                        className="w-[130px] shrink-0"
                        value={lookupTranslationLanguage}
                        placeholder={t("settings.languageUnset")}
                        onChange={(lang) => {
                          setLookupTranslationLanguage(lang);
                          save("lookup_translation_language", lang);
                          showSavedToast();
                        }}
                        options={LANGUAGE_OPTIONS}
                      />
                    </SettingsRow>
                    <div className="w-full min-w-0 pt-2 px-1">
                      <p className="text-[10px] font-bold text-text-placeholder mb-1.5 uppercase tracking-[0.3px]">
                        {t("settings.tools.preview")}
                      </p>
                      <div className="w-full min-w-0 bg-bg-muted border border-border rounded-lg overflow-hidden">
                        <div className="flex items-center justify-between px-3 py-2">
                          <div className="flex items-center gap-1.5">
                            <Sparkles size={13} className="text-accent-text" />
                            <span className="text-[12px] font-medium text-accent-text">{t("lookup.title")}</span>
                          </div>
                          <X size={12} className="text-text-placeholder" />
                        </div>
                        <div className="px-3 pb-3 flex flex-col gap-1.5">
                          <p className="text-[14px] font-bold text-text-primary">interfaces</p>
                          <p
                            aria-hidden={!shouldShowTranslation}
                            className={`text-[11px] font-medium text-accent-text leading-[16px] transition-opacity ${
                              shouldShowTranslation ? "opacity-100" : "opacity-0"
                            }`}
                          >
                            {SAMPLE_TRANSLATIONS[lookupTranslationLanguage] || "interfaces"}
                          </p>
                          <p className="text-[11px] text-text-secondary leading-[1.45]">
                            {lookupLanguage === "zh"
                              ? "名词。两个系统相互连接和交互的点或区域。"
                              : "A term used in this passage to convey a specific quality relevant to themes of technological advancement."}
                          </p>
                          <div className="p-2 rounded-md bg-bg-surface border border-border">
                            <p className="text-[9px] font-bold text-text-placeholder mb-0.5">
                              {t("lookup.inContext")}
                            </p>
                            <p className="text-[10px] text-text-secondary leading-[1.45]">
                              {lookupLanguage === "zh"
                                ? "在这段文字中，interfaces 指的是人类与技术之间的边界。"
                                : "This word contributes to the author's exploration of the intersection between humanity and technology."}
                            </p>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                )}
                  {section.id === "explain" && (
                  <div className="w-full min-w-0 flex flex-col gap-1 pb-3">
                    <SettingsRow
                      title={t("settings.tools.explainLanguage")}
                      subtitle={t("settings.tools.explainLanguageHint")}
                    >
                      <Select
                        className="w-[150px] shrink-0"
                        value={explainLanguage}
                        onChange={(lang) => {
                          setExplainLanguage(lang);
                          save("explain_language", lang);
                          showSavedToast();
                        }}
                        options={explainLanguageOptions}
                      />
                    </SettingsRow>
                  </div>
                )}
                  {section.id === "translate" && (
                  <div className="w-full min-w-0 flex flex-col gap-1 pb-3">
                    <SettingsRow
                      title={t("settings.tools.translateTo")}
                      subtitle={t("settings.tools.translateToHint")}
                    >
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
                    </SettingsRow>
                  </div>
                )}
                </AccordionBody>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
