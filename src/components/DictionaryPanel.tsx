import { useState } from "react";
import { useTranslation } from "react-i18next";
import { BookOpen, Search, Trash2, Clock, FileText } from "lucide-react";
import { useDictionary, type DictionaryWord } from "../hooks/useDictionary";
import { timeAgo } from "../utils/timeAgo";
import VocabDetailModal from "./VocabDetailModal";

interface DictionaryPanelProps {
  bookId: string;
  bookTitle?: string;
  onNavigate?: (cfi: string) => void;
  getPageFromCfi?: (cfi: string) => number | null;
}

export default function DictionaryPanel({ bookId, bookTitle, onNavigate, getPageFromCfi }: DictionaryPanelProps) {
  const { t } = useTranslation();
  const [dictSearch, setDictSearch] = useState("");
  const [activeWord, setActiveWord] = useState<DictionaryWord | null>(null);
  const { words, remove: removeWord } = useDictionary(bookId);

  const filteredWords = words.filter((w) => {
    if (!dictSearch) return true;
    return w.word.toLowerCase().startsWith(dictSearch.toLowerCase());
  });

  return (
    <div className="flex flex-col h-full bg-bg-muted">
      <div className="border-b border-border shrink-0 px-4 h-[45px] flex items-center">
        <h2 className="text-[14px] font-medium text-text-primary tracking-[-0.15px]">
          {t("vocab.title")}
        </h2>
      </div>

      {/* Search */}
      <div className="px-4 pt-2 pb-2 shrink-0">
        <div className="flex items-center gap-1.5 h-[28px] px-2 rounded-lg bg-bg-input border border-border">
          <Search size={12} className="text-text-muted shrink-0" />
          <input
            type="search"
            placeholder={t("vocab.searchPanel")}
            defaultValue=""
            onInput={(e) => setDictSearch((e.target as HTMLInputElement).value)}
            onKeyDown={(e) => e.stopPropagation()}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            className="flex-1 text-[12px] text-text-primary bg-transparent outline-none placeholder:text-text-placeholder [&::-webkit-search-cancel-button]:hidden"
          />
        </div>
      </div>

      {/* Word list */}
      <div className="flex-1 overflow-auto">
        {filteredWords.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full px-4">
            <div className="size-12 rounded-full bg-bg-input flex items-center justify-center mb-3">
              <BookOpen size={20} className="text-text-muted" />
            </div>
            <p className="text-[14px] text-text-muted text-center">
              {words.length === 0 ? t("vocab.panelEmpty") : t("vocab.noMatches")}
            </p>
            {words.length === 0 && (
              <p className="text-[12px] text-text-muted text-center mt-1">
                {t("vocab.panelEmptySub")}
              </p>
            )}
          </div>
        ) : (
          filteredWords.map((word) => {
            const page = getPageFromCfi && word.cfi ? getPageFromCfi(word.cfi) : null;
            const parts = word.definition.split("\n\n");
            const defText = parts[0] || "";
            const ctxText = parts.length > 1 ? parts.slice(1).join(" ") : null;
            return (
              <button
                key={word.id}
                type="button"
                onClick={() => setActiveWord(word)}
                className="group relative border-l-[3px] border-accent bg-bg-surface mx-3 mb-2 rounded-r-lg px-4 pt-3 pb-3 w-[calc(100%-1.5rem)] text-left cursor-pointer hover:bg-bg-input transition-colors"
              >
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    removeWord(word.id);
                  }}
                  className="absolute top-3 right-3 p-1 rounded hover:bg-bg-input cursor-pointer"
                >
                  <Trash2 size={15} className="text-text-muted" />
                </button>
                <div className="flex items-center gap-2 pr-8">
                  <span className="text-[16px] font-bold text-text-primary leading-5">
                    {word.word}
                  </span>
                </div>
                <p className="text-[14px] text-text-primary leading-[1.5] mt-2 pr-6 line-clamp-3">
                  {defText}
                </p>
                {ctxText && (
                  <p className="text-[13px] italic text-text-muted leading-[1.45] mt-1 line-clamp-2">
                    {ctxText}
                  </p>
                )}
                <div className="flex items-center gap-3 mt-2.5">
                  {page != null && (
                    <span className="flex items-center gap-1 text-[11px] text-text-muted tracking-[0.06px]">
                      <FileText size={12} />
                      p. {page}
                    </span>
                  )}
                  <span className="flex items-center gap-1 text-[11px] text-text-muted tracking-[0.06px]">
                    <Clock size={12} />
                    {timeAgo(word.created_at)}
                  </span>
                </div>
              </button>
            );
          })
        )}
      </div>

      {/* Footer */}
      <div className="border-t border-border px-4 pt-[11px] pb-3 shrink-0">
        <p className="text-[11px] text-text-muted tracking-[0.06px] text-center">
          {t("vocab.wordCount", { count: filteredWords.length })}
        </p>
      </div>

      <VocabDetailModal
        word={activeWord}
        bookTitle={bookTitle}
        onClose={() => setActiveWord(null)}
        onDelete={async (id) => {
          await removeWord(id);
          setActiveWord(null);
        }}
        navigateMode="inline"
        onNavigateInline={(cfi) => onNavigate?.(cfi)}
      />
    </div>
  );
}
