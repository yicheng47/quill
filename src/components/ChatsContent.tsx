import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Search, BookOpen, Sparkles, MessageSquare, Loader2 } from "lucide-react";
import { useAllChats, useChatCounts, type ChatSummary } from "../hooks/useChats";
import { timeAgo } from "../utils/timeAgo";
import ChatDetailView from "./ChatDetailView";
import Select from "./ui/Select";

export default function ChatsContent() {
  const { t } = useTranslation();
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [bookFilter, setBookFilter] = useState<string | null>(null);
  const [selectedChat, setSelectedChat] = useState<ChatSummary | null>(null);
  const {
    chats,
    total,
    loading,
    loadingMore,
    hasMore,
    loadMore,
    refresh,
    removeLocal,
    patchChat,
  } = useAllChats(debouncedSearch || undefined, bookFilter || undefined);
  const { counts, refresh: refreshCounts } = useChatCounts();

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedSearch(search.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    if (bookFilter && counts && !counts.by_book.some((book) => book.book_id === bookFilter)) {
      setBookFilter(null);
    }
  }, [bookFilter, counts]);

  const bookOptions = useMemo(() => [
    { value: "", label: t("chats.allBooks"), detail: String(counts?.total ?? total) },
    ...(counts?.by_book ?? []).map((book) => ({
      value: book.book_id,
      label: book.book_title || t("common.unknownBook"),
      detail: String(book.count),
    })),
  ], [counts, total, t]);

  const globalTotal = counts?.total ?? (debouncedSearch || bookFilter ? 0 : total);
  const hasFilters = Boolean(debouncedSearch || bookFilter);

  if (selectedChat) {
    return (
      <ChatDetailView
        chat={selectedChat}
        onBack={() => setSelectedChat(null)}
        onChatDeleted={(id) => {
          setSelectedChat(null);
          removeLocal(id);
          void refreshCounts();
        }}
        onChatRenamed={(id, title) => {
          const updatedAt = Date.now();
          setSelectedChat((current) => current?.id === id
            ? { ...current, title, updated_at: updatedAt }
            : current);
          if (debouncedSearch) {
            void refresh();
          } else {
            patchChat(id, { title, updated_at: updatedAt });
          }
        }}
      />
    );
  }

  return (
    <div className="flex-1 flex flex-col min-w-0">
      <div className={`px-page pb-4 relative select-none ${globalTotal > 0 ? "border-b border-border" : ""}`}>
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
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              className="flex-1 text-[14px] text-text-primary bg-transparent outline-none placeholder:text-text-placeholder [&::-webkit-search-cancel-button]:hidden"
            />
          </div>
          {globalTotal > 0 && (
            <Select
              value={bookFilter ?? ""}
              onChange={(value) => setBookFilter(value || null)}
              options={bookOptions}
              className="w-[190px] shrink-0"
            />
          )}
        </div>
      </div>

      <div className="flex-1 overflow-auto scrollbar-none p-page pb-20">
        {loading ? (
          <div className="flex items-center justify-center h-full">
            <Loader2 size={24} className="text-text-muted animate-spin" />
          </div>
        ) : globalTotal === 0 && !hasFilters ? (
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
        ) : chats.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-64 gap-2">
            <p className="text-[14px] text-text-muted">{t("chats.noMatch")}</p>
          </div>
        ) : (
          <div>
            {chats.map((chat) => {
              const lastMessage = chat.last_message
                ? `${chat.last_message.substring(0, 80)}${chat.last_message.length > 80 ? "..." : ""}`
                : t("chats.noMessages");
              return (
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
                    <div className="flex items-center gap-1.5 text-[12px] text-text-muted leading-[18px] mt-0.5 min-w-0">
                      <BookOpen size={12} className="text-accent shrink-0" />
                      <span className="text-accent-text shrink-0 max-w-[35%] truncate">
                        {chat.book_title || t("common.unknownBook")}
                      </span>
                      <span className="shrink-0">·</span>
                      <span className="truncate">{lastMessage}</span>
                    </div>
                  </div>

                  <span className="text-[11px] text-text-muted shrink-0">
                    {timeAgo(chat.updated_at)}
                  </span>
                </div>
              );
            })}
            {hasMore && <LoadMoreSentinel loadMore={loadMore} loadingMore={loadingMore} />}
          </div>
        )}
      </div>
    </div>
  );
}

function LoadMoreSentinel({ loadMore, loadingMore }: { loadMore: () => void; loadingMore: boolean }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new IntersectionObserver(
      ([entry]) => { if (entry.isIntersecting) loadMore(); },
      { rootMargin: "200px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [loadMore]);

  return (
    <div ref={ref} className="flex justify-center py-4">
      {loadingMore && <Loader2 size={20} className="text-text-muted animate-spin" />}
    </div>
  );
}
