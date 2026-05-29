import { useState, useEffect, useRef, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { X, Loader2, Check } from "lucide-react";
import { useUpdate } from "../contexts/UpdateContext";

// Top-center toast carrying the full update lifecycle in one surface:
// available → downloading → (auto-relaunch). Manual checks (from the app
// menu) additionally surface the transient checking / up-to-date / error
// states so the menu click visibly does something; the launch auto-check
// stays silent unless an update is found.
export default function UpdateToast() {
  const { t } = useTranslation();
  const { status, update, progress, manualCheck, error, downloadAndInstall, checkForUpdate } =
    useUpdate();
  const [dismissed, setDismissed] = useState(false);
  const [visible, setVisible] = useState(false);
  const [confirmUpToDate, setConfirmUpToDate] = useState(false);
  const prevStatus = useRef(status);

  // A manual check ending with no update → brief "up to date" confirmation.
  // Any new check / found update clears it and un-dismisses the toast.
  useEffect(() => {
    const prev = prevStatus.current;
    prevStatus.current = status;
    if (
      status === "checking" ||
      status === "available" ||
      status === "downloading" ||
      status === "ready"
    ) {
      setConfirmUpToDate(false);
      setDismissed(false);
    } else if (manualCheck && prev === "checking" && status === "idle") {
      setConfirmUpToDate(true);
      setDismissed(false);
    }
  }, [status, manualCheck]);

  const view: "available" | "downloading" | "checking" | "uptodate" | "error" | null =
    status === "available"
      ? "available"
      : status === "downloading" || status === "ready"
        ? "downloading"
        : status === "checking" && manualCheck
          ? "checking"
          : status === "error" && manualCheck
            ? "error"
            : confirmUpToDate
              ? "uptodate"
              : null;

  const shouldShow = view !== null && !dismissed;

  const dismiss = useCallback(() => {
    setVisible(false);
    setTimeout(() => {
      setDismissed(true);
      setConfirmUpToDate(false);
    }, 200);
  }, []);

  useEffect(() => {
    if (!shouldShow) {
      setVisible(false);
      return;
    }
    const raf = requestAnimationFrame(() => setVisible(true));
    // Auto-dismiss the non-blocking states; keep downloading/checking up.
    let timer: ReturnType<typeof setTimeout> | null = null;
    if (view === "available") timer = setTimeout(dismiss, 30000);
    else if (view === "uptodate") timer = setTimeout(dismiss, 4000);
    else if (view === "error") timer = setTimeout(dismiss, 8000);
    return () => {
      cancelAnimationFrame(raf);
      if (timer) clearTimeout(timer);
    };
  }, [shouldShow, view, dismiss]);

  if (!shouldShow) return null;

  const version = update?.version ?? "";
  const dismissible = view !== "downloading" && view !== "checking";

  return (
    <div
      className={`fixed top-5 left-1/2 -translate-x-1/2 z-50 transition-all duration-200 ${
        visible ? "opacity-100 translate-y-0" : "opacity-0 -translate-y-2"
      }`}
    >
      <div className="min-w-[260px] bg-white dark:bg-bg-surface border border-border rounded-[14px] shadow-popover flex flex-col gap-2 pl-4 pr-3 py-2.5">
        <div className="flex items-center gap-3">
          {view === "available" && (
            <span className="relative shrink-0 size-2">
              <span className="absolute -inset-[3px] rounded-full bg-purple/17" />
              <span className="absolute inset-0 rounded-full bg-purple" />
            </span>
          )}
          {view === "checking" && (
            <Loader2 size={14} className="shrink-0 text-text-muted animate-spin" />
          )}
          {view === "uptodate" && (
            <Check size={14} className="shrink-0 text-success-text" />
          )}

          <span className="flex-1 text-[13px] text-text-secondary tracking-[-0.08px] whitespace-nowrap">
            {view === "available" && t("update.toast.available", { version: `v${version}` })}
            {view === "downloading" && t("update.toast.downloading", { progress })}
            {view === "checking" && t("update.toast.checking")}
            {view === "uptodate" && t("update.toast.upToDate")}
            {view === "error" && (error || t("update.toast.error"))}
          </span>

          {view === "available" && (
            <button
              onClick={() => downloadAndInstall()}
              className="text-[13px] font-medium text-accent-text hover:bg-accent-bg px-2.5 py-1 rounded-lg cursor-pointer transition-colors whitespace-nowrap"
            >
              {t("update.toast.update")}
            </button>
          )}
          {view === "error" && (
            <button
              onClick={() => checkForUpdate({ manual: true })}
              className="text-[13px] font-medium text-accent-text hover:bg-accent-bg px-2.5 py-1 rounded-lg cursor-pointer transition-colors whitespace-nowrap"
            >
              {t("update.toast.retry")}
            </button>
          )}
          {dismissible && (
            <button
              onClick={dismiss}
              className="shrink-0 size-6 flex items-center justify-center rounded-lg hover:bg-bg-input cursor-pointer transition-colors"
            >
              <X size={14} className="text-text-muted" />
            </button>
          )}
        </div>

        {view === "downloading" && (
          <div className="h-[3px] bg-bg-input rounded-full overflow-hidden">
            <div
              className="h-full bg-accent rounded-full transition-all duration-300 ease-out"
              style={{ width: `${progress}%` }}
            />
          </div>
        )}
      </div>
    </div>
  );
}
