import { useState } from "react";
import { useTranslation } from "react-i18next";
import { BookOpen, Search, Trash2, Clock, FileText, ArrowRight, Languages } from "lucide-react";
import { useDictionary } from "../hooks/useDictionary";
import { useTranslations } from "../hooks/useTranslations";
import { timeAgo } from "../utils/timeAgo";

interface DictionaryPanelProps {
  bookId: string;
  initialTab?: "dictionary" | "translations";
  onNavigate?: (cfi: string) => void;
  getPageFromCfi?: (cfi: string) => number | null;
}

type Tab = "dictionary" | "translations";

export default function DictionaryPanel({ bookId, initialTab = "dictionary", onNavigate, getPageFromCfi }: DictionaryPanelProps) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<Tab>(initialTab);
  const [dictSearch, setDictSearch] = useState("");
  const [transSearch, setTransSearch] = useState("");
  const { words, remove: removeWord } = useDictionary(bookId);
  const { translations, remove: removeTranslation } = useTranslations(bookId);

  const filteredWords = words.filter((w) => {
    if (!dictSearch) return true;
    return w.word.toLowerCase().startsWith(dictSearch.toLowerCase());
  });

  const filteredTranslations = translations.filter((tr) => {
    if (!transSearch) return true;
    const q = transSearch.toLowerCase();
    return tr.source_text.toLowerCase().includes(q) || tr.translated_text.toLowerCase().includes(q);
  });

  return (
    <div className="flex flex-col h-full bg-bg-muted">
      {/* Tab bar */}
      <div className="flex border-b border-border shrink-0">
        <button
          onClick={() => setTab("dictionary")}
          className={`flex-1 h-[45px] text-[14px] font-medium tracking-[-0.15px] cursor-pointer transition-colors ${
            tab === "dictionary"
              ? "text-text-primary border-b-2 border-accent"
              : "text-text-muted hover:text-text-body"
          }`}
        >
          {t("vocab.title")}
        </button>
        <button
          onClick={() => setTab("translations")}
          className={`flex-1 h-[45px] text-[14px] font-medium tracking-[-0.15px] cursor-pointer transition-colors ${
            tab === "translations"
              ? "text-text-primary border-b-2 border-accent"
              : "text-text-muted hover:text-text-body"
          }`}
        >
          {t("translation.title")}
        </button>
      </div>

      {/* Dictionary tab */}
      {tab === "dictionary" && (
        <>
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
                  <div
                    key={word.id}
                    className="group relative border-l-[3px] border-accent bg-bg-surface mx-3 mb-2 rounded-r-lg px-4 pt-3 pb-3"
                  >
                    <button
                      onClick={() => removeWord(word.id)}
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
              {t("vocab.wordCount", { count: filteredWords.length })}
            </p>
          </div>
        </>
      )}

      {/* Translations tab */}
      {tab === "translations" && (
        <>
          {/* Search */}
          <div className="px-4 pt-2 pb-2 shrink-0">
            <div className="flex items-center gap-1.5 h-[28px] px-2 rounded-lg bg-bg-input border border-border">
              <Search size={12} className="text-text-muted shrink-0" />
              <input
                type="search"
                placeholder={t("translation.search")}
                defaultValue=""
                onInput={(e) => setTransSearch((e.target as HTMLInputElement).value)}
                onKeyDown={(e) => e.stopPropagation()}
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
                className="flex-1 text-[12px] text-text-primary bg-transparent outline-none placeholder:text-text-placeholder [&::-webkit-search-cancel-button]:hidden"
              />
            </div>
          </div>

          {/* Translation list */}
          <div className="flex-1 overflow-auto">
            {filteredTranslations.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-full px-4">
                <div className="size-12 rounded-full bg-bg-input flex items-center justify-center mb-3">
                  <Languages size={20} className="text-text-muted" />
                </div>
                <p className="text-[14px] text-text-muted text-center">
                  {translations.length === 0
                    ? t("translation.panelEmpty")
                    : t("translation.noMatches")}
                </p>
                {translations.length === 0 && (
                  <p className="text-[12px] text-text-muted text-center mt-1">
                    {t("translation.panelEmptySub")}
                  </p>
                )}
              </div>
            ) : (
              filteredTranslations.map((tr) => {
                const page = getPageFromCfi && tr.cfi ? getPageFromCfi(tr.cfi) : null;
                return (
                  <div
                    key={tr.id}
                    className="group relative border-l-[3px] border-accent bg-bg-surface mx-3 mb-2 rounded-r-lg px-4 pt-3 pb-3"
                  >
                    <button
                      onClick={() => removeTranslation(tr.id)}
                      className="absolute top-3 right-3 p-1 rounded hover:bg-bg-input cursor-pointer"
                    >
                      <Trash2 size={15} className="text-text-muted" />
                    </button>
                    <p className="text-[14px] text-text-primary leading-[1.5] pr-6 line-clamp-3">
                      {tr.translated_text}
                    </p>
                    <p className="text-[12px] italic text-text-muted leading-[1.45] mt-1.5 line-clamp-2">
                      {tr.source_text}
                    </p>
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
                          {timeAgo(tr.created_at)}
                        </span>
                      </div>
                      {tr.cfi && (
                        <button
                          onClick={() => onNavigate?.(tr.cfi!)}
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
              {t("translation.count", { count: filteredTranslations.length })}
            </p>
          </div>
        </>
      )}
    </div>
  );
}
