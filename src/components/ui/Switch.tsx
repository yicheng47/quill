interface SwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  "aria-label"?: string;
}

export default function Switch({ checked, onChange, disabled = false, ...rest }: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => !disabled && onChange(!checked)}
      className={`w-[38px] h-[22px] p-[3px] rounded-full flex items-center transition-colors shrink-0 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-focus-ring ${
        disabled ? "opacity-50 cursor-not-allowed" : "cursor-pointer"
      } ${checked ? "bg-accent justify-end" : "bg-border-strong justify-start"}`}
      {...rest}
    >
      <span className="size-4 rounded-full bg-surface-solid shadow-[0_1px_3px_rgba(21,21,26,0.2)] transition-transform" />
    </button>
  );
}
