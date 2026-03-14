import { useState } from "react";
import { BookOpen, Search, Trash2, Clock, Volume2, FileText, ArrowRight, Sparkles } from "lucide-react";
import { useVocab } from "../hooks/useVocab";
import { timeAgo } from "../utils/timeAgo";

interface VocabPanelProps {
  bookId: string;
  onNavigate?: (cfi: string) => void;
  getPageFromCfi?: (cfi: string) => number | null;
}

export default function VocabPanel({ bookId, onNavigate, getPageFromCfi }: VocabPanelProps) {
  const [search, setSearch] = useState("");
  const { words, remove } = useVocab(bookId);

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
            Vocabulary
          </span>
        </div>
        <span className="text-[11px] text-[#9f9fa9] tracking-[0.06px]">
          {words.length} word{words.length !== 1 ? "s" : ""}
        </span>
      </div>

      {/* Search */}
      <div className="px-4 pb-2 shrink-0">
        <div className="flex items-center gap-1.5 h-[28px] px-2 rounded-lg bg-[#f4f4f5] border border-[rgba(228,228,231,0.6)]">
          <Search size={12} className="text-[#9f9fa9] shrink-0" />
          <input
            type="search"
            placeholder="Search vocabulary..."
            defaultValue=""
            onInput={(e) => setSearch((e.target as HTMLInputElement).value)}
            onKeyDown={(e) => e.stopPropagation()}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            className="flex-1 text-[12px] text-text-primary bg-transparent outline-none placeholder:text-[#9f9fa9] [&::-webkit-search-cancel-button]:hidden"
          />
        </div>
      </div>

      {/* Word list */}
      <div className="flex-1 overflow-auto">
        {filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full px-4">
            <div className="size-12 rounded-full bg-[#f4f4f5] flex items-center justify-center mb-3">
              <BookOpen size={20} className="text-[#9f9fa9]" />
            </div>
            <p className="text-[14px] text-[#71717b] text-center">
              {words.length === 0 ? "No saved words yet" : "No matches found"}
            </p>
            {words.length === 0 && (
              <p className="text-[12px] text-[#9f9fa9] text-center mt-1">
                Use "Look Up" on selected text and tap Save
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
                className="group relative border-l-[3px] border-[#c27aff] bg-[#fafafa] mx-3 mb-2 rounded-r-lg px-4 pt-3 pb-3"
              >
                {/* Trash — top right */}
                <button
                  onClick={() => remove(word.id)}
                  className="absolute top-3 right-3 p-1 rounded hover:bg-white/80 cursor-pointer"
                >
                  <Trash2 size={15} className="text-[#d4d4d8]" />
                </button>

                {/* Word + speaker */}
                <div className="flex items-center gap-2 pr-8">
                  <span className="text-[16px] font-bold text-text-primary leading-5">
                    {word.word}
                  </span>
                  <Volume2 size={16} className="text-[#d4d4d8] shrink-0" />
                </div>

                {/* Definition — clamped */}
                <p className="text-[14px] text-text-primary leading-[1.5] mt-2 pr-6 line-clamp-3">
                  {defText}
                </p>

                {/* AI context — italic, clamped */}
                {ctxText && (
                  <p className="text-[13px] italic text-[#9f9fa9] leading-[1.45] mt-1 line-clamp-2">
                    {ctxText}
                  </p>
                )}

                {/* Metadata row */}
                <div className="flex items-center justify-between mt-2.5">
                  <div className="flex items-center gap-3">
                    {page != null && (
                      <span className="flex items-center gap-1 text-[11px] text-[#9f9fa9] tracking-[0.06px]">
                        <FileText size={12} />
                        p. {page}
                      </span>
                    )}
                    <span className="flex items-center gap-1 text-[11px] text-[#9f9fa9] tracking-[0.06px]">
                      <Clock size={12} />
                      {timeAgo(word.created_at)}
                    </span>
                  </div>
                  {word.cfi && (
                    <button
                      onClick={() => onNavigate?.(word.cfi!)}
                      className="flex items-center gap-1 text-[12px] font-medium text-[#9810fa] cursor-pointer hover:opacity-70"
                    >
                      {page != null ? `Go to p. ${page}` : "Go to location"}
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
        <p className="text-[11px] text-[#9f9fa9] tracking-[0.06px] text-center">
          {filtered.length} word{filtered.length !== 1 ? "s" : ""}
        </p>
      </div>
    </div>
  );
}
