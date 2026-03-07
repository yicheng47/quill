import { Bookmark, BookmarkPlus, Trash2, Clock } from "lucide-react";
import { useBookmarks, useHighlights } from "../hooks/useBookmarks";

interface BookmarksPanelProps {
  bookId: string;
}

function timeAgo(dateStr: string): string {
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diff = now - then;
  const minutes = Math.floor(diff / 60000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export default function BookmarksPanel({ bookId }: BookmarksPanelProps) {
  const { bookmarks, add: addBookmark, remove: removeBookmark } = useBookmarks(bookId);
  const { highlights } = useHighlights(bookId);

  const handleAddBookmark = async () => {
    // Add a bookmark at current position (placeholder CFI)
    await addBookmark("epubcfi(/)", "Current position");
  };

  return (
    <div className="flex flex-col h-full bg-bg-muted">
      {/* Header */}
      <div className="flex items-center justify-between px-4 h-[65px] border-b border-border shrink-0">
        <div className="flex items-center gap-2">
          <Bookmark size={20} className="text-text-muted" />
          <h2 className="text-[20px] font-semibold text-text-primary tracking-[-0.45px] leading-[30px]">
            Bookmarks
          </h2>
        </div>
        <button
          onClick={handleAddBookmark}
          className="flex items-center gap-1.5 h-8 px-2.5 rounded-lg bg-[#eceef2] hover:bg-[#e0e2e7] cursor-pointer"
        >
          <BookmarkPlus size={16} className="text-dark" />
          <span className="text-[14px] font-medium text-dark tracking-[-0.15px]">
            Add
          </span>
        </button>
      </div>

      {/* Bookmark list */}
      <div className="flex-1 overflow-auto pt-1">
        {bookmarks.length === 0 && highlights.length === 0 ? (
          <p className="text-[13px] text-text-muted text-center mt-8 px-4">
            No bookmarks or highlights yet. Add one to save your place.
          </p>
        ) : (
          <>
            {bookmarks.map((bookmark) => (
              <div
                key={bookmark.id}
                className="flex items-start gap-0 pl-[18px] pr-4 pt-3 pb-3 w-full text-left border-l-2 border-transparent hover:bg-bg-input group"
              >
                <Bookmark size={16} className="shrink-0 mt-0.5 text-text-muted" />
                <div className="ml-3 min-w-0 flex-1">
                  <span className="block text-[14px] text-text-primary tracking-[-0.15px] leading-5 truncate">
                    {bookmark.label || "Bookmark"}
                  </span>
                  <div className="flex items-center gap-3 mt-1.5">
                    <span className="flex items-center gap-1 text-[11px] text-[#9f9fa9] tracking-[0.06px]">
                      <Clock size={12} />
                      {timeAgo(bookmark.created_at)}
                    </span>
                  </div>
                </div>
                <button
                  onClick={() => removeBookmark(bookmark.id)}
                  className="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-bg-surface transition-opacity"
                >
                  <Trash2 size={14} className="text-text-muted" />
                </button>
              </div>
            ))}

            {highlights.map((highlight) => (
              <div
                key={highlight.id}
                className="flex items-start gap-0 pl-[18px] pr-4 pt-3 pb-3 w-full text-left border-l-2 border-transparent hover:bg-bg-input"
                style={{ borderLeftColor: highlight.color }}
              >
                <div
                  className="w-4 h-4 rounded shrink-0 mt-0.5"
                  style={{ backgroundColor: highlight.color }}
                />
                <div className="ml-3 min-w-0 flex-1">
                  {highlight.text_content && (
                    <p className="text-[13px] text-text-primary tracking-[-0.15px] leading-5 line-clamp-2">
                      "{highlight.text_content}"
                    </p>
                  )}
                  {highlight.note && (
                    <p className="text-[12px] text-text-muted leading-4 mt-0.5 truncate">
                      {highlight.note}
                    </p>
                  )}
                  <span className="flex items-center gap-1 text-[11px] text-[#9f9fa9] tracking-[0.06px] mt-1.5">
                    <Clock size={12} />
                    {timeAgo(highlight.created_at)}
                  </span>
                </div>
              </div>
            ))}
          </>
        )}
      </div>

      {/* Footer */}
      <div className="border-t border-border px-4 pt-[11px] pb-3 shrink-0">
        <p className="text-[11px] text-[#9f9fa9] tracking-[0.06px] text-center">
          {bookmarks.length} bookmarks &middot; {highlights.length} highlights
        </p>
      </div>
    </div>
  );
}
