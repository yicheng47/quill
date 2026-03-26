export interface SettingsProps {
  settings: Record<string, string>;
  loading: boolean;
  save: (key: string, value: string) => Promise<void>;
  saveBulk: (entries: Record<string, string>) => Promise<void>;
  showSavedToast: (msg?: string) => void;
}
