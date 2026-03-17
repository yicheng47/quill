interface ToggleProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}

export default function Toggle({ checked, onChange, disabled }: ToggleProps) {
  return (
    <button
      onClick={() => !disabled && onChange(!checked)}
      disabled={disabled}
      className={`relative w-[44px] h-[24px] rounded-full transition-colors ${
        disabled ? "opacity-50 cursor-not-allowed" : "cursor-pointer"
      } ${checked ? "bg-accent" : "bg-border"}`}
    >
      <div
        className={`absolute top-[2px] size-5 rounded-full bg-white shadow transition-transform ${
          checked ? "translate-x-[22px]" : "translate-x-[2px]"
        }`}
      />
    </button>
  );
}
