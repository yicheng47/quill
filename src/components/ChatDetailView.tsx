import { useState, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { ArrowLeft, ArrowRight, Send, Loader2, Trash2, Sparkles } from "lucide-react";
import { useAiChat } from "../hooks/useAiChat";
import { openReaderWindow } from "../utils/openReaderWindow";
import type { ChatSummary } from "../hooks/useChats";
import Button from "./ui/Button";
import MessageBubble from "./MessageBubble";

interface ChatDetailViewProps {
  chat: ChatSummary;
  onBack: () => void;
  onChatDeleted: (id: string) => void;
}

export default function ChatDetailView({ chat, onBack, onChatDeleted }: ChatDetailViewProps) {
  const { t } = useTranslation();
  const {
    messages, streaming, send, initialize,
    chatId, chats, titling, loadChat, deleteChat, renameChat,
  } = useAiChat(chat.book_id, { title: chat.book_title ?? undefined });

  const [input, setInput] = useState("");
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const titleInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { initialize(); }, [initialize]);

  useEffect(() => {
    if (chat.id && chats.length > 0) loadChat(chat.id);
  }, [chat.id, chats.length, loadChat]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

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

  const handleDelete = () => {
    deleteChat(chat.id);
    onChatDeleted(chat.id);
  };

  const currentTitle = chats.find((c) => c.id === chatId)?.title || chat.title;

  return (
    <div className="flex-1 flex flex-col min-w-0 bg-bg-muted">
      {/* Header */}
      <div className="flex items-center justify-between px-6 pt-11 pb-3 bg-bg-surface border-b border-border shrink-0">
        <div className="flex items-center gap-3 min-w-0">
          <button
            onClick={onBack}
            className="size-7 rounded-lg flex items-center justify-center hover:bg-bg-input cursor-pointer shrink-0"
          >
            <ArrowLeft size={18} className="text-text-muted" />
          </button>
          <div className="flex flex-col gap-px min-w-0">
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
                className="text-[15px] font-semibold text-text-primary bg-transparent outline-none border-b border-accent min-w-0"
              />
            ) : (
              <span
                className="text-[15px] font-semibold text-text-primary tracking-[-0.23px] truncate cursor-default"
                onDoubleClick={() => {
                  setTitleDraft(currentTitle);
                  setEditingTitle(true);
                }}
              >
                {titling ? (
                  <span className="flex items-center gap-1.5 text-text-muted">
                    <Loader2 size={14} className="animate-spin" />
                    {t("ai.generatingTitle")}
                  </span>
                ) : (
                  currentTitle
                )}
              </span>
            )}
            <span className="text-[12px] text-text-muted">
              {chat.book_title || t("common.unknownBook")}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-2.5 shrink-0">
          <button
            onClick={() => openReaderWindow(chat.book_id, { openChat: true, chatId: chat.id })}
            className="flex items-center gap-1 h-7 px-3 rounded-[10px] bg-accent-bg text-[12px] font-medium text-accent-text tracking-[0.06px] cursor-pointer hover:opacity-70"
          >
            {t("chats.openInReader")}
            <ArrowRight size={12} />
          </button>
          <button
            onClick={() => setDeleteConfirm(true)}
            className="size-7 rounded-lg flex items-center justify-center hover:bg-bg-input cursor-pointer"
          >
            <Trash2 size={16} className="text-text-muted" />
          </button>
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-auto px-6 py-4">
        {messages.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full gap-3">
            <div className="size-14 rounded-full bg-bg-input flex items-center justify-center">
              <Sparkles size={28} className="text-text-muted" />
            </div>
            <h3 className="text-[16px] font-semibold text-text-primary tracking-[-0.31px]">
              {t("chats.detailEmpty")}
            </h3>
            <p className="text-[13px] text-text-muted text-center tracking-[-0.08px] max-w-[260px]">
              {t("chats.detailEmptySub")}
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {messages.map((msg) => (
              <MessageBubble key={msg.id} msg={msg} messages={messages} streaming={streaming} />
            ))}
            <div ref={messagesEndRef} />
          </div>
        )}
      </div>

      {/* Input bar */}
      <div className="border-t border-border px-6 pt-[17px] pb-4 flex flex-col gap-2">
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

      {/* Delete confirmation */}
      {deleteConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-overlay">
          <div className="bg-bg-surface rounded-xl shadow-lg w-[400px] p-6">
            <h3 className="text-[18px] font-semibold text-text-primary mb-2">
              {t("chats.deleteTitle")}
            </h3>
            <p className="text-[14px] text-text-secondary leading-5 mb-6">
              {t("chats.deleteMsg", { title: currentTitle })}
            </p>
            <div className="flex justify-end gap-3">
              <Button variant="ghost" size="md" onClick={() => setDeleteConfirm(false)}>
                {t("common.cancel")}
              </Button>
              <button
                onClick={handleDelete}
                className="h-9 px-4 rounded-lg bg-red-500 text-white text-[14px] font-medium cursor-pointer hover:bg-red-600 transition-colors"
              >
                {t("common.delete")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
