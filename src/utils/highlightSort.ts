import { compare as compareEpubCfi, isCFI } from "../../public/foliate-js/epubcfi.js";
import type { Highlight } from "../hooks/useBookmarks";

export type HighlightSortMode = "newest" | "oldest" | "chapter";

export function extractPdfPageIndex(cfi: string): number | null {
  if (!cfi) return null;
  // foliate-js encodes PDF pages via fake CFI steps: epubcfi(/6/<(page+1)*2>!...)
  const fakeMatch = cfi.match(/^epubcfi\(\/6\/(\d+)/);
  if (fakeMatch) {
    const step = Number.parseInt(fakeMatch[1], 10);
    if (Number.isFinite(step) && step >= 2) {
      return Math.floor(step / 2) - 1;
    }
  }
  const pageMatch = cfi.match(/^(?:page:)?(\d+)$/i);
  if (pageMatch) {
    const page = Number.parseInt(pageMatch[1], 10);
    if (Number.isFinite(page)) return page;
  }
  return null;
}

function compareCfiPositions(aCfi: string, bCfi: string, format?: string): number {
  if (format === "pdf") {
    const aPage = extractPdfPageIndex(aCfi);
    const bPage = extractPdfPageIndex(bCfi);
    if (aPage !== null && bPage !== null && aPage !== bPage) {
      return aPage - bPage;
    }
  }

  if (isCFI.test(aCfi) && isCFI.test(bCfi)) {
    try {
      const cmp = compareEpubCfi(aCfi, bCfi);
      if (Number.isFinite(cmp) && cmp !== 0) {
        return cmp;
      }
    } catch {
      // Fall through to created_at / string order on malformed CFI
    }
  }

  return 0;
}

export function sortHighlights<T extends Highlight>(
  highlights: T[],
  sortMode: HighlightSortMode,
  options?: {
    bookFormats?: ReadonlyMap<string, string>;
    bookOrder?: ReadonlyMap<string, number>;
  },
): T[] {
  const copy = [...highlights];

  if (sortMode === "newest") {
    return copy.sort((a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id));
  }

  if (sortMode === "oldest") {
    return copy.sort((a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id));
  }

  const bookFormats = options?.bookFormats;
  const bookOrder = options?.bookOrder;

  return copy.sort((a, b) => {
    if (a.book_id !== b.book_id) {
      const aOrd = bookOrder?.get(a.book_id);
      const bOrd = bookOrder?.get(b.book_id);
      if (aOrd !== undefined && bOrd !== undefined && aOrd !== bOrd) {
        return aOrd - bOrd;
      }
      if (aOrd !== undefined && bOrd === undefined) return -1;
      if (aOrd === undefined && bOrd !== undefined) return 1;

      const aTitle = a.book_title ?? "";
      const bTitle = b.book_title ?? "";
      const titleCmp = aTitle.localeCompare(bTitle, undefined, { sensitivity: "base" });
      if (titleCmp !== 0) return titleCmp;
      return a.book_id.localeCompare(b.book_id);
    }

    const format = bookFormats?.get(a.book_id);
    const posCmp = compareCfiPositions(a.cfi_range, b.cfi_range, format);
    if (posCmp !== 0) return posCmp;
    return a.created_at - b.created_at || a.id.localeCompare(b.id);
  });
}
