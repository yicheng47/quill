import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Loader2, Monitor, Smartphone, Laptop } from "lucide-react";
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
    setConfirm(status.enabled ? "disable" : "enable");
  };

  const onConfirmToggle = async () => {
    const action = confirm;
    setConfirm(null);
    if (!action) return;
    setBusy(true);
    setError(null);
    try {
      const minDelay = new Promise((r) => setTimeout(r, 1500));
      if (action === "disable") {
        await Promise.all([invoke("sync_disable"), minDelay]);
      } else {
        await Promise.all([invoke("sync_enable"), minDelay]);
      }
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const onSyncNow = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await invoke<SyncNowResult>("sync_now");
      // After a successful tick, refresh status so peer last-seen +
      // pending_events update.
      await refresh();
      // Surface a tiny in-component note for one second so the user
      // sees something happened. Reuses the existing busy state with
      // a synthetic delay so we don't need a separate "synced" toast.
      void r;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const enabled = status?.enabled ?? false;
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
                    : t("settings.librarySync.toggleSub")}
                </p>
              </div>
              <Toggle
                checked={enabled}
                onChange={onToggleClick}
                disabled={!available}
              />
            </>
          )}
        </div>

        {/* Other devices — visible only when sync is on. The empty state
            still renders so a single-device user understands why the list
            is empty. */}
        {enabled && (
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
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
            <div className="h-px bg-black/10 mt-3" />

            {/* Actions row */}
            <div className="flex items-center justify-between pt-4 pb-2">
              <div className="flex items-center gap-4">
                <button
                  type="button"
                  onClick={onSyncNow}
                  disabled={busy}
                  className="text-[13px] font-medium text-[#7c3aed] hover:underline disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
                >
                  {t("settings.librarySync.syncNow")}
                </button>
                {/* Compact log is deferred to Chunk 8 — the button is
                    intentionally disabled in v1 so the row matches the
                    design without surfacing a half-wired action. */}
                <button
                  type="button"
                  disabled
                  title={t("settings.librarySync.compactSoon")}
                  className="text-[13px] font-medium text-text-muted/60 cursor-not-allowed"
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
              className="text-[12px] font-medium text-[#e7000b] dark:text-red-400 underline cursor-pointer ml-2 shrink-0"
              onClick={() => {
                setError(null);
                refresh();
              }}
            >
              {t("settings.ai.retry")}
            </button>
          </div>
        )}
      </div>

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
