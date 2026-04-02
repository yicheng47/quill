import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Languages, Search, Trash2, Clock, FileText, ArrowRight } from "lucide-react";
import { useTranslations } from "../hooks/useTranslations";
import { timeAgo } from "../utils/timeAgo";

interface TranslationsPanelProps {
  bookId: string;
  onNavigate?: (cfi: string) => void;
  getPageFromCfi?: (cfi: string) => number | null;
}

export default function TranslationsPanel({
  bookId,
  onNavigate,
  getPageFromCfi,
}: TranslationsPanelProps) {
  const { t } = useTranslation();
  const [search, setSearch] = useState("");
  const { translations, remove } = useTranslations(bookId);

  const filtered = translations.filter((tr) => {
    if (!search) return true;
    const q = search.toLowerCase();
    return (
      tr.source_text.toLowerCase().includes(q) ||
      tr.translated_text.toLowerCase().includes(q)
    );
  });

  return (
    <div className="flex flex-col h-full bg-bg-muted">
      {/* Header */}
      <div className="flex items-center justify-between px-4 h-[45px] shrink-0">
        <div className="flex items-center gap-2">
          <div
            className="size-5 rounded-md flex items-center justify-center"
            style={{ background: "linear-gradient(135deg, #3B82F6, #1D4ED8)" }}
          >
            <Languages size={12} className="text-white" />
          </div>
          <span className="text-[14px] font-semibold text-text-primary tracking-[-0.15px]">
            {t("translation.title")}
          </span>
        </div>
        <span className="text-[11px] text-text-muted tracking-[0.06px]">
          {t("translation.count", { count: translations.length })}
        </span>
      </div>

      {/* Search */}
      <div className="px-4 pb-2 shrink-0">
        <div className="flex items-center gap-1.5 h-[28px] px-2 rounded-lg bg-bg-input border border-border">
          <Search size={12} className="text-text-muted shrink-0" />
          <input
            type="search"
            placeholder={t("translation.search")}
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

      {/* Translation list */}
      <div className="flex-1 overflow-auto">
        {filtered.length === 0 ? (
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
          filtered.map((tr) => {
            const page =
              getPageFromCfi && tr.cfi ? getPageFromCfi(tr.cfi) : null;
            return (
              <div
                key={tr.id}
                className="group relative border-l-[3px] border-blue-500 bg-bg-surface mx-3 mb-2 rounded-r-lg px-4 pt-3 pb-3"
              >
                {/* Trash */}
                <button
                  onClick={() => remove(tr.id)}
                  className="absolute top-3 right-3 p-1 rounded hover:bg-bg-input cursor-pointer"
                >
                  <Trash2 size={15} className="text-text-muted" />
                </button>

                {/* Translated text */}
                <p className="text-[14px] text-text-primary leading-[1.5] pr-6 line-clamp-3">
                  {tr.translated_text}
                </p>

                {/* Source text — muted */}
                <p className="text-[12px] italic text-text-muted leading-[1.45] mt-1.5 line-clamp-2">
                  {tr.source_text}
                </p>

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
                      {timeAgo(tr.created_at)}
                    </span>
                  </div>
                  {tr.cfi && (
                    <button
                      onClick={() => onNavigate?.(tr.cfi!)}
                      className="flex items-center gap-1 text-[12px] font-medium text-accent-text cursor-pointer hover:opacity-70"
                    >
                      {page != null
                        ? t("vocab.goToPage", { page })
                        : t("vocab.goToLocation")}
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
          {t("translation.count", { count: filtered.length })}
        </p>
      </div>
    </div>
  );
}
