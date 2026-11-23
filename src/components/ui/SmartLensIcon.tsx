interface SmartLensIconProps {
  size?: number;
  className?: string;
  strokeWidth?: number;
}

export default function SmartLensIcon({
  size = 16,
  className,
  strokeWidth = 2,
}: SmartLensIconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      className={className}
    >
      <path
        d="M 17.93 10.46 A 7.5 7.5 0 1 1 11.54 4.07 M 20.8 21.8 L 15.8 16.8"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M 17.2 1.6 C 17.5 3.7 18.7 4.9 20.8 5.2 C 18.7 5.5 17.5 6.7 17.2 8.8 C 16.9 6.7 15.7 5.5 13.6 5.2 C 15.7 4.9 16.9 3.7 17.2 1.6 Z"
        fill="currentColor"
      />
    </svg>
  );
}
