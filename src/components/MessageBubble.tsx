import { useTranslation } from "react-i18next";
import { Loader2, Settings } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import Markdown from "react-markdown";
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
