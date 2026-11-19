import { useState, useEffect, useRef, useCallback } from "react";
import { useTranslation } from "react-i18next";
import {
  ArrowUp,
  Check,
  ChevronDown,
  ChevronUp,
  CornerDownRight,
  Cpu,
  Loader2,
  Plus,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import { useAiChat } from "../hooks/useAiChat";
import { invoke } from "../platform";
import { getAllSettings } from "../hooks/useSettings";
import { formatAiModelFooter, parseAiErrorMessage } from "../utils/aiStream";
import { timeAgo } from "../utils/timeAgo";
import MessageBubble from "./MessageBubble";
import QuillLogo from "./QuillLogo";

export interface AiQuoteContext {
  text: string;
  cfi?: string;
  page?: number | null;
}

interface AiPanelProps {
  bookId?: string;
  bookTitle?: string;
  bookAuthor?: string;
  currentChapter?: string;
  context?: AiQuoteContext;
  initialChatId?: string;
  initialChatSeq?: number;
  onContextConsumed?: () => void;
  onNavigateToCfi?: (cfi: string) => void;
  onClose?: () => void;
}

export default function AiPanel({
  bookId,
  bookTitle,
  bookAuthor,
  currentChapter,
  context,
  initialChatId,
  initialChatSeq,
  onContextConsumed,
  onNavigateToCfi,
  onClose,
}: AiPanelProps) {
  const { t } = useTranslation();

  const SUGGESTED_PROMPTS = [
    t("ai.prompt.summarize"),
    t("ai.prompt.themes"),
    t("ai.prompt.characters"),
  ];
  const FOLLOWUP_PROMPTS = [
    t("ai.followup.simplify"),
    t("ai.followup.example"),
    t("ai.followup.context"),
  ];
  const {
    messages,
    streaming,
    send,
    initialize,
    chatId,
    chats,
    titling,
    initializing,
    loadChat,
    deleteChat,
    renameChat,
    reset,
    savedMessageSeq,
  } = useAiChat(bookId, { title: bookTitle, author: bookAuthor, chapter: currentChapter });

  const [input, setInput] = useState("");
  const [pendingQuote, setPendingQuote] = useState<AiQuoteContext | undefined>();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const [newChatFlash, setNewChatFlash] = useState(false);
  const [modelFooter, setModelFooter] = useState<string | null>(null);
  const [messageCountsById, setMessageCountsById] = useState<Record<string, number>>({});
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const titleInputRef = useRef<HTMLInputElement>(null);
  const pickerRef = useRef<HTMLDivElement>(null);
  const appliedChatSeqRef = useRef<number | null>(null);

  useEffect(() => {
    setMessageCountsById({});
  }, [bookId]);

  useEffect(() => {
    if (!pickerOpen || !bookId) return;
    let cancelled = false;

    const loadSwitcherCounts = async () => {
      const nextCounts: Record<string, number> = {};
      let cursor: string | null = null;
      const seenCursors = new Set<string>();
      try {
        while (!cancelled) {
          const page: {
            chats?: Array<{ id: string; message_count?: number | null }>;
            next_cursor?: string | null;
          } | null = await invoke("list_all_chats", {
            search: null,
            bookId,
            cursor,
            limit: 100,
          });
          if (cancelled || !page || !Array.isArray(page.chats)) break;
          for (const summary of page.chats) {
            if (typeof summary.message_count === "number") {
              nextCounts[summary.id] = summary.message_count;
            }
          }
          if (!page.next_cursor || seenCursors.has(page.next_cursor)) break;
          seenCursors.add(page.next_cursor);
          cursor = page.next_cursor;
        }
        if (!cancelled) {
          setMessageCountsById(nextCounts);
        }
      } catch {
        // Switcher stays usable with timestamps if count metadata fails to load.
      }
    };

    void loadSwitcherCounts();
    return () => {
      cancelled = true;
    };
  }, [pickerOpen, bookId, chats.length, savedMessageSeq]);

  const currentChat = chats.find((c) => c.id === chatId);

  const refreshModelFooter = useCallback(() => {
    getAllSettings()
      .then((settings) => {
        const label = formatAiModelFooter(settings, (effort) =>
          t(`settings.ai.effort.${effort}`, { defaultValue: effort }).toLowerCase(),
        );
        setModelFooter(label);
      })
      .catch(() => {});
  }, [t]);

  useEffect(() => {
    refreshModelFooter();
    window.addEventListener("focus", refreshModelFooter);
    return () => window.removeEventListener("focus", refreshModelFooter);
  }, [refreshModelFooter]);

  useEffect(() => {
    initialize();
  }, [initialize]);

  useEffect(() => {
    if (!initialChatId || chats.length === 0) return;
    const seq = initialChatSeq ?? 0;
    if (appliedChatSeqRef.current === seq) return;
    appliedChatSeqRef.current = seq;
    loadChat(initialChatId);
  }, [initialChatId, initialChatSeq, chats.length, loadChat]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  useEffect(() => {
    if (!context) return;
    setPendingQuote(context);
    onContextConsumed?.();
  }, [context, onContextConsumed]);

  useEffect(() => {
    if (editingTitle) {
      titleInputRef.current?.focus();
      titleInputRef.current?.select();
    }
  }, [editingTitle]);

  useEffect(() => {
    if (!pickerOpen) return;
    const handlePointerDown = (e: MouseEvent) => {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
        setPickerOpen(false);
      }
    };
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPickerOpen(false);
    };
    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleEscape);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [pickerOpen]);

  const handleSend = () => {
    if (!input.trim() || streaming || initializing) return;
    send(input.trim(), pendingQuote?.text, pendingQuote?.cfi);
    setPendingQuote(undefined);
    setInput("");
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      handleSend();
    } else if (e.key === "Escape" && pendingQuote) {
      e.preventDefault();
      setPendingQuote(undefined);
    }
  };

  const handleTitleSubmit = () => {
    if (titleDraft.trim() && chatId) {
      renameChat(chatId, titleDraft.trim());
    }
    setEditingTitle(false);
  };

  const handleNewChat = () => {
    if (bookId) {
      reset();
      setPickerOpen(false);
      setInput("");
      setNewChatFlash(true);
      requestAnimationFrame(() => {
        requestAnimationFrame(() => setNewChatFlash(false));
      });
    }
  };

  const handleSelectChat = (id: string) => {
    loadChat(id);
    setPickerOpen(false);
  };

  const composerPlaceholder = pendingQuote
    ? t("ai.placeholderQuoted")
    : messages.length > 0
      ? t("ai.placeholderPassage")
      : t("ai.placeholder");

  const lastMessage = messages[messages.length - 1];
  const showFollowUpChips = Boolean(
    !streaming &&
      !initializing &&
      lastMessage &&
      lastMessage.role === "assistant" &&
      lastMessage.content &&
      lastMessage.content !== "AI_NOT_CONFIGURED" &&
      lastMessage.content !== "AI_REAUTH_REQUIRED" &&
      !parseAiErrorMessage(lastMessage.content),
  );

  return (
    <div className="flex flex-col h-full min-w-0 p-6 gap-4">
      {/* Header + Thread Switcher */}
      <div className="flex items-center justify-between gap-2 shrink-0 relative" ref={pickerRef}>
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <QuillLogo size={22} className="shrink-0" />
          {editingTitle ? (
            <input
              ref={titleInputRef}
              value={titleDraft}
              onChange={(e) => setTitleDraft(e.target.value)}
              onBlur={handleTitleSubmit}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleTitleSubmit();
                if (e.key === "Escape") setEditingTitle(false);
              }}
              aria-label={t("chats.renameInputLabel")}
              className="text-[14px] font-semibold text-text-primary bg-transparent outline-none border-b border-accent w-full min-w-0"
            />
          ) : (
            <button
              type="button"
              onClick={() => setPickerOpen((prev) => !prev)}
              onDoubleClick={() => {
                if (titling) return;
                setTitleDraft(currentChat?.title || t("ai.newChat"));
                setEditingTitle(true);
              }}
              aria-expanded={pickerOpen}
              aria-haspopup="menu"
              className="flex items-center gap-1.5 min-w-0 cursor-pointer text-left"
            >
              {titling ? (
                <span className="flex items-center gap-1.5 text-[14px] font-semibold text-text-secondary truncate">
                  <Loader2 size={14} className="animate-spin text-accent shrink-0" />
                  <span className="truncate">{t("ai.generatingTitle")}</span>
                </span>
              ) : (
                <span className="text-[14px] font-semibold text-text-primary truncate">
                  {currentChat?.title || t("ai.newChat")}
                </span>
              )}
              {pickerOpen ? (
                <ChevronUp size={14} className="text-text-tertiary shrink-0" />
              ) : (
                <ChevronDown size={14} className="text-text-tertiary shrink-0" />
              )}
            </button>
          )}
        </div>

        <div className="flex items-center gap-1 shrink-0">
          <button
            type="button"
            onClick={handleNewChat}
            aria-label={t("ai.newChat")}
            title={t("ai.newChat")}
            className="size-[30px] rounded-control flex items-center justify-center text-text-secondary hover:bg-border-subtle cursor-pointer transition-colors"
          >
            <Plus size={15} />
          </button>
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              aria-label={t("common.dismiss")}
              className="size-[30px] rounded-control flex items-center justify-center text-text-secondary hover:bg-border-subtle cursor-pointer transition-colors"
            >
              <X size={15} />
            </button>
          )}
        </div>

        {/* Thread Switcher Dropdown */}
        {pickerOpen && (
          <div
            role="menu"
            className="absolute top-[calc(100%+8px)] left-0 right-0 reader-popover rounded-surface p-1.5 z-50 flex flex-col gap-0.5"
          >
            <div className="max-h-[260px] overflow-y-auto flex flex-col gap-0.5">
              {chats.map((chat) => {
                const isActive = chat.id === chatId;
                return (
                  <div
                    key={chat.id}
                    className={`group flex items-center justify-between gap-2 w-full px-2.5 py-[9px] rounded-[8px] transition-colors ${
                      isActive ? "bg-surface-tint" : "hover:bg-border-subtle"
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => handleSelectChat(chat.id)}
                      className="flex-1 flex flex-col gap-0.5 text-left cursor-pointer min-w-0"
                    >
                      <span
                        className={`text-[13px] truncate ${
                          isActive
                            ? "font-semibold text-accent-on-tint"
                            : "font-medium text-text-primary"
                        }`}
                      >
                        {chat.title}
                      </span>
                      <span className="font-mono text-[11px] text-text-tertiary truncate">
                        {messageCountsById[chat.id] !== undefined
                          ? `${timeAgo(chat.updated_at)} · ${t("aiPanel.messageCount", {
                              count: messageCountsById[chat.id],
                            })}`
                          : timeAgo(chat.updated_at)}
                      </span>
                    </button>
                    <div className="flex items-center shrink-0">
                      {isActive && (
                        <Check
                          size={13.5}
                          className="text-accent-on-tint shrink-0 group-hover:hidden group-focus-within:hidden"
                        />
                      )}
                      <button
                        type="button"
                        aria-label={t("common.delete")}
                        onClick={(e) => {
                          e.stopPropagation();
                          void deleteChat(chat.id);
                          if (chats.length <= 1) setPickerOpen(false);
                        }}
                        className={`${
                          isActive
                            ? "w-0 overflow-hidden opacity-0 group-hover:w-6 group-hover:opacity-100 group-focus-within:w-6 group-focus-within:opacity-100 focus-visible:w-6 focus-visible:opacity-100"
                            : "size-6 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                        } h-6 shrink-0 rounded-control flex items-center justify-center text-text-disabled hover:text-danger hover:bg-danger-tint cursor-pointer transition-all`}
                      >
                        <Trash2 size={13.5} />
                      </button>
                    </div>
                  </div>
                );
              })}
              {chats.length === 0 && (
                <p className="px-2.5 py-2.5 text-[12.5px] text-text-tertiary">{t("ai.noChats")}</p>
              )}
            </div>
            <div className="my-[3px] mx-2 h-px bg-border-subtle" />
            <button
              type="button"
              onClick={handleNewChat}
              className="flex items-center gap-2 w-full px-2.5 py-2 rounded-[8px] text-[13px] font-semibold text-accent-on-tint hover:bg-surface-tint cursor-pointer transition-colors"
            >
              <Plus size={14} />
              <span>{t("ai.newChat")}</span>
            </button>
          </div>
        )}
      </div>

      {/* Messages / Empty State */}
      <div
        className="flex-1 min-h-0 overflow-y-auto pr-0.5"
        onClick={() => pickerOpen && setPickerOpen(false)}
      >
        {messages.length === 0 ? (
          <div
            className={`flex flex-col items-center justify-center h-full gap-3 px-4 text-center transition-opacity duration-300 ${
              newChatFlash ? "opacity-0" : "opacity-100"
            }`}
          >
            <div className="size-[52px] rounded-full bg-accent-tint text-accent-on-tint flex items-center justify-center">
              <Sparkles size={22} />
            </div>
            <h3 className="text-[16px] font-semibold text-text-primary">
              {t("ai.startChat")}
            </h3>
            <p className="text-[13px] leading-[1.5] text-text-tertiary max-w-[280px]">
              {t("ai.startChatSub", { title: bookTitle || t("common.unknownBook") })}
            </p>
            <div className="flex flex-col items-center gap-2 pt-1.5 w-full">
              {SUGGESTED_PROMPTS.map((prompt) => (
                <button
                  key={prompt}
                  type="button"
                  onClick={() => {
                    if (initializing) return;
                    send(prompt, pendingQuote?.text, pendingQuote?.cfi);
                    setPendingQuote(undefined);
                  }}
                  disabled={initializing}
                  className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-full bg-surface-solid border border-border-subtle hover:border-accent/40 hover:bg-surface-tint text-[12.5px] font-medium text-text-primary cursor-pointer transition-colors disabled:opacity-50 disabled:cursor-default max-w-full"
                >
                  <CornerDownRight size={12} className="text-accent-on-tint shrink-0" />
                  <span className="truncate">{prompt}</span>
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            {messages.map((msg) => (
              <MessageBubble
                key={msg.id}
                msg={msg}
                messages={messages}
                streaming={streaming}
                onNavigateToCfi={onNavigateToCfi}
              />
            ))}
            {showFollowUpChips && (
              <div className="flex flex-wrap gap-1.5 pt-1" data-testid="followup-chips">
                {FOLLOWUP_PROMPTS.map((prompt) => (
                  <button
                    key={prompt}
                    type="button"
                    onClick={() => {
                      send(prompt, pendingQuote?.text, pendingQuote?.cfi);
                      setPendingQuote(undefined);
                    }}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-surface-chip border border-border-subtle hover:border-accent/40 hover:bg-surface-tint text-[12.5px] font-medium text-text-primary cursor-pointer transition-colors max-w-full"
                  >
                    <CornerDownRight size={13} className="text-text-tertiary shrink-0" />
                    <span className="truncate">{prompt}</span>
                  </button>
                ))}
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>
        )}
      </div>

      {/* Pending Quote + Composer + Model Footer */}
      <div className="flex flex-col gap-2.5 shrink-0">
        {pendingQuote && (
          <div className="flex items-start gap-2 px-3 py-2.5 rounded-[6px] bg-surface-tint border border-accent">
            <div className="flex-1 min-w-0 flex flex-col gap-[3px]">
              <span className="font-mono text-[10px] font-semibold uppercase tracking-wide text-accent-on-tint">
                {pendingQuote.page != null
                  ? t("aiPanel.quoteChip.labelWithPage", { page: pendingQuote.page })
                  : t("aiPanel.quoteChip.label")}
              </span>
              <p className="font-reading italic text-[12.5px] leading-[1.45] text-text-secondary line-clamp-2">
                “{pendingQuote.text}”
              </p>
            </div>
            <button
              type="button"
              onClick={() => setPendingQuote(undefined)}
              title={t("aiPanel.quoteChip.dismiss")}
              aria-label={t("aiPanel.quoteChip.dismiss")}
              className="shrink-0 size-5 rounded-control flex items-center justify-center text-text-tertiary hover:text-text-primary hover:bg-border-subtle cursor-pointer transition-colors"
            >
              <X size={13} />
            </button>
          </div>
        )}

        <div className="bg-surface-solid border border-border-default focus-within:border-accent focus-within:ring-[3px] focus-within:ring-focus-ring rounded-[6px] px-3.5 py-2 flex items-end gap-2 shadow-xs transition-shadow">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={composerPlaceholder}
            aria-label={composerPlaceholder}
            spellCheck={false}
            autoCorrect="off"
            autoCapitalize="off"
            rows={1}
            className="flex-1 min-w-0 bg-transparent text-[15px] leading-[1.45] text-text-primary placeholder:text-text-tertiary outline-none resize-none max-h-28 py-1"
          />
          <button
            type="button"
            onClick={handleSend}
            disabled={!input.trim() || streaming || initializing}
            aria-label={t("chats.send")}
            className="size-8 rounded-control flex items-center justify-center shrink-0 transition-colors cursor-pointer bg-accent hover:bg-accent-hover text-text-on-accent disabled:bg-transparent disabled:text-text-tertiary disabled:cursor-default"
          >
            {streaming ? <Loader2 size={14} className="animate-spin" /> : <ArrowUp size={16} />}
          </button>
        </div>

        {modelFooter && (
          <div className="flex items-center gap-1.5 text-text-tertiary px-0.5">
            <Cpu size={12} className="shrink-0" />
            <span className="font-mono text-[11px] truncate">{modelFooter}</span>
          </div>
        )}
      </div>
    </div>
  );
}
