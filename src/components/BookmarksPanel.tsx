import { useState } from "react";
import { Bookmark, BookmarkPlus, Trash2, Clock, Search } from "lucide-react";
import { useBookmarks, useHighlights } from "../hooks/useBookmarks";

const HIGHLIGHT_COLORS = [
  { name: "yellow", hex: "#FBBF24" },
  { name: "green", hex: "#34D399" },
  { name: "blue", hex: "#60A5FA" },
  { name: "pink", hex: "#F472B6" },
  { name: "purple", hex: "#A78BFA" },
];

interface BookmarksPanelProps {
  bookId: string;
  onNavigate?: (cfi: string) => void;
  getCurrentCfi?: () => string | null;
  getCurrentLabel?: () => string;
  getPageFromCfi?: (cfi: string) => number | null;
}

type Tab = "bookmarks" | "highlights";

function timeAgo(dateStr: string): string {
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diff = now - then;
  if (diff < 60000) return "Just now";
  const minutes = Math.floor(diff / 60000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export default function BookmarksPanel({ bookId, onNavigate, getCurrentCfi, getCurrentLabel, getPageFromCfi }: BookmarksPanelProps) {
  const [tab, setTab] = useState<Tab>("bookmarks");
  const [colorFilter, setColorFilter] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const { bookmarks, add: addBookmark, remove: removeBookmark } = useBookmarks(bookId);
  const { highlights, remove: removeHighlight } = useHighlights(bookId);

  const handleAddBookmark = async () => {
    const cfi = getCurrentCfi?.();
    if (!cfi) return;
    const label = getCurrentLabel?.() || "Bookmark";
    await addBookmark(cfi, label);
  };

  const filteredHighlights = highlights.filter((h) => {
    if (colorFilter && h.color !== colorFilter) return false;
    if (search && h.text_content && !h.text_content.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });

  return (
    <div className="flex flex-col h-full bg-bg-muted">
      {/* Tab bar */}
      <div className="flex border-b border-border shrink-0">
        <button
          onClick={() => setTab("bookmarks")}
          className={`flex-1 h-[45px] text-[14px] font-medium tracking-[-0.15px] cursor-pointer transition-colors ${
            tab === "bookmarks"
              ? "text-text-primary border-b-2 border-text-primary"
              : "text-text-muted hover:text-text-body"
          }`}
        >
          Bookmarks
        </button>
        <button
          onClick={() => setTab("highlights")}
          className={`flex-1 h-[45px] text-[14px] font-medium tracking-[-0.15px] cursor-pointer transition-colors ${
            tab === "highlights"
              ? "text-text-primary border-b-2 border-text-primary"
              : "text-text-muted hover:text-text-body"
          }`}
        >
          Highlights
        </button>
      </div>

      {/* Bookmarks tab */}
      {tab === "bookmarks" && (
        <>
          {/* Bookmark header */}
          <div className="flex items-center justify-end px-4 h-[45px] shrink-0">
            <button
              onClick={handleAddBookmark}
              className="flex items-center gap-1.5 h-8 px-2.5 rounded-lg bg-[#eceef2] hover:bg-[#e0e2e7] cursor-pointer"
            >
              <BookmarkPlus size={16} className="text-dark" />
              <span className="text-[14px] font-medium text-dark tracking-[-0.15px]">
                Saved
              </span>
            </button>
          </div>

          <div className="flex-1 overflow-auto">
            {bookmarks.length === 0 ? (
              <p className="text-[13px] text-text-muted text-center mt-8 px-4">
                No bookmarks yet. Add one to save your place.
              </p>
            ) : (
              bookmarks.map((bookmark) => (
                <button
                  key={bookmark.id}
                  onClick={() => onNavigate?.(bookmark.cfi)}
                  className="flex items-start gap-0 pl-[18px] pr-4 pt-3 pb-3 w-full text-left border-l-2 border-transparent hover:bg-bg-input group cursor-pointer"
                >
                  <Bookmark size={16} className="shrink-0 mt-0.5 text-text-muted" />
                  <div className="ml-3 min-w-0 flex-1">
                    <span className="block text-[14px] text-text-primary tracking-[-0.15px] leading-5 truncate">
                      {bookmark.label || "Bookmark"}
                    </span>
                    <div className="flex items-center gap-3 mt-1.5">
                      {getPageFromCfi && (() => {
                        const page = getPageFromCfi(bookmark.cfi);
                        return page != null ? (
                          <span className="text-[11px] text-[#9f9fa9] tracking-[0.06px]">
                            Page {page}
                          </span>
                        ) : null;
                      })()}
                      <span className="flex items-center gap-1 text-[11px] text-[#9f9fa9] tracking-[0.06px]">
                        <Clock size={12} />
                        {timeAgo(bookmark.created_at)}
                      </span>
                    </div>
                  </div>
                  <div
                    onClick={(e) => { e.stopPropagation(); removeBookmark(bookmark.id); }}
                    className="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-bg-surface transition-opacity"
                  >
                    <Trash2 size={14} className="text-text-muted" />
                  </div>
                </button>
              ))
            )}
          </div>

          <div className="border-t border-border px-4 pt-[11px] pb-3 shrink-0">
            <p className="text-[11px] text-[#9f9fa9] tracking-[0.06px] text-center">
              {bookmarks.length} bookmark{bookmarks.length !== 1 ? "s" : ""}
            </p>
          </div>
        </>
      )}

      {/* Highlights tab */}
      {tab === "highlights" && (
        <>
          {/* Filter bar */}
          <div className="flex items-center gap-2 px-4 h-[45px] shrink-0">
            <button
              onClick={() => setColorFilter(null)}
              className={`px-2.5 h-[26px] rounded-full text-[12px] font-medium cursor-pointer transition-colors ${
                colorFilter === null
                  ? "bg-text-primary text-white"
                  : "bg-[#eceef2] text-text-muted hover:bg-[#e0e2e7]"
              }`}
            >
              All
            </button>
            {HIGHLIGHT_COLORS.map((c) => (
              <div
                key={c.name}
                onClick={() => setColorFilter(colorFilter === c.name ? null : c.name)}
                className={`w-[18px] h-[18px] rounded-full cursor-pointer transition-transform ${
                  colorFilter === c.name ? "ring-2 ring-offset-1 ring-text-primary scale-110" : "hover:scale-110"
                }`}
                style={{ backgroundColor: c.hex }}
              />
            ))}
            <div className="flex-1 flex items-center gap-1.5 ml-auto h-[28px] px-2 rounded-md bg-[#eceef2]">
              <Search size={12} className="text-[#9f9fa9] shrink-0" />
              <input
                type="text"
                placeholder="Search..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="flex-1 text-[12px] text-text-primary bg-transparent outline-none placeholder:text-[#9f9fa9]"
              />
            </div>
          </div>

          <div className="flex-1 overflow-auto">
            {filteredHighlights.length === 0 ? (
              <p className="text-[13px] text-text-muted text-center mt-8 px-4">
                {highlights.length === 0
                  ? "No highlights yet. Select text and choose a color to highlight."
                  : "No highlights match your filter."}
              </p>
            ) : (
              filteredHighlights.map((highlight) => (
                <button
                  key={highlight.id}
                  onClick={() => onNavigate?.(highlight.cfi_range)}
                  className="flex items-start gap-0 pl-[18px] pr-4 pt-3 pb-3 w-full text-left hover:bg-bg-input group cursor-pointer"
                >
                  <div
                    className="w-4 h-4 rounded-full shrink-0 mt-0.5"
                    style={{ backgroundColor: HIGHLIGHT_COLORS.find((c) => c.name === highlight.color)?.hex || "#FBBF24" }}
                  />
                  <div className="ml-3 min-w-0 flex-1">
                    {highlight.text_content && (
                      <p className="text-[13px] text-text-primary tracking-[-0.15px] leading-5 line-clamp-2">
                        &ldquo;{highlight.text_content}&rdquo;
                      </p>
                    )}
                    <div className="flex items-center gap-3 mt-1.5">
                      {getPageFromCfi && (() => {
                        const page = getPageFromCfi(highlight.cfi_range);
                        return page != null ? (
                          <span className="text-[11px] text-[#9f9fa9] tracking-[0.06px]">
                            Page {page}
                          </span>
                        ) : null;
                      })()}
                      <span className="flex items-center gap-1 text-[11px] text-[#9f9fa9] tracking-[0.06px]">
                        <Clock size={12} />
                        {timeAgo(highlight.created_at)}
                      </span>
                    </div>
                  </div>
                  <div
                    onClick={(e) => { e.stopPropagation(); removeHighlight(highlight.id); }}
                    className="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-bg-surface transition-opacity"
                  >
                    <Trash2 size={14} className="text-text-muted" />
                  </div>
                </button>
              ))
            )}
          </div>

          <div className="border-t border-border px-4 pt-[11px] pb-3 shrink-0">
            <p className="text-[11px] text-[#9f9fa9] tracking-[0.06px] text-center">
              {filteredHighlights.length} highlight{filteredHighlights.length !== 1 ? "s" : ""}
            </p>
          </div>
        </>
      )}
    </div>
  );
}
