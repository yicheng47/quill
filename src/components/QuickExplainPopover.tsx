import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { X, Loader2, Sparkles } from "lucide-react";
import Markdown from "react-markdown";

interface QuickExplainPopoverProps {
  x: number;
  y: number;
  word: string;
  sentence: string;
  bookTitle?: string;
  chapter?: string;
  onClose: () => void;
}

export default function QuickExplainPopover({
  x,
  y,
  word,
  sentence,
  bookTitle,
  chapter,
  onClose,
}: QuickExplainPopoverProps) {
  const contentRef = useRef("");
  const [content, setContent] = useState("");
  const [streaming, setStreaming] = useState(true);
  const popoverRef = useRef<HTMLDivElement>(null);
  const unlistenRef = useRef<UnlistenFn | null>(null);

  // Position clamping — run once on mount
  const [pos, setPos] = useState({ left: x, top: y });

  useEffect(() => {
    if (!popoverRef.current) return;
    const rect = popoverRef.current.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left = x;
    let top = y;
    if (left + rect.width > vw - 16) left = vw - rect.width - 16;
    if (left < 16) left = 16;
    if (top + rect.height > vh - 16) top = y - rect.height - 8;
    if (top < 16) top = 16;
    setPos({ left, top });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Stream AI response
  useEffect(() => {
    let cancelled = false;

    const run = async () => {
      unlistenRef.current = await listen<{ delta: string; done: boolean }>(
        "ai-quick-explain-chunk",
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
        await invoke("ai_quick_explain", {
          word,
          sentence,
          bookTitle: bookTitle || null,
          chapter: chapter || null,
        });
      } catch (err) {
        if (!cancelled) {
          setContent(`Error: ${err}`);
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
  }, [word, sentence]);

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
    let id: number;
    const handler = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    id = requestAnimationFrame(() => {
      document.addEventListener("mousedown", handler);
    });
    return () => {
      cancelAnimationFrame(id);
      document.removeEventListener("mousedown", handler);
    };
  }, [onClose]);

  return (
    <div
      ref={popoverRef}
      className="fixed z-50 w-[320px] bg-white/95 border border-border/80 rounded-xl backdrop-blur-sm shadow-context"
      style={{ left: pos.left, top: pos.top }}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-3 pt-2.5 pb-1.5">
        <div className="flex items-center gap-1.5">
          <Sparkles size={14} className="text-text-muted" />
          <span className="text-[12px] font-semibold text-text-muted uppercase tracking-wide">
            Quick Explain
          </span>
        </div>
        <button
          onClick={onClose}
          className="size-5 flex items-center justify-center rounded hover:bg-bg-input cursor-pointer"
        >
          <X size={12} className="text-text-muted" />
        </button>
      </div>

      {/* Content */}
      <div className="px-3 pb-3 max-h-[240px] overflow-auto">
        {streaming && !content ? (
          <div className="flex items-center gap-1.5 py-2">
            <Loader2 size={14} className="animate-spin text-text-muted" />
            <span className="text-[13px] text-text-muted">Thinking...</span>
          </div>
        ) : (
          <div className="prose prose-sm max-w-none text-[13px] text-text-primary leading-[1.5] [&_p]:my-1 [&_strong]:font-semibold [&_em]:italic">
            <Markdown>{content || "No explanation available."}</Markdown>
            {streaming && (
              <Loader2 size={12} className="inline-block ml-0.5 animate-spin text-text-muted" />
            )}
          </div>
        )}
      </div>
    </div>
  );
}
