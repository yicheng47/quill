import { pinyin } from "pinyin-pro";

const HAN_CHAR_RE = /\p{Script=Han}/u;
const ASCII_LETTER_RE = /^[A-Z]$/;

function stripDiacritics(input: string): string {
  return input.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function firstNonSpaceChar(word: string): string {
  const trimmed = word.trim();
  if (!trimmed) return "";
  return Array.from(trimmed)[0] ?? "";
}

export function getVocabGroupKey(word: string): string {
  const first = firstNonSpaceChar(word);
  if (!first) return "#";

  if (HAN_CHAR_RE.test(first)) {
    const initial = stripDiacritics(
      pinyin(first, {
        toneType: "none",
        pattern: "first",
        traditional: true,
        v: true,
      }),
    )
      .trim()
      .charAt(0)
      .toUpperCase();
    return ASCII_LETTER_RE.test(initial) ? initial : "#";
  }

  const normalized = stripDiacritics(first).toUpperCase();
  return ASCII_LETTER_RE.test(normalized) ? normalized : "#";
}

export function getVocabSortKey(word: string): string {
  const trimmed = word.trim();
  if (!trimmed) return "\uffff";

  const group = getVocabGroupKey(trimmed);
  const bucketPrefix = group === "#" ? "1:" : "0:";

  let sortable: string;
  if (HAN_CHAR_RE.test(trimmed)) {
    const py = pinyin(trimmed, {
      toneType: "none",
      nonZh: "consecutive",
      traditional: true,
      v: true,
    });
    sortable = stripDiacritics(py).toLowerCase().replace(/\s+/g, "");
  } else {
    sortable = stripDiacritics(trimmed).toLowerCase();
  }

  return `${bucketPrefix}${sortable}\0${trimmed.toLowerCase()}`;
}

export function matchesVocabSearch(
  word: string,
  query: string,
  gloss?: string | null,
): boolean {
  const trimmedQuery = query.trim();
  if (!trimmedQuery) return true;

  const qLower = trimmedQuery.toLowerCase();
  if (word.toLowerCase().includes(qLower)) return true;
  if (gloss && gloss.toLowerCase().includes(qLower)) return true;

  if (!HAN_CHAR_RE.test(word)) {
    const qNorm = stripDiacritics(qLower);
    return stripDiacritics(word.toLowerCase()).includes(qNorm);
  }

  const qNorm = stripDiacritics(qLower);
  const qCompact = qNorm.replace(/\s+/g, "");
  if (!qCompact) return true;

  const fullWithV = stripDiacritics(
    pinyin(word, {
      toneType: "none",
      nonZh: "consecutive",
      traditional: true,
      v: true,
    }),
  ).toLowerCase();
  if (fullWithV.includes(qNorm) || fullWithV.replace(/\s+/g, "").includes(qCompact)) {
    return true;
  }

  const fullWithU = fullWithV.replace(/v/g, "u");
  if (fullWithU.includes(qNorm) || fullWithU.replace(/\s+/g, "").includes(qCompact)) {
    return true;
  }

  const initials = stripDiacritics(
    pinyin(word, {
      toneType: "none",
      pattern: "first",
      nonZh: "consecutive",
      traditional: true,
      v: true,
    }),
  )
    .toLowerCase()
    .replace(/\s+/g, "");
  return initials.includes(qCompact);
}
