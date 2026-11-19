import { useState, useEffect, useCallback, useRef } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import {
  Check,
  Copy,
  ExternalLink,
  Info,
  KeyRound,
  Loader2,
  LogIn,
  RefreshCw,
  Sparkles,
  Terminal,
  X,
} from "lucide-react";
import { invoke, openUrl } from "../platform";
import { isMacOS } from "../lib/platformEnv";
import {
  CODEX_INSTALL_COMMAND,
  CODEX_INSTALL_GUIDE_URL,
  CODEX_UPDATE_COMMAND,
  formatCodexAccountLine,
  type CodexStatus,
  type LoginOutcome,
} from "../lib/aiConnections";
import Button from "./ui/Button";
import { StatusBadge } from "./ui/Badge";

interface AiSetupDialogProps {
  open: boolean;
  isMigration: boolean;
  onClose: () => void;
  onUseApi: () => void;
}

export default function AiSetupDialog({
  open,
  isMigration,
  onClose,
  onUseApi,
}: AiSetupDialogProps) {
  const { t } = useTranslation();
  const isMac = isMacOS();

  const [status, setStatus] = useState<CodexStatus | null>(null);
  const [checking, setChecking] = useState(true);
  const [signingIn, setSigningIn] = useState(false);
  const [loginError, setLoginError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState(false);

  const dialogRef = useRef<HTMLDivElement>(null);
  const probeSeqRef = useRef(0);
  const loginAttemptRef = useRef(0);
  const signingInRef = useRef(false);
  signingInRef.current = signingIn;
  const copyTimerRef = useRef<number | null>(null);

  const probeCodex = useCallback(async (options?: { quiet?: boolean }) => {
    const seq = ++probeSeqRef.current;
    if (!options?.quiet) setChecking(true);
    try {
      const result = await invoke<CodexStatus>("codex_status");
      if (probeSeqRef.current !== seq) return;
      if (result) {
        setStatus(result);
        if (result.state === "ready") {
          setLoginError(null);
        }
      }
    } catch (err) {
      if (probeSeqRef.current !== seq) return;
      setStatus({
        state: "failed",
        version: null,
        min_version: "0.170.0",
        path: null,
        from_override: false,
        email: null,
        plan: null,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      if (probeSeqRef.current === seq) {
        setChecking(false);
      }
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    setLoginError(null);
    setSigningIn(false);
    void probeCodex();
  }, [open, probeCodex]);

  useEffect(() => {
    if (!open) return;
    const onFocus = () => {
      if (!signingInRef.current) {
        void probeCodex({ quiet: true });
      }
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [open, probeCodex]);

  useEffect(() => {
    return () => {
      if (copyTimerRef.current !== null) {
        window.clearTimeout(copyTimerRef.current);
      }
      if (signingInRef.current) {
        void invoke("codex_login_cancel").catch(() => {});
      }
    };
  }, []);

  const cancelSignIn = useCallback(() => {
    loginAttemptRef.current += 1;
    setSigningIn(false);
    setLoginError(null);
    void invoke("codex_login_cancel").catch(() => {});
  }, []);

  const persistDismiss = useCallback(
    async (extra?: Record<string, string>) => {
      const updates: Record<string, string> = {
        ai_setup_seen: "true",
        ...(isMigration ? { ai_codex_migration_pending: "false" } : {}),
        ...extra,
      };
      await invoke("set_settings_bulk", { settings: updates });
    },
    [isMigration],
  );

  const handleUseCodex = async () => {
    setSaving(true);
    try {
      await persistDismiss({
        ai_auth_mode: "codex",
        // Reset any leftover model slug from an incomplete API setup so Codex
        // uses its catalog default; real OAuth migrations keep their saved model
        // and effort tiers.
        ...(isMigration ? {} : { ai_model: "" }),
      });
      onClose();
    } catch (err) {
      console.error("Failed to save Codex connection:", err);
    } finally {
      setSaving(false);
    }
  };

  const handleSignIn = async () => {
    const attempt = ++loginAttemptRef.current;
    setSigningIn(true);
    setLoginError(null);
    try {
      const outcome = await invoke<LoginOutcome>("codex_login");
      if (loginAttemptRef.current !== attempt) return;
      setSigningIn(false);
      if (outcome?.success) {
        await probeCodex();
      } else if (outcome?.error) {
        setLoginError(outcome.error);
      }
    } catch (err) {
      if (loginAttemptRef.current !== attempt) return;
      setSigningIn(false);
      setLoginError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleSkip = useCallback(async () => {
    if (signingInRef.current) cancelSignIn();
    setSaving(true);
    try {
      await persistDismiss();
    } catch (err) {
      console.error("Failed to dismiss AI setup:", err);
    } finally {
      setSaving(false);
      onClose();
    }
  }, [cancelSignIn, persistDismiss, onClose]);

  const handleUseApi = async () => {
    if (signingInRef.current) cancelSignIn();
    setSaving(true);
    try {
      await persistDismiss();
    } catch (err) {
      console.error("Failed to save AI setup dismissal:", err);
    } finally {
      setSaving(false);
      onClose();
      onUseApi();
    }
  };

  const handleCopyCommand = (cmd: string) => {
    void navigator.clipboard?.writeText(cmd);
    setCopied(true);
    if (copyTimerRef.current !== null) {
      window.clearTimeout(copyTimerRef.current);
    }
    copyTimerRef.current = window.setTimeout(() => {
      setCopied(false);
      copyTimerRef.current = null;
    }, 2000);
  };

  const handleSkipRef = useRef(handleSkip);
  handleSkipRef.current = handleSkip;
  const cancelSignInRef = useRef(cancelSignIn);
  cancelSignInRef.current = cancelSignIn;

  useEffect(() => {
    if (!open) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const getFocusable = (): HTMLElement[] => {
      const dialog = dialogRef.current;
      if (!dialog) return [];
      return Array.from(
        dialog.querySelectorAll<HTMLElement>(
          'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      );
    };

    const focusDialog = () => {
      const dialog = dialogRef.current;
      if (!dialog) return;
      if (document.activeElement && dialog.contains(document.activeElement)) return;
      // Focus the dialog itself: while Codex is checked the primary action is
      // disabled, so the first control is the footer link, and a ring on it at
      // launch reads as a selection.
      dialog.focus();
    };
    focusDialog();

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        if (signingInRef.current) {
          cancelSignInRef.current();
        } else {
          void handleSkipRef.current();
        }
        return;
      }
      if (e.key === "Tab") {
        const dialog = dialogRef.current;
        if (!dialog) return;
        const focusable = getFocusable();
        if (focusable.length === 0) {
          e.preventDefault();
          dialog.focus();
          return;
        }
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        const active = document.activeElement as HTMLElement | null;
        if (!active || !dialog.contains(active)) {
          e.preventDefault();
          (e.shiftKey ? last : first).focus();
        } else if (e.shiftKey && (active === first || active === dialog)) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && active === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener("keydown", handleKeyDown, true);
    return () => {
      window.removeEventListener("keydown", handleKeyDown, true);
      if (previousFocus && previousFocus.isConnected) {
        previousFocus.focus();
      }
    };
  }, [open]);

  if (!open) return null;

  const effectiveState = signingIn
    ? "signing_in"
    : checking || !status
      ? "checking"
      : status.state;

  const title = (() => {
    if (effectiveState === "signing_in") return t("aiSetup.signingInTitle");
    if (effectiveState === "too_old") return t("aiSetup.tooOldTitle");
    if (isMigration) return t("aiSetup.migrationTitle");
    return t("aiSetup.title");
  })();

  const body = (() => {
    switch (effectiveState) {
      case "checking":
        return t("aiSetup.checkingBody");
      case "ready":
        return isMigration ? t("aiSetup.migrationReadyBody") : t("aiSetup.readyBody");
      case "not_signed_in":
        return t("aiSetup.notSignedInBody");
      case "signing_in":
        return t("aiSetup.signingInBody");
      case "not_installed":
        return t("aiSetup.notInstalledBody");
      case "too_old":
        return t("aiSetup.tooOldBody");
      case "failed":
        return t("aiSetup.failedBody");
    }
  })();

  const detectedName = (() => {
    if (effectiveState === "checking") return t("aiSetup.checkingName");
    if (effectiveState === "not_installed") return t("aiSetup.notFoundName");
    if (status?.version) return t("aiSetup.codexVersion", { version: status.version });
    return t("settings.ai.codex.title");
  })();

  const detectedDetail = (() => {
    switch (effectiveState) {
      case "checking":
        return isMac ? t("aiSetup.checkingDetailMac") : t("aiSetup.checkingDetailWin");
      case "ready": {
        const line = status ? formatCodexAccountLine(status, false) : "";
        return line || t("aiSetup.readySignedInFallback");
      }
      case "not_signed_in":
        return loginError || t("aiSetup.notSignedInDetail");
      case "signing_in":
        return t("aiSetup.signingInDetail");
      case "not_installed":
        return isMac ? t("aiSetup.notFoundDetailMac") : t("aiSetup.notFoundDetailWin");
      case "too_old":
        return t("aiSetup.tooOldDetail", { minVersion: status?.min_version ?? "0.170.0" });
      case "failed":
        return status?.error || t("settings.ai.codex.failedFallback");
    }
  })();

  const commandText =
    effectiveState === "not_installed"
      ? CODEX_INSTALL_COMMAND
      : effectiveState === "too_old"
        ? CODEX_UPDATE_COMMAND
        : null;

  return createPortal(
    <div
      className="fixed inset-0 z-50 bg-scrim backdrop-blur-[6px] flex items-center justify-center p-4"
      data-testid="ai-setup-backdrop"
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="ai-setup-dialog-title"
        tabIndex={-1}
        data-testid="ai-setup-dialog"
        data-state={effectiveState}
        className="w-full max-w-[520px] bg-surface-solid border border-border-subtle rounded-[20px] p-8 shadow-2xl flex flex-col gap-5 outline-none"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Head */}
        <div className="flex flex-col gap-3">
          <div className="size-10 rounded-[12px] bg-accent-tint text-accent-on-tint flex items-center justify-center shrink-0">
            <Sparkles size={19} />
          </div>

          {isMigration && (
            <div
              data-testid="ai-setup-migration-note"
              className="rounded-[10px] bg-accent-tint/85 border border-accent/20 px-3.5 py-2.5 flex items-start gap-2.5 text-[12.5px] font-medium text-accent-on-tint leading-[1.45]"
            >
              <Info size={15} className="shrink-0 mt-0.5" />
              <span>{t("aiSetup.migrationNote")}</span>
            </div>
          )}

          <div className="flex flex-col gap-1.5">
            <h2
              id="ai-setup-dialog-title"
              className="text-[20px] font-bold tracking-[-0.35px] text-text-primary leading-snug"
            >
              {title}
            </h2>
            <p className="text-[14px] text-text-secondary leading-[1.5]">{body}</p>
          </div>
        </div>

        {/* Detected agent box */}
        <div className="rounded-[12px] border border-border-subtle bg-surface-inset/50 px-4 py-3.5 flex items-center gap-3">
          <div className="size-9 rounded-[10px] bg-surface-solid border border-border-subtle flex items-center justify-center text-text-secondary shrink-0">
            {effectiveState === "checking" || effectiveState === "signing_in" ? (
              <Loader2 size={16} className="animate-spin text-accent-fg" />
            ) : (
              <Terminal size={16} />
            )}
          </div>

          <div className="min-w-0 flex-1">
            <p className="text-[14px] font-semibold text-text-primary leading-snug truncate">
              {detectedName}
            </p>
            <p
              className={`text-[12.5px] leading-snug truncate mt-0.5 ${
                loginError && effectiveState === "not_signed_in"
                  ? "text-danger"
                  : "text-text-tertiary"
              }`}
            >
              {detectedDetail}
            </p>
          </div>

          {effectiveState === "ready" && (
            <StatusBadge tone="success" label={t("settings.ai.codex.ready")} />
          )}
          {effectiveState === "not_signed_in" && (
            <StatusBadge tone="warning" label={t("settings.ai.codex.signInNeeded")} />
          )}
          {effectiveState === "too_old" && (
            <StatusBadge tone="warning" label={t("settings.ai.codex.updateNeeded")} />
          )}
          {effectiveState === "failed" && (
            <StatusBadge tone="danger" label={t("settings.ai.codex.errorBadge")} />
          )}
        </div>

        {/* Install / Update command box */}
        {commandText && (
          <div className="rounded-[10px] bg-surface-inset border border-border-subtle px-3 py-2.5 flex items-center justify-between gap-2.5">
            <code className="font-mono text-[13px] text-text-primary select-all truncate">
              {commandText}
            </code>
            <button
              type="button"
              onClick={() => handleCopyCommand(commandText)}
              aria-label={copied ? t("common.copied") : t("settings.ai.codex.copyCommand")}
              className="p-1.5 rounded-[6px] text-text-secondary hover:text-text-primary hover:bg-border-subtle cursor-pointer transition-colors shrink-0"
            >
              {copied ? <Check size={15} className="text-success" /> : <Copy size={15} />}
            </button>
          </div>
        )}

        {/* Primary action stack */}
        <div className="flex flex-col gap-2.5">
          {effectiveState === "ready" && (
            <Button
              type="button"
              appearance="dawn"
              variant="primary"
              disabled={saving}
              onClick={() => void handleUseCodex()}
              className="w-full !h-[42px] !text-[14px]"
            >
              <Check size={15} />
              <span>{t("aiSetup.useCodex")}</span>
            </Button>
          )}

          {effectiveState === "not_signed_in" && (
            <Button
              type="button"
              appearance="dawn"
              variant="primary"
              disabled={saving}
              onClick={() => void handleSignIn()}
              className="w-full !h-[42px] !text-[14px]"
            >
              <LogIn size={15} />
              <span>{t("settings.ai.signInWithChatGpt")}</span>
            </Button>
          )}

          {effectiveState === "signing_in" && (
            <Button
              type="button"
              appearance="dawn"
              variant="secondary"
              onClick={cancelSignIn}
              className="w-full !h-[42px] !text-[14px]"
            >
              <X size={15} />
              <span>{t("aiSetup.cancelSignIn")}</span>
            </Button>
          )}

          {effectiveState === "not_installed" && (
            <>
              <Button
                type="button"
                appearance="dawn"
                variant="primary"
                onClick={() => void probeCodex()}
                className="w-full !h-[42px] !text-[14px]"
              >
                <RefreshCw size={15} />
                <span>{t("settings.ai.codex.checkAgain")}</span>
              </Button>
              <Button
                type="button"
                appearance="dawn"
                variant="secondary"
                onClick={() => void openUrl(CODEX_INSTALL_GUIDE_URL)}
                className="w-full !h-[42px] !text-[14px]"
              >
                <ExternalLink size={15} />
                <span>{t("aiSetup.openInstallGuide")}</span>
              </Button>
            </>
          )}

          {effectiveState === "too_old" && (
            <Button
              type="button"
              appearance="dawn"
              variant="primary"
              onClick={() => void probeCodex()}
              className="w-full !h-[42px] !text-[14px]"
            >
              <RefreshCw size={15} />
              <span>{t("settings.ai.codex.checkAgain")}</span>
            </Button>
          )}

          {effectiveState === "failed" && (
            <Button
              type="button"
              appearance="dawn"
              variant="primary"
              onClick={() => void probeCodex()}
              className="w-full !h-[42px] !text-[14px]"
            >
              <RefreshCw size={15} />
              <span>{t("settings.ai.retry")}</span>
            </Button>
          )}

          {effectiveState === "checking" && (
            <Button
              type="button"
              appearance="dawn"
              variant="secondary"
              disabled
              className="w-full !h-[42px] !text-[14px]"
            >
              <Loader2 size={15} className="animate-spin" />
              <span>{t("settings.ai.codex.checking")}</span>
            </Button>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between pt-1">
          <button
            type="button"
            disabled={saving}
            onClick={() => void handleUseApi()}
            className="inline-flex items-center gap-1.5 text-[13.5px] font-medium text-text-secondary hover:text-text-primary cursor-pointer transition-colors disabled:opacity-50"
          >
            <KeyRound size={14} />
            <span>{t("aiSetup.useApiOrOllama")}</span>
          </button>

          <button
            type="button"
            disabled={saving}
            onClick={() => void handleSkip()}
            className="text-[13.5px] font-medium text-text-secondary hover:text-text-primary cursor-pointer transition-colors disabled:opacity-50"
          >
            {t("aiSetup.skipForNow")}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
