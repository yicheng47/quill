import { ButtonHTMLAttributes, HTMLAttributes, forwardRef, ReactNode } from "react";

interface MenuProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
}

export const Menu = forwardRef<HTMLDivElement, MenuProps>(
  ({ className = "", children, ...props }, ref) => (
    <div
      ref={ref}
      className={`dawn-menu rounded-[14px] p-1.5 flex flex-col gap-0.5 ${className}`}
      {...props}
    >
      {children}
    </div>
  ),
);
Menu.displayName = "Menu";

interface MenuItemProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  icon?: ReactNode;
  shortcut?: string;
  active?: boolean;
  tone?: "default" | "danger";
}

export function MenuItem({
  icon,
  shortcut,
  active = false,
  tone = "default",
  children,
  className = "",
  ...props
}: MenuItemProps) {
  const toneClass =
    tone === "danger"
      ? "text-danger hover:bg-danger-tint"
      : active
        ? "bg-violet-50 text-accent-on-tint"
        : "text-text-primary hover:bg-violet-50 hover:text-accent-on-tint";

  return (
    <button
      type="button"
      className={`w-full flex items-center gap-2.5 px-2.5 py-2 rounded-[8px] text-[13.5px] text-left cursor-pointer transition-colors disabled:opacity-50 disabled:pointer-events-none ${toneClass} ${className}`}
      {...props}
    >
      {icon && (
        <span
          className={`shrink-0 inline-flex ${
            tone === "danger"
              ? "text-danger"
              : active
                ? "text-accent-on-tint"
                : "text-text-secondary"
          }`}
        >
          {icon}
        </span>
      )}
      <span className="flex-1 min-w-0 truncate">{children}</span>
      {shortcut && (
        <span className="font-mono text-[11px] text-text-tertiary shrink-0">
          {shortcut}
        </span>
      )}
    </button>
  );
}

export function MenuDivider() {
  return <div className="my-1 h-px bg-border-subtle" />;
}
