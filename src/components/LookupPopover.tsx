import { useState, useEffect, useRef } from "react";
import { focusWindow, invoke, listen, type UnlistenFn } from "../platform";
import { AlertCircle, Loader2, Sparkles, BookmarkPlus, Check, Copy, Settings } from "lucide-react";
import { useTranslation } from "react-i18next";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import AiAuthPromptCard from "./AiAuthPromptCard";
import ReaderPopover from "./ReaderPopover";
import Button from "./ui/Button";
import { LOOKUP_PROSE } from "./lookup-prose";
import { parseAiErrorMessage } from "../utils/aiStream";
import { parseDefinition } from "../utils/vocabParse";

const TRANSLATION_MARKER = "[[QUILL_TRANSLATION]]";

interface LookupPopoverProps {
  x: number;
  y: number;
  word: string;
  sentence: string;
  bookTitle?: string;
  chapter?: string;
  bookId: string;
  cfi?: string;
  onSaved?: () => void;
  onClose: () => void;
}

function useStreamingLookup(
  word: string,
  sentence: string,
  bookTitle: string | undefined,
  chapter: string | undefined,
  kind: "definition" | "context",
) {
  const contentRef = useRef("");
  const [content, setContent] = useState("");
  const [streaming, setStreaming] = useState(true);
  const [notConfigured, setNotConfigured] = useState(false);
  const [reauthRequired, setReauthRequired] = useState(false);
  const [translationLanguageNotConfigured, setTranslationLanguageNotConfigured] = useState(false);
  const unlistenRef = useRef<UnlistenFn | null>(null);

  useEffect(() => {
    let cancelled = false;
    contentRef.current = "";
    setContent("");
    setStreaming(true);
    setNotConfigured(false);
    setReauthRequired(false);
    setTranslationLanguageNotConfigured(false);

    const run = async () => {
      const requestId = crypto.randomUUID();

      unlistenRef.current = await listen<{ delta: string; done: boolean }>(
        `ai-lookup-chunk-${requestId}`,
        (event) => {
          if (cancelled) return;
          if (event.payload.done) {
            const finalContent = contentRef.current.trim();
            if (finalContent === "AI_REAUTH_REQUIRED") {
              setReauthRequired(true);
              contentRef.current = "";
              setContent("");
            } else if (finalContent === "AI_NOT_CONFIGURED") {
              setNotConfigured(true);
              contentRef.current = "";
              setContent("");
            }
            setStreaming(false);
            unlistenRef.current?.();
            unlistenRef.current = null;
            return;
          }
          contentRef.current += event.payload.delta;
          if (
            contentRef.current !== "AI_REAUTH_REQUIRED" &&
            contentRef.current !== "AI_NOT_CONFIGURED"
          ) {
            setContent(contentRef.current);
          }
        },
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
          } else if (msg.includes("AI_REAUTH_REQUIRED")) {
            setReauthRequired(true);
          } else if (msg.includes("LOOKUP_TRANSLATION_LANGUAGE_NOT_CONFIGURED")) {
            setTranslationLanguageNotConfigured(true);
          } else {
            contentRef.current = `Error: ${msg}`;
            setContent(contentRef.current);
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

  return { content, contentRef, streaming, notConfigured, reauthRequired, translationLanguageNotConfigured };
}

function splitDefinitionContent(content: string, streaming: boolean): {
  translationLine: string | null;
  definitionText: string;
} {
  if (content.startsWith(TRANSLATION_MARKER)) {
    const newline = content.indexOf("\n");
    if (newline === -1) {
      return {
        translationLine: null,
        definitionText: streaming ? "" : content.slice(TRANSLATION_MARKER.length).trimStart(),
      };
    }
    const translationLine = content.slice(TRANSLATION_MARKER.length, newline).trim();
    return {
      translationLine: translationLine || null,
      definitionText: content.slice(newline + 1).trimStart(),
    };
  }

  if (TRANSLATION_MARKER.startsWith(content)) {
    return { translationLine: null, definitionText: "" };
  }

  return { translationLine: null, definitionText: content };
}

function displayedDefinitionContent(content: string): string {
  const split = splitDefinitionContent(content, false);
  return [split.translationLine, split.definitionText].filter(Boolean).join("\n");
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
  onSaved,
  onClose,
}: LookupPopoverProps) {
  const { t } = useTranslation();
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);

  const definition = useStreamingLookup(word, sentence, bookTitle, chapter, "definition");
  const context = useStreamingLookup(word, sentence, bookTitle, chapter, "context");

  const { translationLine, definitionText } = splitDefinitionContent(
    definition.content,
    definition.streaming,
  );

  const definitionError = parseAiErrorMessage(definitionText);
  const contextError = parseAiErrorMessage(context.content);
  const parsedEntry = definitionError ? null : parseDefinition(definitionText);

  const reauthRequired = definition.reauthRequired || context.reauthRequired;
  const aiNotConfigured = !reauthRequired && (definition.notConfigured || context.notConfigured);
  const translationLanguageNotConfigured =
    definition.translationLanguageNotConfigured || context.translationLanguageNotConfigured;
  const hasConfigurationError =
    reauthRequired || aiNotConfigured || translationLanguageNotConfigured;
  const allDone = !definition.streaming && !context.streaming;
  const hasContent = Boolean(definition.content || context.content);
  const hasSavableContent = Boolean(!definitionError && (definitionText.trim() || translationLine));
  const showFooter = allDone && hasContent && !hasConfigurationError && hasSavableContent;

  useEffect(() => {
    invoke<string | null>("check_vocab_exists", { bookId, word })
      .then((id) => {
        if (id) setSaved(true);
      })
      .catch(() => {});
  }, [bookId, word]);

  const handleSave = async () => {
    try {
      await invoke("add_vocab_word", {
        bookId,
        word,
        definition: displayedDefinitionContent(definition.contentRef.current ?? ""),
        contextSentence: sentence || null,
        contextExplanation: contextError ? null : context.contentRef.current || null,
        cfi: cfi || null,
      });
      setSaved(true);
      onSaved?.();
    } catch (err) {
      console.error("Failed to save vocab word:", err);
    }
  };

  const handleCopy = () => {
    const fullText = [
      displayedDefinitionContent(definition.contentRef.current),
      contextError ? "" : context.contentRef.current,
    ]
      .filter(Boolean)
      .join("\n\n");
    navigator.clipboard.writeText(fullText);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <ReaderPopover
      x={x}
      y={y}
      widthClass="w-[420px]"
      title={t("lookup.title")}
      icon={<Sparkles size={15} />}
      onClose={onClose}
      footer={
        showFooter ? (
          <>
            <button
              type="button"
              onClick={handleSave}
              disabled={saved}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-control bg-accent-tint hover:bg-accent-tint-hover text-accent-on-tint text-[12.5px] font-semibold cursor-pointer transition-colors disabled:opacity-70 disabled:cursor-default"
            >
              {saved ? <Check size={13} /> : <BookmarkPlus size={13} />}
              <span>{saved ? t("lookup.saved") : t("lookup.saveToDict")}</span>
            </button>
            <button
              type="button"
              onClick={handleCopy}
              className="inline-flex items-center gap-[5px] px-2 py-1 rounded-control text-[12.5px] font-medium text-text-secondary hover:text-text-primary hover:bg-border-subtle cursor-pointer transition-colors"
            >
              {copied ? <Check size={13} /> : <Copy size={13} />}
              <span>{copied ? t("lookup.copied") : t("lookup.copy")}</span>
            </button>
          </>
        ) : undefined
      }
    >
      <div className="p-[18px] flex flex-col gap-2.5 max-h-[360px] overflow-y-auto">
        <div className="flex flex-wrap items-baseline gap-2">
          <h3 className="font-reading text-[24px] font-semibold leading-tight text-text-primary">
            {word}
          </h3>
          {parsedEntry?.partOfSpeech && (
            <span className="px-2 py-0.5 rounded-full bg-accent-tint text-accent-on-tint text-[11.5px] font-semibold leading-none">
              {parsedEntry.partOfSpeech}
            </span>
          )}
          {parsedEntry?.pronunciation && (
            <span className="font-mono text-[12px] text-text-tertiary">
              {parsedEntry.pronunciation}
            </span>
          )}
        </div>

        {reauthRequired || aiNotConfigured ? (
          <AiAuthPromptCard
            variant={reauthRequired ? "reauth" : "notConfigured"}
            embedded
            onOpenSettings={async () => {
              onClose();
              await invoke("open_settings_on_main", { section: "ai" });
              await focusWindow("main");
            }}
          />
        ) : translationLanguageNotConfigured ? (
          <div className="flex flex-col items-center gap-3 py-4 text-center">
            <p className="text-[13px] text-text-secondary">
              {t("lookup.translationLanguageNotConfigured")}
            </p>
            <Button
              type="button"
              appearance="dawn"
              variant="tonal"
              size="sm"
              onClick={async () => {
                onClose();
                await invoke("open_settings_on_main", { section: "tools" });
                await focusWindow("main");
              }}
            >
              <Settings size={14} />
              <span>{t("lookup.openSettings")}</span>
            </Button>
          </div>
        ) : null}

        {!hasConfigurationError &&
          (definition.streaming && !definition.content ? (
            <div className="flex items-center gap-2 py-1 text-text-tertiary">
              <Loader2 size={14} className="animate-spin text-accent" />
              <span className="text-[13px]">{t("lookup.lookingUp")}</span>
            </div>
          ) : definitionError ? (
            <div
              role="alert"
              className="flex items-start gap-2 rounded-[10px] bg-danger-tint/70 border border-danger/20 px-3 py-2.5 text-[13px] text-danger"
            >
              <AlertCircle size={15} className="shrink-0 mt-0.5" />
              <span>{definitionError}</span>
            </div>
          ) : (
            <>
              {translationLine && (
                <p className="text-[13.5px] font-medium text-accent-on-tint leading-snug">
                  {translationLine}
                </p>
              )}
              {(parsedEntry?.definition || definition.streaming) && (
                <div className={`${LOOKUP_PROSE} text-[13.5px] leading-[1.5] text-text-primary`}>
                  <Markdown remarkPlugins={[remarkGfm]}>
                    {parsedEntry?.definition ?? definitionText}
                  </Markdown>
                  {definition.streaming && (
                    <Loader2 size={12} className="inline-block ml-1 animate-spin text-text-tertiary" />
                  )}
                </div>
              )}
            </>
          ))}

        {!hasConfigurationError && !definitionError && (context.content || context.streaming) && (
          <div className="mt-0.5 p-3 rounded-[10px] bg-surface-tint flex flex-col gap-1">
            <span className="text-[10.5px] font-semibold tracking-[0.8px] uppercase text-accent-on-tint">
              {t("lookup.inContext")}
            </span>
            {context.streaming && !context.content ? (
              <div className="flex items-center gap-1.5 py-0.5 text-text-tertiary">
                <Loader2 size={12} className="animate-spin text-accent" />
                <span className="text-[12px]">{t("lookup.analyzing")}</span>
              </div>
            ) : contextError ? (
              <p role="alert" className="text-[12.5px] text-danger">
                {contextError}
              </p>
            ) : (
              <div className={`${LOOKUP_PROSE} text-[12.5px] leading-[1.5] text-text-secondary`}>
                <Markdown remarkPlugins={[remarkGfm]}>{context.content}</Markdown>
                {context.streaming && (
                  <Loader2 size={12} className="inline-block ml-1 animate-spin text-text-tertiary" />
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </ReaderPopover>
  );
}
