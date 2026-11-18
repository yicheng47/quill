import { useState, useEffect, useCallback, useRef } from "react";
import { createPortal } from "react-dom";
import { getAppVersion, invoke, listen } from "../../platform";
import {
  AlertTriangle,
  Cloud,
  CloudOff,
  Laptop,
  Layers,
  Loader2,
  Monitor,
  RefreshCw,
  RotateCcw,
  Smartphone,
  Trash2,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import Button from "../ui/Button";
import ProgressBar from "../ui/ProgressBar";
import Switch from "../ui/Switch";
import { StatusBadge } from "../ui/Badge";
import { SettingsGroup, SettingsOverline, SettingsRow } from "../ui/SettingsRow";
import type { SettingsProps } from "./types";

export interface PeerInfo {
  device_uuid: string;
  name: string;
  platform: string;
  app_version: string;
  last_seen: number;
  pending_events: number;
}

export interface SyncStatus {
  enabled: boolean;
  available: boolean;
  sync_enabled: boolean;
  shared_dir: string | null;
  device_uuid: string;
  device_name: string;
  peers: PeerInfo[];
  pending_events: number;
  last_replay_at: number | null;
}

interface SyncNowResult {
  outbox_flushed: number;
  snapshots_applied: number;
  events_applied: number;
  peers_seen: number;
}

interface SyncCompactResult {
  events_folded: number;
  snapshot_written: boolean;
  bytes_freed: number;
}

export interface SyncDisableProgress {
  phase: "preparing" | "downloading" | "copying" | "skipped" | "done";
  copied: number;
  total: number;
  current: string | null;
}

interface SyncProgressPayload {
  applied: number;
  total: number;
}

function formatRelative(
  ts: number | null,
  now: number,
  t: (key: string, opts?: Record<string, unknown>) => string,
): string {
  if (ts == null) return "—";
  const diffSec = Math.max(0, Math.floor((now - ts) / 1000));
  if (diffSec < 60) return t("settings.updates.relativeJustNow");
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return t("settings.updates.relativeMinutes", { count: diffMin });
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return t("settings.updates.relativeHours", { count: diffHr });
  const diffDay = Math.floor(diffHr / 24);
  return t("settings.updates.relativeDays", { count: diffDay });
}

function platformIcon(platform: string) {
  if (platform === "ios") return Smartphone;
  if (platform === "macos") return Laptop;
  return Monitor;
}

function progressPercent(progress: SyncDisableProgress): number {
  if (progress.total <= 0) return progress.phase === "done" ? 100 : 0;
  return Math.min(100, Math.round((progress.copied / progress.total) * 100));
}

interface LibrarySyncSettingsProps extends SettingsProps {
  onBlockingChange?: (blocking: boolean) => void;
}

export default function LibrarySyncSettings({
  onBlockingChange,
}: LibrarySyncSettingsProps) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [appVersion, setAppVersion] = useState("");
  const [loadingStatus, setLoadingStatus] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<"enable" | "disable" | null>(null);
  // Tracks the toggle action that returned an error so the Retry
  // button can re-invoke it. Without this, after a failed enable
  // that committed the marker, the next toggle click would open the
  // Disable flow (because `sync_enabled` is now true), leaving
  // the user with no UI path to finish the half-completed enable.
  const [lastFailedAction, setLastFailedAction] = useState<"enable" | "disable" | null>(null);
  const [pendingRemoval, setPendingRemoval] = useState<PeerInfo | null>(null);
  const [confirmRebuild, setConfirmRebuild] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [syncing, setSyncing] = useState(false);
  const [syncProgress, setSyncProgress] = useState<SyncProgressPayload | null>(null);
  const [disableProgress, setDisableProgress] = useState<SyncDisableProgress | null>(null);

  const copyingDialogRef = useRef<HTMLDivElement>(null);
  const removeCancelRef = useRef<HTMLButtonElement>(null);
  const rebuildCancelRef = useRef<HTMLButtonElement>(null);

  const refresh = useCallback(async () => {
    setLoadingStatus(true);
    try {
      const next = await invoke<SyncStatus>("sync_status");
      setStatus(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingStatus(false);
    }
  }, []);

  useEffect(() => {
    void getAppVersion()
      .then(setAppVersion)
      .catch(() => {});
  }, []);

  useEffect(() => {
    const unProgress = listen<SyncProgressPayload>("sync-progress", (e) => {
      setSyncing(true);
      setSyncProgress(e.payload ?? null);
    });
    const unDone = listen("sync-initial-tick-done", () => {
      setSyncing(false);
      setSyncProgress(null);
      void refresh();
    });
    const unStatusChanged = listen("sync-status-changed", () => {
      void refresh();
    });
    const unDisableProgress = listen<SyncDisableProgress>("sync-disable-progress", (e) => {
      setDisableProgress(e.payload);
    });
    return () => {
      void unProgress.then((fn) => fn()).catch(() => {});
      void unDone.then((fn) => fn()).catch(() => {});
      void unStatusChanged.then((fn) => fn()).catch(() => {});
      void unDisableProgress.then((fn) => fn()).catch(() => {});
    };
  }, [refresh]);

  useEffect(() => {
    void refresh();
    const interval = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(interval);
  }, [refresh]);

  useEffect(() => {
    onBlockingChange?.(disableProgress !== null);
    if (disableProgress !== null) {
      copyingDialogRef.current?.focus();
    }
    return () => onBlockingChange?.(false);
  }, [disableProgress, onBlockingChange]);

  useEffect(() => {
    if (pendingRemoval) {
      removeCancelRef.current?.focus();
    }
  }, [pendingRemoval]);

  useEffect(() => {
    if (confirmRebuild) {
      rebuildCancelRef.current?.focus();
    }
  }, [confirmRebuild]);

  useEffect(() => {
    const hasModal =
      confirm !== null ||
      pendingRemoval !== null ||
      confirmRebuild ||
      disableProgress !== null;
    if (!hasModal) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (disableProgress !== null) {
        if (
          e.key === "Escape" ||
          e.key === "Tab" ||
          e.key === "Enter" ||
          e.key === " "
        ) {
          e.preventDefault();
          e.stopPropagation();
          e.stopImmediatePropagation();
        }
        return;
      }
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      if (pendingRemoval) {
        setPendingRemoval(null);
      } else if (confirmRebuild) {
        setConfirmRebuild(false);
      } else if (confirm) {
        setConfirm(null);
      }
    };
    document.addEventListener("keydown", handleKeyDown, true);
    return () => document.removeEventListener("keydown", handleKeyDown, true);
  }, [confirm, pendingRemoval, confirmRebuild, disableProgress]);

  const onToggleClick = () => {
    if (!status) return;
    // Action mirrors the rendered toggle, which reflects persisted
    // intent (`sync_enabled`) not runtime state (`enabled`).
    // Using `enabled` here meant a queue-only/offline session showed
    // the toggle as on but opened the Enable flow on click.
    setConfirm(status.sync_enabled ? "disable" : "enable");
  };

  const runToggle = async (action: "enable" | "disable") => {
    setBusy(true);
    setError(null);
    try {
      const minDelay = new Promise((r) => setTimeout(r, 1500));
      if (action === "disable") {
        setDisableProgress({ phase: "preparing", copied: 0, total: 0, current: null });
        await Promise.all([invoke("sync_disable"), minDelay]);
      } else {
        await Promise.all([invoke("sync_enable"), minDelay]);
      }
      setLastFailedAction(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setLastFailedAction(action);
    } finally {
      // Always refresh — sync_enable's Phase 2 may have committed
      // the marker before erroring on the binary move, so a failed
      // call can still flip the durable "sync on" state.
      await refresh();
      setDisableProgress(null);
      setBusy(false);
    }
  };

  const onConfirmToggle = async () => {
    const action = confirm;
    setConfirm(null);
    if (!action) return;
    await runToggle(action);
  };

  const onRetry = async () => {
    if (lastFailedAction) {
      await runToggle(lastFailedAction);
    } else {
      setError(null);
      await refresh();
    }
  };

  const onSyncNow = async () => {
    setBusy(true);
    setError(null);
    try {
      await invoke<SyncNowResult>("sync_now");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const onConfirmRemovePeer = async () => {
    const peer = pendingRemoval;
    setPendingRemoval(null);
    if (!peer) return;
    setBusy(true);
    setError(null);
    try {
      await invoke("sync_remove_peer", { deviceUuid: peer.device_uuid });
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const onRebuild = async () => {
    setConfirmRebuild(false);
    setBusy(true);
    setError(null);
    try {
      await invoke<SyncNowResult>("sync_rebuild");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const onCompact = async () => {
    setBusy(true);
    setError(null);
    try {
      await invoke<SyncCompactResult>("sync_compact");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const syncOn = status?.sync_enabled ?? false;
  const engineRunning = status?.enabled ?? false;
  const available = status?.available ?? false;
  const peers = status?.peers ?? [];
  const initialStatusLoading = loadingStatus && !status;
  const disableProgressValue = disableProgress ? progressPercent(disableProgress) : 0;
  const syncPercent =
    syncProgress && syncProgress.total > 0
      ? Math.min(100, Math.round((syncProgress.applied / syncProgress.total) * 100))
      : 0;
  const lastSyncTime = formatRelative(status?.last_replay_at ?? null, now, t);
  const pendingEvents = status?.pending_events ?? 0;

  const modalOverlays =
    confirm !== null ||
    disableProgress !== null ||
    pendingRemoval !== null ||
    confirmRebuild ? (
      <>
        {/* Turn on / Turn off iCloud Sync confirmation */}
        {confirm && (
          <div
            className="fixed inset-0 z-[60] bg-[#15151A]/26 backdrop-blur-[6px] flex items-center justify-center p-4"
            onClick={(e) => {
              if (e.target === e.currentTarget) setConfirm(null);
            }}
          >
            <div
              role="dialog"
              aria-modal="true"
              aria-labelledby="sync-toggle-confirm-title"
              className="w-full max-w-[460px] p-[22px] rounded-[24px] bg-surface-solid border border-border-subtle shadow-menu flex flex-col gap-4"
            >
              <div className="flex flex-col gap-2">
                <div className="flex items-center gap-2.5">
                  <div
                    className={`size-8 rounded-[10px] flex items-center justify-center shrink-0 ${
                      confirm === "enable"
                        ? "bg-accent-tint text-accent-on-tint"
                        : "bg-warning-tint text-warning"
                    }`}
                  >
                    {confirm === "enable" ? <Cloud size={15} /> : <CloudOff size={15} />}
                  </div>
                  <h3
                    id="sync-toggle-confirm-title"
                    className="text-[16.5px] font-semibold text-text-primary tracking-[-0.3px]"
                  >
                    {confirm === "enable"
                      ? t("settings.librarySync.confirmEnable")
                      : t("settings.librarySync.confirmDisable")}
                  </h3>
                </div>
                <p className="text-[13px] text-text-secondary leading-[1.5]">
                  {confirm === "enable"
                    ? t("settings.librarySync.confirmEnableMsg")
                    : t("settings.librarySync.confirmDisableMsg")}
                </p>
              </div>
              <div className="flex items-center justify-end gap-2">
                <Button variant="secondary" size="sm" onClick={() => setConfirm(null)}>
                  {t("common.cancel")}
                </Button>
                <Button variant="primary" size="sm" onClick={() => void onConfirmToggle()}>
                  {confirm === "enable"
                    ? t("settings.librarySync.confirmEnableCta")
                    : t("settings.librarySync.confirmDisableCta")}
                </Button>
              </div>
            </div>
          </div>
        )}

        {/* Blocking local copy verification modal (non-dismissible) */}
        {disableProgress && (
          <div className="fixed inset-0 z-[70] bg-[#15151A]/26 backdrop-blur-[6px] flex items-center justify-center p-4">
            <div
              ref={copyingDialogRef}
              tabIndex={-1}
              role="dialog"
              aria-modal="true"
              aria-labelledby="sync-copying-title"
              className="w-full max-w-[460px] p-[22px] rounded-[24px] bg-surface-solid border border-violet-200 shadow-menu flex flex-col gap-3.5 focus:outline-none"
            >
              <div className="flex items-center gap-2.5">
                <Loader2 size={18} className="text-accent animate-spin shrink-0" />
                <h3
                  id="sync-copying-title"
                  className="text-[16.5px] font-semibold text-text-primary tracking-[-0.3px]"
                >
                  {t("settings.librarySync.copyingTitle")}
                </h3>
              </div>
              <p className="text-[13px] text-text-secondary leading-[1.5]">
                {t("settings.librarySync.copyingMsg")}
              </p>
              <div className="flex items-center justify-between gap-2">
                <p className="text-[12.5px] font-semibold text-text-primary">
                  {disableProgress.total > 0
                    ? t("settings.librarySync.copyPhaseWithCount", {
                        phase: t(`settings.librarySync.copyPhase.${disableProgress.phase}`),
                        copied: disableProgress.copied,
                        total: disableProgress.total,
                      })
                    : t(`settings.librarySync.copyPhase.${disableProgress.phase}`)}
                </p>
                <p className="font-mono text-[12px] text-accent-on-tint">
                  {disableProgress.total > 0
                    ? `${disableProgressValue}%`
                    : t("settings.librarySync.working")}
                </p>
              </div>
              <ProgressBar
                value={disableProgress.total > 0 ? disableProgressValue : 12}
                className="h-2 rounded-[4px]"
              />
              {disableProgress.current && (
                <p className="font-mono text-[11.5px] text-text-tertiary truncate">
                  {disableProgress.current}
                </p>
              )}
            </div>
          </div>
        )}

        {/* Remove peer confirmation (Cancel-focused) */}
        {pendingRemoval && (
          <div
            className="fixed inset-0 z-[60] bg-[#15151A]/26 backdrop-blur-[6px] flex items-center justify-center p-4"
            onClick={(e) => {
              if (e.target === e.currentTarget) setPendingRemoval(null);
            }}
          >
            <div
              role="dialog"
              aria-modal="true"
              aria-labelledby="sync-remove-peer-title"
              className="w-full max-w-[460px] p-[22px] rounded-[24px] bg-surface-solid border border-border-subtle shadow-menu flex flex-col gap-4"
            >
              <div className="flex flex-col gap-2">
                <div className="flex items-center gap-2.5">
                  <div className="size-8 rounded-[10px] bg-danger-tint flex items-center justify-center text-danger shrink-0">
                    <Trash2 size={15} />
                  </div>
                  <h3
                    id="sync-remove-peer-title"
                    className="text-[16.5px] font-semibold text-text-primary tracking-[-0.3px] truncate"
                  >
                    {t("settings.librarySync.removeDeviceTitle", { name: pendingRemoval.name })}
                  </h3>
                </div>
                <p className="text-[13px] text-text-secondary leading-[1.5]">
                  {t("settings.librarySync.removeDeviceBody")}
                </p>
              </div>
              <div className="flex items-center justify-end gap-2">
                <button
                  ref={removeCancelRef}
                  type="button"
                  onClick={() => setPendingRemoval(null)}
                  className="px-[15px] py-2 rounded-control bg-surface-chip border-[1.5px] border-accent text-[13px] font-medium text-text-primary hover:bg-surface-inset cursor-pointer transition-colors focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-focus-ring"
                >
                  {t("common.cancel")}
                </button>
                <button
                  type="button"
                  onClick={() => void onConfirmRemovePeer()}
                  className="px-4 py-2 rounded-control bg-danger hover:bg-danger-hover text-white text-[13px] font-semibold cursor-pointer transition-colors"
                >
                  {t("settings.librarySync.remove")}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Rebuild library confirmation (Cancel-focused) */}
        {confirmRebuild && (
          <div
            className="fixed inset-0 z-[60] bg-[#15151A]/26 backdrop-blur-[6px] flex items-center justify-center p-4"
            onClick={(e) => {
              if (e.target === e.currentTarget) setConfirmRebuild(false);
            }}
          >
            <div
              role="dialog"
              aria-modal="true"
              aria-labelledby="sync-rebuild-title"
              className="w-full max-w-[460px] p-[22px] rounded-[24px] bg-surface-solid border border-border-subtle shadow-menu flex flex-col gap-4"
            >
              <div className="flex flex-col gap-2">
                <div className="flex items-center gap-2.5">
                  <div className="size-8 rounded-[10px] bg-danger-tint flex items-center justify-center text-danger shrink-0">
                    <RotateCcw size={15} />
                  </div>
                  <h3
                    id="sync-rebuild-title"
                    className="text-[16.5px] font-semibold text-text-primary tracking-[-0.3px]"
                  >
                    {t("settings.librarySync.rebuildConfirmTitle")}
                  </h3>
                </div>
                <p className="text-[13px] text-text-secondary leading-[1.5]">
                  {t("settings.librarySync.rebuildConfirmMsg")}
                </p>
              </div>
              <div className="flex items-center justify-end gap-2">
                <button
                  ref={rebuildCancelRef}
                  type="button"
                  onClick={() => setConfirmRebuild(false)}
                  className="px-[15px] py-2 rounded-control bg-surface-chip border-[1.5px] border-accent text-[13px] font-medium text-text-primary hover:bg-surface-inset cursor-pointer transition-colors focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-focus-ring"
                >
                  {t("common.cancel")}
                </button>
                <button
                  type="button"
                  onClick={() => void onRebuild()}
                  className="px-4 py-2 rounded-control bg-danger hover:bg-danger-hover text-white text-[13px] font-semibold cursor-pointer transition-colors"
                >
                  {t("settings.librarySync.rebuildConfirmCta")}
                </button>
              </div>
            </div>
          </div>
        )}
      </>
    ) : null;

  return (
    <>
      <div className="flex flex-col gap-6">
        {/* ICLOUD section */}
        <section className="flex flex-col gap-2.5">
          <SettingsOverline>{t("settings.librarySync.icloudGroup")}</SettingsOverline>
          <SettingsGroup>
            {busy || initialStatusLoading ? (
              <div className="min-h-[72px] px-5 py-3 flex items-center gap-2.5">
                <Loader2 size={16} className="text-text-tertiary animate-spin shrink-0" />
                <p className="text-[13.5px] text-text-secondary">
                  {t("settings.librarySync.working")}
                </p>
              </div>
            ) : (
              <>
                <SettingsRow
                  title={t("settings.librarySync.toggle")}
                  hint={
                    !available && !syncOn
                      ? t("settings.librarySync.signIn")
                      : syncOn && !engineRunning
                        ? t("settings.librarySync.paused")
                        : syncOn
                          ? t("settings.librarySync.toggleSub")
                          : t("settings.librarySync.offSub")
                  }
                >
                  <Switch
                    aria-label={t("settings.librarySync.toggle")}
                    checked={syncOn}
                    onChange={onToggleClick}
                    disabled={!available && !syncOn}
                  />
                </SettingsRow>

                {!available && !syncOn && (
                  <div
                    data-testid="icloud-unavailable-hint"
                    className="px-5 py-3 bg-warning-tint flex items-center gap-2.5 text-warning text-[12.5px]"
                  >
                    <CloudOff size={15} className="shrink-0" />
                    <span>{t("settings.librarySync.unavailableBanner")}</span>
                  </div>
                )}

                {syncOn && !syncing && (
                  <SettingsRow
                    title={t("settings.librarySync.statusRow")}
                    hint={
                      !engineRunning && pendingEvents > 0
                        ? t("settings.librarySync.queuedStatus", {
                            count: pendingEvents,
                            time: lastSyncTime,
                          })
                        : t("settings.librarySync.lastSyncAt", { time: lastSyncTime })
                    }
                  >
                    <StatusBadge
                      tone={engineRunning ? "success" : "warning"}
                      label={
                        engineRunning
                          ? t("settings.librarySync.syncedBadge")
                          : t("settings.librarySync.pausedBadge")
                      }
                    />
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={busy || !engineRunning}
                      title={!engineRunning ? t("settings.librarySync.paused") : undefined}
                      onClick={() => void onCompact()}
                    >
                      <Layers size={13.5} className="text-text-secondary" />
                      <span>{t("settings.librarySync.compact")}</span>
                    </Button>
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={busy || !engineRunning}
                      title={!engineRunning ? t("settings.librarySync.paused") : undefined}
                      onClick={() => void onSyncNow()}
                    >
                      <RefreshCw size={13.5} className="text-text-secondary" />
                      <span>{t("settings.librarySync.syncNow")}</span>
                    </Button>
                  </SettingsRow>
                )}
              </>
            )}
          </SettingsGroup>

          {!syncOn && available && (
            <p className="text-[12.5px] text-text-tertiary leading-[1.5]">
              {t("settings.librarySync.offMergeNote")}
            </p>
          )}
        </section>

        {/* Active syncing progress card */}
        {syncOn && syncing && (
          <div
            data-testid="sync-active-card"
            className="bg-surface-solid border border-violet-200 rounded-[14px] p-5 flex flex-col gap-3"
          >
            <div className="flex items-center justify-between gap-4">
              <div className="flex items-center gap-2.5 min-w-0">
                <Loader2 size={18} className="text-accent animate-spin shrink-0" />
                <div className="min-w-0">
                  <p className="text-[14px] font-semibold text-text-primary">
                    {t("settings.librarySync.syncingTitle")}
                  </p>
                  <p className="font-mono text-[11.5px] text-text-secondary mt-0.5">
                    {syncProgress && syncProgress.total > 0
                      ? t("settings.librarySync.syncingProgressDetail", {
                          applied: syncProgress.applied,
                          total: syncProgress.total,
                          percent: syncPercent,
                        })
                      : t("settings.librarySync.syncingPreparing")}
                  </p>
                </div>
              </div>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => void invoke("sync_cancel")}
              >
                {t("settings.librarySync.cancelSync")}
              </Button>
            </div>
            <ProgressBar value={syncProgress && syncProgress.total > 0 ? syncPercent : 15} />
          </div>
        )}

        {/* Error banner */}
        {error && (
          <div
            role="alert"
            data-testid="sync-error-banner"
            className="bg-danger-tint border border-[#D93F4C33] rounded-[14px] px-[18px] py-3.5 flex items-center justify-between gap-4"
          >
            <div className="flex items-center gap-3 min-w-0">
              <AlertTriangle size={17} className="text-danger shrink-0" />
              <div className="min-w-0">
                <p className="text-[13.5px] font-semibold text-text-primary break-words">
                  {error}
                </p>
                {lastFailedAction && (
                  <p className="text-[12.5px] text-danger mt-0.5">
                    {t("settings.librarySync.retryHint")}
                  </p>
                )}
              </div>
            </div>
            <Button
              variant="primary"
              size="sm"
              disabled={busy}
              onClick={() => void onRetry()}
            >
              <RefreshCw size={13.5} />
              <span>{t("settings.ai.retry")}</span>
            </Button>
          </div>
        )}

        {/* DEVICES & REPAIR when sync intent is ON */}
        {syncOn && (
          <>
            <section className="flex flex-col gap-2.5">
              <SettingsOverline>{t("settings.librarySync.devicesGroup")}</SettingsOverline>
              {status && (
                <SettingsGroup>
                  {/* This Mac */}
                  <div className="min-h-[64px] px-5 py-2.5 flex items-center justify-between gap-4">
                    <div className="flex items-center gap-3 min-w-0">
                      <div className="size-[34px] rounded-[10px] bg-surface-solid border border-border-subtle flex items-center justify-center shrink-0">
                        <Laptop size={16} className="text-accent-on-tint" />
                      </div>
                      <div className="min-w-0">
                        <p className="text-[14px] font-medium text-text-primary truncate">
                          {status.device_name}
                        </p>
                        <p className="text-[12px] text-text-tertiary truncate">
                          {!engineRunning && pendingEvents > 0
                            ? t("settings.librarySync.thisDeviceQueued", { count: pendingEvents })
                            : appVersion
                              ? t("settings.librarySync.thisDeviceVersion", { version: appVersion })
                              : t("settings.librarySync.thisDevice")}
                        </p>
                      </div>
                    </div>
                    <span className="px-2.5 py-1 rounded-full bg-accent-tint text-accent-on-tint text-[11.5px] font-semibold shrink-0">
                      {t("settings.librarySync.thisMacBadge")}
                    </span>
                  </div>

                  {/* Peer devices */}
                  {peers.map((p) => {
                    const Icon = platformIcon(p.platform);
                    const lastSeen = formatRelative(p.last_seen, now, t);
                    return (
                      <div
                        key={p.device_uuid}
                        className="min-h-[64px] px-5 py-2.5 flex items-center justify-between gap-4"
                      >
                        <div className="flex items-center gap-3 min-w-0">
                          <div className="size-[34px] rounded-[10px] bg-surface-solid border border-border-subtle flex items-center justify-center shrink-0">
                            <Icon size={16} className="text-text-secondary" />
                          </div>
                          <div className="min-w-0">
                            <p className="text-[14px] font-medium text-text-primary truncate">
                              {p.name}
                            </p>
                            <p className="text-[12px] text-text-tertiary truncate">
                              {p.app_version
                                ? t("settings.librarySync.lastSeenVersion", {
                                    time: lastSeen,
                                    version: p.app_version,
                                  })
                                : t("settings.librarySync.lastSeen", { time: lastSeen })}
                            </p>
                          </div>
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          {p.pending_events > 0 && (
                            <span className="px-[9px] py-[3px] rounded-full bg-surface-solid border border-border-subtle font-mono text-[11px] text-text-secondary">
                              {t("settings.librarySync.pendingEvents", { count: p.pending_events })}
                            </span>
                          )}
                          <button
                            type="button"
                            onClick={() => setPendingRemoval(p)}
                            disabled={busy || !engineRunning}
                            aria-label={t("settings.librarySync.removeDeviceNamed", { name: p.name })}
                            title={t("settings.librarySync.removeDevice")}
                            className="size-[30px] rounded-[8px] flex items-center justify-center text-text-tertiary hover:text-danger hover:bg-danger-tint/60 disabled:opacity-35 disabled:cursor-not-allowed cursor-pointer transition-colors"
                          >
                            <Trash2 size={14} />
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </SettingsGroup>
              )}

              {peers.length === 0 && (
                <div
                  data-testid="sync-empty-peers-card"
                  className="bg-surface-solid border border-border-subtle rounded-[14px] px-5 py-[22px] flex items-center gap-3.5"
                >
                  <div className="size-[38px] rounded-[12px] bg-surface-inset border border-border-subtle flex items-center justify-center shrink-0">
                    <Laptop size={17} className="text-text-tertiary" />
                  </div>
                  <div className="min-w-0">
                    <p className="text-[13.5px] font-semibold text-text-primary">
                      {t("settings.librarySync.onlyThisMacTitle")}
                    </p>
                    <p className="text-[12.5px] text-text-tertiary leading-[1.45] mt-0.5">
                      {t("settings.librarySync.noPeers")}
                    </p>
                  </div>
                </div>
              )}

              <p className="text-[12.5px] text-text-tertiary leading-[1.45]">
                {t("settings.librarySync.privacyAndMergeNote")}
              </p>
            </section>

            {/* REPAIR section */}
            <section
              className={`flex flex-col gap-2.5 ${!engineRunning ? "opacity-50" : ""}`}
            >
              <SettingsOverline>{t("settings.librarySync.repairGroup")}</SettingsOverline>
              <SettingsGroup>
                <SettingsRow
                  title={t("settings.librarySync.rebuild")}
                  hint={
                    !engineRunning
                      ? t("settings.librarySync.rebuildPausedHint")
                      : t("settings.librarySync.rebuildSub")
                  }
                >
                  <button
                    type="button"
                    onClick={() => setConfirmRebuild(true)}
                    disabled={busy || syncing || !engineRunning}
                    title={!engineRunning ? t("settings.librarySync.paused") : undefined}
                    className="px-3.5 py-[7px] rounded-control bg-danger-tint border border-[#D93F4C33] text-danger text-[13px] font-semibold inline-flex items-center gap-1.5 cursor-pointer hover:bg-danger/15 transition-colors disabled:opacity-50 disabled:cursor-not-allowed shrink-0"
                  >
                    <RotateCcw size={13.5} />
                    <span>{t("settings.librarySync.rebuildCta")}</span>
                  </button>
                </SettingsRow>
              </SettingsGroup>
            </section>
          </>
        )}
      </div>

      {modalOverlays && typeof document !== "undefined"
        ? createPortal(modalOverlays, document.body)
        : modalOverlays}
    </>
  );
}
