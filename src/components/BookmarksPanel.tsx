import { Bookmark, BookmarkPlus, FileText, Clock } from "lucide-react";

interface BookmarkItem {
  id: string;
  title: string;
  preview: string;
  page: number;
  timeAgo: string;
  active?: boolean;
}

const mockBookmarks: BookmarkItem[] = [
  {
    id: "1",
    title: "Chapter 1: The Beginning",
    preview: "In the year 2025, humanity stood at the precipice of a new era...",
    page: 1,
    timeAgo: "2d ago",
    active: true,
  },
  {
    id: "2",
    title: "The Breakthrough",
    preview:
      "The synchronization rate had improved by fifteen percent overnight...",
    page: 3,
    timeAgo: "5h ago",
  },
];

export default function BookmarksPanel() {
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
        <button className="flex items-center gap-1.5 h-8 px-2.5 rounded-lg bg-[#eceef2] opacity-50 cursor-default">
          <BookmarkPlus size={16} className="text-dark" />
          <span className="text-[14px] font-medium text-dark tracking-[-0.15px]">
            Saved
          </span>
        </button>
      </div>

      {/* Bookmark list */}
      <div className="flex-1 overflow-auto pt-1">
        {mockBookmarks.map((bookmark) => (
          <button
            key={bookmark.id}
            className={`flex items-start gap-0 pl-[18px] pr-4 pt-3 pb-3 w-full text-left cursor-pointer border-l-2 ${
              bookmark.active
                ? "border-link-light bg-[rgba(239,246,255,0.5)]"
                : "border-transparent hover:bg-bg-input"
            }`}
          >
            <Bookmark
              size={16}
              className={`shrink-0 mt-0.5 ${
                bookmark.active
                  ? "text-link-light fill-link-light"
                  : "text-text-muted"
              }`}
            />
            <div className="ml-3 min-w-0 flex-1">
              <span className="block text-[14px] text-text-primary tracking-[-0.15px] leading-5 truncate">
                {bookmark.title}
              </span>
              <p className="text-[12px] text-text-muted leading-4 mt-0.5 truncate">
                {bookmark.preview}
              </p>
              <div className="flex items-center gap-3 mt-1.5">
                <span className="flex items-center gap-1 text-[11px] text-[#9f9fa9] tracking-[0.06px]">
                  <FileText size={12} />
                  Page {bookmark.page}
                </span>
                <span className="flex items-center gap-1 text-[11px] text-[#9f9fa9] tracking-[0.06px]">
                  <Clock size={12} />
                  {bookmark.timeAgo}
                </span>
              </div>
            </div>
          </button>
        ))}
      </div>

      {/* Footer */}
      <div className="border-t border-border px-4 pt-[11px] pb-3 shrink-0">
        <p className="text-[11px] text-[#9f9fa9] tracking-[0.06px] text-center">
          {mockBookmarks.length} bookmarks
        </p>
      </div>
    </div>
  );
}
