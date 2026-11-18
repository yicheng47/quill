/** @vitest-environment jsdom */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../i18n";
import type { Book } from "../hooks/useBooks";
import type { Highlight } from "../hooks/useBookmarks";
import type { DictionaryWord } from "../hooks/useDictionary";
import type { ChatSummary } from "../hooks/useChats";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn<(cmd: string, args?: Record<string, unknown>) => Promise<unknown>>(),
  openReaderWindow: vi.fn<(bookId: string, opts?: unknown) => Promise<void>>(),
}));

vi.mock("../platform", () => ({
  invoke: (cmd: string, args?: Record<string, unknown>) => mocks.invoke(cmd, args),
  convertFileSrc: (p: string) => `quill-file://local/${p}`,
}));

vi.mock("../utils/openReaderWindow", () => ({
  openReaderWindow: (bookId: string, opts?: unknown) => mocks.openReaderWindow(bookId, opts),
}));

import CommandSearchModal from "./CommandSearchModal";

describe("CommandSearchModal", () => {
  let container: HTMLDivElement;
  let root: Root;

  const flushMicrotasks = async () => {
    for (let i = 0; i < 4; i++) {
      await act(async () => {
        await Promise.resolve();
      });
    }
  };

  beforeEach(async () => {
    await i18n.changeLanguage("en");
    mocks.invoke.mockReset();
    mocks.openReaderWindow.mockReset().mockResolvedValue(undefined);
    Element.prototype.scrollIntoView = vi.fn();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    vi.useRealTimers();
    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it("cycles scopes with Tab and renders scope empty states + filtered no-match state", async () => {
    vi.useFakeTimers();
    mocks.invoke.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "list_books") return { books: [], next_cursor: null, total: 0 };
      if (cmd === "list_all_highlights") return [];
      if (cmd === "list_all_vocab_words") return [];
      if (cmd === "list_all_chats") {
        expect(args).toBeTruthy();
        return { chats: [], next_cursor: null, total: 0 };
      }
      return null;
    });

    await act(async () => {
      root.render(<CommandSearchModal open={true} onClose={vi.fn()} onNavigate={vi.fn()} />);
    });
    await act(async () => {
      vi.advanceTimersByTime(20);
    });
    await flushMicrotasks();

    const scopeButtons = Array.from(
      container.querySelectorAll<HTMLButtonElement>('[role="tab"]'),
    );
    expect(scopeButtons.map((b) => b.querySelector("span")?.textContent)).toEqual([
      "All",
      "Books",
      "Highlights",
      "Words",
      "Chats",
    ]);
    expect(container.textContent).toContain("Nothing saved to search yet");

    const input = container.querySelector<HTMLInputElement>("input")!;
    for (const expectedEmpty of [
      "No books in your library yet",
      "No highlights yet",
      "No saved words yet",
      "No conversations yet",
      "Nothing saved to search yet",
    ]) {
      await act(async () => {
        input.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
      });
      await flushMicrotasks();
      expect(container.textContent).toContain(expectedEmpty);
    }

    // Search with no results shows no-match copy
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(input, "nonexistent-xyz");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      vi.advanceTimersByTime(150);
    });
    await flushMicrotasks();
    expect(container.textContent).toContain("No matches for “nonexistent-xyz”");
  });

  it("groups cross-kind results and routes Enter vs Cmd+Enter and Esc cleanly", async () => {
    vi.useFakeTimers();
    const sampleBook: Book = {
      id: "b1",
      title: "Invisible Cities",
      author: "Italo Calvino",
      description: null,
      cover_path: null,
      file_path: "/tmp/ic.epub",
      format: "epub",
      genre: null,
      pages: 165,
      status: "reading",
      progress: 42,
      current_cfi: "epubcfi(/6/4!/4/2/1:0)",
      created_at: 1000,
      updated_at: 2000,
      available: true,
      cover_data: null,
    };
    const sampleHighlight: Highlight = {
      id: "h1",
      book_id: "b1",
      cfi_range: "epubcfi(/6/6!/4/2/1:0)",
      color: "yellow",
      note: "memory vs city",
      text_content: "Cities, like dreams, are made of desires and fears.",
      created_at: 3000,
      updated_at: 3000,
      book_title: "Invisible Cities",
      book_author: "Italo Calvino",
    };
    const sampleWord: DictionaryWord = {
      id: "w1",
      book_id: "b1",
      word: "cityscape",
      definition: "/ˈsɪt.i.skeɪp/ noun. Urban view.",
      context_sentence: "A cityscape of spires.",
      context_explanation: null,
      cfi: "epubcfi(/6/8!/4/2/1:0)",
      mastery: "learning",
      review_count: 0,
      next_review_at: null,
      created_at: 4000,
      updated_at: 4000,
      book_title: "Invisible Cities",
    };
    const sampleChat: ChatSummary = {
      id: "c1",
      book_id: "b1",
      title: "City memory symbolism",
      model: "gpt-4o-mini",
      pinned: false,
      metadata: null,
      created_at: 5000,
      updated_at: 5000,
      book_title: "Invisible Cities",
      message_count: 4,
      last_message: "Marco Polo answers Khan.",
    };

    mocks.invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "list_books") return { books: [sampleBook], next_cursor: null, total: 1 };
      if (cmd === "list_all_highlights") return [sampleHighlight];
      if (cmd === "list_all_vocab_words") return [sampleWord];
      if (cmd === "list_all_chats") return { chats: [sampleChat], next_cursor: null, total: 1 };
      return null;
    });

    const onClose = vi.fn();
    const onNavigate = vi.fn();

    await act(async () => {
      root.render(<CommandSearchModal open={true} onClose={onClose} onNavigate={onNavigate} />);
    });
    await act(async () => {
      vi.advanceTimersByTime(20);
    });
    await flushMicrotasks();

    const input = container.querySelector<HTMLInputElement>("input")!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(input, "cit");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      vi.advanceTimersByTime(150);
    });
    await flushMicrotasks();

    expect(container.textContent).toContain("Books");
    expect(container.textContent).toContain("Highlights");
    expect(container.textContent).toContain("Words & Chats");
    expect(container.textContent).toContain("Invisible Cities");
    expect(container.textContent).toContain("cityscape");
    expect(container.textContent).toContain("City memory symbolism");

    // ArrowDown moves selection from Book (0) -> Highlight (1); Enter navigates in main window
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    });
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(onNavigate).toHaveBeenCalledWith("highlights", {
      bookId: "b1",
      highlightId: "h1",
    });
    expect(onClose).toHaveBeenCalledTimes(1);

    // ArrowDown to Word (2) and Cmd+Enter opens directly in Reader at CFI
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    });
    await act(async () => {
      input.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", metaKey: true, bubbles: true }),
      );
    });
    expect(mocks.openReaderWindow).toHaveBeenCalledWith("b1", {
      cfi: "epubcfi(/6/8!/4/2/1:0)",
      openVocab: true,
    });

    // Escape closes palette
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it("resolves chat quote contextCfi when opening a chat result directly in Reader via Cmd+Enter", async () => {
    vi.useFakeTimers();
    const chatHit: ChatSummary = {
      id: "chat-a",
      book_id: "b1",
      title: "QA archive Frankenstein A",
      model: "gpt-4o-mini",
      pinned: false,
      metadata: null,
      created_at: 5000,
      updated_at: 5000,
      book_title: "Frankenstein",
      message_count: 2,
      last_message: "Letter I analysis",
    };

    mocks.invoke.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "list_books") return { books: [], next_cursor: null, total: 0 };
      if (cmd === "list_all_highlights") return [];
      if (cmd === "list_all_vocab_words") return [];
      if (cmd === "list_all_chats") return { chats: [chatHit], next_cursor: null, total: 1 };
      if (cmd === "list_chat_messages" && args?.chatId === "chat-a") {
        return [
          { id: "m1", chat_id: "chat-a", role: "user", content: "Explain", metadata: JSON.stringify({ cfi: "epubcfi(/6/4!/4/2/1:0)" }) },
          { id: "m2", chat_id: "chat-a", role: "assistant", content: "Here is why", metadata: null },
        ];
      }
      return [];
    });

    await act(async () => {
      root.render(
        <CommandSearchModal open={true} onClose={vi.fn()} onNavigate={vi.fn()} initialScope="chats" />,
      );
    });
    await act(async () => {
      vi.advanceTimersByTime(20);
    });
    await flushMicrotasks();

    const input = container.querySelector<HTMLInputElement>("input")!;
    await act(async () => {
      input.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", metaKey: true, bubbles: true }),
      );
    });
    await flushMicrotasks();

    expect(mocks.openReaderWindow).toHaveBeenCalledWith("b1", {
      openChat: true,
      chatId: "chat-a",
      cfi: "epubcfi(/6/4!/4/2/1:0)",
    });
  });

  it("ignores stale prior results on rapid query + Enter and activates the new query hit once settled", async () => {
    vi.useFakeTimers();
    const ch5Highlight: Highlight = {
      id: "hl-ch5",
      book_id: "b1",
      cfi_range: "epubcfi(/6/14!/4/2:0)",
      color: "yellow",
      note: null,
      text_content: "QA chapter five anchor",
      created_at: 9000,
      updated_at: 9000,
      book_title: "Frankenstein",
      book_author: "Mary Shelley",
    };
    const letter1Highlight: Highlight = {
      id: "hl-let1",
      book_id: "b1",
      cfi_range: "epubcfi(/6/4!/4/2:0)",
      color: "blue",
      note: null,
      text_content: "QA letter one anchor",
      created_at: 2000,
      updated_at: 2000,
      book_title: "Frankenstein",
      book_author: "Mary Shelley",
    };

    let resolveLetterSearch: ((items: Highlight[]) => void) | null = null;
    mocks.invoke.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "list_books") return { books: [], next_cursor: null, total: 0 };
      if (cmd === "list_all_vocab_words") return [];
      if (cmd === "list_all_chats") return { chats: [], next_cursor: null, total: 0 };
      if (cmd === "list_all_highlights") {
        if (args?.search === "QA letter one anchor") {
          return await new Promise<Highlight[]>((resolve) => {
            resolveLetterSearch = resolve;
          });
        }
        return [ch5Highlight, letter1Highlight];
      }
      return null;
    });

    const onClose = vi.fn();
    const onNavigate = vi.fn();
    await act(async () => {
      root.render(<CommandSearchModal open={true} onClose={onClose} onNavigate={onNavigate} />);
    });
    await act(async () => {
      vi.advanceTimersByTime(20);
    });
    await flushMicrotasks();

    // Reopen cleanly; verify stale items cleared on close and empty query settles with ch5 first
    await act(async () => {
      root.render(<CommandSearchModal open={false} onClose={onClose} onNavigate={onNavigate} />);
    });
    await act(async () => {
      root.render(<CommandSearchModal open={true} onClose={onClose} onNavigate={onNavigate} />);
    });
    await act(async () => {
      vi.advanceTimersByTime(20);
    });
    await flushMicrotasks();

    const input = container.querySelector<HTMLInputElement>("input")!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(input, "QA letter one anchor");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });

    const highlightsTab = Array.from(
      container.querySelectorAll<HTMLButtonElement>('[role="tab"]'),
    ).find((b) => b.textContent?.includes("Highlights"));
    expect(highlightsTab).toBeTruthy();

    // Switch scope and hit Return immediately while 100ms debounce + new fetch are still unresolved
    await act(async () => {
      highlightsTab!.click();
    });
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    await flushMicrotasks();

    // Stale ch5 highlight must NOT have been activated
    expect(onNavigate).not.toHaveBeenCalled();

    // Resolve the fresh query for "QA letter one anchor" -> pending Return immediately selects hl-let1
    expect(resolveLetterSearch).toBeTruthy();
    await act(async () => {
      resolveLetterSearch!([letter1Highlight]);
    });
    await flushMicrotasks();

    expect(onNavigate).toHaveBeenCalledTimes(1);
    expect(onNavigate).toHaveBeenCalledWith("highlights", {
      bookId: "b1",
      highlightId: "hl-let1",
    });
  });
});
