import { useTranslation } from "react-i18next";
import { Loader2, Settings } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ChatMessage } from "../hooks/useAiChat";

interface MessageBubbleProps {
  msg: ChatMessage;
  messages: ChatMessage[];
  streaming: boolean;
  onNavigateToCfi?: (cfi: string) => void;
}

export default function MessageBubble({ msg, messages, streaming, onNavigateToCfi }: MessageBubbleProps) {
  const { t } = useTranslation();
  const isLast = msg === messages[messages.length - 1];

  if (msg.role === "assistant") {
    if (msg.content === "AI_NOT_CONFIGURED") {
      return (
        <div className="bg-bg-surface border border-border rounded-lg px-[13px] py-[13px] max-w-[85%]">
          <p className="text-[14px] text-text-muted mb-2">{t("ai.notConfigured")}</p>
          <button
            onClick={async () => {
              await invoke("open_settings_on_main", { section: "ai" });
              const main = await WebviewWindow.getByLabel("main");
              await main?.setFocus();
            }}
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
          <div className="markdown-body text-[14px] text-text-primary leading-5 tracking-[-0.15px]">
            <Markdown remarkPlugins={[remarkGfm]}>{msg.content}</Markdown>
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
              msg.contextCfi && onNavigateToCfi ? "cursor-pointer hover:opacity-70" : "cursor-default"
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
