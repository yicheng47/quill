import { Bot, KeyRound, Settings } from "lucide-react";
import { useTranslation } from "react-i18next";
import Button from "./ui/Button";

interface AiAuthPromptCardProps {
  variant: "reauth" | "notConfigured";
  onOpenSettings: () => void;
  embedded?: boolean;
  className?: string;
}

export default function AiAuthPromptCard({
  variant,
  onOpenSettings,
  embedded = false,
  className = "",
}: AiAuthPromptCardProps) {
  const { t } = useTranslation();
  const isReauth = variant === "reauth";

  const wrapperClass = embedded
    ? "flex flex-col items-center text-center gap-3.5 px-[22px] py-[22px]"
    : "bg-surface-solid border border-border-subtle rounded-[6px] p-6 flex flex-col items-center text-center gap-3.5 shadow-glass";

  return (
    <div
      data-testid={isReauth ? "ai-reauth-card" : "ai-not-configured-card"}
      className={`${wrapperClass} ${className}`}
    >
      <div
        className={`size-11 rounded-full flex items-center justify-center shrink-0 ${
          isReauth ? "bg-warning-tint text-warning" : "bg-accent-tint text-accent-on-tint"
        }`}
      >
        {isReauth ? <KeyRound size={18} /> : <Bot size={19} />}
      </div>

      <div className="flex flex-col items-center gap-1">
        <p className="text-[15px] font-semibold text-text-primary leading-snug">
          {isReauth ? t("ai.reauthTitle") : t("ai.notConfiguredTitle")}
        </p>
        <p className="text-[13px] leading-[1.5] text-text-secondary max-w-[340px]">
          {isReauth ? t("ai.reauthRequired") : t("ai.notConfigured")}
        </p>
      </div>

      <Button
        type="button"
        appearance="dawn"
        variant={isReauth ? "primary" : "tonal"}
        size="sm"
        onClick={onOpenSettings}
      >
        <Settings size={14} />
        <span>{isReauth ? t("ai.signInAgain") : t("ai.openSettings")}</span>
      </Button>
    </div>
  );
}
