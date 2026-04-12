import { useState, useEffect, useRef, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Globe, BookOpen, Bot, Search, Languages, ArrowLeftRight, Cloud, Info, X, ChevronRight } from "lucide-react";
import GeneralSettings from "./settings/GeneralSettings";
import ReadingSettings from "./settings/ReadingSettings";
import AiSettings from "./settings/AiSettings";
import LanguageSettings from "./settings/LanguageSettings";
import LookupSettings from "./settings/LookupSettings";
import TranslationSettings from "./settings/TranslationSettings";
import ICloudSettings from "./settings/ICloudSettings";
import AboutSettings from "./settings/AboutSettings";
import { useSettings } from "../hooks/useSettings";

type Section = "general" | "language" | "reading" | "ai" | "lookup" | "translation" | "icloud" | "about";

interface SettingsModalProps {
  open: boolean;
  onClose: () => void;
  initialSection?: Section;
}

export default function SettingsModal({ open, onClose, initialSection = "general" }: SettingsModalProps) {
  const { t } = useTranslation();
  const [activeSection, setActiveSection] = useState<Section>(initialSection);
  const { settings, loading, save, saveBulk } = useSettings();
  const modalRef = useRef<HTMLDivElement>(null);

  // Toast state
  const [showToast, setShowToast] = useState(false);
  const [toastMessage, setToastMessage] = useState("");
  const toastTimeout = useRef<ReturnType<typeof setTimeout>>(undefined);
  const showSavedToast = (msg = t("settings.saved")) => {
    if (toastTimeout.current) clearTimeout(toastTimeout.current);
    setToastMessage(msg);
    setShowToast(true);
    toastTimeout.current = setTimeout(() => setShowToast(false), 1500);
  };

  useEffect(() => {
    if (open) setActiveSection(initialSection);
  }, [open, initialSection]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [open, onClose]);

  // AI save state (must be before early return)
  const [aiDirty, setAiDirty] = useState(false);
  const aiSaveRef = useRef<(() => void) | null>(null);

  if (!open) return null;

  const isMacos = navigator.userAgent.includes("Macintosh");

  const allSections: { id: Section; label: string; subtitle: string; icon: typeof Globe }[] = [
    { id: "general", label: t("settings.general.title"), subtitle: t("settings.general.subtitle"), icon: Globe },
    { id: "language", label: t("settings.language"), subtitle: t("settings.language.subtitle"), icon: Languages },
    { id: "reading", label: t("settings.reading.title"), subtitle: t("settings.reading.subtitle"), icon: BookOpen },
    { id: "ai", label: t("settings.ai.shortTitle"), subtitle: t("settings.ai.shortSubtitle"), icon: Bot },
    { id: "lookup", label: t("settings.lookup.title"), subtitle: t("settings.lookup.shortSub"), icon: Search },
    { id: "translation", label: t("settings.translation.title"), subtitle: t("settings.translation.subtitle"), icon: ArrowLeftRight },
    { id: "icloud", label: t("settings.icloud.title"), subtitle: t("settings.icloud.subtitle"), icon: Cloud },
    { id: "about", label: t("settings.about.title"), subtitle: t("settings.about.subtitle"), icon: Info },
  ];

  const sections = isMacos ? allSections : allSections.filter((s) => s.id !== "icloud");

  const settingsProps = { settings, loading, save, saveBulk, showSavedToast };

  const renderContent = (): ReactNode => {
    switch (activeSection) {
      case "general": return <GeneralSettings {...settingsProps} />;
      case "language": return <LanguageSettings {...settingsProps} />;
      case "reading": return <ReadingSettings {...settingsProps} />;
      case "ai": return <AiSettings {...settingsProps} onDirtyChange={setAiDirty} onSaveRef={(fn) => { aiSaveRef.current = fn; }} />;
      case "lookup": return <LookupSettings {...settingsProps} />;
      case "translation": return <TranslationSettings {...settingsProps} />;
      case "icloud": return <ICloudSettings {...settingsProps} />;
      case "about": return <AboutSettings {...settingsProps} />;
    }
  };

  const active = sections.find((s) => s.id === activeSection);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={modalRef}
        className="bg-white dark:bg-bg-surface rounded-2xl shadow-[0px_25px_50px_-12px_rgba(0,0,0,0.25)] border border-border w-[780px] h-[80vh] max-h-[720px] min-h-[480px] flex overflow-hidden"
      >
        {/* Sidebar */}
        <div className="w-[220px] shrink-0 bg-bg-muted border-r border-border">
          <p className="text-[13px] font-semibold text-text-primary px-4 pt-4 pb-2">
            {t("settings.title")}
          </p>
          <nav className="flex flex-col gap-0.5 px-2">
            {sections.map((section) => {
              const Icon = section.icon;
              const isActive = activeSection === section.id;
              return (
                <button
                  key={section.id}
                  onClick={() => setActiveSection(section.id)}
                  className={`flex items-center gap-3 px-3 h-[56px] rounded-[10px] w-full cursor-pointer text-left transition-colors ${
                    isActive ? "bg-accent-bg" : "hover:bg-bg-input"
                  }`}
                >
                  <Icon
                    size={16}
                    className={`shrink-0 ${isActive ? "text-accent-text" : "text-text-muted"}`}
                  />
                  <div className="flex-1 min-w-0">
                    <p className={`text-[14px] font-medium leading-[20px] tracking-[-0.15px] ${
                      isActive ? "text-accent-text" : "text-text-secondary"
                    }`}>
                      {section.label}
                    </p>
                    <p className={`text-[11px] font-medium leading-[16px] tracking-[0.06px] truncate ${
                      isActive ? "text-accent-text/60" : "text-text-muted"
                    }`}>
                      {section.subtitle}
                    </p>
                  </div>
                  <ChevronRight
                    size={14}
                    className={`shrink-0 ${isActive ? "text-accent-text" : "text-text-muted/40"}`}
                  />
                </button>
              );
            })}
          </nav>
        </div>

        {/* Content */}
        <div className="flex-1 flex flex-col min-w-0">
          {/* Header actions */}
          <div className="flex items-center justify-end gap-2 pr-3 pt-3">
            {activeSection === "ai" && (
              <button
                onClick={() => aiSaveRef.current?.()}
                disabled={!aiDirty}
                className={`text-[13px] font-medium px-3 py-1 rounded-lg cursor-pointer transition-colors ${
                  aiDirty
                    ? "text-accent-text hover:bg-accent-bg"
                    : "text-text-muted/40 cursor-default"
                }`}
              >
                Save
              </button>
            )}
            <button
              onClick={onClose}
              className="size-7 flex items-center justify-center rounded-[10px] hover:bg-bg-input cursor-pointer"
            >
              <X size={16} className="text-text-muted" />
            </button>
          </div>

          {/* Scrollable content */}
          <div className="flex-1 overflow-y-auto px-6">
            {/* Section header */}
            <div className="mb-1">
              <h3 className="text-[17px] font-semibold text-text-primary leading-[25px] tracking-[-0.43px]">
                {active?.label}
              </h3>
              <p className="text-[13px] text-text-muted tracking-[-0.08px]">
                {active?.subtitle}
              </p>
            </div>
            <div className="h-px bg-black/10 mb-2" />

            {renderContent()}
          </div>
        </div>
      </div>

      {/* Toast */}
      {showToast && (
        <div className="fixed top-6 left-1/2 -translate-x-1/2 bg-white dark:bg-bg-surface border border-border px-4 py-2.5 rounded-xl text-[13px] font-medium shadow-lg z-[60] flex items-center gap-2">
          <div className="size-5 rounded-full bg-green-100 dark:bg-green-900/30 flex items-center justify-center shrink-0">
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
              <path d="M2.5 6L5 8.5L9.5 3.5" stroke="#22c55e" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </div>
          <span className="text-text-primary">{toastMessage}</span>
        </div>
      )}
    </div>
  );
}
