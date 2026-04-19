import { useState, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Sparkles, Send, Loader2, Plus, ChevronDown, ChevronUp, Trash2 } from "lucide-react";
import { useAiChat } from "../hooks/useAiChat";
import { timeAgo } from "../utils/timeAgo";
import MessageBubble from "./MessageBubble";

interface AiPanelProps {
  bookId?: string;
  bookTitle?: string;
  bookAuthor?: string;
  currentChapter?: string;
  context?: { text: string; cfi?: string };
  initialChatId?: string;
  onContextConsumed?: () => void;
  onNavigateToCfi?: (cfi: string) => void;
}

export default function AiPanel({ bookId, bookTitle, bookAuthor, currentChapter, context, initialChatId, onContextConsumed, onNavigateToCfi }: AiPanelProps) {
  const { t } = useTranslation();

  const SUGGESTED_PROMPTS = [
    t("ai.prompt.summarize"),
    t("ai.prompt.themes"),
    t("ai.prompt.characters"),
  ];
  const {
    messages, streaming, send, initialize,
    chatId, chats, titling, loadChat, deleteChat, renameChat, reset,
  } = useAiChat(bookId, { title: bookTitle, author: bookAuthor, chapter: currentChapter });

  const [input, setInput] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const [newChatFlash, setNewChatFlash] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const titleInputRef = useRef<HTMLInputElement>(null);

  const currentChat = chats.find((c) => c.id === chatId);

  // Initialize on mount / bookId change.
  // Skip when an incoming context is pending — the context effect below will
  // create a new chat for it, and we don't want a racing initialize() to load
  // a stale chat and cancel the stream.
  useEffect(() => {
    if (context) return;
    initialize();
  }, [initialize, context]);

  // Load specific chat when navigating from ChatsPage
  useEffect(() => {
    if (initialChatId && chats.length > 0) {
      loadChat(initialChatId);
    }
  }, [initialChatId, chats.length, loadChat]);

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Handle context from "Ask AI" context menu — always start a new chat.
  // reset() clears chatId so send()'s lazy-create path fires; that path is
  // also what marks the message as belonging to a new chat (drives title gen).
  useEffect(() => {
    if (!context || streaming || !bookId) return;
    (async () => {
      await reset();
      send(t("ai.explain"), context.text, context.cfi);
    })();
    onContextConsumed?.();
  }, [context, bookId, onContextConsumed, reset, send, streaming, t]);

  // Focus title input when editing
  useEffect(() => {
    if (editingTitle) {
      titleInputRef.current?.focus();
      titleInputRef.current?.select();
    }
  }, [editingTitle]);

  const handleSend = () => {
    if (!input.trim() || streaming) return;
    send(input.trim());
    setInput("");
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
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
      reset(); // Clears state; DB record created lazily on first send
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

  return (
    <div className="flex flex-col h-full bg-bg-muted">
      {/* Header */}
      <div className="flex items-center justify-between px-4 h-[63px] border-b border-border shrink-0 relative">
        <div className="flex items-center gap-2.5 min-w-0">
          <Sparkles size={20} className="text-text-muted shrink-0" />
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
              className="text-[15px] font-semibold text-text-primary bg-transparent outline-none border-b border-accent w-full min-w-0"
            />
          ) : (
            <button
              onClick={() => setPickerOpen(!pickerOpen)}
              onDoubleClick={() => {
                setTitleDraft(currentChat?.title || t("ai.newChat"));
                setEditingTitle(true);
              }}
              className="flex items-center gap-1.5 min-w-0 cursor-pointer"
            >
              {titling ? (
                <span className="flex items-center gap-1.5 text-[15px] font-semibold text-text-muted tracking-[-0.23px]">
                  <Loader2 size={14} className="animate-spin" />
                  {t("ai.generatingTitle")}
                </span>
              ) : (
                <span className="text-[15px] font-semibold text-text-primary tracking-[-0.23px] truncate">
                  {currentChat?.title || t("ai.newChat")}
                </span>
              )}
              {pickerOpen ? (
                <ChevronUp size={14} className="text-text-muted shrink-0" />
              ) : (
                <ChevronDown size={14} className="text-text-muted shrink-0" />
              )}
            </button>
          )}
        </div>
        <button
          onClick={handleNewChat}
          className="shrink-0 size-7 rounded-lg flex items-center justify-center hover:bg-bg-input cursor-pointer"
        >
          <Plus size={16} className="text-text-muted" />
        </button>

        {/* Chat picker dropdown */}
        {pickerOpen && (
          <div className="absolute top-[62px] left-3 right-3 bg-bg-surface border border-border rounded-[10px] shadow-popover z-50 overflow-hidden">
            <div className="max-h-[300px] overflow-auto pt-1">
              {chats.map((chat) => {
                const isActive = chat.id === chatId;
                return (
                  <div
                    key={chat.id}
                    className={`group flex items-center gap-2 w-full px-3 py-2.5 border-l-2 ${
                      isActive ? "border-accent bg-bg-input" : "border-transparent hover:bg-bg-input"
                    }`}
                  >
                    <button
                      onClick={() => handleSelectChat(chat.id)}
                      className="flex-1 flex flex-col gap-0.5 text-left cursor-pointer min-w-0"
                    >
                      <span className={`text-[13px] tracking-[-0.08px] truncate ${
                        isActive ? "font-semibold text-text-primary" : "font-normal text-text-primary"
                      }`}>
                        {chat.title}
                      </span>
                      <span className="text-[11px] font-medium text-text-muted tracking-[0.06px]">
                        {timeAgo(chat.updated_at)}
                      </span>
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        deleteChat(chat.id);
                        if (chats.length <= 1) setPickerOpen(false);
                      }}
                      className="opacity-0 group-hover:opacity-100 shrink-0 p-1 rounded hover:bg-bg-muted cursor-pointer transition-opacity"
                    >
                      <Trash2 size={13} className="text-text-muted" />
                    </button>
                  </div>
                );
              })}
              {chats.length === 0 && (
                <p className="px-3 py-3 text-[13px] text-text-muted">{t("ai.noChats")}</p>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-auto px-4 py-4" onClick={() => pickerOpen && setPickerOpen(false)}>
        {messages.length === 0 ? (
          /* Empty state */
          <div className={`flex flex-col items-center justify-center h-full gap-3 transition-opacity duration-300 ${newChatFlash ? "opacity-0" : "opacity-100"}`}>
            <div className="size-14 rounded-full bg-bg-input flex items-center justify-center">
              <Sparkles size={28} className="text-text-muted" />
            </div>
            <h3 className="text-[16px] font-semibold text-text-primary tracking-[-0.31px]">
              {t("ai.startChat")}
            </h3>
            <p className="text-[13px] text-text-muted text-center tracking-[-0.08px] max-w-[215px]">
              {t("ai.startChatSub")}
            </p>
            <div className="flex flex-wrap justify-center gap-2 mt-2">
              {SUGGESTED_PROMPTS.map((prompt) => (
                <button
                  key={prompt}
                  onClick={() => send(prompt)}
                  className="px-3 py-1.5 rounded-full text-[12px] font-medium text-accent-text bg-accent-bg border border-accent/30 hover:opacity-80 cursor-pointer transition-colors"
                >
                  {prompt}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {messages.map((msg) => (
              <MessageBubble key={msg.id} msg={msg} messages={messages} streaming={streaming} onNavigateToCfi={onNavigateToCfi} />
            ))}
            <div ref={messagesEndRef} />
          </div>
        )}
      </div>

      {/* Input */}
      <div className="border-t border-border px-4 pt-[17px] pb-4 flex flex-col gap-2">
        <div className="flex gap-2 items-start">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={t("ai.placeholder")}
            rows={2}
            className="flex-1 h-[60px] bg-bg-input rounded-lg px-3 py-2 text-[14px] text-text-primary placeholder:text-text-placeholder tracking-[-0.15px] leading-5 outline-none border border-transparent focus:border-accent resize-none"
          />
          <button
            onClick={handleSend}
            disabled={!input.trim() || streaming}
            className={`size-[60px] shrink-0 rounded-lg flex items-center justify-center cursor-pointer bg-accent text-white ${
              !input.trim() || streaming ? "opacity-50" : ""
            }`}
          >
            {streaming ? (
              <Loader2 size={16} className="animate-spin" />
            ) : (
              <Send size={16} />
            )}
          </button>
        </div>
        <p className="text-[12px] text-text-muted">
          {t("ai.sendHint")}
        </p>
      </div>
    </div>
  );
}
