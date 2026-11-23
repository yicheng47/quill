/** @vitest-environment jsdom */

import { describe, expect, it, vi } from "vitest";
// @ts-expect-error -- foliate-js has no TS declarations
import { SectionProgress } from "../../public/foliate-js/progress.js";
import {
  createSavedItemPageResolver,
  resolvePdfPageFromCfi,
  textFractionBefore,
  type SavedItemPageView,
} from "./savedItemPages";

function parseHtml(html: string): Document {
  return new DOMParser().parseFromString(html, "text/html");
}

function parseXhtml(xhtml: string): Document {
  return new DOMParser().parseFromString(xhtml, "application/xhtml+xml");
}

describe("textFractionBefore", () => {
  it("returns 0 at the start, exact ratio in the middle, and 1 at the end of a section", () => {
    const doc = parseHtml("<html><body><p>0123456789</p></body></html>");
    const text = doc.querySelector("p")!.firstChild as Text;

    const startRange = doc.createRange();
    startRange.setStart(text, 0);
    startRange.setEnd(text, 3);
    expect(textFractionBefore(doc, startRange)).toBe(0);

    const midRange = doc.createRange();
    midRange.setStart(text, 5);
    midRange.setEnd(text, 8);
    expect(textFractionBefore(doc, midRange)).toBeCloseTo(0.5);

    const endRange = doc.createRange();
    endRange.setStart(text, 10);
    endRange.setEnd(text, 10);
    expect(textFractionBefore(doc, endRange)).toBe(1);
  });

  it("handles ranges inside deeply nested elements and XHTML documents", () => {
    const doc = parseXhtml(
      `<html xmlns="http://www.w3.org/1999/xhtml"><body><div><p>Hello <em><span>world</span></em>!</p><p>Tail</p></div></body></html>`,
    );
    const spanText = doc.querySelector("span")!.firstChild as Text;
    const range = doc.createRange();
    range.setStart(spanText, 2);
    range.setEnd(spanText, 5);

    // Total body text: "Hello world!Tail" (16 chars); before range start: "Hello wo" (8 chars)
    expect(textFractionBefore(doc, range)).toBeCloseTo(8 / 16);
  });

  it("handles Node anchors (Element and Text nodes)", () => {
    const doc = parseHtml("<html><body><p>First</p><p>Second</p></body></html>");
    const paragraphs = doc.querySelectorAll("p");

    // "First" is 5 chars out of 11 ("FirstSecond")
    expect(textFractionBefore(doc, paragraphs[1])).toBeCloseTo(5 / 11);
    expect(textFractionBefore(doc, paragraphs[1].firstChild!)).toBeCloseTo(5 / 11);
    expect(textFractionBefore(doc, doc.body)).toBe(0);
  });

  it("returns 0 for an empty or missing body", () => {
    const emptyBodyDoc = parseHtml("<html><body></body></html>");
    const range = emptyBodyDoc.createRange();
    range.setStart(emptyBodyDoc.body, 0);
    range.setEnd(emptyBodyDoc.body, 0);
    expect(textFractionBefore(emptyBodyDoc, range)).toBe(0);

    const xmlNoBody = new DOMParser().parseFromString("<svg><text>abc</text></svg>", "application/xml");
    const nodeRange = xmlNoBody.createRange();
    nodeRange.selectNodeContents(xmlNoBody.documentElement);
    expect(textFractionBefore(xmlNoBody, nodeRange)).toBe(0);
  });
});

describe("createSavedItemPageResolver", () => {
  it("maps valid PDF CFIs within section bounds without loading any section document and rejects malformed or out-of-range inputs", async () => {
    const createDocument = vi.fn(async () => parseHtml("<html><body>unused</body></html>"));
    const resolveCFI = vi.fn();
    const getLocationOf = vi.fn();
    const view: SavedItemPageView = {
      book: { sections: Array.from({ length: 100 }, () => ({ createDocument })) },
      resolveCFI,
      getLocationOf,
    };

    const resolvePages = createSavedItemPageResolver(view, "pdf");
    const pages = await resolvePages([
      "epubcfi(/6/2!/4/2/1:0)",
      "epubcfi(/6/102!/4/2/1:0)",
      "epubcfi(/6/200)",
      "page:14",
      "0",
      "epubcfi(/6/202)",
      "epubcfi(/6/202!/4/2/1:0)",
      "epubcfi(/6/101)",
      "epubcfi(/6/101!/4/2)",
      "epubcfi(/6/102",
      "epubcfi(/6/0)",
      "epubcfi(/6/102!)",
      "page:100",
      "not-a-pdf-cfi",
    ]);

    expect(pages.get("epubcfi(/6/2!/4/2/1:0)")).toBe(1);
    expect(pages.get("epubcfi(/6/102!/4/2/1:0)")).toBe(51);
    expect(pages.get("epubcfi(/6/200)")).toBe(100);
    expect(pages.get("page:14")).toBe(15);
    expect(pages.get("0")).toBe(1);

    expect(pages.has("epubcfi(/6/202)")).toBe(false);
    expect(pages.has("epubcfi(/6/202!/4/2/1:0)")).toBe(false);
    expect(pages.has("epubcfi(/6/101)")).toBe(false);
    expect(pages.has("epubcfi(/6/101!/4/2)")).toBe(false);
    expect(pages.has("epubcfi(/6/102")).toBe(false);
    expect(pages.has("epubcfi(/6/0)")).toBe(false);
    expect(pages.has("epubcfi(/6/102!)")).toBe(false);
    expect(pages.has("page:100")).toBe(false);
    expect(pages.has("not-a-pdf-cfi")).toBe(false);

    expect(createDocument).not.toHaveBeenCalled();
    expect(resolveCFI).not.toHaveBeenCalled();
    expect(getLocationOf).not.toHaveBeenCalled();

    expect(resolvePdfPageFromCfi("epubcfi(/6/2)", 0)).toBeNull();
    expect(resolvePdfPageFromCfi("epubcfi(/6/102)", 50)).toBeNull();
    expect(resolvePdfPageFromCfi("epubcfi(/6/102)", 51)).toBe(51);
  });

  it("loads an EPUB section once when resolving multiple CFIs in that section and computes SectionProgress locations", async () => {
    const sectionProgress = new SectionProgress(
      [
        { size: 3000 }, // locations 0..1 (pages 1..2)
        { size: 4500 }, // locations 2..4 (pages 3..5)
      ],
      1500,
      1600,
    );

    const section0Doc = parseHtml("<html><body><p>0123456789</p></body></html>");
    const section1Doc = parseHtml("<html><body><p>AAAAABBBBBCCCCC</p></body></html>");

    const createDoc0 = vi.fn(async () => section0Doc);
    const createDoc1 = vi.fn(async () => section1Doc);

    const resolveCFI = vi.fn((cfi: string) => {
      if (cfi === "cfi-s1-start") {
        return {
          index: 1,
          anchor: (doc: Document) => {
            const r = doc.createRange();
            r.setStart(doc.querySelector("p")!.firstChild!, 0);
            r.setEnd(doc.querySelector("p")!.firstChild!, 2);
            return r;
          },
        };
      }
      if (cfi === "cfi-s1-mid") {
        return {
          index: 1,
          anchor: (doc: Document) => {
            const r = doc.createRange();
            // 10 / 15 = 2/3 of 4500 = 3000 -> total size = 3000 + 3000 = 6000 -> loc 4 -> page 5
            r.setStart(doc.querySelector("p")!.firstChild!, 10);
            r.setEnd(doc.querySelector("p")!.firstChild!, 12);
            return r;
          },
        };
      }
      if (cfi === "cfi-s0-node") {
        return {
          index: 0,
          anchor: (doc: Document) => doc.querySelector("p")!,
        };
      }
      return null;
    });

    const view: SavedItemPageView = {
      book: {
        sections: [{ createDocument: createDoc0 }, { createDocument: createDoc1 }],
      },
      resolveCFI,
      getLocationOf: (index, fraction = 0) => sectionProgress.getProgress(index, fraction).location,
    };

    const resolvePages = createSavedItemPageResolver(view, "epub");
    const pages = await resolvePages(["cfi-s1-start", "cfi-s1-mid", "cfi-s0-node"]);

    expect(createDoc1).toHaveBeenCalledTimes(1);
    expect(createDoc0).toHaveBeenCalledTimes(1);
    // section 0 start -> size 0 -> loc 0 -> page 1
    expect(pages.get("cfi-s0-node")).toBe(1);
    // section 1 start -> size 3000 -> loc 2 -> page 3
    expect(pages.get("cfi-s1-start")).toBe(3);
    // section 1 at 2/3 -> size 6000 -> loc 4 -> page 5
    expect(pages.get("cfi-s1-mid")).toBe(5);
  });

  it("omits unresolvable or throwing CFIs without breaking valid siblings", async () => {
    const doc = parseHtml("<html><body><p>Hello world</p></body></html>");
    const createDoc0 = vi.fn(async () => doc);
    const createDoc1 = vi.fn(async () => {
      throw new Error("corrupt section");
    });

    const view: SavedItemPageView = {
      book: {
        sections: [{ createDocument: createDoc0 }, { createDocument: createDoc1 }],
      },
      resolveCFI: (cfi) => {
        if (cfi === "cfi-throws") throw new Error("malformed");
        if (cfi === "cfi-bad-index") return { index: -1, anchor: () => doc.body };
        if (cfi === "cfi-oob-index") return { index: 99, anchor: () => doc.body };
        if (cfi === "cfi-anchor-throws") {
          return {
            index: 0,
            anchor: () => {
              throw new Error("missing node");
            },
          };
        }
        if (cfi === "cfi-anchor-null") return { index: 0, anchor: () => null };
        if (cfi === "cfi-doc-rejects") return { index: 1, anchor: (d) => d.body };
        if (cfi === "cfi-valid") return { index: 0, anchor: (d) => d.querySelector("p")! };
        return null;
      },
      getLocationOf: () => ({ current: 6, total: 20 }),
    };

    const resolvePages = createSavedItemPageResolver(view, "epub");
    const pages = await resolvePages([
      "cfi-throws",
      "cfi-bad-index",
      "cfi-oob-index",
      "cfi-anchor-throws",
      "cfi-anchor-null",
      "cfi-doc-rejects",
      "cfi-valid",
    ]);

    expect(Array.from(pages.entries())).toEqual([["cfi-valid", 7]]);
  });

  it("reuses the per-book cache so cached CFIs are not resolved again", async () => {
    const doc = parseHtml("<html><body><p>Chapter text</p></body></html>");
    const createDocument = vi.fn(async () => doc);
    const resolveCFI = vi.fn(() => ({
      index: 0,
      anchor: (d: Document) => d.querySelector("p")!,
    }));
    const getLocationOf = vi.fn(() => ({ current: 11, total: 40 }));

    const view: SavedItemPageView = {
      book: { sections: [{ createDocument }] },
      resolveCFI,
      getLocationOf,
    };

    const resolvePages = createSavedItemPageResolver(view, "epub");
    const first = await resolvePages(["cfi-cached"]);
    expect(first.get("cfi-cached")).toBe(12);
    expect(resolveCFI).toHaveBeenCalledTimes(1);
    expect(createDocument).toHaveBeenCalledTimes(1);

    const second = await resolvePages(["cfi-cached"]);
    expect(second.get("cfi-cached")).toBe(12);
    expect(resolveCFI).toHaveBeenCalledTimes(1);
    expect(createDocument).toHaveBeenCalledTimes(1);
    expect(getLocationOf).toHaveBeenCalledTimes(1);
  });
});
