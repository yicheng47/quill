import { useState, useCallback, useRef } from "react";
import { checkForUpdate as platformCheckForUpdate, relaunch, type UpdateHandle } from "../platform";

export type UpdateStatus =
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "verifying"
  | "ready"
  | "error";

export interface UpdateState {
  status: UpdateStatus;
  update: UpdateHandle | null;
  progress: number;
  error: string | null;
  /** True when the in-flight/last check was user-initiated (menu). The
   *  toast only surfaces the transient checking/up-to-date/error states
   *  for manual checks — the launch auto-check stays silent unless an
   *  update is actually found. */
  manualCheck: boolean;
  /** Monotonic counters so synchronous/batched `Promise.resolve(null)` checks
   *  and repeated manual checks still drive toast transitions. */
  manualCheckSeq: number;
  upToDateSeq: number;
  checkForUpdate: (opts?: { manual?: boolean }) => Promise<void>;
  downloadAndInstall: () => Promise<void>;
  restart: () => Promise<void>;
}

export function useUpdateChecker(): UpdateState {
  const [status, setStatus] = useState<UpdateStatus>("idle");
  const [update, setUpdate] = useState<UpdateHandle | null>(null);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [manualCheck, setManualCheck] = useState(false);
  const [manualCheckSeq, setManualCheckSeq] = useState(0);
  const [upToDateSeq, setUpToDateSeq] = useState(0);
  const checking = useRef(false);
  const manualCheckRef = useRef(false);

  const checkForUpdate = useCallback(async (opts?: { manual?: boolean }) => {
    if (checking.current) {
      // A check is already running (e.g. the silent launch check). If
      // this one is manual (menu), promote it so the in-flight result
      // still surfaces checking/up-to-date feedback instead of being a
      // visible no-op.
      if (opts?.manual) {
        manualCheckRef.current = true;
        setManualCheck(true);
        setManualCheckSeq((n) => n + 1);
      }
      return;
    }
    checking.current = true;
    const isManual = opts?.manual ?? false;
    manualCheckRef.current = isManual;
    setManualCheck(isManual);
    if (isManual) {
      setManualCheckSeq((n) => n + 1);
    }
    setStatus("checking");
    setError(null);
    try {
      const result = await platformCheckForUpdate();
      if (result) {
        setUpdate(result);
        setStatus("available");
      } else {
        if (manualCheckRef.current) {
          setUpToDateSeq((n) => n + 1);
        }
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
    manualCheckRef.current = true;
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
          setStatus("verifying");
        }
      });
      setStatus("ready");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStatus("error");
    }
  }, [update]);

  const restart = useCallback(async () => {
    try {
      await relaunch();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStatus("error");
    }
  }, []);

  return {
    status,
    update,
    progress,
    error,
    manualCheck,
    manualCheckSeq,
    upToDateSeq,
    checkForUpdate,
    downloadAndInstall,
    restart,
  };
}
