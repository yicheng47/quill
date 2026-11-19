import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { BookOpen, Search, Trash2, X } from "lucide-react";
import { useDictionary } from "../hooks/useDictionary";
import { shouldSuppressSelectionClick } from "../utils/selection";
import { timeAgo } from "../utils/timeAgo";
import { parseSavedVocabDefinition } from "../utils/vocabParse";

interface DictionaryPanelProps {
  bookId: string;
  bookTitle?: string;
  vocabVersion?: number;
  onNavigate?: (cfi: string) => void;
  getPageFromCfi?: (cfi: string) => number | null;
  onClose?: () => void;
  onOpenInWords?: (wordId?: string) => void;
}

export default function DictionaryPanel({
  bookId,
  vocabVersion,
  onNavigate,
  getPageFromCfi,
  onClose,
  onOpenInWords,
}: DictionaryPanelProps) {
  const { t } = useTranslation();
  const [dictSearch, setDictSearch] = useState("");
  const [selectedWordId, setSelectedWordId] = useState<string | null>(null);
  const { words, refresh, remove: removeWord } = useDictionary(bookId);

  useEffect(() => {
    if (vocabVersion !== undefined && vocabVersion > 0) {
      void refresh();
    }
  }, [vocabVersion, refresh]);

  const filteredWords = words.filter((w) => {
    const q = dictSearch.trim().toLowerCase();
    if (!q) return true;
    return w.word.toLowerCase().startsWith(q);
  });

  return (
    <div className="flex flex-col h-full min-w-0 p-5 gap-3.5">
      {/* Header */}
      <div className="flex items-center justify-between gap-2 shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <h2 className="text-[15px] font-semibold text-text-primary truncate">
            {t("vocab.title")}
          </h2>
          <span className="px-2 py-0.5 rounded-full bg-accent-tint text-accent-on-tint font-mono text-[11px] font-semibold leading-none shrink-0">
            {words.length}
          </span>
        </div>
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            aria-label={t("common.dismiss")}
            className="size-7 rounded-control flex items-center justify-center text-text-secondary hover:bg-border-subtle cursor-pointer transition-colors shrink-0"
          >
            <X size={14} />
          </button>
        )}
      </div>

      {/* Search */}
      <div className="h-[34px] px-3 rounded-full bg-surface-inset border border-border-subtle flex items-center gap-2 focus-within:border-accent shrink-0">
        <Search size={13.5} className="text-text-tertiary shrink-0" />
        <input
          type="text"
          placeholder={t("vocab.searchPanel")}
          value={dictSearch}
          onChange={(e) => setDictSearch(e.target.value)}
          onKeyDown={(e) => e.stopPropagation()}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          className="flex-1 min-w-0 text-[12.5px] text-text-primary bg-transparent outline-none placeholder:text-text-disabled"
        />
        {dictSearch && (
          <button
            type="button"
            onClick={() => setDictSearch("")}
            aria-label={t("common.clear")}
            className="size-5 rounded-full flex items-center justify-center text-text-tertiary hover:text-text-primary hover:bg-border-subtle cursor-pointer transition-colors shrink-0"
          >
            <X size={12} />
          </button>
        )}
      </div>

      {/* Word list */}
      <div className="flex-1 min-h-0 overflow-y-auto flex flex-col gap-2.5 pr-0.5">
        {filteredWords.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full px-4 text-center">
            <div className="size-12 rounded-full bg-surface-inset border border-border-subtle flex items-center justify-center mb-3">
              <BookOpen size={20} className="text-text-tertiary" />
            </div>
            <p className="text-[14px] font-medium text-text-secondary">
              {words.length === 0 ? t("vocab.panelEmpty") : t("vocab.noMatches")}
            </p>
            {words.length === 0 && (
              <p className="text-[12px] text-text-tertiary mt-1 max-w-[240px]">
                {t("vocab.panelEmptySub")}
              </p>
            )}
          </div>
        ) : (
          filteredWords.map((word) => {
            const page = getPageFromCfi && word.cfi ? getPageFromCfi(word.cfi) : null;
            const parsed = parseSavedVocabDefinition(word.definition);
            const selected = selectedWordId === word.id;
            const metaParts = [
              page != null ? t("bookmarks.shortPage", { page }) : null,
              timeAgo(word.created_at),
            ].filter(Boolean);

            return (
              <div
                key={word.id}
                role="button"
                tabIndex={0}
                onClick={(e) => {
                  if (shouldSuppressSelectionClick(e)) return;
                  setSelectedWordId(word.id);
                  if (word.cfi) onNavigate?.(word.cfi);
                }}
                onKeyDown={(e) => {
                  if (e.target !== e.currentTarget) return;
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    setSelectedWordId(word.id);
                    if (word.cfi) onNavigate?.(word.cfi);
                  }
                }}
                className={`group relative w-full text-left p-3.5 rounded-[6px] border transition-colors cursor-pointer flex flex-col gap-1.5 ${
                  selected
                    ? "bg-surface-solid border-accent/40"
                    : "bg-surface-inset border-border-subtle hover:bg-surface-solid hover:border-accent/35"
                }`}
              >
                <div className="flex items-baseline justify-between gap-2">
                  <div className="flex items-baseline gap-2 min-w-0 flex-1">
                    <span className="font-reading text-[16px] font-semibold text-text-primary truncate">
                      {word.word}
                    </span>
                    {(parsed.gloss || parsed.partOfSpeech) && (
                      <span className="text-[12px] font-medium text-accent-on-tint truncate">
                        {parsed.gloss || parsed.partOfSpeech}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    <span className="font-mono text-[11px] text-text-tertiary">
                      {metaParts.join(" · ")}
                    </span>
                    <button
                      type="button"
                      aria-label={t("common.delete")}
                      onClick={(e) => {
                        e.stopPropagation();
                        if (selectedWordId === word.id) setSelectedWordId(null);
                        void removeWord(word.id);
                      }}
                      className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 size-6 rounded-control flex items-center justify-center text-text-tertiary hover:text-danger hover:bg-danger-tint transition-all cursor-pointer"
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                </div>

                {parsed.definition && (
                  <p className="text-[12.5px] leading-[1.45] text-text-secondary line-clamp-2 select-text">
                    {parsed.definition}
                  </p>
                )}

                {word.context_sentence && (
                  <p className="font-reading italic text-[12px] leading-[1.4] text-text-tertiary line-clamp-2 select-text">
                    “{word.context_sentence}”
                  </p>
                )}
              </div>
            );
          })
        )}
      </div>

      {/* Footer */}
      <div className="border-t border-border-subtle pt-2.5 flex items-center justify-between gap-2 shrink-0">
        <span className="text-[12px] text-text-tertiary truncate">
          {dictSearch.trim()
            ? t("vocab.matchCountInBook", {
                count: filteredWords.length,
                total: words.length,
              })
            : t("vocab.wordCountInBook", { count: words.length })}
        </span>
        {onOpenInWords && (
          <button
            type="button"
            onClick={() => onOpenInWords(selectedWordId ?? undefined)}
            className="text-[12px] font-medium text-accent-on-tint hover:underline cursor-pointer shrink-0"
          >
            {t("vocab.openInWords")} →
          </button>
        )}
      </div>
    </div>
  );
}
