import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import {
  Check,
  CircleArrowDown,
  ExternalLink,
  Loader2,
  RefreshCw,
  RotateCw,
} from "lucide-react";
import QuillLogo from "../QuillLogo";
import Button from "../ui/Button";
import ProgressBar from "../ui/ProgressBar";
import Switch from "../ui/Switch";
import { SettingsGroup, SettingsOverline, SettingsRow } from "../ui/SettingsRow";
import { useUpdate } from "../../contexts/UpdateContext";
import {
  getAppVersion,
  getOpenReaderCount,
  listenCurrentWindow,
  openUrl,
} from "../../platform";
import type { SettingsProps } from "./types";

function formatBytesMb(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return `${mb.toFixed(1)} MB`;
}

function formatByteProgress(
  downloaded: number,
  total: number,
  t: (key: string, opts?: Record<string, unknown>) => string,
): string {
  if (total > 0) {
    const pct = Math.min(100, Math.round((downloaded / total) * 100));
    const dlMb = (downloaded / (1024 * 1024)).toFixed(1);
    const totalMb = (total / (1024 * 1024)).toFixed(1);
    return t("settings.updates.progressWithTotal", {
      downloaded: dlMb,
      total: totalMb,
      percent: pct,
    });
  }
  if (downloaded > 0) {
    return t("settings.updates.progressDownloaded", {
      size: formatBytesMb(downloaded),
    });
  }
  return "";
}

function formatRelativeShort(
  ts: number | null,
  now: number,
  t: (key: string, opts?: Record<string, unknown>) => string,
): string | null {
  if (ts == null) return null;
  const diffSec = Math.max(0, Math.floor((now - ts) / 1000));
  if (diffSec < 60) return t("settings.updates.relativeJustNow");
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return t("settings.updates.relativeMinutes", { count: diffMin });
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return t("settings.updates.relativeHours", { count: diffHr });
  const diffDay = Math.floor(diffHr / 24);
  return t("settings.updates.relativeDays", { count: diffDay });
}

function formatLastCheckedRow(
  ts: number | null,
  now: number,
  t: (key: string, opts?: Record<string, unknown>) => string,
): string {
  if (ts == null) return t("settings.updates.neverChecked");
  const date = new Date(ts);
  const nowDate = new Date(now);
  const timeStr = date.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const startOfToday = new Date(nowDate.getFullYear(), nowDate.getMonth(), nowDate.getDate()).getTime();
  const startOfDate = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const dayDiff = Math.round((startOfToday - startOfDate) / 86_400_000);
  if (dayDiff === 0) return t("settings.updates.todayAt", { time: timeStr });
  if (dayDiff === 1) return t("settings.updates.yesterdayAt", { time: timeStr });
  const dateStr = date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return `${dateStr}, ${timeStr}`;
}

function downloadsUrl(version: string | undefined): string {
  if (!version) return "https://github.com/yicheng47/quill/releases";
  if (/-nightly(?:\.|$)/.test(version)) {
    return "https://github.com/yicheng47/quill/releases/tag/nightly";
  }
  const tag = version.startsWith("v") ? version : `v${version}`;
  return `https://github.com/yicheng47/quill/releases/tag/${tag}`;
}

export default function UpdatesSettings({ settings, loading, save }: SettingsProps) {
  const { t } = useTranslation();
  const {
    status,
    update,
    progress,
    downloadedBytes,
    totalBytes,
    lastCheckedAt,
    error,
    upToDateSeq,
    checkForUpdate,
    downloadAndInstall,
    cancelDownload,
    skipVersion,
    restart,
  } = useUpdate();

  const [appVersion, setAppVersion] = useState("");
  const [autoCheckUpdates, setAutoCheckUpdates] = useState(true);
  const [openReaderCount, setOpenReaderCount] = useState(0);
  const [showCheckedBadge, setShowCheckedBadge] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    void getAppVersion()
      .then(setAppVersion)
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (loading) return;
    setAutoCheckUpdates(settings.auto_check_updates !== "false");
  }, [settings, loading]);

  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    if (upToDateSeq === 0 || status !== "idle") {
      setShowCheckedBadge(false);
      return;
    }
    setShowCheckedBadge(true);
    const timer = window.setTimeout(() => setShowCheckedBadge(false), 4000);
    return () => window.clearTimeout(timer);
  }, [upToDateSeq, status]);

  useEffect(() => {
    if (status !== "ready") return;
    let active = true;
    void getOpenReaderCount()
      .then((count) => {
        if (active) setOpenReaderCount(count);
      })
      .catch(() => {});
    const unlisten = listenCurrentWindow<number>("reader-windows-changed", (event) => {
      if (active) setOpenReaderCount(event.payload);
    });
    return () => {
      active = false;
      void unlisten.then((fn) => fn()).catch(() => {});
    };
  }, [status]);

  const effectiveLastChecked =
    lastCheckedAt ??
    (settings.last_update_check_at && Number.isFinite(Number(settings.last_update_check_at))
      ? Number(settings.last_update_check_at)
      : null);

  const relativeChecked = formatRelativeShort(effectiveLastChecked, now, t);
  const nextVersion = update?.version ?? "";
  const availableSize = update?.sizeBytes ? formatBytesMb(update.sizeBytes) : null;
  const readySize =
    totalBytes > 0
      ? formatBytesMb(totalBytes)
      : update?.sizeBytes
        ? formatBytesMb(update.sizeBytes)
        : null;
  const downloadProgressCaption = formatByteProgress(downloadedBytes, totalBytes, t);

  let heroStatusText = "";
  if (status === "idle") {
    heroStatusText = relativeChecked
      ? t("settings.updates.upToDateChecked", { relative: relativeChecked })
      : t("settings.updates.upToDate");
  } else if (status === "checking") {
    heroStatusText = t("settings.updates.checking");
  } else if (status === "available") {
    heroStatusText = availableSize
      ? t("settings.updates.availableWithSize", { version: nextVersion, size: availableSize })
      : t("settings.updates.available", { version: nextVersion });
  } else if (status === "downloading") {
    heroStatusText = t("settings.updates.downloading", { version: nextVersion });
  } else if (status === "verifying") {
    heroStatusText = t("settings.updates.verifying", { version: nextVersion });
  } else if (status === "ready") {
    heroStatusText = readySize
      ? t("settings.updates.readyWithSize", { version: nextVersion, size: readySize })
      : t("settings.updates.ready", { version: nextVersion });
  } else if (status === "error") {
    heroStatusText = error || t("settings.updates.errorFallback");
  }

  return (
    <div className="flex flex-col gap-6">
      {/* Hero card */}
      <div
        data-testid="updates-hero-card"
        data-update-status={status}
        className="dawn-inset rounded-[14px] p-5 flex flex-col gap-3.5"
      >
        <div className="flex items-center gap-4">
          <QuillLogo
            size={56}
            className="rounded-[13px] shadow-[0_6px_16px_rgba(109,91,255,0.25)] shrink-0"
          />

          <div className="flex-1 min-w-0 flex flex-col gap-1">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-[18px] font-semibold tracking-[-0.3px] text-text-primary leading-none">
                Quill
              </span>
              {appVersion && (
                <span className="px-[7px] py-[2px] rounded-[6px] bg-surface-solid border border-border-subtle font-mono text-[11.5px] text-text-secondary leading-none">
                  {appVersion}
                </span>
              )}
              {status === "idle" && showCheckedBadge && (
                <span
                  data-testid="updates-uptodate-pill"
                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-success-tint text-success text-[11.5px] font-medium leading-none"
                >
                  <Check size={11} />
                  <span>{t("update.upToDate")}</span>
                </span>
              )}
            </div>

            <p
              className={`text-[13.5px] leading-[1.4] ${
                status === "error" ? "text-danger" : "text-text-secondary"
              }`}
            >
              {heroStatusText}
            </p>
          </div>

          <div className="flex items-center gap-3 shrink-0">
            {status === "idle" && (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => void checkForUpdate({ manual: true })}
              >
                <RefreshCw size={14} className="text-text-secondary" />
                <span>{t("settings.updates.checkNow")}</span>
              </Button>
            )}

            {status === "checking" && (
              <Button variant="secondary" size="sm" disabled className="opacity-60">
                <Loader2 size={14} className="animate-spin text-text-secondary" />
                <span>{t("settings.updates.checkingButton")}</span>
              </Button>
            )}

            {status === "available" && update && (
              <div className="flex items-center gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => void skipVersion(update.version)}
                >
                  <span>{t("settings.updates.skipVersion")}</span>
                </Button>
                <Button
                  variant="primary"
                  size="sm"
                  onClick={() => void downloadAndInstall()}
                >
                  <CircleArrowDown size={14} />
                  <span>{t("settings.updates.download")}</span>
                </Button>
              </div>
            )}

            {status === "downloading" && (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => void cancelDownload()}
              >
                <span>{t("common.cancel")}</span>
              </Button>
            )}

            {status === "verifying" && (
              <Button variant="secondary" size="sm" disabled className="opacity-60">
                <Loader2 size={14} className="animate-spin text-text-secondary" />
                <span>{t("settings.updates.verifyingButton")}</span>
              </Button>
            )}

            {status === "ready" && (
              <>
                {openReaderCount > 0 && (
                  <div className="flex items-center gap-1.5">
                    <span className="size-[7px] rounded-full bg-warning shrink-0" />
                    <span className="text-[12.5px] font-medium text-warning">
                      {t("settings.updates.openBooks", { count: openReaderCount })}
                    </span>
                  </div>
                )}
                <Button
                  variant="primary"
                  size="sm"
                  onClick={() => void restart()}
                >
                  <RotateCw size={14} />
                  <span>{t("update.popover.restart")}</span>
                </Button>
              </>
            )}

            {status === "error" && (
              <div className="flex items-center gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => void openUrl(downloadsUrl(update?.version)).catch(() => {})}
                >
                  <ExternalLink size={14} className="text-text-secondary" />
                  <span>{t("settings.updates.viewDownloads")}</span>
                </Button>
                <Button
                  variant="primary"
                  size="sm"
                  onClick={() => {
                    if (update) {
                      void downloadAndInstall();
                    } else {
                      void checkForUpdate({ manual: true });
                    }
                  }}
                >
                  <RefreshCw size={14} />
                  <span>{t("settings.ai.retry")}</span>
                </Button>
              </div>
            )}
          </div>
        </div>

        {(status === "downloading" || status === "verifying") && (
          <div className="flex flex-col gap-1.5">
            <ProgressBar value={status === "verifying" ? 100 : progress} />
            {(downloadProgressCaption || status === "verifying") && (
              <p className="font-mono text-[11.5px] text-text-tertiary">
                {status === "verifying"
                  ? t("settings.updates.verifyingCaption")
                  : downloadProgressCaption}
              </p>
            )}
          </div>
        )}
      </div>

      {/* PREFERENCES */}
      <section className="flex flex-col gap-2.5">
        <SettingsOverline>{t("settings.updates.preferencesGroup")}</SettingsOverline>
        <SettingsGroup>
          <SettingsRow
            title={t("settings.updates.autoCheck")}
            hint={t("settings.updates.autoCheckHint")}
          >
            <Switch
              aria-label={t("settings.updates.autoCheck")}
              checked={autoCheckUpdates}
              onChange={(checked) => {
                setAutoCheckUpdates(checked);
                void save("auto_check_updates", String(checked));
              }}
            />
          </SettingsRow>
          <SettingsRow title={t("settings.updates.lastChecked")}>
            <span
              data-testid="updates-last-checked"
              className="font-mono text-[12.5px] text-text-tertiary"
            >
              {formatLastCheckedRow(effectiveLastChecked, now, t)}
            </span>
          </SettingsRow>
        </SettingsGroup>
      </section>
    </div>
  );
}
