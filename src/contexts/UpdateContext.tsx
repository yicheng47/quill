import { createContext, useContext, useEffect, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useUpdateChecker, type UpdateState } from "../hooks/useUpdateChecker";

const UpdateContext = createContext<UpdateState | null>(null);

export function UpdateProvider({ children }: { children: ReactNode }) {
  const state = useUpdateChecker();

  // Auto-check on mount after a short delay (if auto-check is enabled)
  useEffect(() => {
    const timer = setTimeout(async () => {
      try {
        const settings = await invoke<Record<string, string>>("get_all_settings");
        const autoCheck = settings.auto_check_updates !== "false"; // default on
        if (autoCheck) {
          state.checkForUpdate();
        }
      } catch {
        // silently ignore — don't bother the user
      }
    }, 3000);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <UpdateContext.Provider value={state}>{children}</UpdateContext.Provider>
  );
}

export function useUpdate(): UpdateState {
  const ctx = useContext(UpdateContext);
  if (!ctx) throw new Error("useUpdate must be used within UpdateProvider");
  return ctx;
}
