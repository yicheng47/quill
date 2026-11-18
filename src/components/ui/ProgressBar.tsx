interface ProgressBarProps {
  value: number;
  className?: string;
}

export default function ProgressBar({ value, className = "" }: ProgressBarProps) {
  const pct = Math.max(0, Math.min(100, value));
  return (
    <div
      role="progressbar"
      aria-valuenow={pct}
      aria-valuemin={0}
      aria-valuemax={100}
      className={`h-1 w-full rounded-full bg-track overflow-hidden ${className}`}
    >
      <div
        className="h-full rounded-full bg-progress transition-[width] duration-200"
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}
