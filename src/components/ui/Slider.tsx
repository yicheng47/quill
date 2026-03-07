interface SliderProps {
  min: number;
  max: number;
  value: number;
  onChange: (value: number) => void;
  label: string;
  displayValue: string;
  hint?: string;
}

export default function Slider({
  min,
  max,
  value,
  onChange,
  label,
  displayValue,
  hint,
}: SliderProps) {
  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <label className="text-[14px] font-semibold text-text-primary">{label}</label>
        <span className="text-[14px] text-text-secondary">{displayValue}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full h-1.5 rounded-full appearance-none cursor-pointer accent-dark bg-border"
      />
      {hint && (
        <p className="text-[12px] text-text-muted mt-1.5">{hint}</p>
      )}
    </div>
  );
}
