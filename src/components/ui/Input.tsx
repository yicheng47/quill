import { InputHTMLAttributes, forwardRef } from "react";

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  icon?: React.ReactNode;
}

const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ icon, className = "", ...props }, ref) => {
    return (
      <div className={`relative ${className}`}>
        {icon && (
          <div className="absolute left-3 top-1/2 -translate-y-1/2 text-text-placeholder">
            {icon}
          </div>
        )}
        <input
          ref={ref}
          className={`w-full h-9 bg-bg-input rounded-lg text-[14px] tracking-[-0.15px] text-text-primary placeholder:text-text-placeholder outline-none border border-transparent focus:border-accent ${
            icon ? "pl-9 pr-3" : "px-3"
          }`}
          {...props}
        />
      </div>
    );
  },
);

Input.displayName = "Input";

export default Input;
