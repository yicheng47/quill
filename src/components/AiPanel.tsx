import { useState, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Sparkles, Send, Loader2, Plus, ChevronDown, ChevronUp, Trash2, Settings } from "lucide-react";
import { emitTo } from "@tauri-apps/api/event";
import Markdown from "react-markdown";
import { useAiChat, type ChatMessage } from "../hooks/useAiChat";
import { timeAgo } from "../utils/timeAgo";

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

  // Initialize on mount / bookId change
  useEffect(() => {
    initialize();
  }, [initialize]);

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

  // Handle context from "Ask AI" context menu — auto-send
  useEffect(() => {
    if (context && !streaming) {
      send(t("ai.explain"), context.text, context.cfi);
      onContextConsumed?.();
    }
  }, [context, onContextConsumed, send, streaming]);

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

function MessageBubble({ msg, messages, streaming, onNavigateToCfi }: { msg: ChatMessage; messages: ChatMessage[]; streaming: boolean; onNavigateToCfi?: (cfi: string) => void }) {
  const { t } = useTranslation();
  const isLast = msg === messages[messages.length - 1];

  if (msg.role === "assistant") {
    if (msg.content === "AI_NOT_CONFIGURED") {
      return (
        <div className="bg-bg-surface border border-border rounded-lg px-[13px] py-[13px] max-w-[85%]">
          <p className="text-[14px] text-text-muted mb-2">{t("ai.notConfigured")}</p>
          <button
            onClick={() => emitTo("main", "open-settings", "ai")}
            className="flex items-center gap-1.5 text-[13px] font-medium text-accent-text hover:opacity-70 cursor-pointer"
          >
            <Settings size={14} />
            {t("ai.openSettings")}
          </button>
        </div>
      );
    }
    return (
      <div className="bg-bg-surface border border-border rounded-lg px-[13px] py-[13px] max-w-[85%]">
        {streaming && !msg.content && isLast ? (
          <span className="flex items-center gap-1.5 text-[14px] text-text-muted">
            <Loader2 size={14} className="animate-spin" />
            {t("ai.thinking")}
          </span>
        ) : (
          <div className="prose prose-sm max-w-none text-[14px] text-text-primary leading-5 tracking-[-0.15px] [&_h1]:text-[16px] [&_h2]:text-[15px] [&_h3]:text-[14px] [&_h1]:font-semibold [&_h2]:font-semibold [&_h3]:font-semibold [&_h1]:mt-3 [&_h1]:mb-1 [&_h2]:mt-3 [&_h2]:mb-1 [&_h3]:mt-2 [&_h3]:mb-1 [&_p]:my-1.5 [&_ul]:my-1 [&_ol]:my-1 [&_li]:my-0.5 [&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-3 [&_blockquote]:italic [&_blockquote]:text-text-muted [&_code]:bg-bg-muted [&_code]:px-1 [&_code]:py-0.5 [&_code]:rounded [&_code]:text-[13px] [&_pre]:bg-bg-muted [&_pre]:p-3 [&_pre]:rounded-lg [&_pre]:overflow-x-auto [&_strong]:font-semibold [&_em]:italic [&_hr]:border-border [&_a]:text-accent [&_a]:underline">
            <Markdown>{msg.content}</Markdown>
            {streaming && msg.content && isLast && (
              <Loader2 size={14} className="inline-block ml-1 animate-spin text-text-muted" />
            )}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="flex justify-end">
      <div className="max-w-[85%] flex flex-col gap-1.5">
        {msg.context && (
          <button
            onClick={() => msg.contextCfi && onNavigateToCfi?.(msg.contextCfi)}
            className={`border-l-2 border-[#c084fc] pl-3 pt-0.5 text-left ${
              msg.contextCfi ? "cursor-pointer hover:opacity-70" : "cursor-default"
            }`}
          >
            <p className="text-[12px] italic text-text-muted line-clamp-2">
              {msg.context}
            </p>
          </button>
        )}
        <div className="bg-[rgba(192,132,252,0.15)] rounded-lg px-[13px] py-[13px]">
          <p className="text-[14px] text-text-primary leading-5 tracking-[-0.15px]">
            {msg.content}
          </p>
        </div>
      </div>
    </div>
  );
}
