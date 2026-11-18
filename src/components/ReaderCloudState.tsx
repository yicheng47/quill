import { useTranslation } from "react-i18next";
import {
  ArrowLeft,
  CloudDownload,
  CloudOff,
  Download,
  Loader2,
  RotateCw,
} from "lucide-react";
import type { Book } from "../hooks/useBooks";
import BookCover from "./ui/BookCover";
import Button from "./ui/Button";

export type ReaderCloudViewState = "downloading" | "timedOut" | "failed";

interface ReaderCloudStateProps {
  book: Pick<Book, "title" | "author" | "cover_data" | "cover_path" | "progress">;
  state: ReaderCloudViewState;
  onDownloadRetry: () => void;
  onBackToLibrary: () => void;
}

export default function ReaderCloudState({
  book,
  state,
  onDownloadRetry,
  onBackToLibrary,
}: ReaderCloudStateProps) {
  const { t } = useTranslation();

  const isFailed = state === "failed";
  const isDownloading = state === "downloading";

  const pillText =
    book.progress > 0
      ? t("reader.icloudPillProgress", { progress: book.progress })
      : t("reader.icloudPill");

  const heading = isFailed
    ? t("reader.openFailed")
    : state === "timedOut"
      ? t("reader.icloudTimeoutTitle")
      : t("reader.icloudTitle");

  const description = isFailed
    ? t("reader.openFailedICloud")
    : state === "timedOut"
      ? t("reader.downloadTimeout")
      : t("reader.icloudDesc");

  return (
    <div className="flex-1 min-w-0 h-full reader-island rounded-[24px] flex items-center justify-center p-6">
      <div className="w-full max-w-[420px] flex flex-col items-center text-center gap-[18px]">
        <BookCover
          title={book.title}
          author={book.author}
          coverData={book.cover_data}
          coverPath={book.cover_path}
          className="w-[124px] h-[184px] !rounded-[10px] border border-border-subtle !shadow-[0_16px_40px_rgba(42,31,77,0.16)]"
        />

        <div
          className={`inline-flex items-center gap-1.5 px-3 py-[5px] rounded-full text-[12px] font-semibold leading-none ${
            isFailed ? "bg-danger-tint text-danger" : "bg-accent-tint text-accent-on-tint"
          }`}
        >
          {isFailed ? <CloudOff size={13.5} /> : <CloudDownload size={13.5} />}
          <span>{pillText}</span>
        </div>

        <div className="flex flex-col items-center gap-1.5">
          <h2 className="text-[20px] font-semibold leading-[26px] tracking-[-0.3px] text-text-primary">
            {heading}
          </h2>
          <p className="max-w-[360px] text-[14px] leading-[1.5] text-text-secondary">
            {description}
          </p>
        </div>

        <div className="pt-1 flex flex-wrap items-center justify-center gap-2.5">
          <Button
            appearance="dawn"
            variant="primary"
            size="md"
            disabled={isDownloading}
            onClick={onDownloadRetry}
          >
            {isDownloading ? (
              <>
                <Loader2 size={16} className="animate-spin" />
                <span>{t("reader.downloadingBook")}</span>
              </>
            ) : isFailed ? (
              <>
                <RotateCw size={16} />
                <span>{t("reader.tryAgain")}</span>
              </>
            ) : (
              <>
                <Download size={16} />
                <span>{t("reader.downloadBook")}</span>
              </>
            )}
          </Button>

          <Button
            appearance="dawn"
            variant="secondary"
            size="md"
            onClick={onBackToLibrary}
          >
            <ArrowLeft size={16} className="text-text-secondary" />
            <span>{t("reader.backToLibrary")}</span>
          </Button>
        </div>
      </div>
    </div>
  );
}
