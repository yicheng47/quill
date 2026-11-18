/** @vitest-environment jsdom */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  focusWindow: vi.fn<(label: string) => Promise<boolean>>(),
  emitTo: vi.fn<(label: string, event: string, payload?: unknown) => Promise<void>>(),
  openPlatformReaderWindow: vi.fn<(opts: Record<string, unknown>) => Promise<void>>(),
}));

vi.mock("../platform", () => ({
  focusWindow: (label: string) => mocks.focusWindow(label),
  emitTo: (label: string, event: string, payload?: unknown) =>
    mocks.emitTo(label, event, payload),
  openReaderWindow: (opts: Record<string, unknown>) => mocks.openPlatformReaderWindow(opts),
}));

import {
  buildReaderUrl,
  openReaderWindow,
  parseReaderNavigation,
  READER_NAVIGATE_EVENT,
} from "./openReaderWindow";

describe("openReaderWindow & deep-link parsing", () => {
  beforeEach(() => {
    mocks.focusWindow.mockReset();
    mocks.emitTo.mockReset().mockResolvedValue(undefined);
    mocks.openPlatformReaderWindow.mockReset().mockResolvedValue(undefined);
  });

  it("encodes and parses standalone cfi, quote, openChat, chatId, and openVocab params", () => {
    const url = buildReaderUrl("b1", {
      cfi: "epubcfi(/6/8!/4/2/1:0)",
      quote: "Cities, like dreams, are made of desires.",
      openChat: true,
    });
    const query = url.slice(url.indexOf("?"));
    expect(parseReaderNavigation(null, query)).toEqual({
      source: "query",
      options: {
        openVocab: false,
        openChat: true,
        chatId: undefined,
        cfi: "epubcfi(/6/8!/4/2/1:0)",
        quote: "Cities, like dreams, are made of desires.",
      },
    });

    const stateParsed = parseReaderNavigation(
      { openVocab: true, cfi: "epubcfi(/6/4!/2/1:0)" },
      "",
    );
    expect(stateParsed).toEqual({
      source: "state",
      options: {
        openVocab: true,
        openChat: false,
        chatId: undefined,
        cfi: "epubcfi(/6/4!/2/1:0)",
        quote: undefined,
      },
    });

    expect(parseReaderNavigation(null, "")).toBeNull();
  });

  it("opens a new reader window with encoded URL params when not already open", async () => {
    mocks.focusWindow.mockResolvedValue(false);

    await openReaderWindow("book-42", {
      cfi: "epubcfi(/6/10!/4/2)",
      quote: "A quoted passage",
      openChat: true,
    });

    expect(mocks.emitTo).not.toHaveBeenCalled();
    expect(mocks.openPlatformReaderWindow).toHaveBeenCalledWith(
      expect.objectContaining({
        label: "reader-book-42",
        url: "/reader/book-42?openChat=true&cfi=epubcfi%28%2F6%2F10%21%2F4%2F2%29&quote=A+quoted+passage",
      }),
    );
  });

  it("focuses an already-open reader window and emits reader-navigate only when options exist", async () => {
    mocks.focusWindow.mockResolvedValue(true);

    await openReaderWindow("book-42", {
      cfi: "epubcfi(/6/12!/4/2)",
      quote: "Updated quote",
      openChat: true,
    });
    expect(mocks.emitTo).toHaveBeenCalledWith("reader-book-42", READER_NAVIGATE_EVENT, {
      cfi: "epubcfi(/6/12!/4/2)",
      quote: "Updated quote",
      openChat: true,
    });
    expect(mocks.openPlatformReaderWindow).not.toHaveBeenCalled();

    mocks.emitTo.mockClear();
    await openReaderWindow("book-42");
    expect(mocks.emitTo).not.toHaveBeenCalled();
  });
});
