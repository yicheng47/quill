import { useState, useCallback, useRef, useEffect } from "react";
import {
  cancelUpdateDownload as platformCancelUpdateDownload,
  checkForUpdate as platformCheckForUpdate,
  invoke,
  relaunch,
  type UpdateHandle,
} from "../platform";

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
  downloadedBytes: number;
  totalBytes: number;
  lastCheckedAt: number | null;
  skippedVersion: string | null;
  error: string | null;
  /** True when the in-flight/last check was user-initiated (menu or Settings).
   *  The TopBar indicator only surfaces transient checking/up-to-date states
   *  for manual checks — the launch auto-check stays silent unless an update
   *  is actually found. */
  manualCheck: boolean;
  /** Monotonic counters so synchronous/batched `Promise.resolve(null)` checks
   *  and repeated manual checks still drive transitions. */
  manualCheckSeq: number;
  upToDateSeq: number;
  checkForUpdate: (opts?: { manual?: boolean }) => Promise<void>;
  downloadAndInstall: () => Promise<void>;
  cancelDownload: () => Promise<void>;
  skipVersion: (version: string) => Promise<void>;
  restart: () => Promise<void>;
}

function parseTimestamp(raw: string | undefined): number | null {
  if (!raw) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

async function persistSetting(key: string, value: string): Promise<void> {
  if (typeof invoke !== "function") return;
  try {
    await invoke("set_setting", { key, value });
  } catch {
    // Best-effort persistence; never block update UI flows.
  }
}

export function useUpdateChecker(): UpdateState {
  const [status, setStatus] = useState<UpdateStatus>("idle");
  const [update, setUpdate] = useState<UpdateHandle | null>(null);
  const [progress, setProgress] = useState(0);
  const [downloadedBytes, setDownloadedBytes] = useState(0);
  const [totalBytes, setTotalBytes] = useState(0);
  const [lastCheckedAt, setLastCheckedAt] = useState<number | null>(null);
  const [skippedVersion, setSkippedVersion] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [manualCheck, setManualCheck] = useState(false);
  const [manualCheckSeq, setManualCheckSeq] = useState(0);
  const [upToDateSeq, setUpToDateSeq] = useState(0);
  const checking = useRef(false);
  const manualCheckRef = useRef(false);
  const downloadingRef = useRef(false);
  const skippedVersionRef = useRef<string | null>(null);
  const initPromiseRef = useRef<Promise<void> | null>(null);

  useEffect(() => {
    if (typeof invoke !== "function") {
      initPromiseRef.current = Promise.resolve();
      return;
    }
    let active = true;
    const init = invoke<Record<string, string>>("get_all_settings")
      .then((settings) => {
        if (!active || !settings) return;
        const ts = parseTimestamp(settings.last_update_check_at);
        if (ts !== null) {
          setLastCheckedAt((prev) => prev ?? ts);
        }
        const skipped = settings.skipped_update_version?.trim() || null;
        if (skipped && skippedVersionRef.current === null) {
          skippedVersionRef.current = skipped;
          setSkippedVersion(skipped);
        }
      })
      .catch(() => {});
    initPromiseRef.current = init;
    return () => {
      active = false;
    };
  }, []);

  const checkForUpdate = useCallback(async (opts?: { manual?: boolean }) => {
    if (checking.current) {
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
      await initPromiseRef.current;
      const result = await platformCheckForUpdate();
      const checkedAt = Date.now();
      setLastCheckedAt(checkedAt);
      void persistSetting("last_update_check_at", String(checkedAt));

      const isSkipped =
        !manualCheckRef.current &&
        result !== null &&
        skippedVersionRef.current !== null &&
        result.version === skippedVersionRef.current;

      if (result && !isSkipped) {
        setUpdate(result);
        setTotalBytes(result.sizeBytes ?? 0);
        setDownloadedBytes(0);
        setProgress(0);
        setStatus("available");
      } else {
        setUpdate(null);
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
    if (!update || downloadingRef.current) return;
    downloadingRef.current = true;
    manualCheckRef.current = true;
    setManualCheck(true);
    setError(null);
    setStatus("downloading");
    setProgress(0);
    setDownloadedBytes(0);
    let totalLen = update.sizeBytes ?? 0;
    setTotalBytes(totalLen);

    if (skippedVersionRef.current === update.version) {
      skippedVersionRef.current = null;
      setSkippedVersion(null);
      void persistSetting("skipped_update_version", "");
    }

    try {
      let downloaded = 0;
      const result = await update.downloadAndInstall((event) => {
        if (event.event === "Started" && event.data.contentLength) {
          totalLen = event.data.contentLength;
          setTotalBytes(totalLen);
        } else if (event.event === "Progress") {
          downloaded += event.data.chunkLength;
          setDownloadedBytes(downloaded);
          if (totalLen > 0) {
            setProgress(Math.round((downloaded / totalLen) * 100));
          }
        } else if (event.event === "Finished") {
          setProgress(100);
          if (totalLen > 0) {
            setDownloadedBytes(totalLen);
          }
          setStatus("verifying");
        }
      });

      if (result?.cancelled) {
        setProgress(0);
        setDownloadedBytes(0);
        setTotalBytes(update.sizeBytes ?? 0);
        setError(null);
        setStatus("available");
        return;
      }

      setStatus("ready");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStatus("error");
    } finally {
      downloadingRef.current = false;
    }
  }, [update]);

  const cancelDownload = useCallback(async () => {
    if (!downloadingRef.current || status !== "downloading") return;
    if (typeof platformCancelUpdateDownload === "function") {
      try {
        await platformCancelUpdateDownload();
      } catch {
        // Ignore IPC errors; authoritative downloadAndInstall() settlement drives state.
      }
    }
  }, [status]);

  const skipVersion = useCallback(async (version: string) => {
    skippedVersionRef.current = version;
    setSkippedVersion(version);
    setUpdate(null);
    setProgress(0);
    setDownloadedBytes(0);
    setTotalBytes(0);
    setError(null);
    setStatus("idle");
    await persistSetting("skipped_update_version", version);
  }, []);

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
    downloadedBytes,
    totalBytes,
    lastCheckedAt,
    skippedVersion,
    error,
    manualCheck,
    manualCheckSeq,
    upToDateSeq,
    checkForUpdate,
    downloadAndInstall,
    cancelDownload,
    skipVersion,
    restart,
  };
}
