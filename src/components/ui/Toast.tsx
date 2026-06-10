import type { ReactNode } from "react";
import { Check } from "lucide-react";

interface ToastProps {
  children: ReactNode;
  icon?: ReactNode;
  className?: string;
}

export default function Toast({ children, icon, className = "" }: ToastProps) {
  return (
    <div
      role="status"
      aria-live="polite"
      className={`fixed top-5 left-1/2 z-[60] -translate-x-1/2 ${className}`}
    >
      <div className="flex min-w-[260px] items-center gap-3 rounded-[14px] border border-border bg-white py-2.5 pl-4 pr-3 shadow-popover dark:bg-bg-surface">
        {icon ?? <Check size={14} className="shrink-0 text-success-text" />}
        <span className="flex-1 whitespace-nowrap text-[13px] font-normal tracking-[-0.08px] text-text-secondary">
          {children}
        </span>
      </div>
    </div>
  );
}
