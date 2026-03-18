import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";

export function useSettings() {
  const [settings, setSettings] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const result = await invoke<Record<string, string>>("get_all_settings");
      setSettings(result);
    } catch (err) {
      console.error("Failed to load settings:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const saveBulk = useCallback(async (newSettings: Record<string, string>) => {
    await invoke("set_settings_bulk", { settings: newSettings });
    setSettings((prev) => ({ ...prev, ...newSettings }));
  }, []);

  const save = useCallback(async (key: string, value: string) => {
    await invoke("set_setting", { key, value });
    setSettings((prev) => ({ ...prev, [key]: value }));
  }, []);

  return { settings, loading, refresh, saveBulk, save };
}

export async function getAllSettings(): Promise<Record<string, string>> {
  return invoke<Record<string, string>>("get_all_settings");
}
