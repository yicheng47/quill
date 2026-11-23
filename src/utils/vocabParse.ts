import { useEffect, useState } from "react";

export interface ParsedDefinition {
  pronunciation: string | null;
  partOfSpeech: string | null;
  definition: string;
}

export interface ParsedSavedVocabDefinition extends ParsedDefinition {
  gloss: string | null;
}

export interface HighlightSegment {
  text: string;
  highlight: boolean;
}

const HAN_RE = /\p{Script=Han}/u;
const KANA_RE = /[\p{Script=Hiragana}\p{Script=Katakana}]/u;
const HANGUL_RE = /\p{Script=Hangul}/u;
const CJK_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const PINYIN_TONE_RE = /[āáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜ]/i;
const IPA_MARKER_RE = /[ˈˌəɪʊɛɔæɑɒʌɜʃʒθðŋɹɾʔːɡ]/;

// Pulls the leading /.../ phonetic (IPA or pinyin) + optional English or
// Chinese part of speech ("noun."/"adj."/"成语."/"名词.") off the first
// paragraph so they can render in the subtitle. Everything else stays in the
// Definition region verbatim.
export function parseDefinition(raw: string): ParsedDefinition {
  const breakIdx = raw.search(/\n\n+/);
  const head = breakIdx === -1 ? raw : raw.slice(0, breakIdx);
  const tail = breakIdx === -1 ? "" : raw.slice(breakIdx).replace(/^\n+/, "");
  const match = head.match(
    /^\s*(?:\*{1,2})?(\/[^/\n]+\/)(?:\*{1,2})?\s*(?:(?:\*{1,2})?\(?([A-Za-z]+|\p{Script=Han}{1,4})[.。]\)?(?:\*{1,2})?)?\s*([\s\S]*)$/u,
  );
  const headRemainder = (match ? match[3] ?? "" : head).trim();
  const definition =
    headRemainder && tail
      ? `${headRemainder}\n\n${tail}`
      : headRemainder || tail;
  return {
    pronunciation: match?.[1] ?? null,
    partOfSpeech: match?.[2] ?? null,
    definition,
  };
}

/**
 * Splits a saved Vocab definition that may have a leading short
 * translation gloss line above the IPA/pinyin/POS/definition entry.
 */
export function parseSavedVocabDefinition(raw: string): ParsedSavedVocabDefinition {
  const newline = raw.indexOf("\n");
  if (newline > 0) {
    const firstLine = raw.slice(0, newline).trim();
    const afterFirst = raw.slice(newline + 1);
    const rest = afterFirst.trimStart();
    if (firstLine && !firstLine.startsWith("/") && /^(?:\*{1,2})?\/[^/\n]+\//.test(rest)) {
      return { gloss: firstLine, ...parseDefinition(rest) };
    }
    if (
      firstLine &&
      !firstLine.startsWith("/") &&
      !afterFirst.startsWith("\n") &&
      /^(?:noun|verb|adjective|adverb|adj|adv|pronoun|preposition|conjunction|interjection|成语|名词|动词|形容词|副词|代词|量词|连词|介词|助词|叹词|短语|词组)[.。]\s/u.test(
        rest,
      )
    ) {
      const posMatch = rest.match(
        /^([A-Za-z]+|\p{Script=Han}{1,4})[.。]\s*([\s\S]*)$/u,
      );
      if (posMatch) {
        return {
          gloss: firstLine,
          pronunciation: null,
          partOfSpeech: posMatch[1] ?? null,
          definition: (posMatch[2] ?? "").trim(),
        };
      }
    }
  }
  return { gloss: null, ...parseDefinition(raw) };
}

/**
 * Formats pronunciation for display: slash-free tone-marked pinyin for Chinese
 * entries (`qián yí mò huà`), and `/IPA/` for English entries.
 */
export function formatPronunciation(
  pron: string | null | undefined,
  langOrWord?: string,
): string | null {
  const trimmed = pron?.trim();
  if (!trimmed) return null;

  const unwrapped = trimmed.replace(/^\/+|\/+$/g, "").trim();
  if (!unwrapped) return null;

  const isChinese =
    langOrWord === "zh" ||
    (Boolean(langOrWord) && HAN_RE.test(langOrWord!)) ||
    (PINYIN_TONE_RE.test(unwrapped) && !IPA_MARKER_RE.test(unwrapped));

  if (isChinese) {
    return unwrapped;
  }

  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    return trimmed;
  }
  return `/${unwrapped}/`;
}

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Splits a reading passage into plain and highlighted segments matching the
 * canonical lemma or any of its inflected forms.
 */
export function splitHighlightedForms(
  sentence: string,
  forms: ReadonlyArray<string>,
): HighlightSegment[] {
  if (!sentence) return [];
  const uniqueForms = Array.from(
    new Set(forms.map((f) => f.trim()).filter((f) => f.length > 0)),
  ).sort((a, b) => b.length - a.length);

  if (uniqueForms.length === 0) {
    return [{ text: sentence, highlight: false }];
  }

  const patternParts = uniqueForms.map((form) => {
    const escaped = escapeRegExp(form);
    if (CJK_RE.test(form)) {
      return escaped;
    }
    return `(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`;
  });

  const regex = new RegExp(patternParts.join("|"), "giu");
  const segments: HighlightSegment[] = [];
  let lastIndex = 0;

  for (const match of sentence.matchAll(regex)) {
    const idx = match.index ?? 0;
    const matched = match[0];
    if (!matched) continue;
    if (idx > lastIndex) {
      segments.push({ text: sentence.slice(lastIndex, idx), highlight: false });
    }
    segments.push({ text: matched, highlight: true });
    lastIndex = idx + matched.length;
  }

  if (lastIndex < sentence.length) {
    segments.push({ text: sentence.slice(lastIndex), highlight: false });
  }

  return segments.length > 0 ? segments : [{ text: sentence, highlight: false }];
}

export function detectSpeechLang(word: string): string | null {
  if (KANA_RE.test(word)) return "ja-JP";
  if (HANGUL_RE.test(word)) return "ko-KR";
  if (HAN_RE.test(word)) return "zh-CN";
  return null;
}

function checkSpeechVoices(): boolean {
  if (
    typeof window === "undefined" ||
    !("speechSynthesis" in window) ||
    typeof window.speechSynthesis?.getVoices !== "function" ||
    typeof SpeechSynthesisUtterance === "undefined"
  ) {
    return false;
  }
  try {
    return window.speechSynthesis.getVoices().length > 0;
  } catch {
    return false;
  }
}

export function useSpeechAvailable(): boolean {
  const [available, setAvailable] = useState<boolean>(() => checkSpeechVoices());

  useEffect(() => {
    setAvailable(checkSpeechVoices());
    if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
    const synth = window.speechSynthesis;
    const handleVoices = () => setAvailable(checkSpeechVoices());
    if (typeof synth.addEventListener === "function") {
      synth.addEventListener("voiceschanged", handleVoices);
      return () => synth.removeEventListener("voiceschanged", handleVoices);
    }
    return undefined;
  }, []);

  return available;
}

export function speakWord(word: string): void {
  if (
    typeof window === "undefined" ||
    !("speechSynthesis" in window) ||
    typeof SpeechSynthesisUtterance === "undefined"
  ) {
    return;
  }
  try {
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(word);
    const lang = detectSpeechLang(word);
    if (lang) {
      utterance.lang = lang;
      if (typeof window.speechSynthesis.getVoices === "function") {
        const prefix = lang.split("-")[0].toLowerCase();
        const voices = window.speechSynthesis.getVoices();
        const exact = voices.find((v) => v.lang?.toLowerCase() === lang.toLowerCase());
        const fallback = voices.find((v) => v.lang?.toLowerCase().startsWith(prefix));
        if (exact || fallback) {
          utterance.voice = exact ?? fallback ?? null;
        }
      }
    }
    window.speechSynthesis.speak(utterance);
  } catch {
    // ignore speech synthesis errors
  }
}

export function formatMonthHeading(
  timestampMs: number,
  locale: string,
  includeYear: boolean,
): string {
  const date = new Date(timestampMs);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(locale, {
    month: "long",
    ...(includeYear ? { year: "numeric" } : {}),
  })
    .format(date)
    .toUpperCase();
}

export function formatShortDate(timestampMs: number, locale: string): string {
  const date = new Date(timestampMs);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(locale, {
    day: "numeric",
    month: "short",
  }).format(date);
}
