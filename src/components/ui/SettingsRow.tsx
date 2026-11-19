import { ReactNode } from "react";

interface SettingsOverlineProps {
  children: ReactNode;
  className?: string;
}

export function SettingsOverline({ children, className = "" }: SettingsOverlineProps) {
  return (
    <h3
      className={`text-[11.5px] font-semibold uppercase tracking-[1px] text-text-tertiary ${className}`}
    >
      {children}
    </h3>
  );
}

interface SettingsGroupProps {
  children: ReactNode;
  className?: string;
}

export function SettingsGroup({ children, className = "" }: SettingsGroupProps) {
  return (
    <div
      className={`dawn-inset rounded-[6px] divide-y divide-border-subtle overflow-hidden ${className}`}
    >
      {children}
    </div>
  );
}

interface SettingsRowProps {
  title: ReactNode;
  hint?: ReactNode;
  children: ReactNode;
  className?: string;
}

export function SettingsRow({ title, hint, children, className = "" }: SettingsRowProps) {
  return (
    <div
      className={`min-h-[72px] px-5 py-3 flex items-center justify-between gap-6 ${className}`}
    >
      <div className="min-w-0 flex-1">
        <p className="text-[14px] font-medium text-text-primary leading-snug">
          {title}
        </p>
        {hint && (
          <p className="text-[12.5px] text-text-tertiary mt-[3px] leading-snug">
            {hint}
          </p>
        )}
      </div>
      <div className="shrink-0 flex items-center gap-2.5">{children}</div>
    </div>
  );
}
