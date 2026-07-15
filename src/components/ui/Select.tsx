import { useState, useRef, useEffect, useLayoutEffect, useCallback, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, Check } from "lucide-react";

interface SelectOption {
  value: string;
  label: string;
  detail?: string;
}

interface SelectProps {
  label?: string;
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  className?: string;
  placeholder?: string;
}

const MENU_GAP = 4;
const OPTION_HEIGHT = 40;
const VIEWPORT_MARGIN = 8;

export default function Select({ label, value, onChange, options, className = "", placeholder = "" }: SelectProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [menuStyle, setMenuStyle] = useState<CSSProperties>();

  const selected = options.find((o) => o.value === value);

  const handleClickOutside = useCallback(
    (e: MouseEvent) => {
      const target = e.target as Node;
      if (ref.current?.contains(target) || menuRef.current?.contains(target)) return;
      setOpen(false);
    },
    [],
  );

  useEffect(() => {
    if (!open) return;
    const handleScroll = (e: Event) => {
      if (menuRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    const handleResize = () => setOpen(false);
    document.addEventListener("mousedown", handleClickOutside);
    window.addEventListener("scroll", handleScroll, true);
    window.addEventListener("resize", handleResize);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      window.removeEventListener("scroll", handleScroll, true);
      window.removeEventListener("resize", handleResize);
    };
  }, [open, handleClickOutside]);

  // The menu is portaled to <body> so it can't be clipped by overflow
  // containers (settings modal scroll area, accordion animations).
  useLayoutEffect(() => {
    if (!open || !buttonRef.current) return;
    const rect = buttonRef.current.getBoundingClientRect();
    const menuHeight = options.length * OPTION_HEIGHT + 2;
    const spaceBelow = window.innerHeight - rect.bottom - MENU_GAP - VIEWPORT_MARGIN;
    const spaceAbove = rect.top - MENU_GAP - VIEWPORT_MARGIN;
    const openUp = menuHeight > spaceBelow && spaceAbove > spaceBelow;
    setMenuStyle({
      left: rect.left,
      width: rect.width,
      maxHeight: Math.min(menuHeight, openUp ? spaceAbove : spaceBelow),
      ...(openUp
        ? { bottom: window.innerHeight - rect.top + MENU_GAP }
        : { top: rect.bottom + MENU_GAP }),
    });
  }, [open, options.length]);

  return (
    <div className={`relative ${className}`} ref={ref}>
      {label && (
        <label className="block text-[14px] font-semibold text-text-primary mb-1.5">
          {label}
        </label>
      )}
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full h-9 bg-bg-input rounded-lg px-3 text-[13px] font-medium text-text-primary flex items-center justify-between cursor-pointer border border-transparent hover:border-border transition-colors"
      >
        <span className="flex items-center gap-1.5 min-w-0">
          <span className="truncate">{selected?.label ?? placeholder}</span>
          {selected?.detail != null && (
            <span className="text-[12px] text-text-muted shrink-0">{selected.detail}</span>
          )}
        </span>
        <ChevronDown size={16} className={`text-text-muted shrink-0 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>

      {open && menuStyle &&
        createPortal(
          <div
            ref={menuRef}
            style={menuStyle}
            // The menu lives under document.body, so without this, pressing an
            // option registers as an outside click for ancestor popovers
            // (e.g. ReaderSettings) and closes them before the option's
            // onClick fires.
            onMouseDown={(e) => e.stopPropagation()}
            className="fixed z-[70] bg-bg-surface border border-border rounded-xl shadow-popover overflow-y-auto"
          >
            {options.map((option) => {
              const isActive = option.value === value;
              return (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => {
                    onChange(option.value);
                    setOpen(false);
                  }}
                  className={`w-full flex items-center justify-between px-4 h-10 text-[14px] cursor-pointer transition-colors ${
                    isActive
                      ? "bg-accent-bg text-accent-text"
                      : "text-text-primary hover:bg-bg-input"
                  }`}
                >
                  <span className="truncate">{option.label}</span>
                  <span className="flex items-center gap-2 shrink-0">
                    {option.detail != null && (
                      <span className={`text-[12px] ${isActive ? "text-accent-text" : "text-text-muted"}`}>
                        {option.detail}
                      </span>
                    )}
                    {isActive && <Check size={16} className="text-accent-text" />}
                  </span>
                </button>
              );
            })}
          </div>,
          document.body,
        )}
    </div>
  );
}
