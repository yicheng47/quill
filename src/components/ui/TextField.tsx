import { forwardRef, InputHTMLAttributes, ReactNode } from "react";

interface TextFieldProps extends InputHTMLAttributes<HTMLInputElement> {
  error?: boolean;
  trailing?: ReactNode;
  containerClassName?: string;
}

const TextField = forwardRef<HTMLInputElement, TextFieldProps>(
  ({ error = false, trailing, containerClassName = "", className = "", ...props }, ref) => {
    return (
      <div
        className={`h-11 px-4 rounded-[14px] bg-surface-solid border inline-flex items-center gap-2.5 transition-colors ${
          error
            ? "border-danger focus-within:ring-[3px] focus-within:ring-danger/20"
            : "border-border-default focus-within:border-violet-500 focus-within:ring-[3px] focus-within:ring-focus-ring"
        } ${containerClassName}`}
      >
        <input
          ref={ref}
          spellCheck={false}
          autoCorrect="off"
          autoCapitalize="off"
          className={`flex-1 min-w-0 bg-transparent text-[14px] outline-none placeholder:text-text-tertiary ${
            error ? "text-danger" : "text-text-primary"
          } ${className}`}
          {...props}
        />
        {trailing && <div className="shrink-0 flex items-center">{trailing}</div>}
      </div>
    );
  },
);

TextField.displayName = "TextField";

export default TextField;
