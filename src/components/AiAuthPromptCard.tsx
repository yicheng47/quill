import { AlertCircle, ArrowUpCircle, Bot, KeyRound, Settings, Terminal } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { AiSentinel } from "../lib/aiConnections";
import Button from "./ui/Button";

interface AiAuthPromptCardProps {
  sentinel: AiSentinel;
  onOpenSettings: () => void;
  embedded?: boolean;
  className?: string;
}

const CARD_META: Record<
  AiSentinel,
  {
    testId: string;
    tone: "accent" | "warning" | "danger";
    buttonVariant: "primary" | "tonal";
    titleKey: string;
    bodyKey: string;
    ctaKey: string;
  }
> = {
  AI_NOT_CONFIGURED: {
    testId: "ai-not-configured-card",
    tone: "accent",
    buttonVariant: "tonal",
    titleKey: "ai.notConfiguredTitle",
    bodyKey: "ai.notConfigured",
    ctaKey: "ai.openSettings",
  },
  CODEX_NOT_SIGNED_IN: {
    testId: "ai-codex-not-signed-in-card",
    tone: "warning",
    buttonVariant: "primary",
    titleKey: "ai.codexNotSignedInTitle",
    bodyKey: "ai.codexNotSignedIn",
    ctaKey: "ai.openSettings",
  },
  CODEX_NOT_INSTALLED: {
    testId: "ai-codex-not-installed-card",
    tone: "accent",
    buttonVariant: "primary",
    titleKey: "ai.codexNotInstalledTitle",
    bodyKey: "ai.codexNotInstalled",
    ctaKey: "ai.openSettings",
  },
  CODEX_TOO_OLD: {
    testId: "ai-codex-too-old-card",
    tone: "warning",
    buttonVariant: "primary",
    titleKey: "ai.codexTooOldTitle",
    bodyKey: "ai.codexTooOld",
    ctaKey: "ai.openSettings",
  },
  CODEX_FAILED: {
    testId: "ai-codex-failed-card",
    tone: "danger",
    buttonVariant: "primary",
    titleKey: "ai.codexFailedTitle",
    bodyKey: "ai.codexFailed",
    ctaKey: "ai.openSettings",
  },
};

function renderIcon(sentinel: AiSentinel) {
  switch (sentinel) {
    case "CODEX_NOT_SIGNED_IN":
      return <KeyRound size={18} />;
    case "CODEX_NOT_INSTALLED":
      return <Terminal size={18} />;
    case "CODEX_TOO_OLD":
      return <ArrowUpCircle size={18} />;
    case "CODEX_FAILED":
      return <AlertCircle size={18} />;
    case "AI_NOT_CONFIGURED":
    default:
      return <Bot size={19} />;
  }
}

export default function AiAuthPromptCard({
  sentinel,
  onOpenSettings,
  embedded = false,
  className = "",
}: AiAuthPromptCardProps) {
  const { t } = useTranslation();
  const meta = CARD_META[sentinel];

  const toneClass =
    meta.tone === "warning"
      ? "bg-warning-tint text-warning"
      : meta.tone === "danger"
        ? "bg-danger-tint text-danger"
        : "bg-accent-tint text-accent-on-tint";

  const wrapperClass = embedded
    ? "flex flex-col items-center text-center gap-3.5 px-[22px] py-[22px]"
    : "bg-surface-solid border border-border-subtle rounded-[6px] p-6 flex flex-col items-center text-center gap-3.5 shadow-glass";

  return (
    <div data-testid={meta.testId} className={`${wrapperClass} ${className}`}>
      <div className={`size-11 rounded-full flex items-center justify-center shrink-0 ${toneClass}`}>
        {renderIcon(sentinel)}
      </div>

      <div className="flex flex-col items-center gap-1">
        <p className="text-[15px] font-semibold text-text-primary leading-snug">
          {t(meta.titleKey)}
        </p>
        <p className="text-[13px] leading-[1.5] text-text-secondary max-w-[340px]">
          {t(meta.bodyKey)}
        </p>
      </div>

      <Button
        type="button"
        appearance="dawn"
        variant={meta.buttonVariant}
        size="sm"
        onClick={onOpenSettings}
      >
        <Settings size={14} />
        <span>{t(meta.ctaKey)}</span>
      </Button>
    </div>
  );
}
