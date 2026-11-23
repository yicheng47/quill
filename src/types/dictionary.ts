export interface DictionarySenseGroup {
  pos: string;
  defs: string[];
}

export interface AlternateLemma {
  lemma: string;
  relation: string;
}

export interface DictionaryMatch {
  dictId: string;
  dictName: string;
  format: "builtin" | "stardict" | "mdx" | string;
  pronunciation: string | null;
  senses: DictionarySenseGroup[] | null;
  html: string | null;
  plainText: string | null;
  gloss_en: string | null;
  gloss_zh: string | null;
}

export interface LookupDictionaryResult {
  lemma: string;
  lang: string;
  inflected_from: string | null;
  alternate_lemmas: AlternateLemma[];
  forms: string[];
  matches: DictionaryMatch[];
}

export interface DictionaryDescriptor {
  id: string;
  name: string;
  format: "builtin" | "stardict" | "mdx" | string;
  sizeBytes: number;
  entryCount: number;
  enabled: boolean;
}

export interface VocabLemmaCheck {
  total_count: number;
  matches_this_passage: boolean;
}

export function resolveBriefGloss(
  match: DictionaryMatch | null | undefined,
  showTranslation: boolean,
  targetLanguage: string,
  entryLang: string,
): string | null {
  if (!match || !showTranslation) return null;
  const target = targetLanguage.trim().toLowerCase();
  const entry = entryLang.trim().toLowerCase();
  if (!target) return null;

  if (target.startsWith("zh")) {
    if (entry.startsWith("zh")) return null;
    return match.gloss_zh?.trim() || null;
  }
  if (target.startsWith("en")) {
    if (entry.startsWith("en")) return null;
    return match.gloss_en?.trim() || null;
  }
  return null;
}

function htmlToCompactPlainText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<\/(p|div|li|dd|dt)>/gi, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Builds a compact plain-text fallback definition saved in `vocab_words.definition`
 * so MCP clients, legacy readers, and offline fallbacks stay human-readable.
 */
export function synthesizeFallbackDefinition(
  match: DictionaryMatch,
  gloss: string | null,
): string {
  const headerParts: string[] = [];
  const pron = match.pronunciation?.trim();
  if (pron) {
    const inner = pron.replace(/^\/+|\/+$/g, "").trim();
    if (inner) headerParts.push(`/${inner}/`);
  }

  let bodyText = "";
  if (match.senses && match.senses.length > 0) {
    const firstGroup = match.senses[0];
    if (firstGroup.pos?.trim()) {
      const pos = firstGroup.pos.trim().replace(/[.。]+$/, "");
      headerParts.push(`${pos}.`);
    }
    const defs: string[] = [];
    for (const group of match.senses) {
      for (const def of group.defs) {
        const cleaned = def.trim();
        if (cleaned) defs.push(cleaned);
        if (defs.length >= 3) break;
      }
      if (defs.length >= 3) break;
    }
    bodyText = defs.join("; ");
  } else if (match.plainText?.trim()) {
    bodyText = match.plainText.trim().replace(/\s+/g, " ").slice(0, 360);
  } else if (match.html?.trim()) {
    bodyText = htmlToCompactPlainText(match.html).slice(0, 360);
  }

  const entryLine = [...headerParts, bodyText].filter(Boolean).join(" ").trim();
  return [gloss?.trim() || null, entryLine || null].filter(Boolean).join("\n");
}

export function formatDictionaryBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
