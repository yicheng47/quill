import { useState, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import {
  ArrowRight,
  Languages,
  Search,
  BookOpen,
  Clock,
  FileText,
  Trash2,
  LayoutGrid,
  List,
  ArrowDownAZ,
  ArrowDownWideNarrow,
  ArrowUpWideNarrow,
} from "lucide-react";
import Button from "./ui/Button";
import { useAllDictionary, type DictionaryWord } from "../hooks/useDictionary";
import { timeAgo } from "../utils/timeAgo";

type SortMode = "newest" | "oldest" | "az";
type ViewMode = "list" | "card";

export default function DictionaryContent() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { words, remove } = useAllDictionary();
  const [sort, setSort] = useState<SortMode>("newest");
  const [view, setView] = useState<ViewMode>("list");
  const [search, setSearch] = useState("");
  const [bookFilter, setBookFilter] = useState<string | null>(null);

  const filtered = useMemo(() => {
    let result = words;
    if (search) {
      const q = search.toLowerCase();
      result = result.filter((w) => w.word.toLowerCase().startsWith(q));
    }
    if (bookFilter) {
      result = result.filter((w) => w.book_id === bookFilter);
    }
    return result;
  }, [words, search, bookFilter]);

  const sorted = useMemo(() => {
    const copy = [...filtered];
    if (sort === "oldest") {
      copy.sort((a, b) => a.created_at.localeCompare(b.created_at));
    } else if (sort === "az") {
      copy.sort((a, b) => a.word.localeCompare(b.word, undefined, { sensitivity: "base" }));
    }
    return copy;
  }, [filtered, sort]);

  const groupedByBook = useMemo(() => {
    const map = new Map<string, { title: string; words: DictionaryWord[] }>();
    for (const w of sorted) {
      if (!map.has(w.book_id)) {
        map.set(w.book_id, { title: w.book_title || t("common.unknownBook"), words: [] });
      }
      map.get(w.book_id)!.words.push(w);
    }
    return Array.from(map.values());
  }, [sorted, t]);

  const groupedByLetter = useMemo(() => {
    const map = new Map<string, DictionaryWord[]>();
    for (const w of sorted) {
      const letter = w.word[0]?.toUpperCase() || "#";
      if (!map.has(letter)) map.set(letter, []);
      map.get(letter)!.push(w);
    }
    return Array.from(map.entries()).sort(([a], [b]) => a.localeCompare(b));
  }, [sorted]);

  const bookPills = useMemo(() => {
    const map = new Map<string, { title: string; count: number }>();
    for (const w of words) {
      if (!map.has(w.book_id)) {
        map.set(w.book_id, { title: w.book_title || t("common.unknownBook"), count: 0 });
      }
      map.get(w.book_id)!.count++;
    }
    return Array.from(map.entries()).map(([id, { title, count }]) => ({ id, title, count }));
  }, [words, t]);

  const isEmpty = words.length === 0;

  return (
    <div className="flex-1 flex flex-col min-w-0">
      {/* Header */}
      <div className="px-page pb-2 relative select-none">
        <div data-tauri-drag-region className="absolute top-0 left-0 right-0 h-11" />
        <div className="pt-11 flex items-center justify-between mb-6">
          <h1 className="text-[24px] font-semibold text-text-primary tracking-[0.07px]">
            {t("vocab.title")}
          </h1>
          <div className="flex items-center gap-0">
            <Button variant="icon" size="md" active={view === "card"} onClick={() => setView("card")}>
              <LayoutGrid size={16} />
            </Button>
            <Button variant="icon" size="md" active={view === "list"} onClick={() => setView("list")}>
              <List size={16} />
            </Button>
          </div>
        </div>

        <div className="flex items-center gap-2 h-9 px-3 rounded-lg bg-bg-input max-w-[448px]">
          <Search size={16} className="text-text-muted shrink-0" />
          <input
            type="search"
            placeholder={t("vocab.search")}
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
            <BookOpen size={12} className={bookFilter === null ? "text-accent-text" : ""} />
            {t("common.allBooks")}
            <span className={`text-[11px] ${bookFilter === null ? "text-accent-text" : "text-text-muted"}`}>
              {words.length}
            </span>
          </button>
          {bookPills.map((pill) => (
            <button
              key={pill.id}
              onClick={() => setBookFilter(bookFilter === pill.id ? null : pill.id)}
              className={`flex items-center gap-1.5 h-8 px-[13px] rounded-full text-[12px] font-medium cursor-pointer shrink-0 transition-colors border ${
                bookFilter === pill.id
                  ? "bg-accent-bg border-accent/30 text-accent-text"
                  : "bg-bg-surface border-border text-text-secondary hover:bg-bg-muted"
              }`}
            >
              <BookOpen size={12} className={bookFilter === pill.id ? "text-accent-text" : ""} />
              <span className="truncate max-w-[120px]">{pill.title}</span>
              <span className={`text-[11px] ${bookFilter === pill.id ? "text-accent-text" : "text-text-muted"}`}>
                {pill.count}
              </span>
            </button>
          ))}

          <div className="ml-auto flex items-center gap-1 shrink-0">
            <button
              onClick={() => setSort("newest")}
              className={`flex items-center gap-1 h-7 px-2.5 rounded-lg text-[11px] font-medium cursor-pointer transition-colors ${
                sort === "newest" ? "text-accent-text" : "text-text-muted hover:text-text-primary"
              }`}
            >
              <ArrowDownWideNarrow size={12} />
              {t("vocab.newest")}
            </button>
            <button
              onClick={() => setSort("oldest")}
              className={`flex items-center gap-1 h-7 px-2.5 rounded-lg text-[11px] font-medium cursor-pointer transition-colors ${
                sort === "oldest" ? "text-accent-text" : "text-text-muted hover:text-text-primary"
              }`}
            >
              <ArrowUpWideNarrow size={12} />
              {t("vocab.oldest")}
            </button>
            <button
              onClick={() => { setSort("az"); setView("list"); }}
              className={`flex items-center gap-1 h-7 px-2.5 rounded-lg text-[11px] font-medium cursor-pointer transition-colors ${
                sort === "az" ? "text-accent-text" : "text-text-muted hover:text-text-primary"
              }`}
            >
              <ArrowDownAZ size={12} />
              {t("vocab.az")}
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
              {t("vocab.empty")}
            </h2>
            <p className="text-[14px] text-text-muted text-center max-w-[296px]">
              {t("vocab.emptySub")}
            </p>
          </div>
        ) : view === "list" ? (
          <div>
            {groupedByLetter.map(([letter, letterWords]) => (
              <div key={letter} className="mb-6">
                <div className="flex items-center gap-3 mb-2">
                  <span className="text-[18px] font-bold text-accent">{letter}</span>
                  <div className="flex-1 h-px bg-border-light" />
                  <span className="text-[11px] text-text-muted">{letterWords.length}</span>
                </div>
                {letterWords.map((word) => {
                  const parts = word.definition.split("\n\n");
                  const defText = parts[0] || "";
                  const ctxText = parts.length > 1 ? parts.slice(1).join(" ") : null;
                  return (
                    <div
                      key={word.id}
                      className="flex items-start gap-4 px-3 pt-3 pb-3 rounded-[10px] hover:bg-bg-input group"
                    >
                      <div className="w-[160px] shrink-0">
                        <span className="block text-[14px] font-semibold text-text-primary leading-5">
                          {word.word}
                        </span>
                        {word.book_title && (
                          <span className="flex items-center gap-1 text-[11px] text-text-muted mt-0.5">
                            <BookOpen size={10} />
                            <span className="truncate">{word.book_title}</span>
                          </span>
                        )}
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-[13px] text-text-secondary leading-5 truncate">{defText}</p>
                        {ctxText && (
                          <p className="text-[11px] italic text-text-muted leading-4 truncate mt-0.5">
                            "{ctxText}"
                          </p>
                        )}
                      </div>
                      <div className="flex items-center gap-3 shrink-0">
                        <span className="text-[11px] text-text-muted">{timeAgo(word.created_at)}</span>
                        <button
                          onClick={() => navigate(`/reader/${word.book_id}`, { state: { openVocab: true, cfi: word.cfi } })}
                          className="flex items-center gap-1 text-[12px] font-medium text-accent-text cursor-pointer hover:opacity-70"
                        >
                          {t("vocab.openInReader")}
                          <ArrowRight size={12} />
                        </button>
                        <button
                          onClick={() => remove(word.id)}
                          className="p-1 rounded hover:bg-bg-surface/80 cursor-pointer opacity-0 group-hover:opacity-100 transition-opacity"
                        >
                          <Trash2 size={14} className="text-text-muted" />
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            ))}
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
                  <span className="text-[11px] text-text-muted">({group.words.length})</span>
                </div>
                <div className="space-y-3">
                  {group.words.map((word) => {
                    const parts = word.definition.split("\n\n");
                    const defText = parts[0] || "";
                    const ctxText = parts.length > 1 ? parts.slice(1).join(" ") : null;
                    return (
                      <div
                        key={word.id}
                        className="group relative bg-bg-muted border border-border rounded-[14px] p-[17px] flex flex-col gap-2"
                      >
                        <button
                          onClick={() => remove(word.id)}
                          className="absolute top-4 right-4 p-1 rounded hover:bg-bg-surface/80 cursor-pointer opacity-0 group-hover:opacity-100 transition-opacity"
                        >
                          <Trash2 size={15} className="text-text-muted" />
                        </button>
                        <span className="text-[15px] font-semibold text-text-primary leading-[22.5px] tracking-[-0.23px]">
                          {word.word}
                        </span>
                        <p className="text-[13px] text-text-secondary leading-[20.15px] tracking-[-0.08px] line-clamp-3 w-[460px] max-w-full">
                          {defText}
                        </p>
                        {ctxText && (
                          <div className="border-l-2 border-accent/30 pl-2 overflow-hidden">
                            <p className="text-[11px] italic text-text-muted leading-[16.5px] tracking-[0.06px] line-clamp-2">
                              {ctxText}
                            </p>
                          </div>
                        )}
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-3">
                            {word.cfi && (
                              <span className="flex items-center gap-1 text-[11px] text-text-muted tracking-[0.06px]">
                                <FileText size={12} />
                                p. 1
                              </span>
                            )}
                            <span className="flex items-center gap-1 text-[11px] text-text-muted tracking-[0.06px]">
                              <Clock size={12} />
                              {timeAgo(word.created_at)}
                            </span>
                          </div>
                          <button
                            onClick={() => navigate(`/reader/${word.book_id}`, { state: { openVocab: true, cfi: word.cfi } })}
                            className="flex items-center gap-1 h-[24.5px] px-2.5 rounded-[10px] bg-accent-bg text-[11px] font-medium text-accent-text tracking-[0.06px] cursor-pointer hover:opacity-70"
                          >
                            {t("vocab.openInReader")}
                            <ArrowRight size={12} />
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
