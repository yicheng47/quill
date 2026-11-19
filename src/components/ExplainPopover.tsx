import { useState, useEffect, useRef } from "react";
import { focusWindow, invoke, listen, type UnlistenFn } from "../platform";
import { AlertCircle, Loader2, WandSparkles, Check, Copy, Quote } from "lucide-react";
import { useTranslation } from "react-i18next";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import AiAuthPromptCard from "./AiAuthPromptCard";
import ReaderPopover from "./ReaderPopover";
import { LOOKUP_PROSE } from "./lookup-prose";
import { isExactAiSentinel, matchAiSentinel, type AiSentinel } from "../lib/aiConnections";
import { parseAiErrorMessage } from "../utils/aiStream";

interface ExplainPopoverProps {
  x: number;
  y: number;
  text: string;
  sentence: string;
  bookTitle?: string;
  chapter?: string;
  bookId: string;
  cfi?: string;
  onQuote?: () => void;
  onClose: () => void;
}

function useExplainStream(
  passage: string,
  surrounding: string | undefined,
  bookTitle: string | undefined,
  chapter: string | undefined,
) {
  const contentRef = useRef("");
  const [content, setContent] = useState("");
  const [streaming, setStreaming] = useState(true);
  const [sentinel, setSentinel] = useState<AiSentinel | null>(null);

  useEffect(() => {
    let cancelled = false;
    let activeChannel: string | null = null;
    let unlisten: UnlistenFn | null = null;
    const disposeListener = () => {
      unlisten?.();
      unlisten = null;
    };
    contentRef.current = "";
    setContent("");
    setStreaming(true);
    setSentinel(null);

    const run = async () => {
      const requestId = crypto.randomUUID();
      const channel = `ai-lookup-chunk-${requestId}`;

      const stop = await listen<{ delta: string; done: boolean; error?: string | null }>(
        channel,
        (event) => {
          if (cancelled) return;
          if (event.payload.error) {
            activeChannel = null;
            const err = event.payload.error;
            const matched = matchAiSentinel(err);
            if (matched) {
              setSentinel(matched);
              contentRef.current = "";
              setContent("");
            } else {
              contentRef.current = err.startsWith("Error:") ? err : `Error: ${err}`;
              setContent(contentRef.current);
            }
            setStreaming(false);
            disposeListener();
            return;
          }
          if (event.payload.done) {
            activeChannel = null;
            const finalContent = contentRef.current.trim();
            if (isExactAiSentinel(finalContent)) {
              setSentinel(finalContent);
              contentRef.current = "";
              setContent("");
            }
            setStreaming(false);
            disposeListener();
            return;
          }
          contentRef.current += event.payload.delta;
          if (!isExactAiSentinel(contentRef.current)) {
            setContent(contentRef.current);
          }
        },
      );

      if (cancelled) {
        stop();
        return;
      }
      unlisten = stop;
      activeChannel = channel;

      try {
        await invoke("ai_explain", {
          passage,
          surrounding: surrounding || null,
          bookTitle: bookTitle || null,
          chapter: chapter || null,
          requestId,
        });
        if (cancelled && activeChannel) {
          const ch = activeChannel;
          activeChannel = null;
          void invoke("ai_cancel", { channel: ch }).catch(() => {});
        }
      } catch (err) {
        activeChannel = null;
        disposeListener();
        if (!cancelled) {
          const msg = String(err);
          const matched = matchAiSentinel(msg);
          if (matched) {
            setSentinel(matched);
          } else {
            contentRef.current = `Error: ${msg}`;
            setContent(contentRef.current);
          }
          setStreaming(false);
        }
      }
    };

    void run();

    return () => {
      cancelled = true;
      if (activeChannel) {
        const ch = activeChannel;
        activeChannel = null;
        void invoke("ai_cancel", { channel: ch }).catch(() => {});
      }
      disposeListener();
    };
  }, [passage, surrounding, bookTitle, chapter]);

  return { content, contentRef, streaming, sentinel };
}

export default function ExplainPopover({
  x,
  y,
  text,
  sentence,
  bookTitle,
  chapter,
  onQuote,
  onClose,
}: ExplainPopoverProps) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);

  const { content, contentRef, streaming, sentinel } = useExplainStream(
    text,
    sentence,
    bookTitle,
    chapter,
  );
  const errorMessage = parseAiErrorMessage(content);
  const hasAuthOrConfigError = Boolean(sentinel);
  const showFooter = !streaming && Boolean(content) && !hasAuthOrConfigError && !errorMessage;

  const handleCopy = () => {
    navigator.clipboard.writeText(contentRef.current);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <ReaderPopover
      x={x}
      y={y}
      widthClass="w-[440px]"
      title={t("explain.title")}
      icon={<WandSparkles size={15} />}
      onClose={onClose}
      footer={
        showFooter ? (
          <>
            {onQuote ? (
              <button
                type="button"
                onClick={onQuote}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-control bg-accent-tint hover:bg-accent-tint-hover text-accent-on-tint text-[12.5px] font-semibold cursor-pointer transition-colors"
              >
                <Quote size={13} />
                <span>{t("contextMenu.quote")}</span>
              </button>
            ) : (
              <span />
            )}
            <button
              type="button"
              onClick={handleCopy}
              className="inline-flex items-center gap-[5px] px-2 py-1 rounded-control text-[12.5px] font-medium text-text-secondary hover:text-text-primary hover:bg-border-subtle cursor-pointer transition-colors"
            >
              {copied ? <Check size={13} /> : <Copy size={13} />}
              <span>{copied ? t("explain.copied") : t("explain.copy")}</span>
            </button>
          </>
        ) : undefined
      }
    >
      <div className="p-[18px] flex flex-col gap-3 max-h-[360px] overflow-y-auto">
        <div className="border-l-2 border-accent/55 pl-3 py-0.5">
          <p className="font-reading italic text-[13px] leading-[1.5] text-text-secondary line-clamp-3">
            “{text}”
          </p>
        </div>

        {sentinel ? (
          <AiAuthPromptCard
            sentinel={sentinel}
            embedded
            onOpenSettings={async () => {
              onClose();
              await invoke("open_settings_on_main", { section: "ai" });
              await focusWindow("main");
            }}
          />
        ) : streaming && !content ? (
          <div className="flex items-center gap-2 py-1 text-text-tertiary">
            <Loader2 size={14} className="animate-spin text-accent-fg" />
            <span className="text-[13px]">{t("explain.thinking")}</span>
          </div>
        ) : errorMessage ? (
          <div
            role="alert"
            className="flex items-start gap-2 rounded-[6px] bg-danger-tint/70 border border-danger/20 px-3 py-2.5 text-[13px] text-danger"
          >
            <AlertCircle size={15} className="shrink-0 mt-0.5" />
            <span>{errorMessage}</span>
          </div>
        ) : (
          <div className={`${LOOKUP_PROSE} text-[13.5px] leading-[1.55] text-text-primary`}>
            <Markdown remarkPlugins={[remarkGfm]}>{content}</Markdown>
            {streaming && (
              <Loader2 size={12} className="inline-block ml-1 animate-spin text-text-tertiary" />
            )}
          </div>
        )}
      </div>
    </ReaderPopover>
  );
}
