import { useTranslation } from "react-i18next";
import { BookUp, AlertCircle, X } from "lucide-react";

interface ImportOverlaysProps {
  isDragging: boolean;
  importing: boolean;
  importingCount?: number;
  importingFileName?: string | null;
  importSlow: boolean;
  importError: string | null;
  onDismissError: () => void;
}

export default function ImportOverlays({
  isDragging,
  importing,
  importingCount = 1,
  importingFileName = null,
  importSlow,
  importError,
  onDismissError,
}: ImportOverlaysProps) {
  const { t } = useTranslation();

  return (
    <>
      {isDragging && (
        <div
          data-testid="import-drop-overlay"
          className="fixed inset-0 z-50 no-drag bg-[#15151A]/22 backdrop-blur-[6px] flex items-center justify-center p-4"
        >
          <div className="w-full max-w-[500px] px-10 py-11 rounded-[26px] bg-white/[0.95] border-2 border-accent backdrop-blur-[36px] shadow-[0_24px_56px_rgba(30,22,56,0.24)] flex flex-col items-center text-center gap-3.5">
            <div className="size-16 rounded-[20px] bg-accent-tint flex items-center justify-center text-accent-on-tint">
              <BookUp size={28} />
            </div>
            <h2 className="text-[20px] font-semibold text-text-primary tracking-[-0.4px]">
              {t("import.dropTitle")}
            </h2>
            <p className="text-[13.5px] text-text-secondary leading-[1.5]">
              {t("import.dropSub")}
            </p>
            <div className="pt-1 flex items-center gap-2">
              <span className="px-2.5 py-1 rounded-[8px] bg-surface-inset border border-border-subtle font-mono text-[11.5px] font-semibold text-accent-on-tint">
                .EPUB
              </span>
              <span className="px-2.5 py-1 rounded-[8px] bg-surface-inset border border-border-subtle font-mono text-[11.5px] font-semibold text-accent-on-tint">
                .PDF
              </span>
            </div>
          </div>
        </div>
      )}

      {!isDragging && importing && (
        <div
          data-testid="import-progress-overlay"
          className="fixed inset-0 z-50 no-drag bg-[#15151A]/22 backdrop-blur-[6px] flex items-center justify-center p-4"
        >
          <div className="w-full max-w-[440px] px-9 py-[38px] rounded-[26px] bg-white/[0.95] border border-surface-glass-border backdrop-blur-[36px] shadow-[0_24px_56px_rgba(30,22,56,0.24)] flex flex-col items-center text-center gap-3.5">
            <svg
              width="44"
              height="44"
              viewBox="0 0 44 44"
              className="shrink-0 animate-spin"
              aria-hidden="true"
            >
              <circle
                cx="22"
                cy="22"
                r="18"
                fill="none"
                stroke="var(--color-track)"
                strokeWidth="4"
              />
              <circle
                cx="22"
                cy="22"
                r="18"
                fill="none"
                stroke="var(--color-accent)"
                strokeWidth="4"
                strokeLinecap="round"
                strokeDasharray="34 80"
              />
            </svg>
            <h2 className="text-[18px] font-semibold text-text-primary tracking-[-0.3px]">
              {t("import.importingCount", { count: importingCount })}
            </h2>
            {importingFileName && (
              <p className="font-mono text-[11.5px] text-accent-on-tint break-all">
                {importingFileName}
              </p>
            )}
            {importSlow && (
              <p className="text-[12.5px] text-text-tertiary leading-[1.45]">
                {t("import.importingSlow")}
              </p>
            )}
          </div>
        </div>
      )}

      {importError && (
        <div
          role="alert"
          data-testid="import-error-toast"
          className="fixed top-5 left-1/2 -translate-x-1/2 z-[60] no-drag w-[560px] max-w-[calc(100vw-32px)] px-4 py-3 rounded-[16px] bg-surface-solid border border-[#D93F4C]/25 backdrop-blur-[36px] shadow-[0_24px_56px_rgba(30,22,56,0.24)] flex items-center gap-3"
        >
          <div className="size-[30px] rounded-[9px] bg-danger-tint flex items-center justify-center text-danger shrink-0">
            <AlertCircle size={16} />
          </div>
          <div className="flex-1 min-w-0 flex flex-col gap-0.5">
            <p className="text-[13.5px] font-semibold text-text-primary">
              {t("import.errorTitle")}
            </p>
            <p className="text-[12px] text-text-secondary break-words">{importError}</p>
          </div>
          <button
            type="button"
            aria-label={t("common.dismiss")}
            onClick={onDismissError}
            className="size-[26px] rounded-[8px] flex items-center justify-center text-text-tertiary hover:bg-black/[0.05] cursor-pointer transition-colors shrink-0"
          >
            <X size={14} />
          </button>
        </div>
      )}
    </>
  );
}
