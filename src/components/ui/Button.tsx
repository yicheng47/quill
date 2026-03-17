import { ButtonHTMLAttributes, forwardRef } from "react";

type ButtonVariant = "primary" | "secondary" | "ghost" | "icon";
type ButtonSize = "sm" | "md" | "lg";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  active?: boolean;
}

const variantStyles: Record<ButtonVariant, string> = {
  primary:
    "bg-accent text-white hover:opacity-90 font-medium",
  secondary:
    "border border-border text-[#3f3f47] hover:bg-bg-input font-medium",
  ghost:
    "text-text-muted hover:bg-bg-input",
  icon:
    "text-text-muted hover:bg-bg-input justify-center",
};

const sizeStyles: Record<ButtonSize, string> = {
  sm: "h-8 px-2 text-[13px] rounded-md gap-1.5",
  md: "h-9 px-3 text-[14px] rounded-lg gap-2",
  lg: "h-10 px-4 text-[14px] rounded-lg gap-2",
};

const iconSizeStyles: Record<ButtonSize, string> = {
  sm: "size-8 rounded-md",
  md: "size-9 rounded-lg",
  lg: "size-10 rounded-lg",
};

const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ variant = "primary", size = "md", active, className = "", children, ...props }, ref) => {
    const base = "inline-flex items-center shrink-0 cursor-pointer transition-colors disabled:opacity-50 disabled:pointer-events-none";
    const variantClass = active
      ? variant === "icon"
        ? "text-accent-text justify-center"
        : "bg-accent-bg text-accent-text font-medium"
      : variantStyles[variant];
    const sizeClass = variant === "icon" ? iconSizeStyles[size] : sizeStyles[size];

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
