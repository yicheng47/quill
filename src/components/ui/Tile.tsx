import { ReactNode } from "react";

interface TileProps {
  title?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  onClick?: () => void;
}

export default function Tile({
  title,
  action,
  children,
  className = "",
  onClick,
}: TileProps) {
  return (
    <div
      onClick={onClick}
      className={`dawn-glass rounded-surface p-6 flex flex-col gap-3.5 ${
        onClick ? "cursor-pointer transition-colors hover:bg-surface-solid" : ""
      } ${className}`}
    >
      {(title || action) && (
        <div className="flex items-center justify-between gap-3">
          {title && (
            <span className="text-[13px] font-medium text-text-secondary">
              {title}
            </span>
          )}
          {action && <div className="shrink-0 flex items-center">{action}</div>}
        </div>
      )}
      {children}
    </div>
  );
}
