import { SelectHTMLAttributes, forwardRef } from "react";

interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  label?: string;
}

const Select = forwardRef<HTMLSelectElement, SelectProps>(
  ({ label, className = "", children, ...props }, ref) => {
    return (
      <div className={className}>
        {label && (
          <label className="block text-[13px] font-medium text-[#3f3f47] mb-1.5">
            {label}
          </label>
        )}
        <select
          ref={ref}
          className="w-full h-9 bg-bg-input rounded-lg px-3 text-[14px] text-text-primary outline-none border border-transparent focus:border-accent appearance-none cursor-pointer"
          {...props}
        >
          {children}
        </select>
      </div>
    );
  },
);

Select.displayName = "Select";

export default Select;
