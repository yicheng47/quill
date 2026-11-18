import { ButtonHTMLAttributes, forwardRef } from "react";

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  active?: boolean;
  size?: "sm" | "md";
}

const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(
  ({ active = false, size = "md", className = "", children, ...props }, ref) => {
    const sizeClass = size === "sm" ? "size-8" : "size-9";
    const stateClass = active
      ? "bg-accent-tint border border-accent/30 text-accent-on-tint"
      : "dawn-glass text-text-secondary hover:bg-surface-solid";

    return (
      <button
        ref={ref}
        type="button"
        className={`inline-flex items-center justify-center shrink-0 rounded-full cursor-pointer transition-colors focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-focus-ring disabled:opacity-50 disabled:pointer-events-none ${sizeClass} ${stateClass} ${className}`}
        {...props}
      >
        {children}
      </button>
    );
  },
);

IconButton.displayName = "IconButton";

export default IconButton;
