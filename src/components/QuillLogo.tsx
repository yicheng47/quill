import { useId } from "react";

interface QuillLogoProps {
  size?: number;
  className?: string;
}

const BACK_PAGE_PATH =
  "M 23.2 78.2 C 40.5 79.4 58.6 73.6 71.2 61.2 C 79.8 52.6 84.0 41.2 83.2 29.5 C 74.8 36.2 65.4 45.2 55.2 55.0 C 44.8 65.0 34.0 72.8 23.2 78.2 Z";

const FRONT_QUILL_PATH =
  "M 18.39 77.43 C 21.13 64.46 25.85 51.09 35.45 38.89 L 37.22 45.82 L 38.87 34.51 C 48.11 25.07 61.56 18.6 73.86 17.71 C 73.59 31.84 66 49.2 52.26 62.03 C 41.27 71.86 29.47 76.53 19.21 78.17 L 39.33 57.14 A 3.6 3.6 0 1 0 37.59 55.55 L 18.39 77.43 Z";

export default function QuillLogo({ size = 28, className = "" }: QuillLogoProps) {
  const uid = useId();
  const tileGradId = `${uid}-tile`;
  const glowGradId = `${uid}-glow`;
  const backGradId = `${uid}-back`;
  const frontGradId = `${uid}-front`;
  const clipId = `${uid}-clip`;
  const shadowId = `${uid}-shadow`;
  const useDropShadow = size >= 40;

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 100 100"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
    >
      <defs>
        <linearGradient id={tileGradId} x1="21" y1="10" x2="79" y2="90" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#3C2DAE" />
          <stop offset="0.5" stopColor="#6A5BE3" />
          <stop offset="1" stopColor="#9B8DFA" />
        </linearGradient>
        <radialGradient
          id={glowGradId}
          cx="61"
          cy="18"
          r="47"
          gradientTransform="matrix(1 0 0 0.766 0 4.21)"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0" stopColor="#FFFFFF" stopOpacity="0.20" />
          <stop offset="1" stopColor="#FFFFFF" stopOpacity="0" />
        </radialGradient>
        <linearGradient id={backGradId} x1="34" y1="32" x2="74" y2="78" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#D8D0FF" stopOpacity="0.47" />
          <stop offset="1" stopColor="#FFFFFF" stopOpacity="0.80" />
        </linearGradient>
        <linearGradient id={frontGradId} x1="49" y1="17" x2="43" y2="78" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#FFFFFF" />
          <stop offset="1" stopColor="#EFEAFF" stopOpacity="0.92" />
        </linearGradient>
        <clipPath id={clipId}>
          <rect width="100" height="100" rx="23.2" />
        </clipPath>
        {useDropShadow && (
          <filter id={shadowId} x="0" y="0" width="100" height="100" filterUnits="userSpaceOnUse">
            <feDropShadow
              dx="1.8"
              dy="2.2"
              stdDeviation="2.6"
              floodColor="#261B68"
              floodOpacity="0.20"
            />
          </filter>
        )}
      </defs>

      <g clipPath={`url(#${clipId})`}>
        <rect width="100" height="100" rx="23.2" fill={`url(#${tileGradId})`} />
        <ellipse cx="61" cy="18" rx="47" ry="36" fill={`url(#${glowGradId})`} />
        <path d={BACK_PAGE_PATH} fill={`url(#${backGradId})`} />
        <path
          d={FRONT_QUILL_PATH}
          fill={`url(#${frontGradId})`}
          filter={useDropShadow ? `url(#${shadowId})` : undefined}
        />
        <rect
          x="0.8"
          y="0.8"
          width="98.4"
          height="98.4"
          rx="22.4"
          stroke="#FFFFFF"
          strokeOpacity="0.24"
          strokeWidth={size >= 48 ? 1.2 : 2.2}
        />
      </g>
    </svg>
  );
}
