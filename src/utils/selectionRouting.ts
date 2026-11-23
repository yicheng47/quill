export type SelectionMode = "word" | "passage";

export interface SelectionClassification {
  mode: SelectionMode;
  grayZone: boolean;
  normalizedTerm: string;
}

const CJK_CHAR_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const INTERNAL_PUNCT_RE = /[.,!?;:。！？；：，、]|——/;
const TRAILING_PUNCT_RE = /[.,;:!?。，；：！？…]+$/;

const SURROUNDING_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['"', '"'],
  ["'", "'"],
  ["“", "”"],
  ["‘", "’"],
  ["「", "」"],
  ["『", "』"],
  ["《", "》"],
  ["(", ")"],
  ["（", "）"],
];

function hasBalancedOuterPair(text: string, open: string, close: string): boolean {
  if (text.length < open.length + close.length) return false;
  if (!text.startsWith(open) || !text.endsWith(close)) return false;

  if (open === close) {
    return text.indexOf(close, open.length) === text.length - close.length;
  }

  let depth = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === open) {
      depth += 1;
    } else if (ch === close) {
      depth -= 1;
      if (depth === 0 && i < text.length - 1) {
        return false;
      }
    }
  }
  return depth === 0;
}

function normalizeSelectedTerm(trimmed: string): string {
  let current = trimmed;
  while (current.length > 0) {
    let next = current.trim();
    for (const [open, close] of SURROUNDING_PAIRS) {
      if (hasBalancedOuterPair(next, open, close)) {
        next = next.slice(open.length, next.length - close.length).trim();
      }
    }
    next = next.replace(TRAILING_PUNCT_RE, "").trim();
    if (next === current) break;
    current = next;
  }
  return current || trimmed;
}

export function classifySelection(rawText: string): SelectionClassification {
  const trimmed = rawText.trim();
  if (!trimmed) {
    return { mode: "word", grayZone: false, normalizedTerm: "" };
  }

  const nonEmptyLines = trimmed
    .split(/[\r\n]+/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (nonEmptyLines.length > 1) {
    return { mode: "passage", grayZone: false, normalizedTerm: trimmed };
  }

  const normalizedTerm = normalizeSelectedTerm(trimmed);
  const chars = Array.from(normalizedTerm);
  const nonSpaceChars = chars.filter((ch) => !/\s/.test(ch));
  const cjkCount = nonSpaceChars.filter((ch) => CJK_CHAR_RE.test(ch)).length;
  const hasSpaces = /\s/.test(normalizedTerm);
  const isCjkDominant =
    cjkCount > 0 && (!hasSpaces || cjkCount * 2 >= nonSpaceChars.length);
  const wordCount = normalizedTerm.split(/\s+/).filter(Boolean).length;

  if (INTERNAL_PUNCT_RE.test(normalizedTerm)) {
    const shortProverbOrIdiom = isCjkDominant ? cjkCount <= 10 : wordCount <= 5;
    return {
      mode: "passage",
      grayZone: shortProverbOrIdiom,
      normalizedTerm,
    };
  }

  if (isCjkDominant) {
    const len = nonSpaceChars.length;
    if (len <= 6) {
      return { mode: "word", grayZone: len >= 4, normalizedTerm };
    }
    if (len <= 10) {
      return { mode: "passage", grayZone: true, normalizedTerm };
    }
    return { mode: "passage", grayZone: false, normalizedTerm };
  }

  const charLen = normalizedTerm.length;
  if (wordCount <= 3 && charLen <= 40) {
    return { mode: "word", grayZone: wordCount >= 2, normalizedTerm };
  }
  if (wordCount >= 4 && wordCount <= 5 && charLen <= 60) {
    return { mode: "passage", grayZone: true, normalizedTerm };
  }
  return { mode: "passage", grayZone: false, normalizedTerm };
}
