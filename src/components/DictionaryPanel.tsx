import { useState } from "react";
import { useTranslation } from "react-i18next";
import { BookOpen, Search, Trash2, Clock, FileText, ArrowRight, Sparkles } from "lucide-react";
import { useDictionary } from "../hooks/useDictionary";
import { timeAgo } from "../utils/timeAgo";

interface DictionaryPanelProps {
  bookId: string;
  onNavigate?: (cfi: string) => void;
  getPageFromCfi?: (cfi: string) => number | null;
}

export default function DictionaryPanel({ bookId, onNavigate, getPageFromCfi }: DictionaryPanelProps) {
  const { t } = useTranslation();
  const [search, setSearch] = useState("");
  const { words, remove } = useDictionary(bookId);

  const filtered = words.filter((w) => {
    if (!search) return true;
    return w.word.toLowerCase().startsWith(search.toLowerCase());
  });

  return (
    <div className="flex flex-col h-full bg-bg-muted">
      {/* Header */}
      <div className="flex items-center justify-between px-4 h-[45px] shrink-0">
        <div className="flex items-center gap-2">
          <div
            className="size-5 rounded-md flex items-center justify-center"
            style={{ background: "linear-gradient(135deg, #AD46FF, #7F22FE)" }}
          >
            <Sparkles size={12} className="text-white" />
          </div>
          <span className="text-[14px] font-semibold text-text-primary tracking-[-0.15px]">
            {t("vocab.title")}
          </span>
        </div>
        <span className="text-[11px] text-text-muted tracking-[0.06px]">
          {t("vocab.wordCount", { count: words.length })}
        </span>
      </div>

      {/* Search */}
      <div className="px-4 pb-2 shrink-0">
        <div className="flex items-center gap-1.5 h-[28px] px-2 rounded-lg bg-bg-input border border-border">
          <Search size={12} className="text-text-muted shrink-0" />
          <input
            type="search"
            placeholder={t("vocab.searchPanel")}
            defaultValue=""
            onInput={(e) => setSearch((e.target as HTMLInputElement).value)}
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
        {filtered.length === 0 ? (
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
          filtered.map((word) => {
            const page = getPageFromCfi && word.cfi ? getPageFromCfi(word.cfi) : null;
            // Split definition into main definition + AI context (joined by \n\n on save)
            const parts = word.definition.split("\n\n");
            const defText = parts[0] || "";
            const ctxText = parts.length > 1 ? parts.slice(1).join(" ") : null;
            return (
              <div
                key={word.id}
                className="group relative border-l-[3px] border-accent bg-bg-surface mx-3 mb-2 rounded-r-lg px-4 pt-3 pb-3"
              >
                {/* Trash — top right */}
                <button
                  onClick={() => remove(word.id)}
                  className="absolute top-3 right-3 p-1 rounded hover:bg-bg-input cursor-pointer"
                >
                  <Trash2 size={15} className="text-text-muted" />
                </button>

                {/* Word */}
                <div className="flex items-center gap-2 pr-8">
                  <span className="text-[16px] font-bold text-text-primary leading-5">
                    {word.word}
                  </span>
                </div>

                {/* Definition — clamped */}
                <p className="text-[14px] text-text-primary leading-[1.5] mt-2 pr-6 line-clamp-3">
                  {defText}
                </p>

                {/* AI context — italic, clamped */}
                {ctxText && (
                  <p className="text-[13px] italic text-text-muted leading-[1.45] mt-1 line-clamp-2">
                    {ctxText}
                  </p>
                )}

                {/* Metadata row */}
                <div className="flex items-center justify-between mt-2.5">
                  <div className="flex items-center gap-3">
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
                  {word.cfi && (
                    <button
                      onClick={() => onNavigate?.(word.cfi!)}
                      className="flex items-center gap-1 text-[12px] font-medium text-accent-text cursor-pointer hover:opacity-70"
                    >
                      {page != null ? t("vocab.goToPage", { page }) : t("vocab.goToLocation")}
                      <ArrowRight size={12} />
                    </button>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* Footer */}
      <div className="border-t border-border px-4 pt-[11px] pb-3 shrink-0">
        <p className="text-[11px] text-text-muted tracking-[0.06px] text-center">
          {t("vocab.wordCount", { count: filtered.length })}
        </p>
      </div>
    </div>
  );
}
