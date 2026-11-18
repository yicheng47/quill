import { CURATED_CODEX_MODELS } from "../components/settings/codexModels";

export function parseAiErrorMessage(content: string): string | null {
  const trimmed = content.trim();
  if (!trimmed.startsWith("Error:")) return null;
  const detail = trimmed.slice("Error:".length).trim();
  return detail || trimmed;
}

export function formatAiModelFooter(
  settings: Record<string, string>,
  formatEffort?: (effort: string) => string,
): string | null {
  const provider = settings.ai_provider?.trim();
  if (!provider) return null;

  // Match crates/quill-core/src/commands/ai.rs:527 & :533 defaults when rows are absent.
  const authMode = settings.ai_auth_mode === "oauth" ? "oauth" : "api_key";
  const model =
    settings.ai_model === undefined ? "llama3.2" : settings.ai_model.trim();
  if (!model) return null;

  const displayName =
    CURATED_CODEX_MODELS.find((m) => m.slug === model)?.display_name ?? model;

  if (provider === "openai" && authMode === "oauth") {
    const effort = settings.ai_effort_deep?.trim();
    if (effort && effort !== "default") {
      const label = formatEffort ? formatEffort(effort) : effort;
      return `${displayName} · ${label}`;
    }
  }

  return displayName;
}

export interface SelectionSentenceResult {
  sentence: string;
  matchStart: number;
}

function findClosestOccurrence(
  haystack: string,
  needle: string,
  targetOffset?: number,
): number {
  const first = haystack.indexOf(needle);
  if (first === -1 || targetOffset === undefined) return first;

  let bestIdx = first;
  let bestDist = Math.abs(first - targetOffset);
  let pos = first + 1;
  while (pos <= haystack.length - needle.length) {
    const next = haystack.indexOf(needle, pos);
    if (next === -1) break;
    const dist = Math.abs(next - targetOffset);
    if (dist < bestDist) {
      bestIdx = next;
      bestDist = dist;
    }
    pos = next + 1;
  }
  return bestIdx;
}

/**
 * Extracts a bounded surrounding window from `blockText` centered on the occurrence
 * closest to `selectionOffset`, plus the selected occurrence's start offset within
 * the returned `sentence` so repeated words highlight the right occurrence.
 */
export function extractSelectionSentenceWithOffset(
  blockText: string,
  selectedText: string,
  selectionOffset?: number,
  maxLength = 500,
): SelectionSentenceResult {
  const trimmedBlock = blockText.trim();
  const trimmedSel = selectedText.trim();
  if (!trimmedBlock) return { sentence: trimmedSel, matchStart: 0 };
  if (!trimmedSel) {
    return {
      sentence: trimmedBlock.length > maxLength ? trimmedBlock.slice(0, maxLength) : trimmedBlock,
      matchStart: 0,
    };
  }

  const idx = findClosestOccurrence(trimmedBlock, trimmedSel, selectionOffset);
  if (idx === -1) return { sentence: trimmedSel, matchStart: 0 };
  if (trimmedBlock.length <= maxLength) {
    return { sentence: trimmedBlock, matchStart: idx };
  }
  if (trimmedSel.length >= maxLength) {
    return { sentence: trimmedBlock.slice(idx, idx + trimmedSel.length), matchStart: 0 };
  }

  const slack = maxLength - trimmedSel.length;
  let start = Math.max(0, idx - Math.floor(slack / 2));
  let end = Math.min(trimmedBlock.length, start + maxLength);
  start = Math.max(0, end - maxLength);

  if (start > 0) {
    const nextSpace = trimmedBlock.indexOf(" ", start);
    if (nextSpace !== -1 && nextSpace < idx) {
      start = nextSpace + 1;
    }
  }
  if (end < trimmedBlock.length) {
    const prevSpace = trimmedBlock.lastIndexOf(" ", end);
    if (prevSpace > idx + trimmedSel.length) {
      end = prevSpace;
    }
  }

  const rawSlice = trimmedBlock.slice(start, end);
  const leadingTrim = rawSlice.length - rawSlice.trimStart().length;
  const sentence = rawSlice.trim();
  return {
    sentence,
    matchStart: Math.max(0, idx - start - leadingTrim),
  };
}

export function extractSelectionSentence(
  blockText: string,
  selectedText: string,
  selectionOffset?: number,
  maxLength = 500,
): string {
  return extractSelectionSentenceWithOffset(
    blockText,
    selectedText,
    selectionOffset,
    maxLength,
  ).sentence;
}

/**
 * Extracts bounded surrounding context for a live DOM `Range` within its containing
 * block element, using the Range's true offset within `blockEl` rather than `indexOf`.
 */
export function extractRangeSelectionContext(
  blockEl: Element,
  range: Range,
  selectedText: string,
  maxLength = 500,
): SelectionSentenceResult {
  const trimmedSel = selectedText.trim();
  if (!trimmedSel) return { sentence: "", matchStart: 0 };
  if (!blockEl.contains(range.startContainer) || !blockEl.contains(range.endContainer)) {
    return { sentence: trimmedSel, matchStart: 0 };
  }

  const rawBlock = blockEl.textContent ?? "";
  if (!rawBlock.trim()) return { sentence: trimmedSel, matchStart: 0 };

  const prefixRange = range.cloneRange();
  prefixRange.selectNodeContents(blockEl);
  prefixRange.setEnd(range.startContainer, range.startOffset);
  const rawPreLen = (prefixRange.cloneContents().textContent ?? "").length;
  const rawSelText = range.cloneContents().textContent ?? "";
  const leadingSelTrim = rawSelText.length - rawSelText.trimStart().length;
  const leadingBlockTrim = rawBlock.length - rawBlock.trimStart().length;
  const selectionOffset = Math.max(0, rawPreLen + leadingSelTrim - leadingBlockTrim);

  return extractSelectionSentenceWithOffset(rawBlock, trimmedSel, selectionOffset, maxLength);
}
