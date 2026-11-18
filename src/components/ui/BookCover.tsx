import { useState, type ReactNode } from "react";
import { convertFileSrc } from "../../platform";

interface BookCoverProps {
  title: string;
  author?: string;
  coverData?: string | null;
  coverPath?: string | null;
  radius?: "sm" | "xs";
  shadow?: boolean;
  className?: string;
  children?: ReactNode;
}

const COVER_PALETTES = [
  "from-[#8F80FF] to-[#5B4BE8]",
  "from-[#6D5BFF] to-[#4334C4]",
  "from-[#7B70DE] to-[#33299A]",
  "from-[#A594F9] to-[#6F63D2]",
];

function paletteForTitle(title: string): string {
  let hash = 0;
  for (let i = 0; i < title.length; i += 1) {
    hash = (hash * 31 + title.charCodeAt(i)) | 0;
  }
  return COVER_PALETTES[Math.abs(hash) % COVER_PALETTES.length];
}

export default function BookCover({
  title,
  author,
  coverData,
  coverPath,
  radius = "sm",
  shadow = true,
  className = "",
  children,
}: BookCoverProps) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null);

  const src =
    coverData ||
    (coverPath && coverPath !== "none" ? convertFileSrc(coverPath) : null);
  const imgFailed = src !== null && failedSrc === src;

  const radiusClass = radius === "xs" ? "rounded-[3px]" : "rounded-[6px]";
  const shadowClass = shadow ? "shadow-[0_12px_26px_rgba(42,31,77,0.20)]" : "";

  return (
    <div
      className={`relative overflow-hidden select-none dawn-cover-sheen bg-surface-solid ${radiusClass} ${shadowClass} ${className}`}
    >
      {src && !imgFailed ? (
        <img
          key={src}
          src={src}
          alt={title}
          onError={() => setFailedSrc(src)}
          className="size-full object-cover block"
          loading="lazy"
        />
      ) : (
        <div
          className={`size-full bg-gradient-to-br ${paletteForTitle(
            title,
          )} flex flex-col justify-between p-3 text-white`}
        >
          <span className="text-[12px] font-semibold leading-snug line-clamp-3">
            {title}
          </span>
          {author && (
            <span className="text-[10px] text-white/75 truncate">{author}</span>
          )}
        </div>
      )}
      {children}
    </div>
  );
}
