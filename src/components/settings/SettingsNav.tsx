import type { ComponentType } from "react";
import {
  SlidersHorizontal,
  Palette,
  BookOpen,
  BookA,
  Bot,
  Cloud,
  Terminal,
  RefreshCw,
  Info,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import QuillLogo from "../QuillLogo";
import SmartLensIcon from "../ui/SmartLensIcon";
import type { SettingsSection } from "./types";

interface SettingsNavProps {
  activeSection: SettingsSection;
  onSelectSection: (section: SettingsSection) => void;
  isMac: boolean;
  appVersion: string;
}

interface NavItemDef {
  id: SettingsSection;
  labelKey: string;
  icon: ComponentType<{ size?: number; className?: string }>;
  macOnly?: boolean;
}

interface NavGroupDef {
  id: string;
  titleKey: string;
  items: NavItemDef[];
}

const NAV_GROUPS: NavGroupDef[] = [
  {
    id: "app",
    titleKey: "settings.groups.app",
    items: [
      { id: "general", labelKey: "settings.general.title", icon: SlidersHorizontal },
      { id: "appearance", labelKey: "settings.appearance.title", icon: Palette },
      { id: "reading", labelKey: "settings.reading.title", icon: BookOpen },
    ],
  },
  {
    id: "tools",
    titleKey: "settings.groups.tools",
    items: [
      { id: "dictionary", labelKey: "settings.dictionary.title", icon: BookA },
      { id: "tools", labelKey: "settings.tools.title", icon: SmartLensIcon },
    ],
  },
  {
    id: "integrations",
    titleKey: "settings.groups.integrations",
    items: [
      { id: "ai", labelKey: "settings.ai.shortTitle", icon: Bot },
      { id: "librarySync", labelKey: "settings.librarySync.title", icon: Cloud, macOnly: true },
      { id: "mcp", labelKey: "settings.mcp.title", icon: Terminal },
    ],
  },
  {
    id: "system",
    titleKey: "settings.groups.system",
    items: [
      { id: "updates", labelKey: "settings.updates.title", icon: RefreshCw },
      { id: "about", labelKey: "settings.about.title", icon: Info },
    ],
  },
];

export default function SettingsNav({
  activeSection,
  onSelectSection,
  isMac,
  appVersion,
}: SettingsNavProps) {
  const { t } = useTranslation();

  return (
    <aside
      aria-label={t("settings.title")}
      className="w-[260px] shrink-0 h-full dawn-glass rounded-surface p-3 flex flex-col gap-4 overflow-y-auto"
    >
      {NAV_GROUPS.map((group) => {
        const items = group.items.filter((item) => !item.macOnly || isMac);
        if (items.length === 0) return null;
        return (
          <div key={group.id} className="flex flex-col gap-0.5">
            <div className="px-3 pt-0.5 pb-1">
              <span className="text-[11px] font-semibold uppercase tracking-[0.9px] text-text-tertiary">
                {t(group.titleKey)}
              </span>
            </div>
            {items.map((item) => {
              const Icon = item.icon;
              const isActive = activeSection === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  data-settings-tab={item.id}
                  aria-current={isActive ? "page" : undefined}
                  onClick={() => onSelectSection(item.id)}
                  className={`w-full px-3 py-[9px] rounded-[6px] flex items-center gap-3 text-left text-[14px] cursor-pointer transition-colors focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-focus-ring ${
                    isActive
                      ? "bg-accent-tint text-accent-on-tint font-semibold"
                      : "text-text-primary font-normal hover:bg-surface-hover"
                  }`}
                >
                  <Icon
                    size={16}
                    className={`shrink-0 ${isActive ? "text-accent-on-tint" : "text-text-secondary"}`}
                  />
                  <span className="truncate">{t(item.labelKey)}</span>
                </button>
              );
            })}
          </div>
        );
      })}

      <div className="flex-1" />

      <div className="px-3 py-2 flex items-center gap-2 shrink-0">
        <QuillLogo size={18} />
        <span className="font-mono text-[11.5px] text-text-tertiary">
          {appVersion ? `Quill ${appVersion}` : "Quill"}
        </span>
      </div>
    </aside>
  );
}
