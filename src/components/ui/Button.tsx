import { ButtonHTMLAttributes, forwardRef } from "react";

type ButtonVariant = "primary" | "secondary" | "tonal" | "ghost" | "icon";
type ButtonSize = "sm" | "md" | "lg";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  active?: boolean;
  appearance?: "dawn" | "legacy";
}

const dawnVariantStyles: Record<ButtonVariant, string> = {
  primary:
    "bg-accent text-text-on-accent font-semibold hover:bg-accent-hover active:bg-accent-pressed disabled:bg-violet-200 disabled:text-text-on-accent disabled:opacity-100",
  secondary:
    "bg-surface-chip border border-border-default text-text-primary font-medium hover:bg-surface-solid active:bg-surface-inset",
  tonal:
    "bg-accent-tint text-accent-on-tint font-semibold hover:bg-accent-tint-hover",
  ghost:
    "text-text-secondary font-medium hover:bg-black/[0.04]",
  icon:
    "text-text-muted hover:bg-bg-input justify-center",
};

const legacyVariantStyles: Record<ButtonVariant, string> = {
  primary:
    "bg-accent text-white hover:opacity-90 font-medium",
  secondary:
    "border border-border text-text-secondary hover:bg-bg-input font-medium",
  tonal:
    "bg-accent-bg text-accent-text font-medium",
  ghost:
    "text-text-muted hover:bg-bg-input",
  icon:
    "text-text-muted hover:bg-bg-input justify-center",
};

const dawnSizeStyles: Record<ButtonSize, string> = {
  sm: "px-3.5 py-2 text-[13px] rounded-full gap-1.5 leading-none",
  md: "px-5 py-3 text-[14px] rounded-full gap-2 leading-none",
  lg: "px-6 py-3.5 text-[14px] rounded-full gap-2 leading-none",
};

const legacySizeStyles: Record<ButtonSize, string> = {
  sm: "h-8 px-2 text-[13px] rounded-md gap-1.5",
  md: "h-9 px-3 text-[14px] rounded-lg gap-2",
  lg: "h-10 px-4 text-[14px] rounded-lg gap-2",
};

const iconSizeStyles: Record<ButtonSize, string> = {
  sm: "size-8 rounded-md",
  md: "size-9 rounded-lg",
  lg: "size-10 rounded-lg",
};

function isDawnSurface(appearance?: "dawn" | "legacy"): boolean {
  if (appearance) return appearance === "dawn";
  return typeof document !== "undefined" && document.documentElement.classList.contains("dawn");
}

const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  (
    { variant = "primary", size = "md", active, appearance, className = "", children, ...props },
    ref,
  ) => {
    const dawn = isDawnSurface(appearance);
    const base = dawn
      ? "inline-flex items-center justify-center shrink-0 cursor-pointer transition-colors focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-focus-ring disabled:opacity-50 disabled:pointer-events-none"
      : "inline-flex items-center shrink-0 cursor-pointer transition-colors disabled:opacity-50 disabled:pointer-events-none";
    const variantClass = active
      ? variant === "icon"
        ? "text-accent-text justify-center"
        : dawn
          ? "bg-accent-tint text-accent-on-tint font-semibold"
          : "bg-accent-bg text-accent-text font-medium"
      : (dawn ? dawnVariantStyles : legacyVariantStyles)[variant];
    const sizeClass =
      variant === "icon"
        ? iconSizeStyles[size]
        : (dawn ? dawnSizeStyles : legacySizeStyles)[size];

    return (
      <button
        ref={ref}
        className={`${base} ${variantClass} ${sizeClass} ${className}`}
        {...props}
      >
        {children}
      </button>
    );
  },
);

Button.displayName = "Button";

export default Button;
