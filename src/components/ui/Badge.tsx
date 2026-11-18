import { Check } from "lucide-react";

export function PercentBadge({ percent, className = "" }: { percent: number; className?: string }) {
  return (
    <span
      className={`inline-flex items-center px-2 py-[3px] rounded-full bg-white/90 backdrop-blur-[10px] font-mono text-[11px] font-medium text-text-primary leading-none ${className}`}
    >
      {percent}%
    </span>
  );
}

export function DoneBadge({ className = "" }: { className?: string }) {
  return (
    <span
      className={`inline-flex items-center justify-center size-[22px] rounded-full bg-white/90 backdrop-blur-[10px] text-success ${className}`}
    >
      <Check size={12} strokeWidth={2.5} />
    </span>
  );
}

type StatusTone = "success" | "accent" | "warning" | "danger" | "neutral";

const TONE_STYLES: Record<StatusTone, { bg: string; dot: string; text: string }> = {
  success: { bg: "bg-success-tint", dot: "bg-success", text: "text-success" },
  accent: { bg: "bg-accent-tint", dot: "bg-accent", text: "text-accent-on-tint" },
  warning: { bg: "bg-warning-tint", dot: "bg-warning", text: "text-warning" },
  danger: { bg: "bg-danger-tint", dot: "bg-danger", text: "text-danger" },
  neutral: { bg: "bg-black/[0.06]", dot: "bg-text-tertiary", text: "text-text-secondary" },
};

export function StatusBadge({
  tone = "neutral",
  label,
  pulse = false,
  className = "",
}: {
  tone?: StatusTone;
  label: string;
  pulse?: boolean;
  className?: string;
}) {
  const s = TONE_STYLES[tone];
  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[12px] font-medium leading-none ${s.bg} ${s.text} ${className}`}
    >
      <span
        className={`size-1.5 rounded-full shrink-0 ${s.dot} ${pulse ? "animate-pulse" : ""}`}
      />
      <span>{label}</span>
    </span>
  );
}
