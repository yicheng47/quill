interface QuillLogoProps {
  size?: number;
  className?: string;
}

export default function QuillLogo({ size = 32, className = "" }: QuillLogoProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 280 280"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
    >
      <rect x="2" y="2" width="276" height="276" rx="48" fill="url(#ql_bg)" />
      <circle cx="120" cy="112" r="97" fill="white" fillOpacity="0.07" />
      <g transform="translate(109, 88)">
        <path
          opacity="0.95"
          d="M54.6 0.35C46.2 11.55 26.6 39.55 15.4 67.55C7 84.35 1.4 101.15 4.2 112.35L9.8 117.95L15.4 109.55C21 89.95 32.2 67.55 43.4 50.75C54.6 33.95 63 17.15 65.8 5.95L54.6 0.35Z"
          fill="url(#ql_f1)"
        />
        <path
          opacity="0.85"
          d="M54.6 0.35C71.4 11.55 88.2 33.95 82.6 56.35C77 73.15 65.8 89.95 54.6 101.15L15.4 109.55C32.2 67.55 43.4 50.75 43.4 50.75C54.6 33.95 63 17.15 65.8 5.95L54.6 0.35Z"
          fill="url(#ql_f2)"
        />
        <path opacity="0.7" d="M54.6 0.35L9.8 117.95" stroke="url(#ql_s1)" strokeWidth="1.96" />
        <path opacity="0.2" d="M47.88 17.99L31.08 26.39" stroke="white" strokeWidth="0.84" />
        <path opacity="0.23" d="M43.4 29.75L25.2 38.15" stroke="white" strokeWidth="0.84" />
        <path opacity="0.26" d="M38.92 41.51L19.32 49.91" stroke="white" strokeWidth="0.84" />
        <path opacity="0.29" d="M34.44 53.27L13.44 61.67" stroke="white" strokeWidth="0.84" />
        <path opacity="0.32" d="M29.96 65.03L7.56 73.43" stroke="white" strokeWidth="0.84" />
        <path opacity="0.35" d="M25.48 76.79L1.68 85.19" stroke="white" strokeWidth="0.84" />
        <path opacity="0.15" d="M49.22 14.46L71.62 20.06" stroke="white" strokeWidth="0.84" />
        <path opacity="0.18" d="M44.74 26.22L67.98 31.82" stroke="white" strokeWidth="0.84" />
        <path opacity="0.21" d="M40.26 37.98L64.34 43.58" stroke="white" strokeWidth="0.84" />
        <path opacity="0.24" d="M35.78 49.74L60.7 55.34" stroke="white" strokeWidth="0.84" />
        <path opacity="0.27" d="M31.3 61.5L57.06 67.1" stroke="white" strokeWidth="0.84" />
        <path opacity="0.9" d="M9.8 117.95L4.2 134.75L12.6 126.35L9.8 117.95Z" fill="white" />
        <circle cx="4.2" cy="141.75" r="4.2" fill="url(#ql_ink)" />
        <path
          d="M4.2 134.75C3.27 136.62 3.27 138.95 4.2 141.75"
          stroke="url(#ql_inks)"
          strokeWidth="1.4"
          strokeLinecap="round"
        />
      </g>
      <defs>
        <linearGradient id="ql_bg" x1="0" y1="0" x2="280" y2="280" gradientUnits="userSpaceOnUse">
          <stop stopColor="#4F46E5" />
          <stop offset="0.5" stopColor="#7C3AED" />
          <stop offset="1" stopColor="#A855F7" />
        </linearGradient>
        <linearGradient id="ql_f1" x1="22" y1="0" x2="96" y2="78" gradientUnits="userSpaceOnUse">
          <stop stopColor="white" />
          <stop offset="1" stopColor="#E0E7FF" />
        </linearGradient>
        <linearGradient id="ql_f2" x1="36" y1="0" x2="102" y2="84" gradientUnits="userSpaceOnUse">
          <stop stopColor="white" />
          <stop offset="1" stopColor="#E0E7FF" />
        </linearGradient>
        <linearGradient id="ql_s1" x1="10" y1="0" x2="88" y2="30" gradientUnits="userSpaceOnUse">
          <stop stopColor="white" stopOpacity="0.9" />
          <stop offset="1" stopColor="#C7D2FE" stopOpacity="0.8" />
        </linearGradient>
        <linearGradient id="ql_ink" x1="0" y1="138" x2="8.4" y2="146" gradientUnits="userSpaceOnUse">
          <stop stopColor="#818CF8" stopOpacity="0.6" />
          <stop offset="1" stopColor="#C084FC" stopOpacity="0.3" />
        </linearGradient>
        <linearGradient id="ql_inks" x1="3.5" y1="135" x2="5" y2="135" gradientUnits="userSpaceOnUse">
          <stop stopColor="#818CF8" stopOpacity="0.6" />
          <stop offset="1" stopColor="#C084FC" stopOpacity="0.3" />
        </linearGradient>
      </defs>
    </svg>
  );
}
