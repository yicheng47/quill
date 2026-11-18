import { ButtonHTMLAttributes, forwardRef, ReactNode } from "react";

interface ChipProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  selected?: boolean;
  icon?: ReactNode;
  count?: number;
}

const Chip = forwardRef<HTMLButtonElement, ChipProps>(
  ({ selected = false, icon, count, children, className = "", ...props }, ref) => {
    return (
      <button
        ref={ref}
        type="button"
        className={`inline-flex items-center gap-1.5 px-3.5 py-2 rounded-full text-[13px] cursor-pointer transition-colors focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-focus-ring disabled:opacity-50 disabled:pointer-events-none ${
          selected
            ? "bg-accent-tint border border-accent/35 text-accent-on-tint font-semibold"
            : "dawn-chip text-text-primary font-normal hover:bg-surface-solid"
        } ${className}`}
        {...props}
      >
        {icon && (
          <span
            className={`inline-flex shrink-0 ${
              selected ? "text-accent-on-tint" : "text-text-tertiary"
            }`}
          >
            {icon}
          </span>
        )}
        <span className="truncate">{children}</span>
        {count !== undefined && (
          <span
            className={`font-mono text-[11px] leading-none shrink-0 ${
              selected ? "text-accent-on-tint" : "text-text-tertiary"
            }`}
          >
            {count}
          </span>
        )}
      </button>
    );
  },
);

Chip.displayName = "Chip";

export default Chip;
