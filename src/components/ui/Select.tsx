import { useState, useRef, useEffect, useLayoutEffect, useCallback, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, Check } from "lucide-react";

export interface SelectOption {
  value: string;
  label: string;
  detail?: string;
  description?: string;
}

interface SelectProps {
  label?: string;
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  icon?: ReactNode;
  highlighted?: boolean;
  appearance?: "dawn" | "legacy";
  className?: string;
  placeholder?: string;
  menuHeader?: ReactNode;
  menuFooter?: ReactNode;
}

const VIEWPORT_MARGIN = 8;

function isDawnSurface(appearance?: "dawn" | "legacy"): boolean {
  if (appearance) return appearance === "dawn";
  return typeof document !== "undefined" && document.documentElement.classList.contains("dawn");
}

export default function Select({
  label,
  value,
  onChange,
  options,
  icon,
  highlighted = false,
  appearance,
  className = "",
  placeholder = "",
  menuHeader,
  menuFooter,
}: SelectProps) {
  const dawn = isDawnSurface(appearance);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [menuStyle, setMenuStyle] = useState<CSSProperties>();

  const selected = options.find((o) => o.value === value);

  const handleClickOutside = useCallback((e: MouseEvent) => {
    const target = e.target as Node;
    if (ref.current?.contains(target) || menuRef.current?.contains(target)) return;
    setOpen(false);
  }, []);

  useEffect(() => {
    if (!open) return;
    const handleScroll = (e: Event) => {
      if (menuRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    const handleResize = () => setOpen(false);
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", handleClickOutside);
    window.addEventListener("scroll", handleScroll, true);
    window.addEventListener("resize", handleResize);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      window.removeEventListener("scroll", handleScroll, true);
      window.removeEventListener("resize", handleResize);
      document.removeEventListener("keydown", handleKey);
    };
  }, [open, handleClickOutside]);

  const menuGap = dawn ? 6 : 4;
  const optionHeight = dawn ? 38 : 40;
  const describedOptionHeight = 52;
  const menuHeight = options.reduce(
    (h, o) => h + (o.description != null ? describedOptionHeight : optionHeight),
    dawn ? 12 + (menuHeader ? 44 : 0) + (menuFooter ? 44 : 0) : 2,
  );

  // The menu is portaled to <body> so it can't be clipped by overflow
  // containers (settings modal scroll area, bento tiles, accordion animations).
  useLayoutEffect(() => {
    if (!open || !buttonRef.current) return;
    const rect = buttonRef.current.getBoundingClientRect();
    const spaceBelow = window.innerHeight - rect.bottom - menuGap - VIEWPORT_MARGIN;
    const spaceAbove = rect.top - menuGap - VIEWPORT_MARGIN;
    const openUp = menuHeight > spaceBelow && spaceAbove > spaceBelow;
    if (dawn) {
      const minWidth = Math.max(rect.width, 200);
      const left = Math.min(rect.left, window.innerWidth - minWidth - VIEWPORT_MARGIN);
      setMenuStyle({
        left: Math.max(VIEWPORT_MARGIN, left),
        minWidth: rect.width,
        width: minWidth,
        maxHeight: Math.min(menuHeight, openUp ? spaceAbove : spaceBelow),
        ...(openUp
          ? { bottom: window.innerHeight - rect.top + menuGap }
          : { top: rect.bottom + menuGap }),
      });
    } else {
      setMenuStyle({
        left: rect.left,
        width: rect.width,
        maxHeight: Math.min(menuHeight, openUp ? spaceAbove : spaceBelow),
        ...(openUp
          ? { bottom: window.innerHeight - rect.top + menuGap }
          : { top: rect.bottom + menuGap }),
      });
    }
  }, [open, menuHeight, menuGap, dawn]);

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
        className={
          dawn
            ? `w-full h-[38px] rounded-full px-3.5 text-[13px] font-medium flex items-center justify-between gap-[7px] cursor-pointer transition-colors focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-focus-ring ${
                highlighted
                  ? "bg-accent-tint border border-violet-200 text-accent-on-tint font-semibold"
                  : "dawn-glass text-text-primary hover:bg-surface-solid"
              }`
            : "w-full h-9 bg-bg-input rounded-lg px-3 text-[13px] font-medium text-text-primary flex items-center justify-between cursor-pointer border border-transparent hover:border-border transition-colors"
        }
      >
        <span className="flex items-center gap-1.5 min-w-0">
          {icon && (
            <span
              className={`shrink-0 inline-flex ${
                highlighted ? "text-accent-on-tint" : "text-text-secondary"
              }`}
            >
              {icon}
            </span>
          )}
          <span className="truncate">{selected?.label ?? placeholder}</span>
          {selected?.detail != null && (
            <span
              className={`text-[12px] shrink-0 ${
                dawn
                  ? `font-mono ${highlighted ? "text-violet-600" : "text-text-tertiary"}`
                  : "text-text-muted"
              }`}
            >
              {selected.detail}
            </span>
          )}
        </span>
        <ChevronDown
          size={dawn ? 13 : 16}
          className={`shrink-0 transition-transform ${
            dawn
              ? highlighted
                ? "text-accent-on-tint"
                : "text-text-tertiary"
              : "text-text-muted"
          } ${open ? "rotate-180" : ""}`}
        />
      </button>

      {open &&
        menuStyle &&
        createPortal(
          <div
            ref={menuRef}
            style={menuStyle}
            // The menu lives under document.body, so without this, pressing an
            // option registers as an outside click for ancestor popovers
            // (e.g. ReaderSettings) and closes them before the option's
            // onClick fires.
            onMouseDown={(e) => e.stopPropagation()}
            className={
              dawn
                ? "fixed z-[70] dawn-menu rounded-[14px] p-1.5 overflow-y-auto"
                : "fixed z-[70] bg-bg-surface border border-border rounded-xl shadow-popover overflow-y-auto"
            }
          >
            {menuHeader}
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
                  className={
                    dawn
                      ? `w-full flex items-center justify-between gap-2.5 px-2.5 rounded-[8px] text-[13.5px] cursor-pointer transition-colors ${
                          option.description != null ? "h-[52px] py-1.5" : "h-[36px]"
                        } ${
                          isActive
                            ? "bg-violet-50 text-accent-on-tint"
                            : "text-text-primary hover:bg-black/[0.04]"
                        }`
                      : `w-full flex items-center justify-between gap-3 px-4 text-[14px] cursor-pointer transition-colors ${
                          option.description != null ? "h-13 py-1.5" : "h-10"
                        } ${
                          isActive
                            ? "bg-accent-bg text-accent-text"
                            : "text-text-primary hover:bg-bg-input"
                        }`
                  }
                >
                  <span className="min-w-0 text-left">
                    <span className="block truncate">{option.label}</span>
                    {option.description != null && (
                      <span
                        className={`block truncate text-[12px] ${
                          dawn
                            ? isActive
                              ? "text-accent-on-tint/80"
                              : "text-text-tertiary"
                            : isActive
                              ? "text-accent-text/80"
                              : "text-text-muted"
                        }`}
                      >
                        {option.description}
                      </span>
                    )}
                  </span>
                  <span className="flex items-center gap-2 shrink-0">
                    {option.detail != null && (
                      <span
                        className={
                          dawn
                            ? `text-[11.5px] font-mono ${
                                isActive ? "text-accent-on-tint" : "text-text-tertiary"
                              }`
                            : `text-[12px] ${isActive ? "text-accent-text" : "text-text-muted"}`
                        }
                      >
                        {option.detail}
                      </span>
                    )}
                    {isActive && (
                      <Check
                        size={dawn ? 14 : 16}
                        className={dawn ? "text-accent-on-tint" : "text-accent-text"}
                      />
                    )}
                  </span>
                </button>
              );
            })}
            {menuFooter}
          </div>,
          document.body,
        )}
    </div>
  );
}
