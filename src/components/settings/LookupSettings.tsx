import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Sparkles, X } from "lucide-react";
import Select from "../ui/Select";
import Toggle from "../ui/Toggle";
import type { SettingsProps } from "./types";

export default function LookupSettings({ settings, loading, save, showSavedToast }: SettingsProps) {
  const { t, i18n } = useTranslation();
  const [nativeLanguage, setNativeLanguage] = useState("en");
  const [showTranslation, setShowTranslation] = useState(false);

  const language = i18n.language;

  useEffect(() => {
    if (loading) return;
    if (settings.native_language) setNativeLanguage(settings.native_language);
    if (settings.show_translation) setShowTranslation(settings.show_translation === "true");
  }, [settings, loading]);

  return (
    <div>
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
          ]}
        />
      </div>
      <div className="h-px bg-black/10" />

      {/* Show Translation */}
      <div className="flex items-center justify-between h-[73px]">
        <div>
          <p className="text-[14px] font-medium text-text-primary tracking-[-0.15px]">
            {t("settings.lookup.showTranslation")}
          </p>
          <p className="text-[12px] text-text-muted mt-0.5">
            {t("settings.lookup.showTranslationHint")}
          </p>
        </div>
        <Toggle
          checked={showTranslation}
          onChange={(checked) => {
            setShowTranslation(checked);
            save("show_translation", String(checked));
            showSavedToast();
          }}
        />
      </div>
      <div className="h-px bg-black/10" />

      {/* Preview */}
      <div className="mt-5">
        <p className="text-[12px] font-medium text-text-muted mb-2 uppercase tracking-[0.3px]">Preview</p>
        <div className="bg-white dark:bg-bg-surface border border-border/80 rounded-xl shadow-sm overflow-hidden max-w-[360px]">
          <div className="flex items-center justify-between px-3 pt-2.5 pb-2 bg-accent-bg border-b border-border/40">
            <div className="flex items-center gap-1.5">
              <Sparkles size={13} className="text-accent-text" />
              <span className="text-[12px] font-medium text-accent-text">{t("lookup.title")}</span>
            </div>
            <X size={12} className="text-text-muted" />
          </div>
          <div className="px-3 py-2.5">
            <p className="text-[15px] font-bold text-text-primary mb-0.5">interfaces</p>
            {language !== "en" ? (
              <>
                <p className="text-[12px] text-text-secondary leading-[1.5] mb-2">
                  {language === "zh"
                    ? "\u540d\u8bcd\u3002\u4e24\u4e2a\u7cfb\u7edf\u76f8\u4e92\u8fde\u63a5\u548c\u4ea4\u4e92\u7684\u70b9\u6216\u533a\u57df\u3002"
                    : "A term used in this passage to convey a specific quality relevant to themes of technological advancement."}
                </p>
                <div className="p-2 rounded-md bg-bg-muted border border-border/50">
                  <p className="text-[10px] font-medium text-text-muted mb-0.5">{t("lookup.inContext")}</p>
                  <p className="text-[10px] text-text-secondary leading-[1.5]">
                    {language === "zh"
                      ? "\u5728\u8fd9\u6bb5\u6587\u5b57\u4e2d\uff0cinterfaces \u6307\u7684\u662f\u4eba\u7c7b\u4e0e\u6280\u672f\u4e4b\u95f4\u7684\u8fb9\u754c\u3002"
                      : 'This word contributes to the author\u2019s exploration of the intersection between humanity and technology.'}
                  </p>
                </div>
              </>
            ) : (
              <>
                {showTranslation && nativeLanguage !== "en" && (
                  <p className="text-[12px] text-accent-text mb-1">
                    {nativeLanguage === "zh" ? "\u754c\u9762\uff1b\u63a5\u53e3" : "interfaces"}
                  </p>
                )}
                <p className="text-[11px] text-text-secondary leading-[1.5] mb-2">
                  A term used in this passage to convey a specific quality relevant to themes of technological advancement.
                </p>
                <div className="p-2 rounded-md bg-bg-muted border border-border/50">
                  <p className="text-[10px] font-medium text-text-muted mb-0.5">{t("lookup.inContext")}</p>
                  <p className="text-[10px] text-text-secondary leading-[1.5]">
                    {"This word contributes to the author\u2019s exploration of the intersection between humanity and technology."}
                  </p>
                </div>
              </>
            )}
          </div>
          <div className="flex items-center justify-between px-3 py-2 border-t border-border/40">
            <span className="text-[11px] font-medium text-accent-text">{t("lookup.saveToDict")}</span>
            <span className="text-[11px] font-medium text-text-muted">{t("lookup.copy")}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
