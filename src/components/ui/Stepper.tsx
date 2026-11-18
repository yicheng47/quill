import { useTranslation } from "react-i18next";
import { Minus, Plus } from "lucide-react";

interface StepperProps {
  valueLabel: string;
  onDecrement: () => void;
  onIncrement: () => void;
  disableDecrement?: boolean;
  disableIncrement?: boolean;
  decrementLabel?: string;
  incrementLabel?: string;
  className?: string;
}

export default function Stepper({
  valueLabel,
  onDecrement,
  onIncrement,
  disableDecrement = false,
  disableIncrement = false,
  decrementLabel,
  incrementLabel,
  className = "",
}: StepperProps) {
  const { t } = useTranslation();

  return (
    <div
      className={`inline-flex items-center gap-0.5 p-[3px] rounded-full bg-surface-solid border border-border-default shrink-0 ${className}`}
    >
      <button
        type="button"
        onClick={onDecrement}
        disabled={disableDecrement}
        aria-label={decrementLabel ?? t("common.decrease")}
        className="size-7 rounded-full bg-border-subtle hover:bg-border-default flex items-center justify-center text-text-secondary cursor-pointer transition-colors disabled:opacity-40 disabled:pointer-events-none"
      >
        <Minus size={13} />
      </button>
      <span className="min-w-[56px] px-1.5 text-center font-mono text-[12.5px] font-medium text-text-primary select-none">
        {valueLabel}
      </span>
      <button
        type="button"
        onClick={onIncrement}
        disabled={disableIncrement}
        aria-label={incrementLabel ?? t("common.increase")}
        className="size-7 rounded-full bg-border-subtle hover:bg-border-default flex items-center justify-center text-text-secondary cursor-pointer transition-colors disabled:opacity-40 disabled:pointer-events-none"
      >
        <Plus size={13} />
      </button>
    </div>
  );
}
