import { extractPdfPageIndex } from "./highlightSort";

export interface SavedItemPageSection {
  createDocument?: () => Promise<Document | null | undefined>;
}

export interface SavedItemPageResolvedCfi {
  index: number;
  anchor?: (doc: Document) => Range | Node | null | undefined;
}

export interface SavedItemPageView {
  book?: {
    sections?: SavedItemPageSection[];
  } | null;
  resolveCFI?: (
    cfi: string,
  ) => SavedItemPageResolvedCfi | Promise<SavedItemPageResolvedCfi | null | undefined> | null | undefined;
  getLocationOf?: (index: number, fraction?: number) => { current: number; total?: number } | null;
}

export type ResolveSavedItemPages = (cfis: Iterable<string>) => Promise<Map<string, number>>;

export interface RelocatePageDetail {
  location?: { current?: number; total?: number } | null;
  section?: { current?: number; total?: number } | null;
}

export function getPageInfoFromRelocate(
  detail: RelocatePageDetail,
  format: string,
): { current: number; total: number } | null {
  const source = format === "pdf" ? detail.section : detail.location;
  if (
    !source ||
    typeof source.current !== "number" ||
    !Number.isFinite(source.current) ||
    source.current < 0 ||
    typeof source.total !== "number" ||
    !Number.isFinite(source.total) ||
    source.total <= 0
  ) {
    return null;
  }
  return { current: source.current + 1, total: source.total };
}

const VALID_PDF_CFI = /^epubcfi\(\/6\/(\d+)(?:\[[^\]]*\])?(?:!\/.+)?\)$/;
const VALID_LEGACY_PDF_PAGE = /^(?:page:)?\d+$/i;

export function resolvePdfPageFromCfi(cfi: string, sectionCount: number): number | null {
  if (!cfi || !Number.isInteger(sectionCount) || sectionCount <= 0) return null;

  const cfiMatch = cfi.match(VALID_PDF_CFI);
  if (cfiMatch) {
    const step = Number.parseInt(cfiMatch[1], 10);
    if (!Number.isSafeInteger(step) || step < 2 || step % 2 !== 0) return null;
  } else if (!VALID_LEGACY_PDF_PAGE.test(cfi)) {
    return null;
  }

  const idx = extractPdfPageIndex(cfi);
  if (idx === null || !Number.isSafeInteger(idx) || idx < 0 || idx >= sectionCount) {
    return null;
  }
  return idx + 1;
}

export function resolveQuotedPage(options: {
  format: string;
  cfi?: string;
  sectionIndex?: number;
  sectionCount: number;
  fallbackPage: number | null;
}): number | null {
  const { format, cfi, sectionIndex, sectionCount, fallbackPage } = options;
  if (format === "pdf") {
    if (
      typeof sectionIndex === "number" &&
      Number.isInteger(sectionIndex) &&
      sectionIndex >= 0 &&
      sectionIndex < sectionCount
    ) {
      return sectionIndex + 1;
    }
    if (cfi) {
      const fromCfi = resolvePdfPageFromCfi(cfi, sectionCount);
      if (fromCfi !== null) return fromCfi;
    }
  }
  return fallbackPage;
}

function isRange(value: Range | Node): value is Range {
  return "startContainer" in value && "startOffset" in value;
}

function isNode(value: unknown): value is Node {
  return typeof value === "object" && value !== null && "nodeType" in value;
}

export function textFractionBefore(doc: Document, range: Range | Node): number {
  const body = doc.body;
  if (!body) return 0;

  const totalLength = body.textContent?.length ?? 0;
  if (totalLength === 0) return 0;

  const before = doc.createRange();
  before.setStart(body, 0);
  if (isRange(range)) {
    before.setEnd(range.startContainer, range.startOffset);
  } else {
    const nodeRange = doc.createRange();
    nodeRange.selectNodeContents(range);
    before.setEnd(nodeRange.startContainer, nodeRange.startOffset);
  }

  return Math.max(0, Math.min(1, before.toString().length / totalLength));
}

export function createSavedItemPageResolver(
  view: SavedItemPageView | null,
  format: string,
): ResolveSavedItemPages {
  const cache = new Map<string, number>();
  const inFlightDocs = new Map<number, Promise<Document | null>>();

  const loadSectionDoc = (index: number, section: SavedItemPageSection): Promise<Document | null> => {
    const existing = inFlightDocs.get(index);
    if (existing) return existing;

    const promise = Promise.resolve()
      .then(() => section.createDocument?.())
      .then((doc) => doc ?? null)
      .catch(() => null)
      .finally(() => {
        if (inFlightDocs.get(index) === promise) {
          inFlightDocs.delete(index);
        }
      });

    inFlightDocs.set(index, promise);
    return promise;
  };

  return async (cfis: Iterable<string>): Promise<Map<string, number>> => {
    const result = new Map<string, number>();
    const pending: string[] = [];
    const seen = new Set<string>();

    for (const cfi of cfis) {
      if (!cfi || seen.has(cfi)) continue;
      seen.add(cfi);
      const cached = cache.get(cfi);
      if (cached !== undefined) {
        result.set(cfi, cached);
      } else {
        pending.push(cfi);
      }
    }

    if (pending.length === 0) return result;

    if (format === "pdf") {
      const sections = view?.book?.sections;
      const sectionCount = Array.isArray(sections) ? sections.length : 0;
      if (sectionCount <= 0) return result;
      for (const cfi of pending) {
        const page = resolvePdfPageFromCfi(cfi, sectionCount);
        if (page !== null) {
          cache.set(cfi, page);
          result.set(cfi, page);
        }
      }
      return result;
    }

    const sections = view?.book?.sections;
    if (
      !view ||
      !Array.isArray(sections) ||
      typeof view.resolveCFI !== "function" ||
      typeof view.getLocationOf !== "function"
    ) {
      return result;
    }

    const bySection = new Map<
      number,
      Array<{ cfi: string; anchor?: (doc: Document) => Range | Node | null | undefined }>
    >();

    for (const cfi of pending) {
      let resolved: SavedItemPageResolvedCfi | null | undefined;
      try {
        resolved = await view.resolveCFI(cfi);
      } catch {
        continue;
      }
      if (!resolved) continue;
      const { index, anchor } = resolved;
      if (typeof index !== "number" || !Number.isInteger(index) || index < 0 || index >= sections.length) {
        continue;
      }
      const list = bySection.get(index);
      if (list) {
        list.push({ cfi, anchor });
      } else {
        bySection.set(index, [{ cfi, anchor }]);
      }
    }

    await Promise.all(
      Array.from(bySection.entries()).map(async ([index, entries]) => {
        const section = sections[index];
        const needsDoc = entries.some((entry) => typeof entry.anchor === "function");
        let doc: Document | null = null;
        if (needsDoc) {
          if (typeof section?.createDocument !== "function") return;
          doc = await loadSectionDoc(index, section);
          if (!doc) return;
        }

        for (const { cfi, anchor } of entries) {
          try {
            let fraction = 0;
            if (typeof anchor === "function") {
              const anchored = anchor(doc!);
              if (!anchored || (!isRange(anchored) && !isNode(anchored))) continue;
              fraction = textFractionBefore(doc!, anchored);
            }
            const loc = view.getLocationOf?.(index, fraction);
            if (loc && typeof loc.current === "number" && Number.isFinite(loc.current) && loc.current >= 0) {
              const page = loc.current + 1;
              cache.set(cfi, page);
              result.set(cfi, page);
            }
          } catch {
            // Unresolvable CFI or bad anchor — omit cleanly
          }
        }
      }),
    );

    return result;
  };
}
