import { useState, useEffect, useCallback } from "react";
import { invoke } from "../platform";

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
    if (
      ("ai_provider" in newSettings || "ai_base_url" in newSettings) &&
      !("ai_api_key" in newSettings)
    ) {
      const fresh = await invoke<Record<string, string>>("get_all_settings");
      if (fresh && typeof fresh === "object" && !Array.isArray(fresh)) {
        setSettings(fresh);
        return;
      }
    }
    setSettings((prev) => ({ ...prev, ...newSettings }));
  }, []);

  const save = useCallback(async (key: string, value: string) => {
    await invoke("set_setting", { key, value });
    if (key === "ai_provider" || key === "ai_base_url") {
      const fresh = await invoke<Record<string, string>>("get_all_settings");
      if (fresh && typeof fresh === "object" && !Array.isArray(fresh)) {
        setSettings(fresh);
        return;
      }
    }
    setSettings((prev) => ({ ...prev, [key]: value }));
  }, []);

  return { settings, loading, refresh, saveBulk, save };
}

export async function getAllSettings(): Promise<Record<string, string>> {
  return invoke<Record<string, string>>("get_all_settings");
}
