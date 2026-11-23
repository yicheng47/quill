import { useState, useEffect, useCallback, useRef } from "react";
import { useTranslation } from "react-i18next";
import { getAppVersion } from "../../platform";
import { useSettings } from "../../hooks/useSettings";
import {
  clearThemeSaveError,
  normalizeAppTheme,
  seedCommittedAppTheme,
} from "../../lib/theme";
import { isMacOS } from "../../lib/platformEnv";
import type { ConnectionKind } from "../../lib/aiConnections";
import Toast from "../ui/Toast";
import SettingsNav from "./SettingsNav";
import GeneralSettings from "./GeneralSettings";
import AppearanceSettings from "./AppearanceSettings";
import ReadingSettings from "./ReadingSettings";
import DictionarySettings from "./DictionarySettings";
import AiSettings from "./AiSettings";
import ToolsSettings from "./ToolsSettings";
import LibrarySyncSettings from "./LibrarySyncSettings";
import McpSettings from "./McpSettings";
import UpdatesSettings from "./UpdatesSettings";
import AboutSettings from "./AboutSettings";
import { normalizeSettingsSection, type SettingsSection } from "./types";

interface SettingsViewProps {
  section: SettingsSection;
  visitSeq?: number;
  initialAiConnection?: ConnectionKind;
  onSelectSection: (section: SettingsSection) => void;
  onClose: () => void;
  onBlockingChange?: (blocking: boolean) => void;
  suppressEscape?: boolean;
}

const SECTION_META: Record<SettingsSection, { titleKey: string; subtitleKey: string }> = {
  general: {
    titleKey: "settings.general.title",
    subtitleKey: "settings.general.subtitle",
  },
  appearance: {
    titleKey: "settings.appearance.title",
    subtitleKey: "settings.appearance.subtitle",
  },
  reading: {
    titleKey: "settings.reading.title",
    subtitleKey: "settings.reading.subtitle",
  },
  dictionary: {
    titleKey: "settings.dictionary.title",
    subtitleKey: "settings.dictionary.subtitle",
  },
  tools: {
    titleKey: "settings.tools.title",
    subtitleKey: "settings.tools.subtitle",
  },
  ai: {
    titleKey: "settings.ai.shortTitle",
    subtitleKey: "settings.ai.subtitle",
  },
  librarySync: {
    titleKey: "settings.librarySync.title",
    subtitleKey: "settings.librarySync.subtitle",
  },
  mcp: {
    titleKey: "settings.mcp.title",
    subtitleKey: "settings.mcp.subtitle",
  },
  updates: {
    titleKey: "settings.updates.title",
    subtitleKey: "settings.updates.subtitle",
  },
  about: {
    titleKey: "settings.about.title",
    subtitleKey: "settings.about.subtitle",
  },
};

export default function SettingsView({
  section,
  visitSeq = 0,
  initialAiConnection,
  onSelectSection,
  onClose,
  onBlockingChange,
  suppressEscape = false,
}: SettingsViewProps) {
  const { t } = useTranslation();
  const isMac = isMacOS();
  const activeSection = normalizeSettingsSection(section, isMac);
  const { settings, loading, save, saveBulk } = useSettings();
  const [appVersion, setAppVersion] = useState("");
  const [blockingSync, setBlockingSync] = useState(false);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const toastTimerRef = useRef<number | null>(null);
  const paneRef = useRef<HTMLDivElement>(null);
  const seededThemeRef = useRef(false);

  useEffect(() => {
    clearThemeSaveError();
    void getAppVersion()
      .then(setAppVersion)
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (loading || seededThemeRef.current) return;
    seededThemeRef.current = true;
    seedCommittedAppTheme(normalizeAppTheme(settings.theme));
  }, [loading, settings]);

  useEffect(() => {
    return () => {
      if (toastTimerRef.current !== null) {
        window.clearTimeout(toastTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (paneRef.current) {
      paneRef.current.scrollTop = 0;
    }
  }, [activeSection]);

  const handleBlockingChange = useCallback(
    (blocking: boolean) => {
      setBlockingSync(blocking);
      onBlockingChange?.(blocking);
    },
    [onBlockingChange],
  );

  useEffect(() => {
    return () => onBlockingChange?.(false);
  }, [onBlockingChange]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (e.defaultPrevented || blockingSync || suppressEscape) return;
      e.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [blockingSync, suppressEscape, onClose]);

  const showSavedToast = useCallback(
    (msg?: string) => {
      if (toastTimerRef.current !== null) {
        window.clearTimeout(toastTimerRef.current);
      }
      setToastMessage(msg ?? t("settings.saved"));
      toastTimerRef.current = window.setTimeout(() => {
        setToastMessage(null);
        toastTimerRef.current = null;
      }, 2200);
    },
    [t],
  );

  const handleSelectSection = (next: SettingsSection) => {
    if (blockingSync) return;
    onSelectSection(normalizeSettingsSection(next, isMac));
  };

  const sectionMeta = SECTION_META[activeSection];
  const sectionProps = { settings, loading, save, saveBulk, showSavedToast };

  return (
    <div
      data-testid="settings-view"
      className="flex-1 min-h-0 flex flex-col pt-1 px-10 pb-7 gap-5 overflow-hidden"
    >
      <header className="flex items-end gap-3 shrink-0">
        <h1 className="text-[28px] font-semibold tracking-[-0.75px] leading-[1.05] text-text-primary">
          {t("settings.title")}
        </h1>
        <p className="text-[14px] leading-[1.35] text-text-tertiary">
          {t("settings.autoSaveSubtitle")}
        </p>
      </header>

      <div className="flex-1 min-h-0 flex gap-4">
        <SettingsNav
          activeSection={activeSection}
          onSelectSection={handleSelectSection}
          isMac={isMac}
          appVersion={appVersion}
        />

        <div
          ref={paneRef}
          className="flex-1 min-w-0 h-full dawn-glass rounded-surface overflow-y-auto px-8 py-9"
        >
          <div className="w-full max-w-[720px] mx-auto flex flex-col gap-7">
            <div className="flex flex-col gap-1">
              <h2 className="text-[22px] font-semibold tracking-[-0.4px] leading-tight text-text-primary">
                {t(sectionMeta.titleKey)}
              </h2>
              <p className="text-[14px] text-text-tertiary">
                {t(sectionMeta.subtitleKey)}
              </p>
            </div>

            {activeSection === "general" && <GeneralSettings {...sectionProps} />}
            {activeSection === "appearance" && <AppearanceSettings {...sectionProps} />}
            {activeSection === "reading" && <ReadingSettings {...sectionProps} />}
            {activeSection === "dictionary" && <DictionarySettings {...sectionProps} />}
            {activeSection === "tools" && <ToolsSettings {...sectionProps} />}
            {activeSection === "ai" && (
              <AiSettings
                {...sectionProps}
                refreshNonce={visitSeq}
                initialConnection={initialAiConnection}
              />
            )}
            {activeSection === "librarySync" && (
              <LibrarySyncSettings
                {...sectionProps}
                onBlockingChange={handleBlockingChange}
              />
            )}
            {activeSection === "mcp" && <McpSettings />}
            {activeSection === "updates" && <UpdatesSettings {...sectionProps} />}
            {activeSection === "about" && <AboutSettings />}
          </div>
        </div>
      </div>

      {toastMessage && <Toast>{toastMessage}</Toast>}
    </div>
  );
}
