import { forwardRef, InputHTMLAttributes } from "react";
import { useTranslation } from "react-i18next";
import { Search, X } from "lucide-react";

interface SearchFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "type"> {
  shortcutHint?: string;
  onClear?: () => void;
  clearLabel?: string;
}

const SearchField = forwardRef<HTMLInputElement, SearchFieldProps>(
  ({ value = "", shortcutHint, onClear, clearLabel, className = "", ...props }, ref) => {
    const { t } = useTranslation();
    const hasValue = String(value).length > 0;
    const resolvedClearLabel = clearLabel ?? t("common.clear");

    return (
      <div
        className={`h-10 px-4 rounded-full dawn-glass inline-flex items-center gap-[9px] transition-shadow focus-within:border-accent focus-within:ring-[3px] focus-within:ring-focus-ring ${className}`}
      >
        <Search size={16} className="text-text-tertiary shrink-0" />
        <input
          ref={ref}
          type="text"
          value={value}
          spellCheck={false}
          autoCorrect="off"
          autoCapitalize="off"
          className="flex-1 min-w-0 bg-transparent text-[13.5px] text-text-primary placeholder:text-text-tertiary outline-none"
          {...props}
        />
        {hasValue && onClear ? (
          <button
            type="button"
            onClick={onClear}
            aria-label={resolvedClearLabel}
            className="size-5 rounded-full flex items-center justify-center text-text-tertiary hover:text-text-primary hover:bg-surface-hover cursor-pointer transition-colors shrink-0"
          >
            <X size={13} />
          </button>
        ) : shortcutHint ? (
          <kbd className="font-mono text-[11px] text-text-tertiary shrink-0 select-none">
            {shortcutHint}
          </kbd>
        ) : null}
      </div>
    );
  },
);

SearchField.displayName = "SearchField";

export default SearchField;
