import { useState, useCallback, useRef } from "react";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

export type UpdateStatus =
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "ready"
  | "error";

export interface UpdateState {
  status: UpdateStatus;
  update: Update | null;
  progress: number;
  error: string | null;
  /** True when the in-flight/last check was user-initiated (menu). The
   *  toast only surfaces the transient checking/up-to-date/error states
   *  for manual checks — the launch auto-check stays silent unless an
   *  update is actually found. */
  manualCheck: boolean;
  checkForUpdate: (opts?: { manual?: boolean }) => Promise<void>;
  downloadAndInstall: () => Promise<void>;
  restart: () => Promise<void>;
}

export function useUpdateChecker(): UpdateState {
  const [status, setStatus] = useState<UpdateStatus>("idle");
  const [update, setUpdate] = useState<Update | null>(null);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [manualCheck, setManualCheck] = useState(false);
  const checking = useRef(false);

  const checkForUpdate = useCallback(async (opts?: { manual?: boolean }) => {
    if (checking.current) {
      // A check is already running (e.g. the silent launch check). If
      // this one is manual (menu), promote it so the in-flight result
      // still surfaces checking/up-to-date feedback instead of being a
      // visible no-op.
      if (opts?.manual) setManualCheck(true);
      return;
    }
    checking.current = true;
    setManualCheck(opts?.manual ?? false);
    setStatus("checking");
    setError(null);
    try {
      const result = await check();
      if (result) {
        setUpdate(result);
        setStatus("available");
      } else {
        setStatus("idle");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStatus("error");
    } finally {
      checking.current = false;
    }
  }, []);

  const downloadAndInstall = useCallback(async () => {
    if (!update) return;
    // Clicking Update is an explicit user action — mark the lifecycle
    // manual so a download/install/relaunch failure surfaces in the
    // toast (error + Retry) even when the update was found by the
    // silent launch check.
    setManualCheck(true);
    setStatus("downloading");
    setProgress(0);
    try {
      let totalLen = 0;
      let downloaded = 0;
      await update.downloadAndInstall((event) => {
        if (event.event === "Started" && event.data.contentLength) {
          totalLen = event.data.contentLength;
        } else if (event.event === "Progress") {
          downloaded += event.data.chunkLength;
          if (totalLen > 0) {
            setProgress(Math.round((downloaded / totalLen) * 100));
          }
        } else if (event.event === "Finished") {
          setProgress(100);
        }
      });
      setStatus("ready");
      // Download + install finished — relaunch straight into the new
      // version (no manual "Restart" step).
      await relaunch();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStatus("error");
    }
  }, [update]);

  const restart = useCallback(async () => {
    await relaunch();
  }, []);

  return {
    status,
    update,
    progress,
    error,
    manualCheck,
    checkForUpdate,
    downloadAndInstall,
    restart,
  };
}
