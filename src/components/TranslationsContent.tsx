import { useState, useMemo } from "react";
import { useTranslation } from "react-i18next";
import {
  ArrowRight,
  Languages,
  Search,
  BookOpen,
  Clock,
  Trash2,
  ArrowDownWideNarrow,
  ArrowUpWideNarrow,
} from "lucide-react";
import { useAllTranslations, type SavedTranslation } from "../hooks/useTranslations";
import { timeAgo } from "../utils/timeAgo";
import { openReaderWindow } from "../utils/openReaderWindow";

type SortMode = "newest" | "oldest";

export default function TranslationsContent() {
  const { t } = useTranslation();
  const { translations, remove } = useAllTranslations();
  const [sort, setSort] = useState<SortMode>("newest");
  const [search, setSearch] = useState("");
  const [bookFilter, setBookFilter] = useState<string | null>(null);

  const filtered = useMemo(() => {
    let result = translations;
    if (search) {
      const q = search.toLowerCase();
      result = result.filter(
        (tr) =>
          tr.source_text.toLowerCase().includes(q) ||
          tr.translated_text.toLowerCase().includes(q)
      );
    }
    if (bookFilter) {
      result = result.filter((tr) => tr.book_id === bookFilter);
    }
    return result;
  }, [translations, search, bookFilter]);

  const sorted = useMemo(() => {
    const copy = [...filtered];
    if (sort === "oldest") {
      copy.sort((a, b) => a.created_at.localeCompare(b.created_at));
    }
    return copy;
  }, [filtered, sort]);

  const groupedByBook = useMemo(() => {
    const map = new Map<string, { title: string; translations: SavedTranslation[] }>();
    for (const tr of sorted) {
      if (!map.has(tr.book_id)) {
        map.set(tr.book_id, {
          title: tr.book_title || t("common.unknownBook"),
          translations: [],
        });
      }
      map.get(tr.book_id)!.translations.push(tr);
    }
    return Array.from(map.values());
  }, [sorted, t]);

  const bookPills = useMemo(() => {
    const map = new Map<string, { title: string; count: number }>();
    for (const tr of translations) {
      if (!map.has(tr.book_id)) {
        map.set(tr.book_id, {
          title: tr.book_title || t("common.unknownBook"),
          count: 0,
        });
      }
      map.get(tr.book_id)!.count++;
    }
    return Array.from(map.entries()).map(([id, { title, count }]) => ({
      id,
      title,
      count,
    }));
  }, [translations, t]);

  const isEmpty = translations.length === 0;

  return (
    <div className="flex-1 flex flex-col min-w-0">
      {/* Header */}
      <div className="px-page pb-2 relative select-none">
        <div data-tauri-drag-region className="absolute top-0 left-0 right-0 h-11" />
        <div className="pt-11 flex items-center justify-between mb-6">
          <h1 className="text-[24px] font-semibold text-text-primary tracking-[0.07px]">
            {t("translation.title")}
          </h1>
        </div>

        <div className="flex items-center gap-2 h-9 px-3 rounded-lg bg-bg-input max-w-[448px]">
          <Search size={16} className="text-text-muted shrink-0" />
          <input
            type="search"
            placeholder={t("translation.search")}
            defaultValue=""
            onInput={(e) => setSearch((e.target as HTMLInputElement).value)}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            className="flex-1 text-[14px] text-text-primary bg-transparent outline-none placeholder:text-text-placeholder [&::-webkit-search-cancel-button]:hidden"
          />
        </div>
      </div>

      {/* Book filter pills + sort */}
      {!isEmpty && (
        <div className="flex items-center gap-2 px-page pt-2 pb-4 overflow-x-auto border-b border-border">
          <button
            onClick={() => setBookFilter(null)}
            className={`flex items-center gap-1.5 h-8 px-[13px] rounded-full text-[12px] font-medium cursor-pointer shrink-0 transition-colors border ${
              bookFilter === null
                ? "bg-accent-bg border-accent/30 text-accent-text"
                : "bg-bg-surface border-border text-text-secondary hover:bg-bg-muted"
            }`}
          >
            <BookOpen
              size={12}
              className={bookFilter === null ? "text-accent-text" : ""}
            />
            {t("common.allBooks")}
            <span
              className={`text-[11px] ${bookFilter === null ? "text-accent-text" : "text-text-muted"}`}
            >
              {translations.length}
            </span>
          </button>
          {bookPills.map((pill) => (
            <button
              key={pill.id}
              onClick={() =>
                setBookFilter(bookFilter === pill.id ? null : pill.id)
              }
              className={`flex items-center gap-1.5 h-8 px-[13px] rounded-full text-[12px] font-medium cursor-pointer shrink-0 transition-colors border ${
                bookFilter === pill.id
                  ? "bg-accent-bg border-accent/30 text-accent-text"
                  : "bg-bg-surface border-border text-text-secondary hover:bg-bg-muted"
              }`}
            >
              <BookOpen
                size={12}
                className={bookFilter === pill.id ? "text-accent-text" : ""}
              />
              <span className="truncate max-w-[120px]">{pill.title}</span>
              <span
                className={`text-[11px] ${bookFilter === pill.id ? "text-accent-text" : "text-text-muted"}`}
              >
                {pill.count}
              </span>
            </button>
          ))}

          <div className="ml-auto flex items-center gap-1 shrink-0">
            <button
              onClick={() => setSort("newest")}
              className={`flex items-center gap-1 h-7 px-2.5 rounded-lg text-[11px] font-medium cursor-pointer transition-colors ${
                sort === "newest"
                  ? "text-accent-text"
                  : "text-text-muted hover:text-text-primary"
              }`}
            >
              <ArrowDownWideNarrow size={12} />
              {t("translation.newest")}
            </button>
            <button
              onClick={() => setSort("oldest")}
              className={`flex items-center gap-1 h-7 px-2.5 rounded-lg text-[11px] font-medium cursor-pointer transition-colors ${
                sort === "oldest"
                  ? "text-accent-text"
                  : "text-text-muted hover:text-text-primary"
              }`}
            >
              <ArrowUpWideNarrow size={12} />
              {t("translation.oldest")}
            </button>
          </div>
        </div>
      )}

      {/* Content */}
      <div className="flex-1 overflow-auto p-page pb-20">
        {isEmpty ? (
          <div className="flex flex-col items-center justify-center h-full">
            <div className="size-16 rounded-full bg-bg-input flex items-center justify-center mb-4">
              <Languages size={28} className="text-text-muted" />
            </div>
            <h2 className="text-[18px] font-medium text-text-primary mb-2">
              {t("translation.empty")}
            </h2>
            <p className="text-[14px] text-text-muted text-center max-w-[296px]">
              {t("translation.emptySub")}
            </p>
          </div>
        ) : (
          <div className="max-w-[525px] space-y-6">
            {groupedByBook.map((group) => (
              <div key={group.title}>
                <div className="flex items-center gap-2 mb-3">
                  <BookOpen size={14} className="text-text-muted" />
                  <span className="text-[12px] font-semibold uppercase text-text-muted tracking-[0.3px]">
                    {group.title}
                  </span>
                  <span className="text-[11px] text-text-muted">
                    ({group.translations.length})
                  </span>
                </div>
                <div className="space-y-3">
                  {group.translations.map((tr) => (
                    <div
                      key={tr.id}
                      className="group relative bg-bg-muted border border-border rounded-[14px] p-[17px] flex flex-col gap-2"
                    >
                      <button
                        onClick={() => remove(tr.id)}
                        className="absolute top-4 right-4 p-1 rounded hover:bg-bg-surface/80 cursor-pointer opacity-0 group-hover:opacity-100 transition-opacity"
                      >
                        <Trash2 size={15} className="text-text-muted" />
                      </button>

                      {/* Translated text */}
                      <p className="text-[13px] text-text-primary leading-[20.15px] tracking-[-0.08px] line-clamp-3 w-[460px] max-w-full">
                        {tr.translated_text}
                      </p>

                      {/* Source text */}
                      <div className="border-l-2 border-accent/30 pl-2 overflow-hidden">
                        <p className="text-[11px] italic text-text-muted leading-[16.5px] tracking-[0.06px] line-clamp-2">
                          {tr.source_text}
                        </p>
                      </div>

                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-3">
                          <span className="text-[10px] font-medium text-text-muted bg-bg-input px-1.5 py-0.5 rounded">
                            {tr.target_language.toUpperCase()}
                          </span>
                          <span className="flex items-center gap-1 text-[11px] text-text-muted tracking-[0.06px]">
                            <Clock size={12} />
                            {timeAgo(tr.created_at)}
                          </span>
                        </div>
                        {tr.cfi && (
                          <button
                            onClick={() =>
                              openReaderWindow(tr.book_id, { cfi: tr.cfi })
                            }
                            className="flex items-center gap-1 h-[24.5px] px-2.5 rounded-[10px] bg-accent-bg text-[11px] font-medium text-accent-text tracking-[0.06px] cursor-pointer hover:opacity-70"
                          >
                            {t("chats.openInReader")}
                            <ArrowRight size={12} />
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
