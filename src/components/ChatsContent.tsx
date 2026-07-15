import { useState, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Search, BookOpen, Sparkles, MessageSquare } from "lucide-react";
import { useAllChats, type ChatSummary } from "../hooks/useChats";
import { timeAgo } from "../utils/timeAgo";
import ChatDetailView from "./ChatDetailView";
import Select from "./ui/Select";

export default function ChatsContent() {
  const { t } = useTranslation();
  const { chats, remove } = useAllChats();
  const [search, setSearch] = useState("");
  const [bookFilter, setBookFilter] = useState<string | null>(null);
  const [selectedChat, setSelectedChat] = useState<ChatSummary | null>(null);

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

  // Group chats by book
  const groupedByBook = useMemo(() => {
    const map = new Map<string, { bookId: string; title: string; chats: ChatSummary[] }>();
    for (const chat of filtered) {
      if (!map.has(chat.book_id)) {
        map.set(chat.book_id, { bookId: chat.book_id, title: chat.book_title || "Unknown Book", chats: [] });
      }
      map.get(chat.book_id)!.chats.push(chat);
    }
    return Array.from(map.values());
  }, [filtered]);

  const bookOptions = useMemo(() => {
    const map = new Map<string, { value: string; label: string; count: number }>();
    for (const chat of chats) {
      const existing = map.get(chat.book_id);
      if (existing) {
        existing.count++;
      } else {
        map.set(chat.book_id, {
          value: chat.book_id,
          label: chat.book_title || "Unknown Book",
          count: 1,
        });
      }
    }
    const books = Array.from(map.values()).sort((a, b) => b.count - a.count);
    return [
      { value: "", label: t("chats.allBooks"), detail: String(chats.length) },
      ...books.map((b) => ({ value: b.value, label: b.label, detail: String(b.count) })),
    ];
  }, [chats, t]);

  const isEmpty = chats.length === 0;

  if (selectedChat) {
    return (
      <ChatDetailView
        chat={selectedChat}
        onBack={() => setSelectedChat(null)}
        onChatDeleted={(id) => {
          setSelectedChat(null);
          remove(id);
        }}
      />
    );
  }

  return (
    <div className="flex-1 flex flex-col min-w-0">
      {/* Header */}
      <div className={`px-page pb-4 relative select-none ${!isEmpty ? "border-b border-border" : ""}`}>
        <div data-tauri-drag-region className="absolute top-0 left-0 right-0 h-11" />
        <div className="pt-11 flex items-center justify-between mb-6">
          <h1 className="text-[24px] font-semibold text-text-primary tracking-[0.07px]">
            {t("chats.title")}
          </h1>
          <div className="flex items-center gap-0" />
        </div>

        <div className="flex items-center gap-2">
          <div className="flex items-center gap-2 h-9 px-3 rounded-lg bg-bg-input flex-1 min-w-0 max-w-[448px]">
            <Search size={16} className="text-text-muted shrink-0" />
            <input
              type="search"
              placeholder={t("chats.search")}
              defaultValue=""
              onInput={(e) => setSearch((e.target as HTMLInputElement).value)}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              className="flex-1 text-[14px] text-text-primary bg-transparent outline-none placeholder:text-text-placeholder [&::-webkit-search-cancel-button]:hidden"
            />
          </div>
          {!isEmpty && (
            <Select
              value={bookFilter ?? ""}
              onChange={(v) => setBookFilter(v || null)}
              options={bookOptions}
              className="w-[190px] shrink-0"
            />
          )}
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto scrollbar-none p-page pb-20">
        {isEmpty ? (
          <div className="flex flex-col items-center justify-center h-full">
            <div className="size-16 rounded-full bg-bg-input flex items-center justify-center mb-4">
              <MessageSquare size={28} className="text-text-muted" />
            </div>
            <h2 className="text-[18px] font-medium text-text-primary mb-2">
              {t("chats.empty")}
            </h2>
            <p className="text-[14px] text-text-muted text-center max-w-[296px]">
              {t("chats.emptySub")}
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
                    onClick={() => setSelectedChat(chat)}
                    className="flex items-center gap-3 px-3 py-2.5 rounded-[10px] hover:bg-bg-input cursor-pointer"
                  >
                    <div className="size-9 rounded-[10px] flex items-center justify-center shrink-0 bg-accent-bg border border-accent/20">
                      <Sparkles size={16} className="text-accent-text" />
                    </div>

                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-[14px] font-semibold text-text-primary leading-5 truncate tracking-[-0.08px]">
                          {chat.title}
                        </span>
                        {(chat.message_count ?? 0) > 0 && (
                          <span className="flex items-center justify-center h-[18px] px-[7px] rounded-full bg-bg-input text-[10px] font-medium text-text-muted shrink-0">
                            {chat.message_count}
                          </span>
                        )}
                      </div>
                      <p className="text-[12px] text-text-muted leading-[18px] truncate mt-0.5">
                        {chat.last_message
                          ? `AI: ${chat.last_message.substring(0, 80)}${chat.last_message.length > 80 ? "..." : ""}`
                          : t("chats.noMessages")}
                      </p>
                    </div>

                    <span className="text-[11px] text-text-muted shrink-0">
                      {timeAgo(chat.updated_at)}
                    </span>
                  </div>
                ))}
              </div>
            ))}
            {filtered.length === 0 && chats.length > 0 && (
              <div className="flex flex-col items-center justify-center h-64 gap-2">
                <p className="text-[14px] text-text-muted">{t("chats.noMatch")}</p>
              </div>
            )}
          </div>
        )}
      </div>

    </div>
  );
}
