import type { ReactNode } from "react";

interface SegmentProps {
  label: ReactNode;
  count?: number;
  selected?: boolean;
  variant?: "accent" | "solid";
  onClick?: () => void;
  className?: string;
}

export function Segment({
  label,
  count,
  selected = false,
  variant = "accent",
  onClick,
  className = "",
}: SegmentProps) {
  const selectedClass =
    variant === "solid"
      ? "bg-surface-solid text-text-primary font-semibold shadow-xs"
      : "bg-accent-tint text-accent-on-tint font-semibold";

  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      className={`inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-full text-[13px] whitespace-nowrap cursor-pointer transition-colors focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-focus-ring ${
        selected
          ? selectedClass
          : "text-text-secondary font-medium hover:bg-surface-hover"
      } ${className}`}
    >
      <span>{label}</span>
      {count !== undefined && (
        <span
          className={`font-mono text-[11px] leading-none ${
            selected ? "text-accent-on-tint" : "text-text-tertiary"
          }`}
        >
          {count}
        </span>
      )}
    </button>
  );
}

export interface SegmentedOption<T extends string> {
  value: T;
  label: ReactNode;
  count?: number;
}

interface SegmentedControlProps<T extends string> {
  value: T;
  onChange: (value: T) => void;
  options: SegmentedOption<T>[];
  surface?: "glass" | "inset";
  variant?: "accent" | "solid";
  className?: string;
}

export function SegmentedControl<T extends string>({
  value,
  onChange,
  options,
  surface = "glass",
  variant = "accent",
  className = "",
}: SegmentedControlProps<T>) {
  return (
    <div
      className={`inline-flex items-center gap-0.5 p-1 rounded-full ${
        surface === "inset" ? "bg-segment-well" : "dawn-glass"
      } ${className}`}
    >
      {options.map((opt) => (
        <Segment
          key={opt.value}
          label={opt.label}
          count={opt.count}
          selected={opt.value === value}
          variant={variant}
          onClick={() => onChange(opt.value)}
        />
      ))}
    </div>
  );
}
