import { useEffect, useState } from "react";

export interface ParsedDefinition {
  pronunciation: string | null;
  partOfSpeech: string | null;
  definition: string;
}

// Pulls the leading /.../ phonetic + optional "noun."/"verb."/etc. off the
// first paragraph so they can render in the subtitle. Everything else — the
// rest of the first paragraph plus all following paragraphs — stays in the
// Definition region verbatim.
export function parseDefinition(raw: string): ParsedDefinition {
  const breakIdx = raw.search(/\n\n+/);
  const head = breakIdx === -1 ? raw : raw.slice(0, breakIdx);
  const tail = breakIdx === -1 ? "" : raw.slice(breakIdx).replace(/^\n+/, "");
  const match = head.match(/^\s*(\/[^/]+\/)\s*(?:(\w+)\.)?\s*([\s\S]*)$/);
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
