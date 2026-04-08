import { useState, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import {
  ArrowLeft,
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
import { useAllDictionary, type DictionaryWord } from "../hooks/useDictionary";
import { timeAgo } from "../utils/timeAgo";
import VocabDetailModal from "../components/VocabDetailModal";

type SortMode = "newest" | "oldest" | "az";
type ViewMode = "list" | "card";

export default function DictionaryPage() {
  const navigate = useNavigate();
  const { words, remove } = useAllDictionary();
  const [sort, setSort] = useState<SortMode>("newest");
  const [view, setView] = useState<ViewMode>("list");
  const [search, setSearch] = useState("");
  const [bookFilter, setBookFilter] = useState<string | null>(null);
  const [activeWord, setActiveWord] = useState<DictionaryWord | null>(null);

  // Filter
  const filtered = useMemo(() => {
    let result = words;
    if (search) {
      const q = search.toLowerCase();
      result = result.filter(
        (w) => w.word.toLowerCase().startsWith(q)
      );
    }
    if (bookFilter) {
      result = result.filter((w) => w.book_id === bookFilter);
    }
    return result;
  }, [words, search, bookFilter]);

  // Sort
  const sorted = useMemo(() => {
    const copy = [...filtered];
    if (sort === "oldest") {
      copy.sort((a, b) => a.created_at.localeCompare(b.created_at));
    } else if (sort === "az") {
      copy.sort((a, b) => a.word.localeCompare(b.word, undefined, { sensitivity: "base" }));
    }
    // newest is default order from backend (created_at DESC)
    return copy;
  }, [filtered, sort]);

  // Group by book for card view
  const groupedByBook = useMemo(() => {
    const map = new Map<string, { title: string; words: DictionaryWord[] }>();
    for (const w of sorted) {
      const key = w.book_id;
      if (!map.has(key)) {
        map.set(key, { title: w.book_title || "Unknown Book", words: [] });
      }
      map.get(key)!.words.push(w);
    }
    return Array.from(map.values());
  }, [sorted]);

  // Group by letter for list view
  const groupedByLetter = useMemo(() => {
    const map = new Map<string, DictionaryWord[]>();
    for (const w of sorted) {
      const letter = w.word[0]?.toUpperCase() || "#";
      if (!map.has(letter)) map.set(letter, []);
      map.get(letter)!.push(w);
    }
    // Sort letters alphabetically
    return Array.from(map.entries()).sort(([a], [b]) => a.localeCompare(b));
  }, [sorted]);

  // Book pills data
  const bookPills = useMemo(() => {
    const map = new Map<string, { title: string; count: number }>();
    for (const w of words) {
      if (!map.has(w.book_id)) {
        map.set(w.book_id, { title: w.book_title || "Unknown Book", count: 0 });
      }
      map.get(w.book_id)!.count++;
    }
    return Array.from(map.entries()).map(([id, { title, count }]) => ({ id, title, count }));
  }, [words]);

  const isEmpty = words.length === 0;

  return (
    <div className="flex flex-col h-screen bg-bg-surface">
      {/* Header */}
      <header className="flex items-center justify-between px-section pt-11 pb-4 shrink-0 relative">
        <div data-tauri-drag-region className="absolute top-0 left-0 right-0 h-11" />
        <div className="flex items-center gap-3">
          <button
            onClick={() => navigate("/")}
            className="size-9 flex items-center justify-center rounded-lg hover:bg-bg-input cursor-pointer"
          >
            <ArrowLeft size={16} className="text-text-body" />
          </button>
          <div
            className="size-8 rounded-[14px] flex items-center justify-center shadow-sm"
            style={{ background: "linear-gradient(135deg, #AD46FF, #7F22FE)" }}
          >
            <Languages size={16} className="text-white" />
          </div>
          <div className="flex flex-col">
            <h1 className="text-[20px] font-semibold text-text-primary leading-7 tracking-[-0.45px]">
              Dictionary
            </h1>
            <span className="text-[12px] text-text-muted leading-[18px]">
              {words.length} word{words.length !== 1 ? "s" : ""} saved
            </span>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {/* View toggle */}
          <div className="flex items-center bg-border rounded-[10px] h-[30px] p-0.5">
            <button
              onClick={() => setView("card")}
              className={`flex items-center justify-center size-[26px] rounded-lg cursor-pointer transition-colors ${
                view === "card" ? "bg-bg-surface shadow-sm text-text-primary" : "text-text-secondary"
              }`}
            >
              <LayoutGrid size={14} />
            </button>
            <button
              onClick={() => setView("list")}
              className={`flex items-center justify-center size-[26px] rounded-lg cursor-pointer transition-colors ${
                view === "list" ? "bg-bg-surface shadow-sm text-text-primary" : "text-text-secondary"
              }`}
            >
              <List size={14} />
            </button>
          </div>

          {/* Sort control */}
          <div className="flex items-center bg-border rounded-[10px] h-[32.5px] p-0.5">
            <button
              onClick={() => setSort("newest")}
              className={`flex items-center gap-1 h-[28px] px-2.5 rounded-lg text-[11px] font-medium cursor-pointer transition-colors ${
                sort === "newest" ? "bg-bg-surface shadow-sm text-text-primary" : "text-text-secondary"
              }`}
            >
              <ArrowDownWideNarrow size={12} />
              Newest
            </button>
            <button
              onClick={() => setSort("oldest")}
              className={`flex items-center gap-1 h-[28px] px-2.5 rounded-lg text-[11px] font-medium cursor-pointer transition-colors ${
                sort === "oldest" ? "bg-bg-surface shadow-sm text-text-primary" : "text-text-secondary"
              }`}
            >
              <ArrowUpWideNarrow size={12} />
              Oldest
            </button>
            <button
              onClick={() => { setSort("az"); setView("list"); }}
              className={`flex items-center gap-1 h-[28px] px-2.5 rounded-lg text-[11px] font-medium cursor-pointer transition-colors ${
                sort === "az" ? "bg-bg-surface shadow-sm text-text-primary" : "text-text-secondary"
              }`}
            >
              <ArrowDownAZ size={12} />
              A-Z
            </button>
          </div>
        </div>
      </header>

      {/* Search */}
      <div className={`px-section pt-2 pb-2${isEmpty ? " border-b border-border" : ""}`}>
        <div className="flex items-center gap-2 h-9 px-3 rounded-lg bg-bg-input max-w-[448px]">
          <Search size={16} className="text-text-muted shrink-0" />
          <input
            type="search"
            placeholder="Search words, definitions, or books..."
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

      {/* Book filter pills */}
      {!isEmpty && (
        <div className="flex items-center gap-2 px-section pt-2 pb-5 overflow-x-auto border-b border-border">
          <button
            onClick={() => setBookFilter(null)}
            className={`flex items-center gap-1.5 h-8 px-[13px] rounded-full text-[12px] font-medium cursor-pointer shrink-0 transition-colors border ${
              bookFilter === null
                ? "bg-accent-bg border-accent/30 text-accent-text"
                : "bg-bg-surface border-border text-text-secondary hover:bg-bg-muted"
            }`}
          >
            <BookOpen size={12} className={bookFilter === null ? "text-accent-text" : ""} />
            All Books
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
        </div>
      )}

      {/* Content */}
      <div className="flex-1 overflow-auto px-section py-4">
        {isEmpty ? (
          /* Empty state */
          <div className="flex flex-col items-center justify-center h-full">
            <div className="size-16 rounded-full bg-bg-input flex items-center justify-center mb-4">
              <Languages size={28} className="text-text-muted" />
            </div>
            <h2 className="text-[18px] font-medium text-text-primary mb-2">
              Start Building Your Dictionary
            </h2>
            <p className="text-[14px] text-text-muted text-center max-w-[296px]">
              Select a word while reading, use "Look Up" to see its definition, then tap "Save to Dict" to add it here.
            </p>
          </div>
        ) : view === "list" ? (
          /* A-Z list view */
          <div>
            {groupedByLetter.map(([letter, letterWords]) => (
              <div key={letter} className="mb-6">
                {/* Letter header */}
                <div className="flex items-center gap-3 mb-2">
                  <span className="text-[18px] font-bold text-accent">{letter}</span>
                  <div className="flex-1 h-px bg-border-light" />
                  <span className="text-[11px] text-text-muted">{letterWords.length}</span>
                </div>
                {/* Word rows */}
                {letterWords.map((word) => {
                  const parts = word.definition.split("\n\n");
                  const defText = parts[0] || "";
                  const ctxText = parts.length > 1 ? parts.slice(1).join(" ") : null;
                  return (
                    <button
                      key={word.id}
                      type="button"
                      onClick={() => setActiveWord(word)}
                      className="flex items-start gap-4 px-3 pt-3 pb-3 rounded-[10px] hover:bg-bg-input group w-full text-left cursor-pointer"
                    >
                      {/* Left column */}
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
                      {/* Middle */}
                      <div className="flex-1 min-w-0">
                        <p className="text-[13px] text-text-secondary leading-5 truncate">
                          {defText}
                        </p>
                        {ctxText && (
                          <p className="text-[11px] italic text-text-muted leading-4 truncate mt-0.5">
                            "{ctxText}"
                          </p>
                        )}
                      </div>
                      {/* Right */}
                      <div className="flex items-center gap-3 shrink-0">
                        <span className="text-[11px] text-text-muted">
                          {timeAgo(word.created_at)}
                        </span>
                      </div>
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
        ) : (
          /* Card view — grouped by book */
          <div className="max-w-[525px] space-y-6">
            {groupedByBook.map((group) => (
              <div key={group.title}>
                {/* Book section header */}
                <div className="flex items-center gap-2 mb-3">
                  <BookOpen size={14} className="text-text-muted" />
                  <span className="text-[12px] font-semibold uppercase text-text-muted tracking-[0.3px]">
                    {group.title}
                  </span>
                  <span className="text-[11px] text-text-muted">({group.words.length})</span>
                </div>
                {/* Word cards */}
                <div className="space-y-3">
                  {group.words.map((word) => {
                    const parts = word.definition.split("\n\n");
                    const defText = parts[0] || "";
                    const ctxText = parts.length > 1 ? parts.slice(1).join(" ") : null;
                    return (
                      <button
                        key={word.id}
                        type="button"
                        onClick={() => setActiveWord(word)}
                        className="group relative bg-bg-muted border border-border rounded-[14px] p-[17px] flex flex-col gap-2 w-full text-left cursor-pointer hover:bg-bg-input transition-colors"
                      >
                        {/* Trash — top right */}
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            remove(word.id);
                          }}
                          className="absolute top-4 right-4 p-1 rounded hover:bg-bg-surface/80 cursor-pointer opacity-0 group-hover:opacity-100 transition-opacity"
                        >
                          <Trash2 size={15} className="text-text-muted" />
                        </button>

                        {/* Word */}
                        <span className="text-[15px] font-semibold text-text-primary leading-[22.5px] tracking-[-0.23px]">
                          {word.word}
                        </span>

                        {/* Definition */}
                        <p className="text-[13px] text-text-secondary leading-[20.15px] tracking-[-0.08px] line-clamp-3 w-[460px] max-w-full">
                          {defText}
                        </p>

                        {/* AI context — blockquote style */}
                        {ctxText && (
                          <div className="border-l-2 border-accent/30 pl-2 overflow-hidden">
                            <p className="text-[11px] italic text-text-muted leading-[16.5px] tracking-[0.06px] line-clamp-2">
                              {ctxText}
                            </p>
                          </div>
                        )}

                        {/* Footer */}
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
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <VocabDetailModal
        word={activeWord}
        onClose={() => setActiveWord(null)}
        onDelete={async (id) => {
          await remove(id);
          setActiveWord(null);
        }}
      />
    </div>
  );
}
