import { useTranslation } from "react-i18next";
import { ArrowLeft, ChevronLeft, ChevronRight, Minus, Plus } from "lucide-react";

interface ReaderBottomPillsProps {
  bookFormat: "epub" | "pdf";
  isDarkPaper: boolean;
  canGoBack: boolean;
  jumpBackPage: number | null;
  onGoBack: () => void;
  progress: number;
  progressPillLabel: string;
  timeLeftLabel: string | null;
  zoom: number | "fit";
  fitPercent: number;
  onZoom: (delta: number) => void;
  onResetPdfZoom: () => void;
  onPrev: () => void;
  onNext: () => void;
}

export default function ReaderBottomPills({
  bookFormat,
  isDarkPaper,
  canGoBack,
  jumpBackPage,
  onGoBack,
  progress,
  progressPillLabel,
  timeLeftLabel,
  zoom,
  fitPercent,
  onZoom,
  onResetPdfZoom,
  onPrev,
  onNext,
}: ReaderBottomPillsProps) {
  const { t } = useTranslation();

  // Keep prev/next/zoom controls reachable down to a 224px Paper width
  // (700px minimum window with the 420px right island open): compact control
  // sizing and hide secondary text ("· Fit", time-left, track) via container
  // queries first, and stack jump-back above the pill below 700px Paper.
  const layoutClass = canGoBack
    ? "flex flex-col items-center gap-2 @[700px]/paper:flex-row @[700px]/paper:items-center @[700px]/paper:justify-between @[700px]/paper:gap-3 @[840px]/paper:grid @[840px]/paper:grid-cols-[1fr_auto_1fr]"
    : "flex justify-center";

  const clampedProgress = Math.max(0, Math.min(100, progress));
  const fullZoomLabel =
    zoom === "fit" ? `${fitPercent}% · ${t("reader.zoom.fit")}` : `${zoom}%`;

  return (
    <div
      className={`pointer-events-none select-none absolute inset-x-2 @[400px]/paper:inset-x-3 @[560px]/paper:inset-x-6 bottom-[15px] z-20 ${layoutClass}`}
    >
      {canGoBack && (
        <div className="self-start @[700px]/paper:self-auto @[840px]/paper:justify-self-start min-w-0 max-w-full">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onGoBack();
            }}
            className="pointer-events-auto max-w-full inline-flex items-center gap-1.5 h-8 px-3.5 rounded-full reader-pill reader-pill-accent text-[12.5px] font-semibold cursor-pointer transition-colors"
          >
            <ArrowLeft size={13} className="shrink-0" />
            <span className="truncate">
              {jumpBackPage != null
                ? t("reader.backToPage", { page: jumpBackPage })
                : t("reader.back")}
            </span>
          </button>
        </div>
      )}

      <div
        onClick={(e) => e.stopPropagation()}
        className="pointer-events-auto max-w-full min-w-0 h-[42px] px-1 @[320px]/paper:px-1.5 @[480px]/paper:px-2 py-1.5 rounded-full reader-pill flex items-center gap-1 @[320px]/paper:gap-1.5 @[480px]/paper:gap-3"
      >
        <button
          type="button"
          onClick={onPrev}
          aria-label={t("reader.previousPage")}
          className={`size-[26px] @[320px]/paper:size-[30px] rounded-control border flex items-center justify-center cursor-pointer transition-colors shrink-0 ${
            isDarkPaper
              ? "bg-white/[0.07] border-white/10 text-[#DBD2C4] hover:bg-white/15"
              : "bg-surface-glass border-surface-glass-border text-text-secondary hover:bg-surface-solid"
          }`}
        >
          <ChevronLeft size={14} />
        </button>

        <span
          className={`text-[12.5px] font-medium min-w-0 truncate ${
            isDarkPaper ? "text-[#DBD2C4]" : "text-text-secondary"
          }`}
        >
          {progressPillLabel}
        </span>

        <div
          className={`${
            bookFormat === "pdf"
              ? "hidden @[600px]/paper:block w-[110px]"
              : "hidden @[560px]/paper:block w-[140px]"
          } h-1 rounded-full overflow-hidden shrink-0 ${
            isDarkPaper ? "bg-white/12" : "bg-track"
          }`}
        >
          <div
            className="h-full rounded-full bg-progress transition-[width] duration-200"
            style={{ width: `${clampedProgress}%` }}
          />
        </div>

        {bookFormat === "pdf" ? (
          <>
            <div
              className={`hidden @[300px]/paper:block w-px h-4 shrink-0 ${
                isDarkPaper ? "bg-white/15" : "bg-border-default"
              }`}
            />
            <div className="flex items-center gap-0.5 @[320px]/paper:gap-1 @[480px]/paper:gap-1.5 shrink-0">
              <button
                type="button"
                onClick={() => onZoom(-10)}
                aria-label={t("common.decrease")}
                className={`size-[22px] @[320px]/paper:size-6 rounded-control flex items-center justify-center cursor-pointer transition-colors ${
                  isDarkPaper
                    ? "bg-white/10 text-[#DBD2C4] hover:bg-white/20"
                    : "bg-surface-solid text-text-secondary hover:bg-surface-inset"
                }`}
              >
                <Minus size={12} />
              </button>
              <button
                type="button"
                onClick={onResetPdfZoom}
                aria-label={fullZoomLabel}
                title={t("reader.zoom.fitTooltip")}
                className={`font-mono text-[11.5px] font-medium @[360px]/paper:min-w-[54px] px-0.5 @[360px]/paper:px-1 text-center tabular-nums whitespace-nowrap ${
                  isDarkPaper ? "text-[#F0EAE1]" : "text-text-primary"
                } ${zoom === "fit" ? "" : "cursor-pointer hover:opacity-80"}`}
              >
                {zoom === "fit" ? (
                  <>
                    {fitPercent}%
                    <span className="hidden @[280px]/paper:inline">
                      {" · "}
                      {t("reader.zoom.fit")}
                    </span>
                  </>
                ) : (
                  `${zoom}%`
                )}
              </button>
              <button
                type="button"
                onClick={() => onZoom(10)}
                aria-label={t("common.increase")}
                className={`size-[22px] @[320px]/paper:size-6 rounded-control flex items-center justify-center cursor-pointer transition-colors ${
                  isDarkPaper
                    ? "bg-white/10 text-[#DBD2C4] hover:bg-white/20"
                    : "bg-surface-solid text-text-secondary hover:bg-surface-inset"
                }`}
              >
                <Plus size={12} />
              </button>
            </div>
          </>
        ) : (
          <span
            className={`font-mono text-[11.5px] whitespace-nowrap shrink-0 ${
              isDarkPaper ? "text-[#A39A8E]" : "text-text-tertiary"
            }`}
          >
            {progress}%
            {timeLeftLabel && (
              <span className="hidden @[360px]/paper:inline"> · {timeLeftLabel}</span>
            )}
          </span>
        )}

        <button
          type="button"
          onClick={onNext}
          aria-label={t("reader.nextPage")}
          className={`size-[26px] @[320px]/paper:size-[30px] rounded-control border flex items-center justify-center cursor-pointer transition-colors shrink-0 ${
            isDarkPaper
              ? "bg-white/[0.07] border-white/10 text-[#DBD2C4] hover:bg-white/15"
              : "bg-surface-glass border-surface-glass-border text-text-secondary hover:bg-surface-solid"
          }`}
        >
          <ChevronRight size={14} />
        </button>
      </div>

      {canGoBack && <div className="hidden @[840px]/paper:block min-w-0" />}
    </div>
  );
}
