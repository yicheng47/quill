import { useState, useEffect, useRef, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Globe, BookOpen, Bot, Wrench, Cloud, Info, Terminal, X, ChevronRight, Palette } from "lucide-react";
import GeneralSettings from "./settings/GeneralSettings";
import AppearanceSettings from "./settings/AppearanceSettings";
import ReadingSettings from "./settings/ReadingSettings";
import AiSettings from "./settings/AiSettings";
import ToolsSettings from "./settings/ToolsSettings";
import LibrarySyncSettings from "./settings/LibrarySyncSettings";
import McpSettings from "./settings/McpSettings";
import AboutSettings from "./settings/AboutSettings";
import Toast from "./ui/Toast";
import { useSettings } from "../hooks/useSettings";

export type SettingsSection = "general" | "appearance" | "reading" | "ai" | "tools" | "librarySync" | "mcp" | "about";

interface SettingsModalProps {
  open: boolean;
  onClose: () => void;
  initialSection?: SettingsSection;
}

export default function SettingsModal({ open, onClose, initialSection = "general" }: SettingsModalProps) {
  const { t } = useTranslation();
  const [activeSection, setActiveSection] = useState<SettingsSection>(initialSection);
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

  const allSections: { id: SettingsSection; label: string; subtitle: string; paneSubtitle?: string; icon: typeof Globe }[] = [
    { id: "general", label: t("settings.general.title"), subtitle: t("settings.general.subtitle"), icon: Globe },
    { id: "appearance", label: t("settings.appearance.title"), subtitle: t("settings.appearance.subtitle"), icon: Palette },
    { id: "reading", label: t("settings.reading.title"), subtitle: t("settings.reading.subtitle"), icon: BookOpen },
    { id: "ai", label: t("settings.ai.shortTitle"), subtitle: t("settings.ai.shortSubtitle"), icon: Bot },
    { id: "tools", label: t("settings.tools.title"), subtitle: t("settings.tools.subtitle"), paneSubtitle: t("settings.tools.paneSubtitle"), icon: Wrench },
    { id: "librarySync", label: t("settings.librarySync.title"), subtitle: t("settings.librarySync.subtitle"), icon: Cloud },
    { id: "mcp", label: t("settings.mcp.title"), subtitle: t("settings.mcp.subtitle"), icon: Terminal },
    { id: "about", label: t("settings.about.title"), subtitle: t("settings.about.subtitle"), icon: Info },
  ];

  const sections = isMacos ? allSections : allSections.filter((s) => s.id !== "librarySync");

  const settingsProps = { settings, loading, save, saveBulk, showSavedToast };

  const renderContent = (): ReactNode => {
    switch (activeSection) {
      case "general": return <GeneralSettings {...settingsProps} />;
      case "appearance": return <AppearanceSettings {...settingsProps} />;
      case "reading": return <ReadingSettings {...settingsProps} />;
      case "ai": return <AiSettings {...settingsProps} onDirtyChange={setAiDirty} onSaveRef={(fn) => { aiSaveRef.current = fn; }} />;
      case "tools": return <ToolsSettings {...settingsProps} />;
      case "librarySync": return <LibrarySyncSettings {...settingsProps} />;
      case "mcp": return <McpSettings {...settingsProps} />;
      case "about": return <AboutSettings />;
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
          <div
            className="flex-1 overflow-y-scroll px-6"
            style={{ scrollbarGutter: "stable" }}
          >
            {/* Pane header — title + subtitle, then a rule with room
                below it. Suppressed for About, which leads with its
                centered identity card. */}
            {activeSection !== "about" && (
              <div className="flex flex-col gap-1">
                <h3 className="text-[18px] font-semibold text-text-primary">
                  {active?.label}
                </h3>
                <p className="text-[13px] text-text-muted">
                  {active?.paneSubtitle ?? active?.subtitle}
                </p>
                <div className="mt-3 h-px bg-black/10 mb-2" />
              </div>
            )}

            {renderContent()}
          </div>
        </div>
      </div>

      {/* Toast */}
      {showToast && (
        <Toast>{toastMessage}</Toast>
      )}
    </div>
  );
}
