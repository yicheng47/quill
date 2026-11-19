import { useTranslation } from "react-i18next";
import { AlertCircle, Loader2 } from "lucide-react";
import { focusWindow, invoke } from "../platform";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ChatMessage } from "../hooks/useAiChat";
import AiAuthPromptCard from "./AiAuthPromptCard";
import { parseAiErrorMessage } from "../utils/aiStream";

interface MessageBubbleProps {
  msg: ChatMessage;
  messages: ChatMessage[];
  streaming: boolean;
  onNavigateToCfi?: (cfi: string) => void;
}

export default function MessageBubble({
  msg,
  messages,
  streaming,
  onNavigateToCfi,
}: MessageBubbleProps) {
  const { t } = useTranslation();
  const isLast = msg === messages[messages.length - 1];

  if (msg.role === "assistant") {
    if (msg.content === "AI_NOT_CONFIGURED" || msg.content === "AI_REAUTH_REQUIRED") {
      return (
        <AiAuthPromptCard
          variant={msg.content === "AI_REAUTH_REQUIRED" ? "reauth" : "notConfigured"}
          onOpenSettings={async () => {
            await invoke("open_settings_on_main", { section: "ai" });
            await focusWindow("main");
          }}
        />
      );
    }

    if (streaming && !msg.content && isLast) {
      return (
        <div className="flex items-center gap-2 text-[14px] text-text-tertiary">
          <Loader2 size={14} className="animate-spin text-accent" />
          <span>{t("ai.thinking")}</span>
        </div>
      );
    }

    const errorMessage = parseAiErrorMessage(msg.content);
    if (errorMessage) {
      return (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-[6px] bg-danger-tint/70 border border-danger/20 px-3.5 py-2.5 text-[14px] text-danger"
        >
          <AlertCircle size={15} className="shrink-0 mt-0.5" />
          <span>{errorMessage}</span>
        </div>
      );
    }

    return (
      <div className="markdown-body text-[16px] leading-[1.6] text-text-primary select-text">
        <Markdown remarkPlugins={[remarkGfm]}>{msg.content}</Markdown>
        {streaming && msg.content && isLast && (
          <Loader2 size={14} className="inline-block ml-1.5 animate-spin text-text-tertiary" />
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {msg.context && (
        <button
          type="button"
          onClick={() => msg.contextCfi && onNavigateToCfi?.(msg.contextCfi)}
          disabled={!msg.contextCfi || !onNavigateToCfi}
          className={`border-l-2 border-accent/55 pl-3 py-0.5 text-left ${
            msg.contextCfi && onNavigateToCfi
              ? "cursor-pointer hover:opacity-80"
              : "cursor-default"
          }`}
        >
          <p className="font-reading italic text-[15px] leading-[1.55] text-text-secondary select-text">
            “{msg.context}”
          </p>
        </button>
      )}
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-[16px] bg-accent-tint px-3.5 py-2.5 text-[16px] leading-[1.5] text-accent-on-tint whitespace-pre-wrap select-text">
          {msg.content}
        </div>
      </div>
    </div>
  );
}
