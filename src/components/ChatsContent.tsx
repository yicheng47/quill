import { useState, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import {
  ArrowRight,
  Search,
  BookOpen,
  Sparkles,
  Trash2,
  MessageSquare,
  Settings,
  ArrowDownWideNarrow,
  ArrowUpWideNarrow,
} from "lucide-react";
import Button from "./ui/Button";
import { useAllChats, type ChatSummary } from "../hooks/useChats";
import { timeAgo } from "../utils/timeAgo";

type SortMode = "newest" | "oldest";

export default function ChatsContent() {
  const navigate = useNavigate();
  const { chats, remove } = useAllChats();
  const [sort, setSort] = useState<SortMode>("newest");
  const [search, setSearch] = useState("");
  const [bookFilter, setBookFilter] = useState<string | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<ChatSummary | null>(null);

  const filtered = useMemo(() => {
    let result = chats;
    if (search) {
      const q = search.toLowerCase();
      result = result.filter((c) => c.title.toLowerCase().includes(q));
    }
    if (bookFilter) {
      result = result.filter((c) => c.book_id === bookFilter);
    }
    return result;
  }, [chats, search, bookFilter]);

  const sorted = useMemo(() => {
    const copy = [...filtered];
    if (sort === "oldest") {
      copy.sort((a, b) => a.updated_at.localeCompare(b.updated_at));
    }
    return copy;
  }, [filtered, sort]);

  // Group chats by book
  const groupedByBook = useMemo(() => {
    const map = new Map<string, { bookId: string; title: string; chats: ChatSummary[] }>();
    for (const chat of sorted) {
      if (!map.has(chat.book_id)) {
        map.set(chat.book_id, { bookId: chat.book_id, title: chat.book_title || "Unknown Book", chats: [] });
      }
      map.get(chat.book_id)!.chats.push(chat);
    }
    return Array.from(map.values());
  }, [sorted]);

  const bookPills = useMemo(() => {
    const map = new Map<string, { id: string; title: string; count: number }>();
    for (const chat of chats) {
      const existing = map.get(chat.book_id);
      if (existing) {
        existing.count++;
      } else {
        map.set(chat.book_id, {
          id: chat.book_id,
          title: chat.book_title || "Unknown Book",
          count: 1,
        });
      }
    }
    return Array.from(map.values());
  }, [chats]);

  const handleOpenInReader = (chat: ChatSummary) => {
    navigate(`/reader/${chat.book_id}`, {
      state: { openChat: true, chatId: chat.id },
    });
  };

  const isEmpty = chats.length === 0;

  return (
    <div className="flex-1 flex flex-col min-w-0">
      {/* Header */}
      <div className="px-page pb-2 relative">
        <div data-tauri-drag-region className="absolute top-0 left-0 right-0 h-11" />
        <div className="pt-11 flex items-center justify-between mb-6">
          <h1 className="text-[24px] font-semibold text-text-primary tracking-[0.07px]">
            Chats
          </h1>
          <div className="flex items-center gap-0">
            <Button variant="icon" size="md" onClick={() => navigate("/settings")}>
              <Settings size={16} />
            </Button>
          </div>
        </div>

        <div className="flex items-center gap-2 h-9 px-3 rounded-lg bg-bg-input max-w-[448px]">
          <Search size={16} className="text-text-muted shrink-0" />
          <input
            type="search"
            placeholder="Search chats..."
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
            All Books
            <span className={`text-[11px] ${bookFilter === null ? "text-accent-text" : "text-text-muted"}`}>
              {chats.length}
            </span>
          </button>
          {bookPills.map((bp) => (
            <button
              key={bp.id}
              onClick={() => setBookFilter(bookFilter === bp.id ? null : bp.id)}
              className={`flex items-center gap-1.5 h-8 px-[13px] rounded-full text-[12px] font-medium cursor-pointer shrink-0 transition-colors border ${
                bookFilter === bp.id
                  ? "bg-accent-bg border-accent/30 text-accent-text"
                  : "bg-bg-surface border-border text-text-secondary hover:bg-bg-muted"
              }`}
            >
              <BookOpen size={12} className={bookFilter === bp.id ? "text-accent-text" : ""} />
              <span className="truncate max-w-[120px]">{bp.title}</span>
              <span className={`text-[11px] ${bookFilter === bp.id ? "text-accent-text" : "text-text-muted"}`}>
                {bp.count}
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
              Newest
            </button>
            <button
              onClick={() => setSort("oldest")}
              className={`flex items-center gap-1 h-7 px-2.5 rounded-lg text-[11px] font-medium cursor-pointer transition-colors ${
                sort === "oldest" ? "text-accent-text" : "text-text-muted hover:text-text-primary"
              }`}
            >
              <ArrowUpWideNarrow size={12} />
              Oldest
            </button>
          </div>
        </div>
      )}

      {/* Content */}
      <div className="flex-1 overflow-auto p-page pb-20">
        {isEmpty ? (
          <div className="flex flex-col items-center justify-center h-full">
            <div className="size-16 rounded-full bg-bg-input flex items-center justify-center mb-4">
              <MessageSquare size={28} className="text-text-muted" />
            </div>
            <h2 className="text-[18px] font-medium text-text-primary mb-2">
              No Chats Yet
            </h2>
            <p className="text-[14px] text-text-muted text-center max-w-[296px]">
              Start a conversation in the AI panel while reading a book.
            </p>
          </div>
        ) : (
          <div>
            {groupedByBook.map((group) => (
              <div key={group.bookId} className="mb-6">
                <div className="flex items-center gap-3 mb-2">
                  <div className="flex items-center gap-1.5">
                    <BookOpen size={14} className="text-accent" />
                    <span className="text-[14px] font-semibold text-accent">{group.title}</span>
                  </div>
                  <div className="flex-1 h-px bg-border-light" />
                  <span className="text-[11px] text-text-muted">{group.chats.length}</span>
                </div>
                {group.chats.map((chat) => (
                  <div
                    key={chat.id}
                    className="flex items-start gap-4 px-3 pt-3 pb-3 rounded-[10px] hover:bg-bg-input group"
                  >
                    <div className="size-9 rounded-[10px] flex items-center justify-center shrink-0 mt-0.5 bg-accent-bg border border-accent/20">
                      <Sparkles size={16} className="text-accent-text" />
                    </div>

                    <div className="flex-1 min-w-0">
                      <span className="block text-[14px] font-semibold text-text-primary leading-5">
                        {chat.title}
                      </span>
                      <p className="text-[12px] text-text-muted leading-[18px] truncate mt-0.5">
                        {chat.last_message
                          ? `AI: ${chat.last_message.substring(0, 80)}${chat.last_message.length > 80 ? "..." : ""}`
                          : "No messages yet"}
                      </p>
                    </div>

                    <div className="flex items-center gap-3 shrink-0">
                      <div className="flex flex-col items-end gap-0.5">
                        <span className="text-[11px] text-text-muted">{timeAgo(chat.updated_at)}</span>
                        <span className="text-[11px] text-text-muted">
                          {chat.message_count ?? 0} msgs
                        </span>
                      </div>
                      <button
                        onClick={() => handleOpenInReader(chat)}
                        className="flex items-center gap-1 h-[24.5px] px-2.5 rounded-[10px] bg-accent-bg text-[11px] font-medium text-accent-text tracking-[0.06px] cursor-pointer hover:opacity-70"
                      >
                        Open in Reader
                        <ArrowRight size={12} />
                      </button>
                      <button
                        onClick={() => setDeleteConfirm(chat)}
                        className="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-bg-surface/80 cursor-pointer transition-opacity"
                      >
                        <Trash2 size={15} className="text-text-muted" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            ))}
            {filtered.length === 0 && chats.length > 0 && (
              <div className="flex flex-col items-center justify-center h-64 gap-2">
                <p className="text-[14px] text-text-muted">No matching chats</p>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Delete confirmation dialog */}
      {deleteConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-overlay">
          <div className="bg-bg-surface rounded-xl shadow-lg w-[400px] p-6">
            <h3 className="text-[18px] font-semibold text-text-primary mb-2">
              Delete Chat?
            </h3>
            <p className="text-[14px] text-text-secondary leading-5 mb-6">
              "{deleteConfirm.title}" and all its messages will be permanently deleted. This action cannot be undone.
            </p>
            <div className="flex justify-end gap-3">
              <Button variant="ghost" size="md" onClick={() => setDeleteConfirm(null)}>
                Cancel
              </Button>
              <button
                onClick={() => {
                  remove(deleteConfirm.id);
                  setDeleteConfirm(null);
                }}
                className="h-9 px-4 rounded-lg bg-red-500 text-white text-[14px] font-medium cursor-pointer hover:bg-red-600 transition-colors"
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
