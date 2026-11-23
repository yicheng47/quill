import { useCallback, useState, useEffect, useMemo, useRef } from "react";
import { focusWindow, invoke, listen, type UnlistenFn } from "../platform";
import {
  AlertCircle,
  Loader2,
  BookmarkPlus,
  Check,
  Copy,
  Quote,
  Settings,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import AiAuthPromptCard from "./AiAuthPromptCard";
import ReaderPopover from "./ReaderPopover";
import Button from "./ui/Button";
import SmartLensIcon from "./ui/SmartLensIcon";
import { DICT_HTML_PROSE, LOOKUP_PROSE } from "./lookup-prose";
import { isExactAiSentinel, matchAiSentinel, type AiSentinel } from "../lib/aiConnections";
import { parseAiErrorMessage } from "../utils/aiStream";
import { formatPronunciation, parseDefinition } from "../utils/vocabParse";
import { classifySelection, type SelectionMode } from "../utils/selectionRouting";
import {
  resolveBriefGloss,
  synthesizeFallbackDefinition,
  type DictionarySenseGroup,
  type LookupDictionaryResult,
  type VocabLemmaCheck,
} from "../types/dictionary";

const TRANSLATION_MARKER = "[[QUILL_TRANSLATION]]";
const INITIAL_VISIBLE_SENSES = 3;

export interface ExplainSelectionPopoverProps {
  x: number;
  y: number;
  text: string;
  sentence: string;
  bookTitle?: string;
  chapter?: string;
  bookId: string;
  cfi?: string;
  initialMode?: SelectionMode;
  grayZone?: boolean;
  normalizedTerm?: string;
  onSaved?: () => void;
  onQuote?: () => void;
  onClose: () => void;
}

interface SettledLookupResult {
  content: string;
  failed: boolean;
  cancelled?: boolean;
}

function useStreamingLookup(
  enabled: boolean,
  word: string,
  sentence: string,
  bookTitle: string | undefined,
  chapter: string | undefined,
  kind: "definition" | "context",
) {
  const contentRef = useRef("");
  const [content, setContent] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [sentinel, setSentinel] = useState<AiSentinel | null>(null);
  const [translationLanguageNotConfigured, setTranslationLanguageNotConfigured] = useState(false);
  const settledPromiseRef = useRef<Promise<SettledLookupResult>>(
    Promise.resolve({ content: "", failed: true }),
  );
  const settledStateRef = useRef<SettledLookupResult | null>({ content: "", failed: true });

  useEffect(() => {
    contentRef.current = "";
    setContent("");
    setSentinel(null);
    setTranslationLanguageNotConfigured(false);

    if (!enabled || !word.trim()) {
      const idle: SettledLookupResult = { content: "", failed: true };
      settledStateRef.current = idle;
      settledPromiseRef.current = Promise.resolve(idle);
      setStreaming(false);
      return;
    }

    let cancelled = false;
    let settled = false;
    let activeChannel: string | null = null;
    let unlisten: UnlistenFn | null = null;
    let resolveSettled!: (res: SettledLookupResult) => void;
    settledStateRef.current = null;
    settledPromiseRef.current = new Promise<SettledLookupResult>((resolve) => {
      resolveSettled = resolve;
    });
    const finishSettled = (res: SettledLookupResult) => {
      if (settled) return;
      settled = true;
      settledStateRef.current = res;
      resolveSettled(res);
    };
    const disposeListener = () => {
      unlisten?.();
      unlisten = null;
    };
    setStreaming(true);

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
            } else if (err.includes("LOOKUP_TRANSLATION_LANGUAGE_NOT_CONFIGURED")) {
              setTranslationLanguageNotConfigured(true);
              contentRef.current = "";
              setContent("");
            } else {
              contentRef.current = err.startsWith("Error:") ? err : `Error: ${err}`;
              setContent(contentRef.current);
            }
            setStreaming(false);
            finishSettled({ content: "", failed: true });
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
              setStreaming(false);
              finishSettled({ content: "", failed: true });
              disposeListener();
              return;
            }
            const failed = Boolean(parseAiErrorMessage(finalContent));
            setStreaming(false);
            finishSettled({ content: failed ? "" : finalContent, failed });
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
        await invoke("ai_lookup", {
          word,
          sentence,
          bookTitle: bookTitle || null,
          chapter: chapter || null,
          requestId,
          kind,
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
          } else if (msg.includes("LOOKUP_TRANSLATION_LANGUAGE_NOT_CONFIGURED")) {
            setTranslationLanguageNotConfigured(true);
          } else {
            contentRef.current = `Error: ${msg}`;
            setContent(contentRef.current);
          }
          setStreaming(false);
          finishSettled({ content: "", failed: true });
        }
      }
    };

    void run();

    return () => {
      cancelled = true;
      finishSettled({ content: "", failed: true, cancelled: true });
      if (activeChannel) {
        const ch = activeChannel;
        activeChannel = null;
        void invoke("ai_cancel", { channel: ch }).catch(() => {});
      }
      disposeListener();
    };
  }, [enabled, word, sentence, bookTitle, chapter, kind]);

  const waitUntilSettled = useCallback((): Promise<SettledLookupResult> => {
    if (settledStateRef.current) {
      return Promise.resolve(settledStateRef.current);
    }
    return settledPromiseRef.current;
  }, []);

  return {
    content,
    contentRef,
    streaming,
    sentinel,
    translationLanguageNotConfigured,
    waitUntilSettled,
  };
}

function useExplainStream(
  enabled: boolean,
  passage: string,
  surrounding: string | undefined,
  bookTitle: string | undefined,
  chapter: string | undefined,
) {
  const contentRef = useRef("");
  const [content, setContent] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [sentinel, setSentinel] = useState<AiSentinel | null>(null);

  useEffect(() => {
    contentRef.current = "";
    setContent("");
    setSentinel(null);

    if (!enabled || !passage.trim()) {
      setStreaming(false);
      return;
    }

    let cancelled = false;
    let activeChannel: string | null = null;
    let unlisten: UnlistenFn | null = null;
    const disposeListener = () => {
      unlisten?.();
      unlisten = null;
    };
    setStreaming(true);

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
  }, [enabled, passage, surrounding, bookTitle, chapter]);

  return { content, contentRef, streaming, sentinel };
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

function sliceSenseGroups(
  groups: DictionarySenseGroup[],
  limit: number | null,
): { visibleGroups: DictionarySenseGroup[]; hiddenCount: number } {
  let total = 0;
  for (const g of groups) total += g.defs.length;
  if (limit === null || total <= limit) {
    return { visibleGroups: groups, hiddenCount: 0 };
  }
  const visibleGroups: DictionarySenseGroup[] = [];
  let remaining = limit;
  for (const g of groups) {
    if (remaining <= 0) break;
    const take = g.defs.slice(0, remaining);
    if (take.length > 0) {
      visibleGroups.push({ pos: g.pos, defs: take });
      remaining -= take.length;
    }
  }
  return { visibleGroups, hiddenCount: total - limit };
}

export default function ExplainSelectionPopover({
  x,
  y,
  text,
  sentence,
  bookTitle,
  chapter,
  bookId,
  cfi,
  initialMode,
  grayZone: grayZoneProp,
  normalizedTerm: normalizedTermProp,
  onSaved,
  onQuote,
  onClose,
}: ExplainSelectionPopoverProps) {
  const { t } = useTranslation();
  const classification = useMemo(() => classifySelection(text), [text]);
  const resolvedInitialMode = initialMode ?? classification.mode;
  const resolvedGrayZone = grayZoneProp ?? classification.grayZone;
  const resolvedNormalizedTerm = normalizedTermProp ?? classification.normalizedTerm;

  const [mode, setMode] = useState<SelectionMode>(resolvedInitialMode);
  const [activeQueryTerm, setActiveQueryTerm] = useState(resolvedNormalizedTerm);
  const [dictState, setDictState] = useState<{
    queryTerm: string;
    settled: boolean;
    result: LookupDictionaryResult | null;
  }>({ queryTerm: "", settled: false, result: null });
  const [activeDictIdx, setActiveDictIdx] = useState(0);
  const [expandedSenses, setExpandedSenses] = useState(false);
  const [prefs, setPrefs] = useState({
    showTranslation: false,
    glossTarget: "en",
    showAllMatches: true,
  });
  const [vocabStatus, setVocabStatus] = useState<VocabLemmaCheck | null>(null);
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState(false);
  const vocabStatusEpochRef = useRef(0);
  const savingEpochRef = useRef<number | null>(null);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Sync mode and query term when the selected text / initial mode changes.
  useEffect(() => {
    setMode(resolvedInitialMode);
    setActiveQueryTerm(resolvedNormalizedTerm);
    setActiveDictIdx(0);
    setExpandedSenses(false);
    setVocabStatus(null);
    savingEpochRef.current = null;
    setSaving(false);
    setCopied(false);
  }, [text, resolvedInitialMode, resolvedNormalizedTerm]);

  // Load lookup display preferences (gloss toggle, gloss target, multi-dict tabs).
  useEffect(() => {
    let cancelled = false;
    invoke<Record<string, string>>("get_all_settings")
      .then((map) => {
        if (cancelled || !map || typeof map !== "object") return;
        setPrefs({
          showTranslation: map.show_translation === "true",
          glossTarget: map.lookup_translation_language || map.language || "en",
          showAllMatches: map.dictionary_show_all_matches !== "false",
        });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  // Offline dictionary lookup + English lemmatization in word mode.
  useEffect(() => {
    if (mode !== "word" || !activeQueryTerm.trim()) {
      setDictState({ queryTerm: activeQueryTerm, settled: false, result: null });
      return;
    }

    let cancelled = false;
    setDictState({ queryTerm: activeQueryTerm, settled: false, result: null });
    setActiveDictIdx(0);
    setExpandedSenses(false);

    invoke<LookupDictionaryResult | null>("lookup_dictionary", {
      term: activeQueryTerm,
    })
      .then((res) => {
        if (cancelled) return;
        const validResult =
          res && typeof res === "object" && Array.isArray(res.matches) ? res : null;
        setDictState({ queryTerm: activeQueryTerm, settled: true, result: validResult });
      })
      .catch(() => {
        if (cancelled) return;
        setDictState({ queryTerm: activeQueryTerm, settled: true, result: null });
      });

    return () => {
      cancelled = true;
    };
  }, [mode, activeQueryTerm]);

  const dictSettled = mode === "word" && dictState.settled && dictState.queryTerm === activeQueryTerm;
  const dictResult = dictSettled ? dictState.result : null;
  const hasDictMatch = Boolean(dictResult && dictResult.matches.length > 0);
  const canonicalLemma =
    (hasDictMatch ? dictResult?.lemma : dictResult?.lemma || activeQueryTerm)?.trim() ||
    activeQueryTerm;

  // Check whether canonical lemma is already in Vocab across all books + this passage.
  useEffect(() => {
    const epoch = ++vocabStatusEpochRef.current;
    savingEpochRef.current = null;
    setSaving(false);
    if (mode !== "word" || !dictSettled || !canonicalLemma) {
      setVocabStatus(null);
      return;
    }
    let cancelled = false;
    invoke<VocabLemmaCheck | null>("check_vocab_lemma", {
      lemma: canonicalLemma,
      bookId,
      cfi: cfi || null,
      contextSentence: sentence || null,
    })
      .then((status) => {
        if (cancelled || vocabStatusEpochRef.current !== epoch) return;
        if (status && typeof status.total_count === "number") {
          setVocabStatus(status);
        } else {
          setVocabStatus({ total_count: 0, matches_this_passage: false });
        }
      })
      .catch(() => {
        if (!cancelled && vocabStatusEpochRef.current === epoch) {
          setVocabStatus({ total_count: 0, matches_this_passage: false });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [mode, dictSettled, canonicalLemma, bookId, cfi, sentence]);

  const runAiDefinition = mode === "word" && dictSettled && !hasDictMatch;
  const runAiContext = mode === "word" && dictSettled;
  const runAiExplain = mode === "passage";

  const definition = useStreamingLookup(
    runAiDefinition,
    activeQueryTerm,
    sentence,
    bookTitle,
    chapter,
    "definition",
  );
  const context = useStreamingLookup(
    runAiContext,
    activeQueryTerm,
    sentence,
    bookTitle,
    chapter,
    "context",
  );
  const explain = useExplainStream(runAiExplain, text, sentence, bookTitle, chapter);

  const openAiSettings = async () => {
    onClose();
    await invoke("open_settings_on_main", { section: "ai" });
    await focusWindow("main");
  };

  const openToolsSettings = async () => {
    onClose();
    await invoke("open_settings_on_main", { section: "tools" });
    await focusWindow("main");
  };

  // Word-mode derived values
  const matches = dictResult?.matches ?? [];
  const activeMatch = matches[activeDictIdx] ?? matches[0] ?? null;
  const showSourceSwitcher = matches.length > 1 && prefs.showAllMatches;

  const { translationLine, definitionText } = splitDefinitionContent(
    definition.content,
    definition.streaming,
  );
  const definitionError = parseAiErrorMessage(definitionText);
  const contextError = parseAiErrorMessage(context.content);
  const parsedAiEntry = definitionError ? null : parseDefinition(definitionText);

  const briefGloss = hasDictMatch
    ? resolveBriefGloss(activeMatch, prefs.showTranslation, prefs.glossTarget, dictResult?.lang ?? "")
    : translationLine;

  const formattedDictPron = hasDictMatch
    ? formatPronunciation(activeMatch?.pronunciation, dictResult?.lang || canonicalLemma)
    : formatPronunciation(parsedAiEntry?.pronunciation, activeQueryTerm);

  const showInflectedPill = Boolean(
    hasDictMatch &&
      dictResult?.inflected_from &&
      dictResult.inflected_from.trim().toLowerCase() !== canonicalLemma.toLowerCase(),
  );

  // Fallback (no dictionary match) error / completion state
  const fallbackSentinel = !hasDictMatch ? definition.sentinel ?? context.sentinel : null;
  const fallbackTranslationLangMissing =
    !hasDictMatch &&
    (definition.translationLanguageNotConfigured || context.translationLanguageNotConfigured);
  const hasFallbackConfigError = Boolean(fallbackSentinel) || fallbackTranslationLangMissing;
  const fallbackAllDone = !definition.streaming && !context.streaming;
  const fallbackHasSavable = Boolean(
    !definitionError && (definitionText.trim() || translationLine),
  );

  const showWordFooter = hasDictMatch
    ? true
    : dictSettled && fallbackAllDone && !hasFallbackConfigError && fallbackHasSavable;

  // Passage-mode derived values
  const explainError = parseAiErrorMessage(explain.content);
  const showExplainFooter =
    !explain.streaming && Boolean(explain.content) && !explain.sentinel && !explainError;

  const isPassageAlreadySaved = Boolean(vocabStatus?.matches_this_passage);
  const existingVocabCount = vocabStatus?.total_count ?? 0;

  const handleSave = async () => {
    if (savingEpochRef.current !== null || isPassageAlreadySaved) return;
    const saveEpoch = ++vocabStatusEpochRef.current;
    savingEpochRef.current = saveEpoch;
    setSaving(true);
    // Capture the original encounter synchronously so dismissing the popover
    // or switching mode/lemma mid-stream still persists this encounter once.
    const capturedBookId = bookId;
    const capturedLemma = canonicalLemma;
    const capturedSentence = sentence || null;
    const capturedCfi = cfi || null;
    const capturedOnSaved = onSaved;
    const defToSave =
      hasDictMatch && activeMatch
        ? synthesizeFallbackDefinition(activeMatch, briefGloss)
        : displayedDefinitionContent(definition.contentRef.current ?? "");
    const shouldAwaitContext = hasDictMatch && context.streaming;
    const initialCtxNote =
      contextError || context.sentinel ? null : context.contentRef.current.trim() || null;

    try {
      let ctxToSave: string | null;
      if (shouldAwaitContext) {
        // Wait for the in-flight context stream so we persist either the complete
        // note (if it finishes) or null (if dismissed/cancelled/failed), never a partial delta.
        const settledCtx = await context.waitUntilSettled();
        ctxToSave =
          settledCtx.failed || settledCtx.cancelled
            ? null
            : settledCtx.content.trim() || null;
      } else {
        ctxToSave = initialCtxNote;
      }

      await invoke("add_vocab_word", {
        bookId: capturedBookId,
        word: capturedLemma,
        definition: defToSave,
        contextSentence: capturedSentence,
        contextExplanation: ctxToSave,
        cfi: capturedCfi,
      });

      capturedOnSaved?.();

      if (mountedRef.current && vocabStatusEpochRef.current === saveEpoch) {
        let authoritativeStatus: VocabLemmaCheck | null = null;
        try {
          const refreshed = await invoke<VocabLemmaCheck | null>("check_vocab_lemma", {
            lemma: capturedLemma,
            bookId: capturedBookId,
            cfi: capturedCfi,
            contextSentence: capturedSentence,
          });
          if (refreshed && typeof refreshed.total_count === "number") {
            authoritativeStatus = {
              total_count: Math.max(refreshed.total_count, 1),
              matches_this_passage: true,
            };
          }
        } catch {
          // Fall back to monotonic local floor below.
        }

        if (mountedRef.current && vocabStatusEpochRef.current === saveEpoch) {
          setVocabStatus((prev) =>
            authoritativeStatus ?? {
              total_count: Math.max(
                (prev?.total_count ?? 0) + (prev?.matches_this_passage ? 0 : 1),
                1,
              ),
              matches_this_passage: true,
            },
          );
        }
      }
    } catch (err) {
      console.error("Failed to save vocab word:", err);
    } finally {
      if (mountedRef.current && savingEpochRef.current === saveEpoch) {
        savingEpochRef.current = null;
        setSaving(false);
      }
    }
  };

  const handleCopyWord = () => {
    const defBody =
      hasDictMatch && activeMatch
        ? synthesizeFallbackDefinition(activeMatch, briefGloss)
        : displayedDefinitionContent(definition.contentRef.current);
    const ctxBody = contextError || context.sentinel ? "" : context.contentRef.current.trim();
    const fullText = [canonicalLemma, defBody, ctxBody].filter(Boolean).join("\n\n");
    void navigator.clipboard.writeText(fullText);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleCopyExplain = () => {
    void navigator.clipboard.writeText(explain.contentRef.current);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleToggleMode = () => {
    setCopied(false);
    setMode((prev) => (prev === "word" ? "passage" : "word"));
  };

  const handleSwitchAlternateLemma = (lemma: string) => {
    setActiveQueryTerm(lemma);
    setActiveDictIdx(0);
    setExpandedSenses(false);
  };

  const headerRight = (
    <>
      {mode === "word" && existingVocabCount > 0 && (
        <span
          data-testid="vocab-status-pill"
          className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-success-tint text-success text-[11px] font-semibold leading-none whitespace-nowrap"
        >
          <Check size={11} />
          <span>{t("lookup.inVocabCount", { count: existingVocabCount })}</span>
        </span>
      )}
      {resolvedGrayZone && (
        <button
          type="button"
          data-testid="selection-mode-switch"
          onClick={handleToggleMode}
          className="px-2 py-1 rounded-[6px] bg-surface-solid/80 dark:bg-surface-chip border border-border-subtle text-[11px] font-medium text-accent-on-tint hover:bg-surface-solid cursor-pointer transition-colors whitespace-nowrap"
        >
          {mode === "word" ? t("lookup.switchToExplain") : t("explain.switchToLookup")}
        </button>
      )}
    </>
  );

  const senseSlice =
    activeMatch?.senses && activeMatch.senses.length > 0
      ? sliceSenseGroups(activeMatch.senses, expandedSenses ? null : INITIAL_VISIBLE_SENSES)
      : null;

  const wordFooter = showWordFooter ? (
    <>
      <button
        type="button"
        onClick={handleSave}
        disabled={isPassageAlreadySaved || saving}
        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-control bg-accent-tint hover:bg-accent-tint-hover text-accent-on-tint text-[12.5px] font-semibold cursor-pointer transition-colors disabled:opacity-70 disabled:cursor-default"
      >
        {isPassageAlreadySaved ? <Check size={13} /> : <BookmarkPlus size={13} />}
        <span>
          {isPassageAlreadySaved
            ? t("lookup.saved")
            : existingVocabCount > 0
              ? t("lookup.addPassageToVocab")
              : t("lookup.saveToDict")}
        </span>
      </button>

      <div className="flex items-center gap-1">
        {onQuote && (
          <button
            type="button"
            onClick={onQuote}
            className="inline-flex items-center gap-[5px] px-2 py-1 rounded-control text-[12.5px] font-medium text-text-secondary hover:text-text-primary hover:bg-border-subtle cursor-pointer transition-colors"
          >
            <Quote size={13} />
            <span>{t("lookup.quote")}</span>
          </button>
        )}
        <button
          type="button"
          onClick={handleCopyWord}
          className="inline-flex items-center gap-[5px] px-2 py-1 rounded-control text-[12.5px] font-medium text-text-secondary hover:text-text-primary hover:bg-border-subtle cursor-pointer transition-colors"
        >
          {copied ? <Check size={13} /> : <Copy size={13} />}
          <span>{copied ? t("lookup.copied") : t("lookup.copy")}</span>
        </button>
      </div>
    </>
  ) : undefined;

  const explainFooter = showExplainFooter ? (
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
        onClick={handleCopyExplain}
        className="inline-flex items-center gap-[5px] px-2 py-1 rounded-control text-[12.5px] font-medium text-text-secondary hover:text-text-primary hover:bg-border-subtle cursor-pointer transition-colors"
      >
        {copied ? <Check size={13} /> : <Copy size={13} />}
        <span>{copied ? t("explain.copied") : t("explain.copy")}</span>
      </button>
    </>
  ) : undefined;

  const sourceSwitcher = showSourceSwitcher ? (
    <div
      role="tablist"
      aria-label={t("lookup.dictionarySource")}
      className="inline-flex items-center gap-0.5 p-0.5 rounded-control bg-surface-inset border border-border-subtle shrink-0"
    >
      {matches.map((match, idx) => {
        const active = idx === activeDictIdx;
        return (
          <button
            key={match.dictId}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => {
              setActiveDictIdx(idx);
              setExpandedSenses(false);
            }}
            className={`px-[7px] py-[2px] rounded-[6px] text-[11px] leading-snug cursor-pointer transition-colors ${
              active
                ? "bg-surface-solid font-semibold text-text-primary shadow-xs"
                : "font-medium text-text-tertiary hover:text-text-secondary"
            }`}
          >
            {match.dictName}
          </button>
        );
      })}
    </div>
  ) : null;

  return (
    <ReaderPopover
      x={x}
      y={y}
      widthClass={mode === "word" ? "w-[420px]" : "w-[440px]"}
      title={mode === "word" ? t("lookup.title") : t("explain.title")}
      icon={<SmartLensIcon size={15} />}
      headerRight={headerRight}
      onClose={onClose}
      footer={mode === "word" ? wordFooter : explainFooter}
    >
      {mode === "word" ? (
        <div className="p-[18px] flex flex-col gap-2.5 max-h-[420px] overflow-y-auto">
          {/* Headword + pronunciation + inflected pill */}
          <div className="flex flex-wrap items-baseline gap-2">
            <h3 className="font-reading text-[24px] font-semibold leading-tight text-text-primary">
              {canonicalLemma}
            </h3>
            {!hasDictMatch && parsedAiEntry?.partOfSpeech && (
              <span className="px-2 py-0.5 rounded-full bg-accent-tint text-accent-on-tint text-[11.5px] font-semibold leading-none">
                {parsedAiEntry.partOfSpeech}
              </span>
            )}
            {formattedDictPron && (
              <span className="font-mono text-[12px] text-text-tertiary">
                {formattedDictPron}
              </span>
            )}
            {showInflectedPill && dictResult?.inflected_from && (
              <span className="px-[7px] py-[2px] rounded-full bg-surface-inset dark:bg-surface-chip border border-border-subtle text-[11px] text-text-secondary leading-snug">
                {t("lookup.inflectedFrom", { form: dictResult.inflected_from })}
              </span>
            )}
          </div>

          {/* Alternate lemma links for homographs (e.g. left -> leave) */}
          {hasDictMatch && dictResult && dictResult.alternate_lemmas.length > 0 && (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 -mt-1">
              {dictResult.alternate_lemmas.map((alt) => (
                <button
                  key={`${alt.lemma}-${alt.relation}`}
                  type="button"
                  onClick={() => handleSwitchAlternateLemma(alt.lemma)}
                  className="text-[11.5px] text-accent-on-tint hover:underline cursor-pointer text-left"
                >
                  {t("lookup.alsoFormOf", {
                    relation: alt.relation,
                    lemma: alt.lemma,
                  })}
                </button>
              ))}
            </div>
          )}

          {/* Dictionary matched path */}
          {hasDictMatch && activeMatch ? (
            <>
              {briefGloss && (
                <p className="text-[13.5px] font-medium text-accent-on-tint leading-snug">
                  {briefGloss}
                </p>
              )}

              {senseSlice ? (
                <div className="flex flex-col gap-2">
                  {senseSlice.visibleGroups.map((group, groupIdx) => (
                    <div key={`${group.pos}-${groupIdx}`} className="flex flex-col gap-1">
                      {(group.pos || (groupIdx === 0 && sourceSwitcher)) && (
                        <div className="flex items-center justify-between gap-2">
                          <div>
                            {group.pos && (
                              <span className="inline-block px-2 py-0.5 rounded-full bg-accent-tint text-accent-on-tint text-[11px] font-semibold leading-none">
                                {group.pos}
                              </span>
                            )}
                          </div>
                          {groupIdx === 0 && sourceSwitcher}
                        </div>
                      )}
                      <ol className="list-decimal pl-4 m-0 flex flex-col gap-1 text-[13px] leading-[1.5] text-text-primary">
                        {group.defs.map((def, defIdx) => (
                          <li key={defIdx} className="select-text">
                            {def}
                          </li>
                        ))}
                      </ol>
                    </div>
                  ))}
                  {(senseSlice.hiddenCount > 0 || expandedSenses) && (
                    <button
                      type="button"
                      onClick={() => setExpandedSenses((prev) => !prev)}
                      className="self-start text-[12px] font-medium text-accent-on-tint hover:underline cursor-pointer"
                    >
                      {expandedSenses
                        ? t("lookup.showLessSenses")
                        : t("lookup.moreSenses", { count: senseSlice.hiddenCount })}
                    </button>
                  )}
                </div>
              ) : activeMatch.html ? (
                <>
                  {sourceSwitcher && (
                    <div className="flex items-center justify-end">{sourceSwitcher}</div>
                  )}
                  <div
                    className={`${DICT_HTML_PROSE} max-h-[190px] overflow-y-auto text-[13px] select-text`}
                    dangerouslySetInnerHTML={{ __html: activeMatch.html }}
                  />
                </>
              ) : activeMatch.plainText ? (
                <>
                  {sourceSwitcher && (
                    <div className="flex items-center justify-end">{sourceSwitcher}</div>
                  )}
                  <div className="max-h-[190px] overflow-y-auto text-[13px] leading-[1.5] text-text-primary whitespace-pre-wrap select-text">
                    {activeMatch.plainText}
                  </div>
                </>
              ) : null}

              {/* Parallel AI context slot — gracefully degrades offline / without AI */}
              {context.sentinel || contextError ? (
                <div
                  data-testid="lookup-ai-optional-note"
                  className="mt-0.5 px-3 py-2.5 rounded-[6px] bg-surface-inset border border-border-subtle flex items-center justify-between gap-2"
                >
                  <span className="text-[12px] text-text-secondary">
                    {t("lookup.connectAiForContext")}
                  </span>
                  <button
                    type="button"
                    onClick={openAiSettings}
                    className="text-[12px] font-medium text-accent-on-tint hover:underline cursor-pointer shrink-0"
                  >
                    {t("lookup.aiSettingsLink")} →
                  </button>
                </div>
              ) : context.content || context.streaming ? (
                <div className="mt-0.5 p-3 rounded-[6px] bg-surface-tint flex flex-col gap-1">
                  <span className="text-[10.5px] font-semibold tracking-[0.8px] uppercase text-accent-on-tint">
                    {t("lookup.inContext")}
                  </span>
                  {context.streaming && !context.content ? (
                    <div className="flex items-center gap-1.5 py-0.5 text-text-tertiary">
                      <Loader2 size={12} className="animate-spin text-accent-fg" />
                      <span className="text-[12px]">{t("lookup.analyzing")}</span>
                    </div>
                  ) : (
                    <div className={`${LOOKUP_PROSE} text-[12.5px] leading-[1.5] text-text-secondary`}>
                      <Markdown remarkPlugins={[remarkGfm]}>{context.content}</Markdown>
                      {context.streaming && (
                        <Loader2
                          size={12}
                          className="inline-block ml-1 animate-spin text-text-tertiary"
                        />
                      )}
                    </div>
                  )}
                </div>
              ) : null}
            </>
          ) : !dictSettled ? (
            <div className="flex items-center gap-2 py-1 text-text-tertiary">
              <Loader2 size={14} className="animate-spin text-accent-fg" />
              <span className="text-[13px]">{t("lookup.lookingUp")}</span>
            </div>
          ) : (
            /* AI fallback path when no enabled dictionary matched */
            <>
              {fallbackSentinel ? (
                <AiAuthPromptCard
                  sentinel={fallbackSentinel}
                  embedded
                  onOpenSettings={openAiSettings}
                />
              ) : fallbackTranslationLangMissing ? (
                <div className="flex flex-col items-center gap-3 py-4 text-center">
                  <p className="text-[13px] text-text-secondary">
                    {t("lookup.translationLanguageNotConfigured")}
                  </p>
                  <Button
                    type="button"
                    appearance="dawn"
                    variant="tonal"
                    size="sm"
                    onClick={openToolsSettings}
                  >
                    <Settings size={14} />
                    <span>{t("lookup.openSettings")}</span>
                  </Button>
                </div>
              ) : null}

              {!hasFallbackConfigError &&
                (definition.streaming && !definition.content ? (
                  <div className="flex items-center gap-2 py-1 text-text-tertiary">
                    <Loader2 size={14} className="animate-spin text-accent-fg" />
                    <span className="text-[13px]">{t("lookup.lookingUp")}</span>
                  </div>
                ) : definitionError ? (
                  <div
                    role="alert"
                    className="flex items-start gap-2 rounded-[6px] bg-danger-tint/70 border border-danger/20 px-3 py-2.5 text-[13px] text-danger"
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
                    {(parsedAiEntry?.definition || definition.streaming) && (
                      <div className={`${LOOKUP_PROSE} text-[13.5px] leading-[1.5] text-text-primary`}>
                        <Markdown remarkPlugins={[remarkGfm]}>
                          {parsedAiEntry?.definition ?? definitionText}
                        </Markdown>
                        {definition.streaming && (
                          <Loader2
                            size={12}
                            className="inline-block ml-1 animate-spin text-text-tertiary"
                          />
                        )}
                      </div>
                    )}
                  </>
                ))}

              {!hasFallbackConfigError &&
                !definitionError &&
                (context.content || context.streaming) && (
                  <div className="mt-0.5 p-3 rounded-[6px] bg-surface-tint flex flex-col gap-1">
                    <span className="text-[10.5px] font-semibold tracking-[0.8px] uppercase text-accent-on-tint">
                      {t("lookup.inContext")}
                    </span>
                    {context.streaming && !context.content ? (
                      <div className="flex items-center gap-1.5 py-0.5 text-text-tertiary">
                        <Loader2 size={12} className="animate-spin text-accent-fg" />
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
                          <Loader2
                            size={12}
                            className="inline-block ml-1 animate-spin text-text-tertiary"
                          />
                        )}
                      </div>
                    )}
                  </div>
                )}
            </>
          )}
        </div>
      ) : (
        /* Passage mode (Explain) — ephemeral, never persisted to DB */
        <div className="p-[18px] flex flex-col gap-3 max-h-[380px] overflow-y-auto">
          <div className="border-l-2 border-accent/55 pl-3 py-0.5">
            <p className="font-reading italic text-[13px] leading-[1.5] text-text-secondary line-clamp-3">
              “{text}”
            </p>
          </div>

          {explain.sentinel ? (
            <AiAuthPromptCard
              sentinel={explain.sentinel}
              embedded
              onOpenSettings={openAiSettings}
            />
          ) : explain.streaming && !explain.content ? (
            <div className="flex items-center gap-2 py-1 text-text-tertiary">
              <Loader2 size={14} className="animate-spin text-accent-fg" />
              <span className="text-[13px]">{t("explain.thinking")}</span>
            </div>
          ) : explainError ? (
            <div
              role="alert"
              className="flex items-start gap-2 rounded-[6px] bg-danger-tint/70 border border-danger/20 px-3 py-2.5 text-[13px] text-danger"
            >
              <AlertCircle size={15} className="shrink-0 mt-0.5" />
              <span>{explainError}</span>
            </div>
          ) : (
            <div className={`${LOOKUP_PROSE} text-[13.5px] leading-[1.55] text-text-primary`}>
              <Markdown remarkPlugins={[remarkGfm]}>{explain.content}</Markdown>
              {explain.streaming && (
                <Loader2 size={12} className="inline-block ml-1 animate-spin text-text-tertiary" />
              )}
            </div>
          )}
        </div>
      )}
    </ReaderPopover>
  );
}
