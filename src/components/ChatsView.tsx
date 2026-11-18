import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ArrowUp,
  BookOpen,
  Check,
  ChevronDown,
  Copy,
  Loader2,
  MoreHorizontal,
  PenLine,
  Settings,
  Sparkles,
  Trash2,
} from "lucide-react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Book } from "../hooks/useBooks";
import { useAiChat } from "../hooks/useAiChat";
import { useAllChats, useChatCounts, type ChatSummary } from "../hooks/useChats";
import { invoke } from "../platform";
import { openReaderWindow } from "../utils/openReaderWindow";
import { formatMonthHeading, formatShortDate } from "../utils/vocabParse";
import type { SettingsSection } from "./settings/types";
import BookCover from "./ui/BookCover";
import { Menu, MenuDivider, MenuItem } from "./ui/Menu";

interface ChatsViewProps {
  booksById: ReadonlyMap<string, Book>;
  initialBookId?: string | null;
  initialChatId?: string | null;
  navigationSeq?: number;
  onOpenSettings: (section?: SettingsSection) => void;
  onNavigateToLibrary: () => void;
}

interface RawChatRecord {
  id: string;
  book_id: string;
  title: string;
  model: string | null;
  pinned: boolean;
  metadata: string | null;
  created_at: number;
  updated_at: number;
}

export default function ChatsView({
  booksById,
  initialBookId,
  initialChatId,
  navigationSeq,
  onOpenSettings,
  onNavigateToLibrary,
}: ChatsViewProps) {
  const { t, i18n } = useTranslation();

  const [bookFilter, setBookFilter] = useState<string | null>(initialBookId ?? null);
  const [bookMenuOpen, setBookMenuOpen] = useState(false);
  const [selectedChatId, setSelectedChatId] = useState<string | null>(initialChatId ?? null);
  const [fallbackChat, setFallbackChat] = useState<ChatSummary | null>(null);
  const [resolvingChatId, setResolvingChatId] = useState<string | null>(initialChatId ?? null);
  const [pendingTargetChat, setPendingTargetChat] = useState<{
    id: string;
    key: string;
  } | null>(() =>
    initialChatId
      ? {
          id: initialChatId,
          key: `${initialBookId ?? ""}:${initialChatId}:${navigationSeq ?? ""}`,
        }
      : null,
  );

  const bookPopoverRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const booksByIdRef = useRef(booksById);
  useEffect(() => {
    booksByIdRef.current = booksById;
  }, [booksById]);
  const appliedNavKeyRef = useRef<string | null>(
    initialBookId !== undefined || initialChatId !== undefined || navigationSeq !== undefined
      ? `${initialBookId ?? ""}:${initialChatId ?? ""}:${navigationSeq ?? ""}`
      : null,
  );

  const {
    chats,
    total,
    loading,
    loadingMore,
    hasMore,
    loadMore,
    removeLocal,
    patchChat,
  } = useAllChats(undefined, bookFilter ?? undefined);
  const { counts, refresh: refreshCounts } = useChatCounts();

  useEffect(() => {
    if (
      initialBookId === undefined &&
      initialChatId === undefined &&
      navigationSeq === undefined
    ) {
      return;
    }
    const navKey = `${initialBookId ?? ""}:${initialChatId ?? ""}:${navigationSeq ?? ""}`;
    if (appliedNavKeyRef.current === navKey) return;
    appliedNavKeyRef.current = navKey;

    if (initialBookId !== undefined) {
      setBookFilter(initialBookId);
    }
    setFallbackChat(null);
    if (initialChatId !== undefined && initialChatId !== null) {
      setSelectedChatId(initialChatId);
      setResolvingChatId(initialChatId);
      setPendingTargetChat({ id: initialChatId, key: navKey });
    } else {
      setResolvingChatId(null);
      setPendingTargetChat(null);
    }
  }, [initialBookId, initialChatId, navigationSeq]);

  // If deep-linked to a chat on an older page not in page 1, fetch it cleanly before fallback
  useEffect(() => {
    if (!pendingTargetChat || loading) return;
    const targetId = pendingTargetChat.id;
    if (chats.some((c) => c.id === targetId)) {
      setFallbackChat(null);
      setResolvingChatId((cur) => (cur === targetId ? null : cur));
      setPendingTargetChat(null);
      return;
    }
    setResolvingChatId(targetId);
    let cancelled = false;
    invoke<RawChatRecord>("get_chat", { chatId: targetId })
      .then((rec) => {
        if (cancelled) return;
        const bookMeta = booksByIdRef.current.get(rec.book_id);
        setFallbackChat({
          id: rec.id,
          book_id: rec.book_id,
          title: rec.title,
          model: rec.model,
          pinned: rec.pinned,
          metadata: rec.metadata,
          created_at: rec.created_at,
          updated_at: rec.updated_at,
          book_title: bookMeta?.title ?? null,
          message_count: null,
          last_message: null,
        });
        setResolvingChatId((cur) => (cur === targetId ? null : cur));
        setPendingTargetChat(null);
      })
      .catch((err) => {
        if (cancelled) return;
        console.error("Failed to load target chat:", err);
        setFallbackChat(null);
        setResolvingChatId((cur) => (cur === targetId ? null : cur));
        setPendingTargetChat(null);
      });
    return () => {
      cancelled = true;
    };
  }, [pendingTargetChat, loading, chats]);

  useEffect(() => {
    if (!bookMenuOpen) return;
    const onPointerDown = (e: MouseEvent) => {
      if (bookPopoverRef.current && !bookPopoverRef.current.contains(e.target as Node)) {
        setBookMenuOpen(false);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setBookMenuOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [bookMenuOpen]);

  useEffect(() => {
    if (bookFilter && counts && !counts.by_book.some((b) => b.book_id === bookFilter)) {
      setBookFilter(null);
    }
  }, [bookFilter, counts]);

  // Infinite scroll sentinel inside left thread list
  useEffect(() => {
    const node = sentinelRef.current;
    if (!node || !hasMore || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          void loadMore();
        }
      },
      { rootMargin: "120px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [hasMore, loadMore]);

  const compatibleFallbackChat =
    fallbackChat && (!bookFilter || fallbackChat.book_id === bookFilter)
      ? fallbackChat
      : null;

  // Default selection to first visible chat when none selected (waiting for pending get_chat lookup)
  useEffect(() => {
    if (loading) return;
    if (selectedChatId && resolvingChatId === selectedChatId) return;
    if (selectedChatId === null && chats.length > 0) {
      setSelectedChatId(chats[0].id);
      return;
    }
    if (
      selectedChatId &&
      !chats.some((c) => c.id === selectedChatId) &&
      compatibleFallbackChat?.id !== selectedChatId
    ) {
      setSelectedChatId(chats[0]?.id ?? null);
    }
  }, [loading, chats, selectedChatId, resolvingChatId, compatibleFallbackChat]);

  const activeChat = useMemo<ChatSummary | null>(() => {
    if (selectedChatId) {
      const found = chats.find((c) => c.id === selectedChatId);
      if (found) return found;
      if (compatibleFallbackChat?.id === selectedChatId) return compatibleFallbackChat;
      if (resolvingChatId === selectedChatId) return null;
    }
    return chats[0] ?? null;
  }, [chats, compatibleFallbackChat, selectedChatId, resolvingChatId]);

  const multiYear = useMemo(() => {
    const years = new Set<number>();
    for (const c of chats) {
      years.add(new Date(c.updated_at).getFullYear());
    }
    return years.size > 1;
  }, [chats]);

  const groupedChats = useMemo(() => {
    const currentYear = new Date().getFullYear();
    const map = new Map<string, { heading: string; items: ChatSummary[] }>();
    for (const chat of chats) {
      const d = new Date(chat.updated_at);
      const year = d.getFullYear();
      const key = Number.isNaN(year) ? "unknown" : `${year}-${d.getMonth()}`;
      const existing = map.get(key);
      if (existing) {
        existing.items.push(chat);
      } else {
        map.set(key, {
          heading: formatMonthHeading(
            chat.updated_at,
            i18n.language,
            multiYear || year !== currentYear,
          ),
          items: [chat],
        });
      }
    }
    return Array.from(map.entries()).map(([key, group]) => ({
      key,
      heading: group.heading,
      items: group.items,
    }));
  }, [chats, i18n.language, multiYear]);

  const globalTotal = counts?.total ?? (bookFilter ? 0 : total);
  const bookCount = counts?.by_book.length ?? 0;
  const isGloballyEmpty = !loading && counts !== null && counts.total === 0 && !bookFilter;
  const activeBookTitle = bookFilter
    ? counts?.by_book.find((b) => b.book_id === bookFilter)?.book_title ??
      booksById.get(bookFilter)?.title ??
      t("chats.allBooks")
    : t("chats.allBooks");

  const handleSelectBookFilter = useCallback((nextBookId: string | null) => {
    setBookFilter(nextBookId);
    setFallbackChat(null);
    setResolvingChatId(null);
    setPendingTargetChat(null);
    setBookMenuOpen(false);
  }, []);

  const handleDeleted = useCallback(
    (deletedId: string) => {
      const idx = chats.findIndex((c) => c.id === deletedId);
      const next = (idx >= 0 ? chats[idx + 1] ?? chats[idx - 1] : null) ?? null;
      removeLocal(deletedId);
      if (fallbackChat?.id === deletedId) setFallbackChat(null);
      setSelectedChatId(next?.id ?? null);
      void refreshCounts();
    },
    [chats, fallbackChat, refreshCounts, removeLocal],
  );

  const handleRenamed = useCallback(
    (id: string, title: string) => {
      patchChat(id, { title, updated_at: Date.now() });
      setFallbackChat((prev) => (prev?.id === id ? { ...prev, title } : prev));
    },
    [patchChat],
  );

  return (
    <main className="flex-1 min-h-0 flex flex-col overflow-hidden px-10 pt-1 pb-6">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-4 pb-5 shrink-0">
        <div className="flex items-baseline gap-3 min-w-0">
          <h1 className="text-[28px] font-semibold tracking-[-0.5px] leading-[1.15] text-text-primary">
            {t("chats.title")}
          </h1>
          <span className="font-mono text-[12.5px] text-text-tertiary shrink-0">
            {globalTotal === 0
              ? t("chats.countZero")
              : t("chats.summary", {
                  count: globalTotal,
                  booksLabel: t("common.booksCount", { count: bookCount }),
                })}
          </span>
        </div>

        {!isGloballyEmpty && (counts?.total ?? chats.length) > 0 && (
          <div className="relative" ref={bookPopoverRef}>
            <button
              type="button"
              onClick={() => setBookMenuOpen((prev) => !prev)}
              aria-expanded={bookMenuOpen}
              aria-haspopup="menu"
              className={`h-10 px-3.5 rounded-full text-[13px] inline-flex items-center gap-2 cursor-pointer transition-colors focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-focus-ring ${
                bookFilter
                  ? "bg-accent-tint border border-violet-300/60 text-accent-on-tint font-semibold"
                  : "dawn-glass text-text-primary font-medium hover:bg-surface-solid"
              }`}
            >
              <BookOpen
                size={14}
                className={bookFilter ? "text-accent" : "text-text-secondary"}
              />
              <span className="truncate max-w-[180px]">{activeBookTitle}</span>
              <ChevronDown size={14} className="text-text-tertiary shrink-0" />
            </button>

            {bookMenuOpen && (
              <div className="absolute right-0 top-[calc(100%+6px)] z-30 w-64 max-h-80 overflow-y-auto">
                <Menu role="menu" aria-label={t("chats.bookFilterLabel")}>
                  <MenuItem
                    role="menuitemradio"
                    aria-checked={bookFilter === null}
                    active={bookFilter === null}
                    shortcut={String(counts?.total ?? total)}
                    onClick={() => handleSelectBookFilter(null)}
                  >
                    {t("chats.allBooks")}
                  </MenuItem>
                  {(counts?.by_book ?? []).map((b) => (
                    <MenuItem
                      key={b.book_id}
                      role="menuitemradio"
                      aria-checked={bookFilter === b.book_id}
                      active={bookFilter === b.book_id}
                      shortcut={String(b.count)}
                      onClick={() => handleSelectBookFilter(b.book_id)}
                    >
                      {b.book_title || booksById.get(b.book_id)?.title || t("common.unknownBook")}
                    </MenuItem>
                  ))}
                </Menu>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Body */}
      {isGloballyEmpty ? (
        <div className="flex-1 min-h-0 dawn-glass rounded-[16px] flex items-center justify-center p-8">
          <div className="max-w-[430px] flex flex-col items-center text-center">
            <div className="size-12 rounded-[14px] bg-accent-tint text-accent flex items-center justify-center mb-4">
              <Sparkles size={22} />
            </div>
            <h2 className="text-[20px] font-semibold tracking-[-0.3px] text-text-primary mb-2">
              {t("chats.emptyTitle")}
            </h2>
            <p className="text-[13.5px] leading-[1.55] text-text-secondary mb-6">
              {t("chats.emptyBody")}
            </p>
            <button
              type="button"
              onClick={onNavigateToLibrary}
              className="h-10 px-5 rounded-full bg-accent hover:bg-accent-hover text-text-on-accent text-[13.5px] font-semibold inline-flex items-center gap-2 cursor-pointer transition-colors"
            >
              <BookOpen size={15} />
              <span>{t("chats.emptyCta")}</span>
            </button>
          </div>
        </div>
      ) : loading && chats.length === 0 ? (
        <div className="flex-1 min-h-0 dawn-glass rounded-[16px] flex items-center justify-center">
          <Loader2 size={22} className="text-text-tertiary animate-spin" />
        </div>
      ) : (
        <div className="flex-1 min-h-0 flex gap-4 overflow-hidden">
          {/* Left Chat List (visible scrollbar — #322) */}
          <aside
            aria-label={t("chats.listLabel")}
            className="w-[340px] lg:w-[380px] xl:w-[400px] shrink-0 dawn-glass rounded-[16px] p-3 overflow-y-auto flex flex-col gap-3"
          >
            {groupedChats.map((group) => (
              <div key={group.key}>
                <div className="px-2.5 pt-1 pb-1.5 font-mono text-[11px] font-semibold tracking-[0.08em] uppercase text-text-tertiary">
                  {group.heading}
                </div>
                <div className="flex flex-col gap-0.5">
                  {group.items.map((chat) => {
                    const selected = activeChat?.id === chat.id;
                    const bookMeta = booksById.get(chat.book_id);
                    const rowBookTitle =
                      bookMeta?.title ?? chat.book_title ?? t("common.unknownBook");
                    return (
                      <button
                        key={chat.id}
                        type="button"
                        onClick={() => setSelectedChatId(chat.id)}
                        aria-current={selected ? "true" : undefined}
                        className={`w-full px-2.5 py-2.5 rounded-[10px] flex items-center gap-3 text-left cursor-pointer transition-colors ${
                          selected
                            ? "bg-accent-tint text-accent-on-tint"
                            : "text-text-primary hover:bg-black/[0.03]"
                        }`}
                      >
                        <BookCover
                          title={rowBookTitle}
                          author={bookMeta?.author}
                          coverData={bookMeta?.cover_data}
                          coverPath={bookMeta?.cover_path}
                          radius="xs"
                          shadow={false}
                          className="w-7 h-10 shrink-0"
                        />
                        <div className="flex-1 min-w-0">
                          <div
                            className={`text-[13.5px] truncate ${
                              selected ? "font-semibold text-accent-on-tint" : "font-medium text-text-primary"
                            }`}
                          >
                            {chat.title}
                          </div>
                          <div className="text-[12px] text-text-tertiary truncate mt-0.5">
                            {rowBookTitle}
                          </div>
                        </div>
                        <span className="font-mono text-[11px] text-text-tertiary shrink-0 self-start pt-0.5">
                          {formatShortDate(chat.updated_at, i18n.language)}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}

            {hasMore && (
              <div ref={sentinelRef} className="py-2 flex items-center justify-center">
                {loadingMore && <Loader2 size={16} className="text-text-tertiary animate-spin" />}
              </div>
            )}
          </aside>

          {/* Right Conversation Pane */}
          <section className="flex-1 min-w-0 dawn-glass rounded-[16px] flex flex-col overflow-hidden">
            {activeChat ? (
              <ChatConversationPane
                key={activeChat.id}
                chat={activeChat}
                book={booksById.get(activeChat.book_id) ?? null}
                onOpenSettings={onOpenSettings}
                onChatDeleted={handleDeleted}
                onChatRenamed={handleRenamed}
              />
            ) : resolvingChatId ? (
              <div className="flex-1 flex items-center justify-center">
                <Loader2 size={20} className="text-text-tertiary animate-spin" />
              </div>
            ) : null}
          </section>
        </div>
      )}
    </main>
  );
}

interface ChatConversationPaneProps {
  chat: ChatSummary;
  book: Book | null;
  onOpenSettings: (section?: SettingsSection) => void;
  onChatDeleted: (id: string) => void;
  onChatRenamed: (id: string, title: string) => void;
}

function ChatConversationPane({
  chat,
  book,
  onOpenSettings,
  onChatDeleted,
  onChatRenamed,
}: ChatConversationPaneProps) {
  const { t, i18n } = useTranslation();
  const bookTitle = book?.title ?? chat.book_title ?? t("common.unknownBook");
  const bookAuthor = book?.author ?? "";

  const {
    messages,
    streaming,
    titling,
    initializing,
    send,
    initialize,
    chats: hookChats,
    deleteChat,
    renameChat,
  } = useAiChat(chat.book_id, { title: bookTitle, author: bookAuthor || undefined });

  const [input, setInput] = useState("");
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const [moreMenuOpen, setMoreMenuOpen] = useState(false);
  const [copiedMarkdown, setCopiedMarkdown] = useState(false);
  const [deleteModalOpen, setDeleteModalOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const cancelRenameRef = useRef(false);
  const titleInputRef = useRef<HTMLInputElement>(null);
  const moreMenuRef = useRef<HTMLDivElement>(null);
  const threadScrollRef = useRef<HTMLDivElement>(null);
  const shouldAutoScrollRef = useRef(true);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const copiedTimerRef = useRef<number | null>(null);

  useEffect(() => {
    shouldAutoScrollRef.current = true;
    void initialize(chat.book_id, chat.id);
  }, [initialize, chat.book_id, chat.id]);

  const hookTitle = hookChats.find((c) => c.id === chat.id)?.title;
  const currentTitle = hookTitle || chat.title;
  const lastMessageContent = messages[messages.length - 1]?.content ?? "";

  useEffect(() => {
    if (hookTitle && hookTitle !== chat.title) {
      onChatRenamed(chat.id, hookTitle);
    }
  }, [hookTitle, chat.title, chat.id, onChatRenamed]);

  useEffect(() => {
    if (!shouldAutoScrollRef.current) return;
    messagesEndRef.current?.scrollIntoView({ behavior: streaming ? "auto" : "smooth" });
  }, [messages, messages.length, lastMessageContent, streaming]);

  useEffect(() => {
    return () => {
      if (copiedTimerRef.current !== null) {
        window.clearTimeout(copiedTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (editingTitle) {
      titleInputRef.current?.focus();
      titleInputRef.current?.select();
    }
  }, [editingTitle]);

  useEffect(() => {
    if (!moreMenuOpen) return;
    const onPointerDown = (e: MouseEvent) => {
      if (moreMenuRef.current && !moreMenuRef.current.contains(e.target as Node)) {
        setMoreMenuOpen(false);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMoreMenuOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [moreMenuOpen]);

  useEffect(() => {
    if (!deleteModalOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !deleting) {
        setDeleteModalOpen(false);
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [deleteModalOpen, deleting]);

  const startRename = useCallback(() => {
    cancelRenameRef.current = false;
    setMoreMenuOpen(false);
    setTitleDraft(currentTitle);
    setEditingTitle(true);
  }, [currentTitle]);

  const submitRename = useCallback(async () => {
    if (cancelRenameRef.current) {
      cancelRenameRef.current = false;
      setEditingTitle(false);
      return;
    }
    const trimmed = titleDraft.trim();
    setEditingTitle(false);
    if (!trimmed || trimmed === currentTitle) return;
    try {
      await renameChat(chat.id, trimmed);
      onChatRenamed(chat.id, trimmed);
    } catch (err) {
      console.error("Failed to rename chat:", err);
    }
  }, [titleDraft, currentTitle, renameChat, chat.id, onChatRenamed]);

  const firstContextCfi = useMemo(
    () => messages.find((m) => m.contextCfi)?.contextCfi ?? undefined,
    [messages],
  );

  const handleOpenInBook = useCallback(
    (cfi?: string) => {
      setMoreMenuOpen(false);
      const targetCfi = cfi ?? firstContextCfi;
      void openReaderWindow(chat.book_id, {
        openChat: true,
        chatId: chat.id,
        ...(targetCfi ? { cfi: targetCfi } : {}),
      });
    },
    [chat.book_id, chat.id, firstContextCfi],
  );

  const handleCopyMarkdown = useCallback(async () => {
    setMoreMenuOpen(false);
    const lines: string[] = [`# ${currentTitle}`, "", `*${bookTitle}*`];
    for (const msg of messages) {
      lines.push("");
      if (msg.context) {
        lines.push(`> ${msg.context.replace(/\n/g, "\n> ")}`, "");
      }
      const speaker = msg.role === "user" ? t("chats.markdownUser") : t("chats.markdownAssistant");
      lines.push(`**${speaker}:**`, msg.content);
    }
    try {
      await navigator.clipboard?.writeText(lines.join("\n"));
      setCopiedMarkdown(true);
      if (copiedTimerRef.current !== null) {
        window.clearTimeout(copiedTimerRef.current);
      }
      copiedTimerRef.current = window.setTimeout(() => {
        setCopiedMarkdown(false);
        copiedTimerRef.current = null;
      }, 1500);
    } catch (err) {
      console.error("Failed to copy conversation markdown:", err);
    }
  }, [currentTitle, bookTitle, messages, t]);

  const handleDeleteConfirm = useCallback(async () => {
    if (deleting) return;
    setDeleting(true);
    try {
      await deleteChat(chat.id);
      setDeleteModalOpen(false);
      onChatDeleted(chat.id);
    } catch (err) {
      console.error("Failed to delete chat:", err);
    } finally {
      setDeleting(false);
    }
  }, [deleting, deleteChat, chat.id, onChatDeleted]);

  const handleSend = useCallback(() => {
    const trimmed = input.trim();
    if (!trimmed || streaming || initializing) return;
    shouldAutoScrollRef.current = true;
    setInput("");
    void send(trimmed);
  }, [input, streaming, initializing, send]);

  const subtitleParts = titling
    ? [bookTitle, t("chats.titlingSub")]
    : [bookTitle, bookAuthor, formatShortDate(chat.updated_at, i18n.language)].filter(Boolean);

  const messageCountForModal = messages.length > 0 ? messages.length : (chat.message_count ?? 0);

  return (
    <>
      {/* Conversation Header */}
      <div className="px-6 py-4 border-b border-border-subtle flex items-center justify-between gap-4 shrink-0">
        <div className="flex items-center gap-3.5 min-w-0 flex-1">
          <BookCover
            title={bookTitle}
            author={bookAuthor}
            coverData={book?.cover_data}
            coverPath={book?.cover_path}
            radius="xs"
            shadow={false}
            className="w-8 h-[46px] shrink-0"
          />

          <div className="min-w-0 flex-1">
            {editingTitle ? (
              <div className="flex items-center gap-2.5 flex-wrap">
                <input
                  ref={titleInputRef}
                  type="text"
                  value={titleDraft}
                  onChange={(e) => setTitleDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      void submitRename();
                    } else if (e.key === "Escape") {
                      e.preventDefault();
                      cancelRenameRef.current = true;
                      setEditingTitle(false);
                    }
                  }}
                  onBlur={() => void submitRename()}
                  aria-label={t("chats.renameInputLabel")}
                  className="w-full max-w-[360px] h-9 px-3 rounded-[9px] bg-surface-solid border border-violet-400 ring-[3px] ring-focus-ring text-[15px] font-semibold text-text-primary outline-none"
                />
                <span className="font-mono text-[11px] text-text-tertiary shrink-0">
                  {t("chats.renameHint")}
                </span>
              </div>
            ) : titling ? (
              <div className="flex items-center gap-2 text-[15px] font-semibold text-text-primary">
                <Loader2 size={14} className="animate-spin text-accent shrink-0" />
                <span className="truncate">{t("chats.generatingTitle")}</span>
              </div>
            ) : (
              <h2
                onDoubleClick={startRename}
                title={t("chats.doubleClickRename")}
                className="text-[16px] font-semibold text-text-primary truncate cursor-text"
              >
                {currentTitle}
              </h2>
            )}
            <p className="text-[12.5px] text-text-secondary truncate mt-0.5">
              {subtitleParts.join(" · ")}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {copiedMarkdown && (
            <span className="px-2.5 py-1 rounded-full bg-accent-tint text-accent-on-tint text-[12px] font-medium inline-flex items-center gap-1">
              <Check size={12} />
              <span>{t("common.copied")}</span>
            </span>
          )}

          <button
            type="button"
            onClick={() => handleOpenInBook()}
            className="h-9 px-3.5 rounded-full bg-surface-chip border border-border-default hover:bg-surface-solid text-[13px] font-medium text-text-primary inline-flex items-center gap-1.5 cursor-pointer transition-colors"
          >
            <BookOpen size={14} className="text-text-secondary" />
            <span>{t("chats.openInBook")}</span>
          </button>

          <div className="relative" ref={moreMenuRef}>
            <button
              type="button"
              onClick={() => setMoreMenuOpen((prev) => !prev)}
              aria-expanded={moreMenuOpen}
              aria-haspopup="menu"
              aria-label={t("chats.moreActions")}
              className="size-9 rounded-full bg-surface-chip border border-border-default hover:bg-surface-solid text-text-secondary hover:text-text-primary inline-flex items-center justify-center cursor-pointer transition-colors"
            >
              <MoreHorizontal size={16} />
            </button>

            {moreMenuOpen && (
              <div className="absolute right-0 top-[calc(100%+6px)] z-30 w-56">
                <Menu role="menu" aria-label={t("chats.moreActions")}>
                  <MenuItem role="menuitem" icon={<PenLine size={14} />} onClick={startRename}>
                    {t("chats.menuRename")}
                  </MenuItem>
                  <MenuItem
                    role="menuitem"
                    icon={<BookOpen size={14} />}
                    onClick={() => handleOpenInBook()}
                  >
                    {t("chats.menuOpenInBook")}
                  </MenuItem>
                  <MenuItem
                    role="menuitem"
                    icon={<Copy size={14} />}
                    onClick={handleCopyMarkdown}
                  >
                    {t("chats.menuCopyMarkdown")}
                  </MenuItem>
                  <MenuDivider />
                  <MenuItem
                    role="menuitem"
                    tone="danger"
                    icon={<Trash2 size={14} />}
                    onClick={() => {
                      setMoreMenuOpen(false);
                      setDeleteModalOpen(true);
                    }}
                  >
                    {t("chats.menuDelete")}
                  </MenuItem>
                </Menu>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Messages Thread */}
      <div
        ref={threadScrollRef}
        onScroll={() => {
          const el = threadScrollRef.current;
          if (!el) return;
          shouldAutoScrollRef.current = el.scrollHeight - el.scrollTop - el.clientHeight <= 80;
        }}
        className="flex-1 min-h-0 overflow-y-auto px-6 py-6"
      >
        <div className="max-w-[640px] mx-auto flex flex-col gap-5">
          {initializing ? (
            <div className="py-12 flex items-center justify-center">
              <Loader2 size={20} className="text-text-tertiary animate-spin" />
            </div>
          ) : (
            messages.map((msg, idx) => {
              const isLast = idx === messages.length - 1;
              if (msg.role === "assistant") {
                if (
                  msg.content === "AI_NOT_CONFIGURED" ||
                  msg.content === "AI_REAUTH_REQUIRED"
                ) {
                  return (
                    <div
                      key={msg.id}
                      className="rounded-[12px] bg-surface-inset border border-border-default p-4"
                    >
                      <p className="text-[13.5px] text-text-secondary mb-2.5">
                        {msg.content === "AI_REAUTH_REQUIRED"
                          ? t("ai.reauthRequired")
                          : t("ai.notConfigured")}
                      </p>
                      <button
                        type="button"
                        onClick={() => onOpenSettings("ai")}
                        className="h-8 px-3.5 rounded-full bg-accent-tint hover:bg-accent-tint-hover text-accent-on-tint text-[12.5px] font-semibold inline-flex items-center gap-1.5 cursor-pointer"
                      >
                        <Settings size={13} />
                        <span>{t("ai.openSettings")}</span>
                      </button>
                    </div>
                  );
                }

                if (streaming && !msg.content && isLast) {
                  return (
                    <div
                      key={msg.id}
                      className="flex items-center gap-2 text-[14px] text-text-tertiary"
                    >
                      <Loader2 size={14} className="animate-spin text-accent" />
                      <span>{t("ai.thinking")}</span>
                    </div>
                  );
                }

                return (
                  <div
                    key={msg.id}
                    className="markdown-body text-[15px] leading-[1.65] text-text-primary select-text"
                  >
                    <Markdown remarkPlugins={[remarkGfm]}>{msg.content}</Markdown>
                    {streaming && msg.content && isLast && (
                      <Loader2
                        size={14}
                        className="inline-block ml-1.5 animate-spin text-text-tertiary"
                      />
                    )}
                  </div>
                );
              }

              return (
                <div key={msg.id} className="flex flex-col gap-3">
                  {msg.context && (
                    <button
                      type="button"
                      onClick={() => msg.contextCfi && handleOpenInBook(msg.contextCfi)}
                      disabled={!msg.contextCfi}
                      className={`border-l-2 border-violet-300 pl-3.5 py-0.5 text-left ${
                        msg.contextCfi
                          ? "cursor-pointer hover:opacity-80"
                          : "cursor-default"
                      }`}
                    >
                      <p className="font-reading italic text-[14.5px] leading-[1.6] text-text-secondary select-text">
                        “{msg.context}”
                      </p>
                    </button>
                  )}

                  <div className="flex justify-end">
                    <div className="max-w-[78%] rounded-[14px] bg-accent-tint px-4 py-3 text-[14.5px] leading-[1.55] text-accent-on-tint whitespace-pre-wrap select-text">
                      {msg.content}
                    </div>
                  </div>
                </div>
              );
            })
          )}
          <div ref={messagesEndRef} />
        </div>
      </div>

      {/* Bottom Composer */}
      <div className="px-6 pb-5 pt-2 shrink-0">
        <div className="max-w-[640px] mx-auto bg-surface-solid border border-border-default focus-within:border-violet-400 focus-within:ring-[3px] focus-within:ring-focus-ring rounded-[12px] px-4 py-2.5 flex items-center gap-2.5 shadow-sm transition-shadow">
          <textarea
            rows={1}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                handleSend();
              }
            }}
            placeholder={t("chats.composerPlaceholder")}
            aria-label={t("chats.composerPlaceholder")}
            disabled={streaming || initializing}
            className="flex-1 min-w-0 resize-none bg-transparent text-[14px] leading-[1.45] text-text-primary placeholder:text-text-tertiary outline-none max-h-32 py-1"
          />
          <button
            type="button"
            onClick={handleSend}
            disabled={!input.trim() || streaming || initializing}
            aria-label={t("chats.send")}
            className="size-8 rounded-full flex items-center justify-center shrink-0 transition-colors cursor-pointer bg-accent hover:bg-accent-hover text-text-on-accent disabled:bg-transparent disabled:text-text-tertiary disabled:cursor-default"
          >
            {streaming ? <Loader2 size={14} className="animate-spin" /> : <ArrowUp size={15} />}
          </button>
        </div>
      </div>

      {/* Delete Conversation Modal */}
      {deleteModalOpen && (
        <div
          className="fixed inset-0 z-50 bg-black/25 backdrop-blur-[2px] flex items-center justify-center p-4"
          onClick={() => !deleting && setDeleteModalOpen(false)}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="delete-chat-modal-title"
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-[400px] bg-surface-solid rounded-[18px] p-6 border border-border-default shadow-xl"
          >
            <div className="flex items-center gap-2.5 mb-2.5">
              <div className="size-8 rounded-[10px] bg-danger-tint text-danger flex items-center justify-center shrink-0">
                <Trash2 size={15} />
              </div>
              <h3
                id="delete-chat-modal-title"
                className="text-[16px] font-semibold text-text-primary"
              >
                {t("chats.deleteModalTitle")}
              </h3>
            </div>
            <p className="text-[13.5px] leading-[1.5] text-text-secondary mb-5">
              {t("chats.deleteModalBody", {
                title: currentTitle,
                count: messageCountForModal,
              })}
            </p>
            <div className="flex items-center justify-end gap-2.5">
              <button
                type="button"
                disabled={deleting}
                onClick={() => setDeleteModalOpen(false)}
                className="h-9 px-4 rounded-full bg-surface-chip border border-border-default hover:bg-surface-solid text-[13px] font-medium text-text-primary cursor-pointer"
              >
                {t("common.cancel")}
              </button>
              <button
                type="button"
                disabled={deleting}
                onClick={handleDeleteConfirm}
                className="h-9 px-4 rounded-full bg-danger hover:bg-danger-hover text-white text-[13px] font-semibold cursor-pointer disabled:opacity-60"
              >
                {t("chats.deleteModalConfirm")}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
