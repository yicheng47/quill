import { useState, useEffect, useCallback, useRef } from "react";
import * as platform from "../platform";

function getPlatformListen() {
  try {
    return typeof platform.listen === "function" ? platform.listen : null;
  } catch {
    return null;
  }
}

type LocalSettingsListener = (
  patch: Record<string, string> | null,
  replace: boolean,
  source: symbol,
) => void;

const localSettingsListeners = new Set<LocalSettingsListener>();

function notifyLocalSettings(
  patch: Record<string, string> | null,
  replace: boolean,
  source: symbol,
) {
  for (const listener of localSettingsListeners) {
    listener(patch, replace, source);
  }
}

function needsServerReconcile(updates: Record<string, string>): boolean {
  if ("ai_auth_mode" in updates) return true;
  if (
    ("ai_provider" in updates || "ai_base_url" in updates) &&
    !("ai_api_key" in updates)
  ) {
    return true;
  }
  for (const [key, value] of Object.entries(updates)) {
    if (
      (key.startsWith("ai_codex_model_") || key.startsWith("ai_codex_effort_")) &&
      (!value.trim() || value.trim() === "default")
    ) {
      return true;
    }
  }
  return false;
}

export function useSettings() {
  const [settings, setSettings] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const sourceRef = useRef<symbol | null>(null);
  if (sourceRef.current === null) {
    sourceRef.current = Symbol("useSettings");
  }
  const reloadGenRef = useRef(0);
  const inFlightReloadsRef = useRef(0);
  const localWriteDepthRef = useRef(0);
  const pendingRemoteChangeRef = useRef(false);

  const reloadSilent = useCallback(async () => {
    const gen = ++reloadGenRef.current;
    inFlightReloadsRef.current += 1;
    try {
      const result = await platform.invoke<Record<string, string>>("get_all_settings");
      if (
        gen === reloadGenRef.current &&
        localWriteDepthRef.current === 0 &&
        result &&
        typeof result === "object" &&
        !Array.isArray(result)
      ) {
        setSettings(result);
      }
    } catch (err) {
      console.error("Failed to reload settings:", err);
    } finally {
      inFlightReloadsRef.current -= 1;
    }
  }, []);

  const refresh = useCallback(async () => {
    const gen = ++reloadGenRef.current;
    inFlightReloadsRef.current += 1;
    setLoading(true);
    try {
      const result = await platform.invoke<Record<string, string>>("get_all_settings");
      if (
        gen === reloadGenRef.current &&
        result &&
        typeof result === "object" &&
        !Array.isArray(result)
      ) {
        setSettings(result);
      }
    } catch (err) {
      console.error("Failed to load settings:", err);
    } finally {
      inFlightReloadsRef.current -= 1;
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const source = sourceRef.current!;
    const onLocal: LocalSettingsListener = (patch, replace, origin) => {
      if (origin === source) return;
      if (patch) {
        setSettings((prev) => (replace ? patch : { ...prev, ...patch }));
      } else {
        void reloadSilent();
      }
    };
    localSettingsListeners.add(onLocal);

    let disposed = false;
    let unlisten: (() => void) | undefined;
    const listenFn = getPlatformListen();
    if (listenFn) {
      void listenFn("settings-changed", () => {
        if (disposed) return;
        if (localWriteDepthRef.current > 0) {
          pendingRemoteChangeRef.current = true;
          return;
        }
        void reloadSilent();
      }).then((fn) => {
        if (disposed) {
          fn();
        } else {
          unlisten = fn;
        }
      });
    }

    return () => {
      disposed = true;
      localSettingsListeners.delete(onLocal);
      unlisten?.();
    };
  }, [reloadSilent]);

  const finishWrite = useCallback(() => {
    localWriteDepthRef.current -= 1;
    if (localWriteDepthRef.current === 0 && pendingRemoteChangeRef.current) {
      pendingRemoteChangeRef.current = false;
      void reloadSilent();
    }
  }, [reloadSilent]);

  const saveBulk = useCallback(
    async (newSettings: Record<string, string>) => {
      const source = sourceRef.current!;
      if (inFlightReloadsRef.current > 0) {
        pendingRemoteChangeRef.current = true;
      }
      reloadGenRef.current += 1;
      localWriteDepthRef.current += 1;
      try {
        await platform.invoke("set_settings_bulk", { settings: newSettings });
        if (needsServerReconcile(newSettings)) {
          const fresh = await platform.invoke<Record<string, string>>("get_all_settings");
          if (fresh && typeof fresh === "object" && !Array.isArray(fresh)) {
            setSettings(fresh);
            notifyLocalSettings(fresh, true, source);
            return;
          }
        }
        setSettings((prev) => ({ ...prev, ...newSettings }));
        notifyLocalSettings(newSettings, false, source);
      } finally {
        finishWrite();
      }
    },
    [finishWrite],
  );

  const save = useCallback(
    async (key: string, value: string) => {
      const source = sourceRef.current!;
      if (inFlightReloadsRef.current > 0) {
        pendingRemoteChangeRef.current = true;
      }
      reloadGenRef.current += 1;
      localWriteDepthRef.current += 1;
      try {
        await platform.invoke("set_setting", { key, value });
        const patch = { [key]: value };
        if (needsServerReconcile(patch)) {
          const fresh = await platform.invoke<Record<string, string>>("get_all_settings");
          if (fresh && typeof fresh === "object" && !Array.isArray(fresh)) {
            setSettings(fresh);
            notifyLocalSettings(fresh, true, source);
            return;
          }
        }
        setSettings((prev) => ({ ...prev, [key]: value }));
        notifyLocalSettings(patch, false, source);
      } finally {
        finishWrite();
      }
    },
    [finishWrite],
  );

  return { settings, loading, refresh, reloadSilent, saveBulk, save };
}

export async function getAllSettings(): Promise<Record<string, string>> {
  return platform.invoke<Record<string, string>>("get_all_settings");
}
