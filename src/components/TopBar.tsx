import { useState, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import {
  Search,
  Plus,
  Settings,
  RefreshCw,
  CircleArrowDown,
  RotateCw,
  TriangleAlert,
  ExternalLink,
  Check,
  Loader2,
} from "lucide-react";
import QuillLogo from "./QuillLogo";
import IconButton from "./ui/IconButton";
import { useUpdate } from "../contexts/UpdateContext";
import { getOpenReaderCount, listen, listenCurrentWindow, openUrl } from "../platform";
import type { UpdateStatus } from "../hooks/useUpdateChecker";
import {
  isMacOS,
  MAC_TRAFFIC_LIGHT_SPACER_CLASS,
  shortcutModSymbol,
} from "../lib/platformEnv";
import type { SettingsSection } from "./settings/types";

interface UpdateIndicatorProps {
  onOpenSettings: (section?: SettingsSection) => void;
  showUpToDateOverride?: boolean;
}

function useManualUpToDate(status: UpdateStatus, upToDateSeq: number, enabled = true): boolean {
  const [showUpToDate, setShowUpToDate] = useState(false);
  const prevUpToDateSeq = useRef(upToDateSeq);

  useEffect(() => {
    if (!enabled) return;
    const hasNewUpToDate = upToDateSeq !== prevUpToDateSeq.current;
    prevUpToDateSeq.current = upToDateSeq;
    if (status !== "idle") {
      setShowUpToDate(false);
      return;
    }
    if (!hasNewUpToDate) return;
    setShowUpToDate(true);
    const timer = window.setTimeout(() => setShowUpToDate(false), 4000);
    return () => window.clearTimeout(timer);
  }, [enabled, status, upToDateSeq]);

  return showUpToDate;
}

export type MainRoute = "home" | "library" | "highlights" | "words" | "chats";

export interface MainNavigateOptions {
  collectionId?: string;
  statusFilter?: "all" | "reading" | "finished" | "unread";
  bookId?: string | null;
  highlightId?: string;
  wordId?: string;
  chatId?: string;
}

function releaseNotesUrl(version: string | undefined): string {
  if (!version) return "https://github.com/yicheng47/quill/releases";
  if (/-nightly(?:\.|$)/.test(version)) {
    return "https://github.com/yicheng47/quill/releases/tag/nightly";
  }
  const tag = version.startsWith("v") ? version : `v${version}`;
  return `https://github.com/yicheng47/quill/releases/tag/${tag}`;
}

export function UpdateIndicator({
  onOpenSettings,
  showUpToDateOverride,
}: UpdateIndicatorProps) {
  const { t } = useTranslation();
  const {
    status,
    update,
    progress,
    error,
    manualCheck,
    upToDateSeq,
    downloadAndInstall,
    restart,
  } = useUpdate();

  const [readyPopoverOpen, setReadyPopoverOpen] = useState(false);
  const [openReaderCount, setOpenReaderCount] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const internalShowUpToDate = useManualUpToDate(
    status,
    upToDateSeq,
    showUpToDateOverride === undefined,
  );
  const showUpToDate = showUpToDateOverride ?? internalShowUpToDate;

  useEffect(() => {
    if (status !== "ready") {
      setReadyPopoverOpen(false);
    }
  }, [status]);

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
  }, [status, readyPopoverOpen]);

  useEffect(() => {
    if (!readyPopoverOpen) return;
    const handleOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setReadyPopoverOpen(false);
      }
    };
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        setReadyPopoverOpen(false);
      }
    };
    document.addEventListener("mousedown", handleOutside);
    document.addEventListener("keydown", handleEsc);
    return () => {
      document.removeEventListener("mousedown", handleOutside);
      document.removeEventListener("keydown", handleEsc);
    };
  }, [readyPopoverOpen]);

  if (status === "checking" && manualCheck) {
    return (
      <span
        data-testid="update-manual-checking"
        title={t("update.checking")}
        className="inline-flex items-center gap-1.5 px-2 lg:px-2.5 py-1 rounded-full dawn-chip text-[11px] font-medium text-text-secondary min-w-0 max-w-full overflow-hidden"
      >
        <Loader2 size={11} className="animate-spin text-accent shrink-0" />
        <span className="truncate">
          <span className="hidden lg:inline">{t("update.checking")}</span>
          <span className="lg:hidden">{t("settings.updates.checkingButton")}</span>
        </span>
      </span>
    );
  }

  if (status === "idle") {
    if (!showUpToDate) return null;
    return (
      <span
        data-testid="update-manual-uptodate"
        title={t("update.upToDate")}
        className="inline-flex items-center gap-1.5 px-2 lg:px-2.5 py-1 rounded-full bg-success-tint text-success text-[11px] font-medium min-w-0 max-w-full overflow-hidden"
      >
        <Check size={11} className="shrink-0" />
        <span className="truncate">{t("update.upToDate")}</span>
      </span>
    );
  }

  if (status === "checking") {
    return null;
  }

  const version = update?.version ?? "";
  const clampedProgress = Math.max(0, Math.min(100, progress));
  const ringRadius = 5.5;
  const ringCircumference = 2 * Math.PI * ringRadius;
  const ringDashOffset = ringCircumference * (1 - clampedProgress / 100);

  let tooltip = "";
  if (status === "available") {
    tooltip = t("update.indicator.availableTooltip", { version });
  } else if (status === "downloading") {
    tooltip = t("update.indicator.downloadingTooltip", { version, progress: clampedProgress });
  } else if (status === "verifying") {
    tooltip = t("update.indicator.verifyingTooltip", { version });
  } else if (status === "ready") {
    tooltip = t("update.indicator.readyTooltip", { version });
  } else if (status === "error") {
    tooltip = version
      ? t("update.indicator.failedTooltip", { version })
      : error || t("update.indicator.checkFailedTooltip");
  }

  const handleClick = () => {
    if (status === "available") {
      void downloadAndInstall();
    } else if (status === "ready") {
      setReadyPopoverOpen((open) => !open);
    } else if (status === "error") {
      onOpenSettings("updates");
    }
  };

  const interactive = status === "available" || status === "ready" || status === "error";

  return (
    <div
      ref={containerRef}
      className={`relative flex items-center shrink-0 ${interactive || readyPopoverOpen ? "no-drag" : ""}`}
    >
      <button
        type="button"
        data-testid="update-indicator"
        data-update-status={status}
        onClick={interactive ? handleClick : undefined}
        aria-disabled={!interactive ? "true" : undefined}
        aria-expanded={status === "ready" ? readyPopoverOpen : undefined}
        aria-label={tooltip}
        title={tooltip}
        className={`size-6 rounded-[6px] inline-flex items-center justify-center transition-colors focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-focus-ring ${
          status === "ready" && readyPopoverOpen
            ? "bg-accent-tint border border-violet-300 text-accent-on-tint cursor-pointer"
            : interactive
              ? "hover:bg-black/[0.05] cursor-pointer"
              : "cursor-default"
        }`}
      >
        {status === "available" && <CircleArrowDown size={14} className="text-accent" />}
        {status === "downloading" && (
          <svg
            width="14"
            height="14"
            viewBox="0 0 14 14"
            className="shrink-0 -rotate-90"
            aria-hidden="true"
          >
            <circle
              cx="7"
              cy="7"
              r={ringRadius}
              fill="none"
              stroke="var(--color-track)"
              strokeWidth="1.75"
            />
            <circle
              cx="7"
              cy="7"
              r={ringRadius}
              fill="none"
              stroke="var(--color-accent)"
              strokeWidth="1.75"
              strokeLinecap="round"
              strokeDasharray={ringCircumference}
              strokeDashoffset={ringDashOffset}
            />
          </svg>
        )}
        {status === "verifying" && (
          <svg
            width="14"
            height="14"
            viewBox="0 0 14 14"
            className="shrink-0 animate-spin"
            aria-hidden="true"
          >
            <circle
              cx="7"
              cy="7"
              r={ringRadius}
              fill="none"
              stroke="var(--color-track)"
              strokeWidth="1.75"
            />
            <circle
              cx="7"
              cy="7"
              r={ringRadius}
              fill="none"
              stroke="var(--color-accent)"
              strokeWidth="1.75"
              strokeLinecap="round"
              strokeDasharray={`${ringCircumference * 0.25} ${ringCircumference * 0.75}`}
            />
          </svg>
        )}
        {status === "ready" && (
          <RotateCw
            size={14}
            className={readyPopoverOpen ? "text-accent-on-tint" : "text-accent"}
          />
        )}
        {status === "error" && <TriangleAlert size={14} className="text-warning" />}
      </button>

      {status === "ready" && readyPopoverOpen && (
        <div
          role="dialog"
          aria-label={t("update.popover.readyTitle", { version })}
          className="absolute left-0 top-full mt-2 w-[264px] p-4 rounded-[14px] bg-surface-solid border border-border-subtle shadow-menu flex flex-col gap-3 z-50 no-drag"
        >
          <div className="flex flex-col gap-1">
            <p className="text-[14.5px] font-semibold text-text-primary leading-snug">
              {t("update.popover.readyTitle", { version })}
            </p>
            {openReaderCount > 0 && (
              <div className="flex items-center gap-1.5">
                <span className="size-[7px] rounded-full bg-warning shrink-0" />
                <span className="text-[12.5px] text-warning">
                  {t("update.popover.openReaders", { count: openReaderCount })}
                </span>
              </div>
            )}
          </div>

          <button
            type="button"
            onClick={() => {
              setReadyPopoverOpen(false);
              void restart();
            }}
            className="w-full rounded-full bg-accent hover:bg-accent-hover active:bg-accent-pressed text-text-on-accent py-[9px] px-3.5 text-[13px] font-semibold inline-flex items-center justify-center gap-2 cursor-pointer transition-colors"
          >
            <RotateCw size={14} />
            <span>{t("update.popover.restart")}</span>
          </button>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => {
                void openUrl(releaseNotesUrl(version)).catch(() => {});
              }}
              className="flex-1 rounded-full bg-surface-inset border border-border-subtle hover:bg-surface-chip py-[7px] px-2.5 text-[12.5px] font-medium text-text-primary inline-flex items-center justify-center gap-[5px] cursor-pointer transition-colors"
            >
              <span>{t("update.popover.whatsNew")}</span>
              <ExternalLink size={11.5} className="text-text-tertiary shrink-0" />
            </button>
            <button
              type="button"
              onClick={() => setReadyPopoverOpen(false)}
              className="w-[84px] rounded-full bg-surface-inset border border-border-subtle hover:bg-surface-chip py-[7px] px-2.5 text-[12.5px] font-medium text-text-secondary inline-flex items-center justify-center cursor-pointer transition-colors"
            >
              <span>{t("update.popover.later")}</span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

interface TopBarProps {
  activeRoute: MainRoute;
  onRouteChange: (route: MainRoute) => void;
  searchOpen: boolean;
  onOpenSearch: () => void;
  importing: boolean;
  onImport: () => void;
  settingsOpen: boolean;
  onOpenSettings: (section?: SettingsSection) => void;
}

export default function TopBar({
  activeRoute,
  onRouteChange,
  searchOpen,
  onOpenSearch,
  importing,
  onImport,
  settingsOpen,
  onOpenSettings,
}: TopBarProps) {
  const { t } = useTranslation();
  const { status: updateStatus, manualCheck, upToDateSeq } = useUpdate();
  const [syncProgress, setSyncProgress] = useState<{ percent: number | null } | null>(null);
  const showUpToDate = useManualUpToDate(updateStatus, upToDateSeq);
  const hasCompactBadge =
    Boolean(syncProgress) ||
    (updateStatus === "checking" && manualCheck) ||
    (updateStatus === "idle" && showUpToDate);
  const isMac = isMacOS();
  const mod = shortcutModSymbol();

  useEffect(() => {
    let maxPercent = 0;
    const unlistenTick = listen("sync-initial-tick-done", () => {
      maxPercent = 0;
      setSyncProgress(null);
    });
    const unlistenProgress = listen<{ applied: number; total: number }>("sync-progress", (e) => {
      const { applied, total } = e.payload;
      if (applied === 0) {
        maxPercent = 0;
      }
      if (total > 0) {
        maxPercent = Math.max(maxPercent, Math.min(100, Math.floor((applied / total) * 100)));
        setSyncProgress({ percent: maxPercent });
      } else {
        setSyncProgress((prev) => prev ?? { percent: null });
      }
    });
    return () => {
      void unlistenTick.then((fn) => fn()).catch(() => {});
      void unlistenProgress.then((fn) => fn()).catch(() => {});
    };
  }, []);

  const routes: Array<{ id: MainRoute; label: string }> = [
    { id: "home", label: t("nav.home") },
    { id: "library", label: t("nav.library") },
    { id: "highlights", label: t("nav.highlights") },
    { id: "words", label: t("nav.words") },
    { id: "chats", label: t("nav.chats") },
  ];

  return (
    <header
      data-drag-region
      className="h-[71px] shrink-0 w-full pl-7 pr-4 lg:px-7 py-4 flex items-center justify-between gap-2 lg:gap-3 select-none relative z-30"
    >
      <div className="flex items-center gap-2.5 lg:gap-[18px] flex-1 basis-0 min-w-0 lg:min-w-fit">
        {isMac && <div className={`${MAC_TRAFFIC_LIGHT_SPACER_CLASS} shrink-0`} aria-hidden="true" />}

        <div className="flex items-center gap-2 lg:gap-[9px] min-w-0">
          <QuillLogo size={28} className="shrink-0" />
          <span
            className={`${hasCompactBadge ? "hidden lg:inline" : "hidden sm:inline"} shrink-0 text-[16px] font-semibold text-text-primary leading-none`}
          >
            Quill
          </span>
          <UpdateIndicator onOpenSettings={onOpenSettings} showUpToDateOverride={showUpToDate} />
        </div>

        {syncProgress && (
          <span
            data-testid="topbar-sync-chip"
            title={t("topBar.syncing")}
            className="inline-flex items-center gap-1.5 px-2 lg:px-2.5 py-1 rounded-full bg-accent-tint text-accent-on-tint shrink-0"
          >
            <RefreshCw size={12} className="animate-spin shrink-0" />
            {syncProgress.percent != null && (
              <span className="font-mono text-[11px] font-semibold leading-none">
                {syncProgress.percent}%
              </span>
            )}
          </span>
        )}
      </div>

      <nav
        aria-label={t("topBar.navigation")}
        className="no-drag inline-flex items-center gap-0.5 p-1 rounded-full dawn-glass shrink-0"
      >
        {routes.map((route) => {
          const isActive = !settingsOpen && activeRoute === route.id;
          return (
            <button
              key={route.id}
              type="button"
              aria-current={isActive ? "page" : undefined}
              onClick={() => onRouteChange(route.id)}
              className={`px-2 sm:px-3 md:px-4 py-[7px] rounded-full text-[12.5px] sm:text-[13px] whitespace-nowrap cursor-pointer transition-colors focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-focus-ring ${
                isActive
                  ? "bg-accent-tint text-accent-on-tint font-semibold"
                  : "text-text-secondary font-medium hover:bg-black/[0.04]"
              }`}
            >
              {route.label}
            </button>
          );
        })}
      </nav>

      <div className="flex items-center justify-end gap-1.5 lg:gap-2.5 shrink-0 lg:flex-1 lg:basis-0 lg:min-w-fit">
        <IconButton
          active={searchOpen}
          onClick={onOpenSearch}
          aria-label={t("topBar.search")}
          title={`${t("topBar.search")} (${mod}K)`}
          className="max-lg:size-8"
        >
          <Search size={16} />
        </IconButton>
        <IconButton
          active={importing}
          onClick={onImport}
          aria-label={t("topBar.import")}
          title={t("topBar.import")}
          className="max-lg:size-8"
        >
          <Plus size={16} />
        </IconButton>
        <IconButton
          active={settingsOpen}
          onClick={() => onOpenSettings()}
          aria-label={t("topBar.settings")}
          title={`${t("topBar.settings")} (${mod},)`}
          className="max-lg:size-8"
        >
          <Settings size={16} />
        </IconButton>
      </div>
    </header>
  );
}
