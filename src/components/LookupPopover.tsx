import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { X, Loader2, Sparkles, BookmarkPlus, Check, Copy, Settings } from "lucide-react";
import { useTranslation } from "react-i18next";
import Markdown from "react-markdown";

// Shared prose classes for lookup markdown rendering — tight spacing for the
// 13px popover body so bullets/paragraphs don't blow out the card height.
const LOOKUP_PROSE =
  "prose prose-sm max-w-none leading-[1.55] [&_p]:my-0 [&_p+p]:mt-1.5 [&_ul]:my-1 [&_ol]:my-1 [&_li]:my-0 [&_strong]:font-semibold [&_em]:italic [&_code]:bg-bg-muted [&_code]:px-1 [&_code]:py-0.5 [&_code]:rounded [&_code]:text-[12px]";

interface LookupPopoverProps {
  x: number;
  y: number;
  word: string;
  sentence: string;
  bookTitle?: string;
  chapter?: string;
  bookId: string;
  cfi?: string;
  onClose: () => void;
}

function useStreamingLookup(
  word: string,
  sentence: string,
  bookTitle: string | undefined,
  chapter: string | undefined,
  kind: "definition" | "context"
) {
  const contentRef = useRef("");
  const [content, setContent] = useState("");
  const [streaming, setStreaming] = useState(true);
  const [notConfigured, setNotConfigured] = useState(false);
  const unlistenRef = useRef<UnlistenFn | null>(null);

  useEffect(() => {
    let cancelled = false;
    contentRef.current = "";

    const run = async () => {
      const requestId = crypto.randomUUID();

      unlistenRef.current = await listen<{ delta: string; done: boolean }>(
        `ai-lookup-chunk-${requestId}`,
        (event) => {
          if (cancelled) return;
          if (event.payload.done) {
            setStreaming(false);
            unlistenRef.current?.();
            unlistenRef.current = null;
            return;
          }
          contentRef.current += event.payload.delta;
          setContent(contentRef.current);
        }
      );

      try {
        await invoke("ai_lookup", {
          word,
          sentence,
          bookTitle: bookTitle || null,
          chapter: chapter || null,
          requestId,
          kind,
        });
      } catch (err) {
        if (!cancelled) {
          const msg = String(err);
          if (msg.includes("AI_NOT_CONFIGURED")) {
            setNotConfigured(true);
          } else {
            setContent(`Error: ${msg}`);
          }
          setStreaming(false);
        }
      }
    };

    run();

    return () => {
      cancelled = true;
      unlistenRef.current?.();
      unlistenRef.current = null;
    };
  }, [word, sentence, bookTitle, chapter, kind]);

  return { content, contentRef, streaming, notConfigured };
}

export default function LookupPopover({
  x,
  y,
  word,
  sentence,
  bookTitle,
  chapter,
  bookId,
  cfi,
  onClose,
}: LookupPopoverProps) {
  const { t } = useTranslation();
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);
  const [showTranslation, setShowTranslation] = useState(false);
  const popoverRef = useRef<HTMLDivElement>(null);

  // Check if translation is enabled
  useEffect(() => {
    invoke<Record<string, string>>("get_all_settings").then((s) => {
      const isEn = (s.language ?? "en") === "en";
      setShowTranslation(isEn && s.show_translation === "true" && (s.native_language ?? "en") !== "en");
    }).catch(() => {});
  }, []);

  // Two concurrent AI streams
  const definition = useStreamingLookup(word, sentence, bookTitle, chapter, "definition");
  const context = useStreamingLookup(word, sentence, bookTitle, chapter, "context");

  // Split translation from definition when translation is enabled
  const translationLine = showTranslation && definition.content.includes("\n")
    ? definition.content.split("\n")[0].trim()
    : null;
  const definitionText = translationLine
    ? definition.content.slice(definition.content.indexOf("\n") + 1).trim()
    : definition.content;

  const aiNotConfigured = definition.notConfigured || context.notConfigured;
  const allDone = !definition.streaming && !context.streaming;
  const hasContent = definition.content || context.content;

  // Position clamping — re-run whenever the popover resizes (e.g. as content streams in)
  const [pos, setPos] = useState({ left: x, top: y });

  useEffect(() => {
    const el = popoverRef.current;
    if (!el) return;
    const clamp = () => {
      const rect = el.getBoundingClientRect();
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      let left = x;
      let top = y;
      if (left + rect.width > vw - 16) left = vw - rect.width - 16;
      if (left < 16) left = 16;
      if (top + rect.height > vh - 16) top = y - rect.height - 8;
      if (top < 16) top = 16;
      setPos({ left, top });
    };
    const observer = new ResizeObserver(clamp);
    observer.observe(el);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Check if word is already saved
  useEffect(() => {
    invoke<string | null>("check_vocab_exists", { bookId, word }).then((id) => {
      if (id) setSaved(true);
    }).catch(() => {});
  }, [bookId, word]);

  const handleSave = async () => {
    try {
      const fullDefinition = [definition.contentRef.current, context.contentRef.current]
        .filter(Boolean)
        .join("\n\n");
      await invoke("add_vocab_word", {
        bookId,
        word,
        definition: fullDefinition,
        contextSentence: sentence || null,
        cfi: cfi || null,
      });
      setSaved(true);
    } catch (err) {
      console.error("Failed to save vocab word:", err);
    }
  };

  const handleCopy = () => {
    const fullText = [definition.contentRef.current, context.contentRef.current]
      .filter(Boolean)
      .join("\n\n");
    navigator.clipboard.writeText(fullText);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  // Dismiss on Escape
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  // Dismiss on click outside — delay registration to avoid catching the
  // context-menu click that opened us
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const id = requestAnimationFrame(() => {
      document.addEventListener("mousedown", handler);
    });
    return () => {
      cancelAnimationFrame(id);
      document.removeEventListener("mousedown", handler);
    };
  }, [onClose]);

  return (
    <>
    <div className="fixed inset-0 z-40" onClick={onClose} />
    <div
      ref={popoverRef}
      className="fixed z-50 w-[440px] bg-bg-surface border border-border/80 rounded-xl shadow-context"
      style={{ left: pos.left, top: pos.top }}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-4 pt-3 pb-2.5 bg-accent-bg rounded-t-xl border-b border-border/40">
        <div className="flex items-center gap-2">
          <Sparkles size={16} className="text-accent-text" />
          <span className="text-[14px] font-medium text-accent-text tracking-[-0.15px]">
            {t("lookup.title")}
          </span>
        </div>
        <button
          onClick={onClose}
          className="size-6 flex items-center justify-center rounded hover:bg-bg-surface/60 cursor-pointer"
        >
          <X size={14} className="text-text-muted" />
        </button>
      </div>

      {/* Content */}
      <div className="px-4 pb-2 max-h-[360px] overflow-auto">
        {/* Word heading */}
        <div className="flex items-center gap-2 pt-3 pb-2">
          <h3 className="text-[20px] font-bold text-text-primary leading-6">{word}</h3>
        </div>

        {aiNotConfigured ? (
          <div className="flex flex-col items-center gap-2 py-4 text-center">
            <p className="text-[13px] text-text-muted">{t("ai.notConfigured")}</p>
            <button
              onClick={async () => {
                onClose();
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
        ) : null}

        {/* Definition section */}
        {!aiNotConfigured && (definition.streaming && !definition.content ? (
          <div className="flex items-center gap-1.5 py-1">
            <Loader2 size={14} className="animate-spin text-text-muted" />
            <span className="text-[13px] text-text-muted">{t("lookup.lookingUp")}</span>
          </div>
        ) : (
          <>
            {translationLine && (
              <p className="text-[13px] text-accent-text mb-1.5">{translationLine}</p>
            )}
            <div className={`${LOOKUP_PROSE} text-[13px] text-text-primary`}>
              <Markdown>{definitionText}</Markdown>
              {definition.streaming && (
                <Loader2 size={12} className="inline-block ml-0.5 animate-spin text-text-muted" />
              )}
            </div>
          </>
        ))}

        {/* In this context — card */}
        {!aiNotConfigured && (context.content || context.streaming) && (
          <div className="mt-3 mb-1 p-3 rounded-lg bg-bg-muted border border-border/50">
            <span className="block text-[12px] font-medium text-text-muted mb-1">
              {t("lookup.inContext")}
            </span>
            {context.streaming && !context.content ? (
              <div className="flex items-center gap-1.5 py-0.5">
                <Loader2 size={12} className="animate-spin text-text-muted" />
                <span className="text-[12px] text-text-muted">{t("lookup.analyzing")}</span>
              </div>
            ) : (
              <div className={`${LOOKUP_PROSE} text-[13px] text-text-secondary`}>
                <Markdown>{context.content}</Markdown>
                {context.streaming && (
                  <Loader2 size={12} className="inline-block ml-0.5 animate-spin text-text-muted" />
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Footer — Save & Copy */}
      {allDone && hasContent && (
        <div className="flex items-center justify-between px-4 py-2.5 border-t border-border/40">
          <button
            onClick={handleSave}
            disabled={saved}
            className="flex items-center gap-1.5 text-[13px] font-medium cursor-pointer text-accent-text hover:opacity-70 disabled:opacity-50 disabled:cursor-default"
          >
            {saved ? <Check size={14} /> : <BookmarkPlus size={14} />}
            {saved ? t("lookup.saved") : t("lookup.saveToDict")}
          </button>
          <button
            onClick={handleCopy}
            className="flex items-center gap-1.5 text-[13px] font-medium cursor-pointer text-text-muted hover:opacity-70"
          >
            {copied ? <Check size={14} /> : <Copy size={14} />}
            {copied ? t("lookup.copied") : t("lookup.copy")}
          </button>
        </div>
      )}
    </div>
    </>
  );
}
