import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowRight, BookOpen, Trash2, X } from "lucide-react";
import type { DictionaryWord } from "../hooks/useDictionary";
import { openReaderWindow } from "../utils/openReaderWindow";

interface VocabDetailModalProps {
  word: DictionaryWord | null;
  onClose: () => void;
  onDelete: (id: string) => void | Promise<void>;
  /**
   * How to act when "Open in Reader" is clicked.
   * - "window" (default): open a new reader window via openReaderWindow
   * - "inline": call onNavigateInline with the cfi — used by DictionaryPanel
   *   which already lives inside the reader.
   */
  navigateMode?: "window" | "inline";
  onNavigateInline?: (cfi: string) => void;
}

interface ParsedDefinition {
  pronunciation: string | null;
  partOfSpeech: string | null;
  definition: string;
  inContext: string | null;
}

function parseDefinition(raw: string): ParsedDefinition {
  const [head, ...rest] = raw.split(/\n\n+/);
  const inContext = rest.join("\n\n").trim() || null;
  // Match leading /.../ phonetic + optional "noun."/"verb."/etc prefix
  const match = head.match(/^\s*(\/[^/]+\/)\s*(?:(\w+)\.)?\s*([\s\S]*)$/);
  if (!match) {
    return {
      pronunciation: null,
      partOfSpeech: null,
      definition: head.trim(),
      inContext,
    };
  }
  return {
    pronunciation: match[1] ?? null,
    partOfSpeech: match[2] ?? null,
    definition: (match[3] ?? "").trim(),
    inContext,
  };
}

export default function VocabDetailModal({
  word,
  onClose,
  onDelete,
  navigateMode = "window",
  onNavigateInline,
}: VocabDetailModalProps) {
  const { t } = useTranslation();
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const confirmTimerRef = useRef<number | null>(null);

  // Reset delete confirmation when switching words
  useEffect(() => {
    setConfirmingDelete(false);
    if (confirmTimerRef.current != null) {
      window.clearTimeout(confirmTimerRef.current);
      confirmTimerRef.current = null;
    }
  }, [word?.id]);

  // Escape to dismiss
  useEffect(() => {
    if (!word) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [word, onClose]);

  useEffect(() => {
    return () => {
      if (confirmTimerRef.current != null) {
        window.clearTimeout(confirmTimerRef.current);
      }
    };
  }, []);

  if (!word) return null;

  const parsed = parseDefinition(word.definition);
  const subtitleParts = [parsed.pronunciation, parsed.partOfSpeech]
    .filter(Boolean)
    .join(" · ");
  const contextSentence = word.context_sentence?.trim() || null;

  const handleOpen = () => {
    if (navigateMode === "inline") {
      if (word.cfi) onNavigateInline?.(word.cfi);
      onClose();
      return;
    }
    openReaderWindow(word.book_id, {
      openVocab: true,
      cfi: word.cfi ?? undefined,
    });
    onClose();
  };

  const handleDelete = async () => {
    if (!confirmingDelete) {
      setConfirmingDelete(true);
      confirmTimerRef.current = window.setTimeout(() => {
        setConfirmingDelete(false);
        confirmTimerRef.current = null;
      }, 3000);
      return;
    }
    if (confirmTimerRef.current != null) {
      window.clearTimeout(confirmTimerRef.current);
      confirmTimerRef.current = null;
    }
    await onDelete(word.id);
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-overlay backdrop-blur-sm"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="bg-bg-surface rounded-xl shadow-popover w-[520px] max-h-[85vh] flex flex-col">
        {/* Header */}
        <div className="flex items-start justify-between px-6 pt-5 pb-4 border-b border-border-light shrink-0">
          <div className="flex flex-col gap-1 min-w-0">
            <h2 className="text-[24px] font-bold text-text-primary tracking-[-0.3px] leading-tight truncate">
              {word.word}
            </h2>
            {subtitleParts && (
              <span className="text-[13px] text-text-muted">{subtitleParts}</span>
            )}
          </div>
          <button
            onClick={onClose}
            className="size-7 flex items-center justify-center rounded-md hover:bg-bg-input cursor-pointer shrink-0"
          >
            <X size={16} className="text-text-muted" />
          </button>
        </div>

        {/* Body */}
        <div className="px-6 pt-4 pb-5 flex flex-col gap-5 overflow-auto">
          {/* Source */}
          <section className="flex flex-col gap-2">
            <h3 className="text-[11px] font-semibold uppercase tracking-[0.4px] text-text-muted">
              {t("vocab.detail.source")}
            </h3>
            <div className="flex items-center justify-between gap-3 p-3 bg-bg-muted border border-border-light rounded-[10px]">
              <div className="flex items-center gap-2.5 min-w-0">
                <div className="size-8 rounded-lg bg-accent-bg flex items-center justify-center shrink-0">
                  <BookOpen size={16} className="text-accent" />
                </div>
                <div className="flex flex-col min-w-0">
                  <span className="text-[14px] font-semibold text-text-primary truncate">
                    {word.book_title || t("vocab.detail.unknownBook")}
                  </span>
                </div>
              </div>
              <button
                onClick={handleOpen}
                className="flex items-center gap-1.5 h-8 px-3 rounded-lg bg-accent text-white text-[13px] font-medium cursor-pointer hover:opacity-90 shrink-0"
              >
                {t("vocab.detail.openInReader")}
                <ArrowRight size={14} />
              </button>
            </div>
          </section>

          {/* Definition */}
          <section className="flex flex-col gap-2">
            <h3 className="text-[11px] font-semibold uppercase tracking-[0.4px] text-text-muted">
              {t("vocab.detail.definition")}
            </h3>
            <p className="text-[14px] leading-[1.55] text-text-primary whitespace-pre-wrap">
              {parsed.definition}
            </p>
            {parsed.inContext && (
              <div className="mt-1 p-3.5 bg-bg-muted border border-border-light rounded-[10px] flex flex-col gap-1.5">
                <span className="text-[12px] font-medium text-text-muted">
                  {t("vocab.detail.inContext")}
                </span>
                <p className="text-[13px] leading-[1.5] text-text-secondary whitespace-pre-wrap">
                  {parsed.inContext}
                </p>
              </div>
            )}
          </section>

          {/* From the Book */}
          {contextSentence && (
            <section className="flex flex-col gap-2">
              <h3 className="text-[11px] font-semibold uppercase tracking-[0.4px] text-text-muted">
                {t("vocab.detail.fromBook")}
              </h3>
              <blockquote className="border-l-2 border-lavender pl-3.5 py-1.5">
                <p className="text-[13px] italic text-text-secondary leading-[1.5]">
                  &ldquo;{contextSentence}&rdquo;
                </p>
              </blockquote>
            </section>
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-border-light flex items-center justify-end shrink-0">
          <button
            onClick={handleDelete}
            className="flex items-center gap-1.5 h-8 px-3 rounded-lg text-[13px] font-medium text-red-500 hover:bg-red-500/10 cursor-pointer transition-colors"
          >
            <Trash2 size={14} />
            {confirmingDelete
              ? t("vocab.detail.deleteConfirm")
              : t("vocab.detail.delete")}
          </button>
        </div>
      </div>
    </div>
  );
}
