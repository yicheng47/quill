import { describe, expect, it } from "vitest";
import type { Highlight } from "../hooks/useBookmarks";
import { extractPdfPageIndex, sortHighlights } from "./highlightSort";

function hl(
  id: string,
  bookId: string,
  cfiRange: string,
  createdAt: number,
  bookTitle = `Book ${bookId}`,
): Highlight {
  return {
    id,
    book_id: bookId,
    cfi_range: cfiRange,
    color: "yellow",
    note: null,
    text_content: `Highlight ${id}`,
    created_at: createdAt,
    updated_at: createdAt,
    book_title: bookTitle,
    book_author: "Author",
  };
}

describe("highlightSort", () => {
  it("sorts newest and oldest by created_at", () => {
    const items = [
      hl("h1", "b1", "epubcfi(/6/4!/4/2/1:0)", 100),
      hl("h2", "b1", "epubcfi(/6/2!/4/2/1:0)", 300),
      hl("h3", "b1", "epubcfi(/6/6!/4/2/1:0)", 200),
    ];

    expect(sortHighlights(items, "newest").map((h) => h.id)).toEqual(["h2", "h3", "h1"]);
    expect(sortHighlights(items, "oldest").map((h) => h.id)).toEqual(["h1", "h3", "h2"]);
  });

  it("groups by book and orders EPUB CFIs with foliate-js compare in chapter order", () => {
    const items = [
      hl("e-ch3", "b1", "epubcfi(/6/12!/4/2/1:0,/4/2/1:10)", 10, "Alpha"),
      hl("b2-later", "b2", "epubcfi(/6/8!/4/2/1:0)", 50, "Beta"),
      hl("e-ch1-b", "b1", "epubcfi(/6/4!/4/10/1:20,/4/10/1:30)", 5, "Alpha"),
      hl("e-ch1-a", "b1", "epubcfi(/6/4!/4/2/1:0,/4/2/1:8)", 99, "Alpha"),
      hl("b2-early", "b2", "epubcfi(/6/2!/4/2/1:0)", 90, "Beta"),
    ];

    const formats = new Map<string, string>([
      ["b1", "epub"],
      ["b2", "epub"],
    ]);
    const bookOrder = new Map<string, number>([
      ["b1", 0],
      ["b2", 1],
    ]);

    const sorted = sortHighlights(items, "chapter", { bookFormats: formats, bookOrder });
    expect(sorted.map((h) => h.id)).toEqual([
      "e-ch1-a",
      "e-ch1-b",
      "e-ch3",
      "b2-early",
      "b2-later",
    ]);
  });

  it("orders PDF highlights by page number and within-page position", () => {
    expect(extractPdfPageIndex("epubcfi(/6/2!/4/2/1:0)")).toBe(0);
    expect(extractPdfPageIndex("epubcfi(/6/20!/4/2/1:0)")).toBe(9);
    expect(extractPdfPageIndex("page:14")).toBe(14);

    const items = [
      hl("p10", "pdf1", "epubcfi(/6/20!/4/2/1:0)", 10, "PDF Book"),
      hl("p2-b", "pdf1", "epubcfi(/6/4!/4/8/1:0)", 20, "PDF Book"),
      hl("p2-a", "pdf1", "epubcfi(/6/4!/4/2/1:0)", 90, "PDF Book"),
      hl("p1", "pdf1", "epubcfi(/6/2!/4/2/1:0)", 100, "PDF Book"),
    ];
    const formats = new Map<string, string>([["pdf1", "pdf"]]);

    const sorted = sortHighlights(items, "chapter", { bookFormats: formats });
    expect(sorted.map((h) => h.id)).toEqual(["p1", "p2-a", "p2-b", "p10"]);
  });

  it("falls back safely on malformed CFIs without throwing", () => {
    const items = [
      hl("bad2", "b1", "not-a-cfi", 200),
      hl("bad1", "b1", "broken", 100),
    ];
    expect(sortHighlights(items, "chapter").map((h) => h.id)).toEqual(["bad1", "bad2"]);
  });
});
