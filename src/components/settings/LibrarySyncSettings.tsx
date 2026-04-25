import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Loader2, Monitor, Smartphone, Laptop, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import Button from "../ui/Button";
import Toggle from "../ui/Toggle";
import type { SettingsProps } from "./types";

interface PeerInfo {
  device_uuid: string;
  name: string;
  platform: string;
  app_version: string;
  last_seen: number;
  pending_events: number;
}

interface SyncStatus {
  enabled: boolean;
  available: boolean;
  migration_complete: boolean;
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

function formatRelative(ts: number | null, now: number): string {
  if (ts == null) return "—";
  const diffSec = Math.max(0, Math.floor((now - ts) / 1000));
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  return `${diffDay}d ago`;
}

function platformIcon(platform: string) {
  if (platform === "ios") return Smartphone;
  if (platform === "macos") return Laptop;
  return Monitor;
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export default function LibrarySyncSettings(_props: SettingsProps) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<"enable" | "disable" | null>(null);
  // Tracks the toggle action that returned an error so the Retry
  // button can re-invoke it. Without this, after a failed enable
  // that committed the marker, the next toggle click would open the
  // Disable flow (because `migration_complete` is now true), leaving
  // the user with no UI path to finish the half-completed enable.
  const [lastFailedAction, setLastFailedAction] = useState<"enable" | "disable" | null>(null);
  // Peer the user clicked the trash icon on; opens a confirmation
  // modal until cleared (cancel) or acted on (remove).
  const [pendingRemoval, setPendingRemoval] = useState<PeerInfo | null>(null);
  // Tick once a minute so "Last seen 2m ago" stays fresh while the modal
  // is open. Cheap; the component re-renders are bounded.
  const [now, setNow] = useState(Date.now());

  const refresh = useCallback(async () => {
    try {
      const next = await invoke<SyncStatus>("sync_status");
      setStatus(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    refresh();
    const interval = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(interval);
  }, [refresh]);

  const onToggleClick = () => {
    if (!status) return;
    // Action mirrors the rendered toggle, which reflects persisted
    // intent (`migration_complete`) not runtime state (`enabled`).
    // Using `enabled` here meant a queue-only/offline session showed
    // the toggle as on but opened the Enable flow on click.
    setConfirm(status.migration_complete ? "disable" : "enable");
  };

  const runToggle = async (action: "enable" | "disable") => {
    setBusy(true);
    setError(null);
    try {
      const minDelay = new Promise((r) => setTimeout(r, 1500));
      if (action === "disable") {
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
      // call can still flip the durable "sync on" state. Without
      // refreshing here the toggle would lie about reality and the
      // user wouldn't see they can retry to finish the move.
      await refresh();
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
      // Re-invoke the operation that errored. `sync_enable` is
      // idempotent — the early `engine_snapshot()` guard returns
      // None after a failed move (engine wasn't stored), so we
      // re-enter Phase 1, then Phase 2 skips the already-done
      // small-file writes (idempotent) and retries the move.
      // Same shape for `sync_disable`.
      await runToggle(lastFailedAction);
    } else {
      // No tracked action — just clear the error and pull fresh
      // status so the user can decide what to do next.
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

  // Two orthogonal states surfaced by the backend:
  //  - `migration_complete` is the user's durable intent ("sync is on
  //    for this install"). This drives the Toggle and the visibility
  //    of the "Other devices" / actions sections — if the user said
  //    they want sync, those affordances should stay put even when
  //    the engine happens to be paused this session.
  //  - `enabled` is the per-session runtime state ("engine + watcher
  //    booted in this process"). False during a queue-only session
  //    (iCloud unreachable at launch); new writes still persist into
  //    `_pending_publish` and drain on the next successful boot.
  // Splitting the two keeps a user with sync on but iCloud temporarily
  // offline from seeing the toggle flip itself off — and from being
  // re-offered `sync_enable` as if they never turned it on.
  const syncOn = status?.migration_complete ?? false;
  const engineRunning = status?.enabled ?? false;
  const available = status?.available ?? false;
  const peers = status?.peers ?? [];

  return (
    <>
      <div>
        {/* Sync toggle */}
        <div className="flex items-center justify-between h-[73px]">
          {busy ? (
            <div className="flex items-center gap-2">
              <Loader2 size={16} className="text-text-muted animate-spin" />
              <p className="text-[13px] text-text-muted">
                {t("settings.librarySync.working")}
              </p>
            </div>
          ) : (
            <>
              <div>
                <p className="text-[14px] font-medium text-text-primary tracking-[-0.15px]">
                  {t("settings.librarySync.toggle")}
                </p>
                <p className="text-[12px] text-text-muted mt-0.5">
                  {!available
                    ? t("settings.librarySync.signIn")
                    : syncOn && !engineRunning
                      ? t("settings.librarySync.paused")
                      : t("settings.librarySync.toggleSub")}
                </p>
              </div>
              <Toggle
                checked={syncOn}
                onChange={onToggleClick}
                disabled={!available && !syncOn}
              />
            </>
          )}
        </div>

        {/* Other devices — visible whenever the user has sync on,
            including queue-only sessions where the engine hasn't
            booted this launch. The peer list reads from manifest
            files on disk, not from the running engine, so it's still
            meaningful offline. The empty state still renders so a
            single-device user understands why the list is empty. */}
        {syncOn && (
          <>
            <div className="h-px bg-black/10" />
            <div className="pt-4 pb-2">
              <p className="text-[11px] font-semibold text-text-muted tracking-[0.6px]">
                {t("settings.librarySync.otherDevices").toUpperCase()}
              </p>
              {peers.length === 0 ? (
                <p className="text-[12px] text-text-muted mt-2 leading-[1.5]">
                  {t("settings.librarySync.noPeers")}
                </p>
              ) : (
                <div className="flex flex-col gap-2 mt-3">
                  {peers.map((p) => {
                    const Icon = platformIcon(p.platform);
                    return (
                      <div
                        key={p.device_uuid}
                        className="flex items-center gap-3 bg-bg-muted rounded-[10px] px-3 py-2.5"
                      >
                        <Icon size={16} className="text-text-muted shrink-0" />
                        <div className="flex-1 min-w-0">
                          <p className="text-[13px] font-medium text-text-primary truncate">
                            {p.name}
                          </p>
                          <p className="text-[11px] text-text-muted">
                            {t("settings.librarySync.lastSeen", {
                              time: formatRelative(p.last_seen, now),
                            })}
                          </p>
                        </div>
                        {p.pending_events > 0 && (
                          <span className="text-[11px] font-medium text-text-muted bg-white dark:bg-bg-surface rounded-full px-2 py-0.5">
                            {p.pending_events}
                          </span>
                        )}
                        <button
                          type="button"
                          onClick={() => setPendingRemoval(p)}
                          disabled={busy}
                          aria-label={t("settings.librarySync.removeDevice")}
                          title={t("settings.librarySync.removeDevice")}
                          className="text-text-muted hover:text-[#e7000b] dark:hover:text-red-400 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer p-1 -m-1"
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
            <div className="h-px bg-black/10 mt-3" />

            {/* Actions row. Sync now / Compact log both require the
                engine to be running this session — disable them when
                we're in queue-only mode so the user isn't confused by
                an error toast. The "Last sync" caption still renders
                whatever the backend reports. */}
            <div className="flex items-center justify-between pt-4 pb-2">
              <div className="flex items-center gap-4">
                <button
                  type="button"
                  onClick={onSyncNow}
                  disabled={busy || !engineRunning}
                  title={!engineRunning ? t("settings.librarySync.paused") : undefined}
                  className="text-[13px] font-medium text-[#7c3aed] hover:underline disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
                >
                  {t("settings.librarySync.syncNow")}
                </button>
                <button
                  type="button"
                  onClick={onCompact}
                  disabled={busy || !engineRunning}
                  title={!engineRunning ? t("settings.librarySync.paused") : undefined}
                  className="text-[13px] font-medium text-[#7c3aed] hover:underline disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
                >
                  {t("settings.librarySync.compact")}
                </button>
              </div>
              <p className="text-[12px] text-text-muted">
                {t("settings.librarySync.lastSyncAt", {
                  time: formatRelative(status?.last_replay_at ?? null, now),
                })}
              </p>
            </div>
          </>
        )}

        {/* Notes — always visible. */}
        <div className="h-px bg-black/10 mt-2" />
        <p className="text-[12px] text-text-muted leading-[1.5] mt-3">
          {t("settings.librarySync.keysNote")}
        </p>
        <p className="text-[12px] text-text-muted leading-[1.5] mt-1">
          {t("settings.librarySync.simultaneityNote")}
        </p>

        {/* Error */}
        {error && (
          <div className="flex items-center justify-between bg-[#fef2f2] dark:bg-red-950/30 border border-[#ffc9c9] dark:border-red-800 rounded-lg px-3.5 py-2 mt-3">
            <span className="text-[12px] text-[#e7000b] dark:text-red-400 truncate">
              {error}
            </span>
            <button
              type="button"
              disabled={busy}
              className="text-[12px] font-medium text-[#e7000b] dark:text-red-400 underline cursor-pointer ml-2 shrink-0 disabled:opacity-50 disabled:cursor-not-allowed"
              onClick={onRetry}
            >
              {t("settings.ai.retry")}
            </button>
          </div>
        )}
      </div>

      {/* Remove-device confirmation. Mirrors iOS's destructive alert
          copy so the cross-platform UX matches. */}
      {pendingRemoval && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40">
          <div className="bg-bg-surface rounded-xl shadow-lg w-[400px] p-6">
            <h3 className="text-[18px] font-semibold text-text-primary mb-2">
              {t("settings.librarySync.removeDeviceTitle", { name: pendingRemoval.name })}
            </h3>
            <p className="text-[14px] text-text-secondary leading-5 mb-6">
              {t("settings.librarySync.removeDeviceBody")}
            </p>
            <div className="flex justify-end gap-3">
              <Button variant="ghost" size="md" onClick={() => setPendingRemoval(null)}>
                {t("common.cancel")}
              </Button>
              <button
                type="button"
                onClick={onConfirmRemovePeer}
                className="bg-[#e7000b] hover:bg-[#c00009] text-white text-[14px] font-medium rounded-md px-4 py-2 cursor-pointer"
              >
                {t("settings.librarySync.remove")}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Confirmation dialog — same shape as the legacy iCloud one so
          the UX is identical at the point of decision. */}
      {confirm && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40">
          <div className="bg-bg-surface rounded-xl shadow-lg w-[400px] p-6">
            <h3 className="text-[18px] font-semibold text-text-primary mb-2">
              {confirm === "enable"
                ? t("settings.librarySync.confirmEnable")
                : t("settings.librarySync.confirmDisable")}
            </h3>
            <p className="text-[14px] text-text-secondary leading-5 mb-6">
              {confirm === "enable"
                ? t("settings.librarySync.confirmEnableMsg")
                : t("settings.librarySync.confirmDisableMsg")}
            </p>
            <div className="flex justify-end gap-3">
              <Button variant="ghost" size="md" onClick={() => setConfirm(null)}>
                {t("common.cancel")}
              </Button>
              <Button variant="primary" size="md" onClick={onConfirmToggle}>
                {confirm === "enable"
                  ? t("settings.librarySync.confirmEnableCta")
                  : t("settings.librarySync.confirmDisableCta")}
              </Button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
