import { useState, useEffect, useRef, Fragment } from "react";
import { focusWindow, invoke, listen, type UnlistenFn } from "../platform";
import {
  AlertCircle,
  Loader2,
  Languages,
  Check,
  Copy,
  ChevronDown,
  ChevronUp,
  Settings,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import AiAuthPromptCard from "./AiAuthPromptCard";
import ReaderPopover from "./ReaderPopover";
import Button from "./ui/Button";
import { LANGUAGE_OPTIONS } from "./settings/languageOptions";
import { isExactAiSentinel, matchAiSentinel, type AiSentinel } from "../lib/aiConnections";
import { parseAiErrorMessage } from "../utils/aiStream";

interface TranslationPopoverProps {
  x: number;
  y: number;
  text: string;
  context?: string;
  contextOffset?: number;
  bookId: string;
  cfi?: string;
  onClose: () => void;
}

const LANG_NAMES: Record<string, string> = {
  en: "English",
  zh: "简体中文",
  ja: "日本語",
  ko: "한국어",
  es: "Español",
  fr: "Français",
  de: "Deutsch",
  pt: "Português",
  ru: "Русский",
  ar: "العربية",
  it: "Italiano",
};

function renderHighlightedContext(
  contextText: string,
  selectedText: string,
  contextOffset?: number,
) {
  const trimmed = selectedText.trim();
  if (!trimmed) return contextText;
  const idx =
    contextOffset !== undefined &&
    contextOffset >= 0 &&
    contextText.slice(contextOffset, contextOffset + trimmed.length) === trimmed
      ? contextOffset
      : contextText.indexOf(trimmed);
  if (idx === -1) return contextText;
  return (
    <Fragment>
      {contextText.slice(0, idx)}
      <mark className="px-0.5 rounded-[3px] bg-hl-violet text-text-primary">
        {contextText.slice(idx, idx + trimmed.length)}
      </mark>
      {contextText.slice(idx + trimmed.length)}
    </Fragment>
  );
}

function useStreamingTranslation(
  text: string,
  context: string | undefined,
  bookId: string,
  cfi: string | undefined,
  targetLanguageOverride: string | null,
) {
  const contentRef = useRef("");
  const [content, setContent] = useState("");
  const [streaming, setStreaming] = useState(true);
  const [sentinel, setSentinel] = useState<AiSentinel | null>(null);
  const [languageNotConfigured, setLanguageNotConfigured] = useState(false);
  const [targetLang, setTargetLang] = useState("");

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
    setLanguageNotConfigured(false);

    if (targetLanguageOverride) {
      setTargetLang(targetLanguageOverride);
    } else {
      setTargetLang("");
      invoke<Record<string, string>>("get_all_settings")
        .then((s) => {
          if (cancelled) return;
          const lang = s.translation_language || s.language || "en";
          setTargetLang(lang);
        })
        .catch(() => {});
    }

    const run = async () => {
      const requestId = crypto.randomUUID();
      const channel = `ai-translate-chunk-${requestId}`;

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
            } else if (err.includes("TRANSLATION_LANGUAGE_NOT_CONFIGURED")) {
              setLanguageNotConfigured(true);
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
        await invoke("ai_translate_passage", {
          text,
          context: context || null,
          bookId,
          targetLanguage: targetLanguageOverride,
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
          } else if (msg.includes("TRANSLATION_LANGUAGE_NOT_CONFIGURED")) {
            setLanguageNotConfigured(true);
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
  }, [text, context, bookId, cfi, targetLanguageOverride]);

  return {
    content,
    contentRef,
    streaming,
    sentinel,
    languageNotConfigured,
    targetLang,
  };
}

export default function TranslationPopover({
  x,
  y,
  text,
  context,
  contextOffset,
  bookId,
  cfi,
  onClose,
}: TranslationPopoverProps) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const [showContext, setShowContext] = useState(false);
  const [langMenuOpen, setLangMenuOpen] = useState(false);
  const [targetLangOverride, setTargetLangOverride] = useState<string | null>(null);
  const langMenuRef = useRef<HTMLDivElement>(null);

  const {
    content,
    contentRef,
    streaming,
    sentinel,
    languageNotConfigured,
    targetLang,
  } = useStreamingTranslation(text, context, bookId, cfi, targetLangOverride);

  useEffect(() => {
    setShowContext(false);
  }, [text, context]);

  useEffect(() => {
    if (!langMenuOpen) return;
    const handlePointerDown = (e: MouseEvent) => {
      if (langMenuRef.current && !langMenuRef.current.contains(e.target as Node)) {
        setLangMenuOpen(false);
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setLangMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown, true);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [langMenuOpen]);

  const errorMessage = parseAiErrorMessage(content);
  const allDone = !streaming;
  const hasContent = Boolean(content);
  const hasConfigurationError = Boolean(sentinel) || languageNotConfigured;
  const trimmedText = text.trim();
  const trimmedContext = context?.trim() ?? "";
  const hasSurroundingContext = Boolean(
    trimmedContext &&
      trimmedText &&
      trimmedContext !== trimmedText &&
      trimmedContext.includes(trimmedText),
  );
  const isLongSelection = trimmedText.length > 180 || trimmedText.includes("\n");
  const canToggleContext = hasSurroundingContext || isLongSelection;
  const showCopy = allDone && hasContent && !hasConfigurationError && !errorMessage;
  const showFooter = showCopy || (!hasConfigurationError && canToggleContext);

  const handleCopy = () => {
    navigator.clipboard.writeText(contentRef.current);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const langName = LANG_NAMES[targetLang] || targetLang;
  const languageChoices = LANGUAGE_OPTIONS.some((o) => o.value === targetLang) || !targetLang
    ? LANGUAGE_OPTIONS
    : [...LANGUAGE_OPTIONS, { value: targetLang, label: langName }];

  return (
    <ReaderPopover
      x={x}
      y={y}
      widthClass="w-[456px]"
      title={t("translation.title")}
      icon={<Languages size={15} />}
      suppressDismiss={langMenuOpen}
      onClose={onClose}
      headerExtra={
        langName ? (
          <div className="relative" ref={langMenuRef}>
            <button
              type="button"
              onClick={() => setLangMenuOpen((open) => !open)}
              aria-expanded={langMenuOpen}
              aria-haspopup="menu"
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-surface-solid border border-border-subtle text-[11.5px] font-medium text-text-secondary hover:text-text-primary cursor-pointer transition-colors"
            >
              <span>{langName}</span>
              <ChevronDown size={11} className="text-text-tertiary" />
            </button>
            {langMenuOpen && (
              <div
                role="menu"
                className="absolute left-0 top-[calc(100%+4px)] z-50 min-w-[132px] reader-popover rounded-surface p-1 flex flex-col gap-0.5"
              >
                {languageChoices.map((opt) => {
                  const active = opt.value === targetLang;
                  return (
                    <button
                      key={opt.value}
                      type="button"
                      role="menuitemradio"
                      aria-checked={active}
                      onClick={() => {
                        setLangMenuOpen(false);
                        if (opt.value !== targetLang) {
                          setTargetLangOverride(opt.value);
                        }
                      }}
                      className={`flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-[8px] text-[12.5px] text-left cursor-pointer transition-colors ${
                        active
                          ? "bg-surface-tint text-accent-on-tint font-semibold"
                          : "text-text-primary hover:bg-surface-tint hover:text-accent-on-tint"
                      }`}
                    >
                      <span>{opt.label}</span>
                      {active && <Check size={12} className="shrink-0" />}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        ) : undefined
      }
      footer={
        showFooter ? (
          <>
            {!hasConfigurationError && canToggleContext ? (
              <button
                type="button"
                onClick={() => setShowContext((prev) => !prev)}
                className="inline-flex items-center gap-1 px-1.5 py-1 rounded-control text-[12px] text-text-tertiary hover:text-text-primary hover:bg-border-subtle cursor-pointer transition-colors"
              >
                <span>
                  {hasSurroundingContext
                    ? showContext
                      ? t("translation.hideSurroundingContext")
                      : t("translation.showSurroundingContext")
                    : showContext
                      ? t("translation.showLessSelection")
                      : t("translation.showFullSelection")}
                </span>
                {showContext ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
              </button>
            ) : (
              <span />
            )}
            {showCopy && (
              <button
                type="button"
                onClick={handleCopy}
                className="inline-flex items-center gap-[5px] px-2 py-1 rounded-control text-[12.5px] font-medium text-text-secondary hover:text-text-primary hover:bg-border-subtle cursor-pointer transition-colors"
              >
                {copied ? <Check size={13} /> : <Copy size={13} />}
                <span>{copied ? t("translation.copied") : t("translation.copy")}</span>
              </button>
            )}
          </>
        ) : undefined
      }
    >
      <div className="p-[18px] flex flex-col gap-3 max-h-[420px] overflow-y-auto">
        <div className="border-l-2 border-border-strong pl-3 py-0.5">
          {showContext && hasSurroundingContext && context ? (
            <p className="font-reading italic text-[12.5px] leading-[1.5] text-text-tertiary">
              “{renderHighlightedContext(context, text, contextOffset)}”
            </p>
          ) : (
            <p
              className={`font-reading italic text-[12.5px] leading-[1.5] text-text-tertiary ${
                showContext ? "" : "line-clamp-3"
              }`}
            >
              “{text}”
            </p>
          )}
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
        ) : languageNotConfigured ? (
          <div className="flex flex-col items-center gap-3 py-4 text-center">
            <p className="text-[13px] text-text-secondary">
              {t("translation.languageNotConfigured")}
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
              <span>{t("translation.openSettings")}</span>
            </Button>
          </div>
        ) : null}

        {!hasConfigurationError &&
          (streaming && !content ? (
            <div className="flex items-center gap-2 py-1 text-text-tertiary">
              <Loader2 size={14} className="animate-spin text-accent-fg" />
              <span className="text-[13px]">{t("translation.translating")}</span>
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
            <p className="text-[15px] leading-[1.7] text-text-primary whitespace-pre-wrap">
              {content}
              {streaming && (
                <Loader2 size={12} className="inline-block ml-1 animate-spin text-text-tertiary" />
              )}
            </p>
          ))}
      </div>
    </ReaderPopover>
  );
}
