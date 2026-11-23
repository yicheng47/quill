export type SettingsSection =
  | "general"
  | "appearance"
  | "reading"
  | "dictionary"
  | "tools"
  | "ai"
  | "librarySync"
  | "mcp"
  | "updates"
  | "about";

export interface SettingsProps {
  settings: Record<string, string>;
  loading: boolean;
  save: (key: string, value: string) => Promise<void>;
  saveBulk: (entries: Record<string, string>) => Promise<void>;
  showSavedToast: (msg?: string) => void;
}

export function normalizeSettingsSection(section?: string, isMac = true): SettingsSection {
  if (section === "lookup" || section === "translation" || section === "tools") {
    return "tools";
  }
  if (section === "librarySync" && !isMac) {
    return "general";
  }
  if (
    section === "general" ||
    section === "appearance" ||
    section === "reading" ||
    section === "dictionary" ||
    section === "tools" ||
    section === "ai" ||
    section === "librarySync" ||
    section === "mcp" ||
    section === "updates" ||
    section === "about"
  ) {
    return section;
  }
  return "general";
}
