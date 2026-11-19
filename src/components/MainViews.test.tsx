/** @vitest-environment jsdom */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../i18n";
import type { Book } from "../hooks/useBooks";
import type { Highlight, HighlightCounts } from "../hooks/useBookmarks";
import type { DictionaryWord } from "../hooks/useDictionary";
import type { ChatSummary } from "../hooks/useChats";
import type { Collection } from "../hooks/useCollections";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn<(cmd: string, args?: Record<string, unknown>) => Promise<unknown>>(),
  openReaderWindow: vi.fn<(bookId: string, opts?: unknown) => Promise<void>>(),
  listen: vi.fn<(event: string, cb: (e: { payload: unknown }) => void) => Promise<() => void>>(),
}));

vi.mock("../platform", () => ({
  invoke: (cmd: string, args?: Record<string, unknown>) => mocks.invoke(cmd, args),
  convertFileSrc: (p: string) => `quill-file://local/${p}`,
  listen: (event: string, cb: (e: { payload: unknown }) => void) => mocks.listen(event, cb),
  focusWindow: vi.fn().mockResolvedValue(true),
}));

vi.mock("../utils/openReaderWindow", () => ({
  openReaderWindow: (bookId: string, opts?: unknown) => mocks.openReaderWindow(bookId, opts),
}));

import HomeView from "./HomeView";
import HighlightsView from "./HighlightsView";
import WordsView from "./WordsView";
import ChatsView from "./ChatsView";
import AiPanel from "./AiPanel";

function makeBook(id: string, overrides?: Partial<Book>): Book {
  return {
    id,
    title: `Book ${id}`,
    author: `Author ${id}`,
    description: null,
    cover_path: null,
    file_path: `/tmp/${id}.epub`,
    format: "epub",
    genre: null,
    pages: 200,
    status: "reading",
    progress: 40,
    current_cfi: `epubcfi(/6/4!/4/2/1:0)`,
    created_at: 1000,
    updated_at: 5000,
    available: true,
    cover_data: null,
    ...overrides,
  };
}

function setInputValue(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  setter?.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("Main Views (Home, Highlights, Words, Chats)", () => {
  let container: HTMLDivElement;
  let root: Root;

  const flushMicrotasks = async () => {
    for (let i = 0; i < 6; i++) {
      await act(async () => {
        await Promise.resolve();
      });
    }
  };

  beforeEach(async () => {
    await i18n.changeLanguage("en");
    mocks.invoke.mockReset();
    mocks.openReaderWindow.mockReset().mockResolvedValue(undefined);
    mocks.listen.mockReset().mockImplementation(async () => () => {});
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

  describe("HomeView", () => {
    it("renders first-launch empty state with specimen cards and routes Import / iCloud Sync", async () => {
      mocks.invoke.mockResolvedValue([]);
      const onImport = vi.fn();
      const onOpenSettings = vi.fn();

      await act(async () => {
        root.render(
          <HomeView
            books={[]}
            totalBooksCount={0}
            booksLoading={false}
            collections={[]}
            onNavigate={vi.fn()}
            onImport={onImport}
            onOpenSettings={onOpenSettings}
          />,
        );
      });
      await flushMicrotasks();

      expect(container.textContent).toContain("Your quiet reading room");
      expect(container.textContent).toContain("palimpsest");
      expect(container.textContent).toContain("Psychological time");

      const importBtn = Array.from(container.querySelectorAll("button")).find((b) =>
        b.textContent?.includes("Import Your First Book"),
      );
      await act(async () => {
        importBtn?.click();
      });
      expect(onImport).toHaveBeenCalledTimes(1);

      const icloudBtn = Array.from(container.querySelectorAll("button")).find((b) =>
        b.textContent?.includes("Turn On iCloud Sync"),
      );
      if (icloudBtn) {
        await act(async () => {
          icloudBtn.click();
        });
        expect(onOpenSettings).toHaveBeenCalledWith("librarySync");
      }
    });

    it("renders populated bento, estimates remaining reading time, and triggers Ask/word/chat/collection links", async () => {
      const books: Book[] = [
        makeBook("b1", {
          title: "The Power of Now",
          author: "Eckhart Tolle",
          pages: 200,
          progress: 60, // 80 pages left * 1.5 min = 120 min = 2h
          current_cfi: "epubcfi(/6/10!/4/2/1:0)",
        }),
        makeBook("b2", {
          title: "Invisible Cities",
          author: "Italo Calvino",
          status: "reading",
          progress: 25,
          updated_at: 4000,
        }),
      ];
      const collections: Collection[] = [
        { id: "col1", name: "Philosophy", book_count: 1, sort_order: 0, created_at: 10, updated_at: 10 },
      ];
      const latestHighlight: Highlight = {
        id: "hl1",
        book_id: "b1",
        cfi_range: "epubcfi(/6/10!/4/4/1:0)",
        color: "yellow",
        note: null,
        text_content: "Attention without judgment quiets the mind.",
        created_at: 9000,
        updated_at: 9000,
      };
      const word: DictionaryWord = {
        id: "w1",
        book_id: "b1",
        word: "ponderous",
        definition: "/ˈpɒndərəs/ adj. Heavy.",
        context_sentence: null,
        context_explanation: null,
        cfi: null,
        mastery: "learning",
        review_count: 0,
        next_review_at: null,
        created_at: 8000,
        updated_at: 8000,
        book_title: "The Power of Now",
      };
      const chat: ChatSummary = {
        id: "ch1",
        book_id: "b1",
        title: "Meaning of nonresistance",
        model: "gpt-4o-mini",
        pinned: false,
        metadata: null,
        created_at: 7000,
        updated_at: 7000,
        book_title: "The Power of Now",
        message_count: 4,
        last_message: "Inner peace arises from presence.",
      };

      mocks.invoke.mockImplementation(async (cmd: string) => {
        if (cmd === "list_all_highlights") return [latestHighlight];
        if (cmd === "list_all_vocab_words") return [word];
        if (cmd === "list_all_chats") return { chats: [chat], next_cursor: null, total: 1 };
        return [];
      });

      const onNavigate = vi.fn();

      await act(async () => {
        root.render(
          <HomeView
            books={books}
            totalBooksCount={2}
            booksLoading={false}
            collections={collections}
            onNavigate={onNavigate}
            onImport={vi.fn()}
            onOpenSettings={vi.fn()}
          />,
        );
      });
      await flushMicrotasks();

      expect(container.textContent).toContain("The Power of Now");
      expect(container.textContent).toContain("about 2 h left at your pace");
      expect(container.textContent).toContain("Attention without judgment quiets the mind.");
      expect(container.textContent).toContain("ponderous");
      expect(container.textContent).toContain("Meaning of nonresistance");

      // Ask about this part opens reader with quote + highlight cfi
      const askBtn = Array.from(container.querySelectorAll("button")).find((b) =>
        b.textContent?.includes("Ask about this part"),
      );
      await act(async () => {
        askBtn?.click();
      });
      expect(mocks.openReaderWindow).toHaveBeenCalledWith("b1", {
        cfi: "epubcfi(/6/10!/4/4/1:0)",
        quote: "Attention without judgment quiets the mind.",
        openChat: true,
      });

      // Clicking saved word chip navigates to Words
      const wordChip = Array.from(container.querySelectorAll("button")).find(
        (b) => b.textContent === "ponderous",
      );
      await act(async () => {
        wordChip?.click();
      });
      expect(onNavigate).toHaveBeenCalledWith("words", { wordId: "w1" });

      // Clicking collection chip navigates to filtered Library
      const colChip = Array.from(container.querySelectorAll("button")).find((b) =>
        b.textContent?.includes("Philosophy"),
      );
      await act(async () => {
        colChip?.click();
      });
      expect(onNavigate).toHaveBeenCalledWith("library", {
        collectionId: "col1",
        statusFilter: "all",
      });

      // Last conversation bento card keeps last_message selectable without navigating on pointer-drag release
      const lastChatCard = Array.from(container.querySelectorAll<HTMLElement>('section[role="button"]')).find(
        (s) => s.textContent?.includes("Meaning of nonresistance"),
      )!;
      const lastChatTitle = lastChatCard.querySelector("h2")!;
      const lastChatExcerpt = Array.from(lastChatCard.querySelectorAll("p")).find((p) =>
        p.textContent?.includes("Inner peace arises from presence."),
      )!;
      expect(lastChatTitle.className).not.toContain("select-text");
      expect(lastChatExcerpt.className).toContain("select-text");

      const sel = window.getSelection();
      sel?.removeAllRanges();
      const excerptText = lastChatExcerpt.firstChild!;

      // First drag-selection on excerpt suppresses click release
      const range1 = document.createRange();
      range1.setStart(excerptText, 0);
      range1.setEnd(excerptText, 11);
      onNavigate.mockClear();
      await act(async () => {
        lastChatExcerpt.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, detail: 1 }));
        sel?.removeAllRanges();
        sel?.addRange(range1);
        document.dispatchEvent(new Event("selectionchange"));
        lastChatExcerpt.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 }));
      });
      expect(onNavigate).not.toHaveBeenCalled();

      // Second drag-selection replacing range1 also suppresses click release
      const range2 = document.createRange();
      range2.setStart(excerptText, 12);
      range2.setEnd(excerptText, 24);
      await act(async () => {
        lastChatExcerpt.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, detail: 1 }));
        sel?.removeAllRanges();
        sel?.addRange(range2);
        document.dispatchEvent(new Event("selectionchange"));
        lastChatExcerpt.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 }));
      });
      expect(onNavigate).not.toHaveBeenCalled();

      // First ordinary pointer click on unselectable card title activates even while range2 remains selected
      await act(async () => {
        lastChatTitle.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, detail: 1 }));
        lastChatTitle.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 }));
      });
      expect(onNavigate).toHaveBeenCalledTimes(1);
      expect(onNavigate).toHaveBeenLastCalledWith("chats", { chatId: "ch1" });

      // Keyboard activation and normal clicks with no selection still navigate to Chats
      await act(async () => {
        lastChatCard.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
      });
      expect(onNavigate).toHaveBeenCalledTimes(2);
      expect(onNavigate).toHaveBeenLastCalledWith("chats", { chatId: "ch1" });

      onNavigate.mockClear();
      sel?.removeAllRanges();
      await act(async () => {
        lastChatCard.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, detail: 1 }));
        lastChatCard.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 }));
      });
      expect(onNavigate).toHaveBeenCalledWith("chats", { chatId: "ch1" });
    });
  });

  describe("HighlightsView", () => {
    it("renders empty state and navigates to Library on CTA", async () => {
      mocks.invoke.mockImplementation(async (cmd: string) => {
        if (cmd === "get_highlight_counts") return { total: 0, book_count: 0, books: [] };
        if (cmd === "list_all_highlights") return [];
        return null;
      });
      const onNavigateToLibrary = vi.fn();

      await act(async () => {
        root.render(
          <HighlightsView
            booksById={new Map()}
            onNavigateToLibrary={onNavigateToLibrary}
          />,
        );
      });
      await flushMicrotasks();

      expect(container.textContent).toContain("No highlights yet");
      const cta = Array.from(container.querySelectorAll("button")).find((b) =>
        b.textContent?.includes("Open a Book to Start Reading"),
      );
      await act(async () => {
        cta?.click();
      });
      expect(onNavigateToLibrary).toHaveBeenCalledTimes(1);
    });

    it("supports color filter, filtered no-match, Book chapter order sort, recolor, inline note edit, and delete confirmation", async () => {
      const booksById = new Map<string, Book>([
        ["b1", makeBook("b1", { title: "Alpha", format: "epub" })],
        ["b2", makeBook("b2", { title: "Manual", format: "pdf" })],
      ]);
      const counts: HighlightCounts = {
        total: 3,
        book_count: 2,
        books: [
          { book_id: "b1", book_title: "Alpha", book_author: "A", book_progress: 40, cover_path: null, count: 2 },
          { book_id: "b2", book_title: "Manual", book_author: "B", book_progress: 10, cover_path: null, count: 1 },
        ],
      };
      let list: Highlight[] = [
        {
          id: "h-later-ch",
          book_id: "b1",
          cfi_range: "epubcfi(/6/12!/4/2/1:0,/4/2/1:5)",
          color: "yellow",
          note: "Ch 3 note",
          text_content: "Later chapter quote",
          created_at: 3000,
          updated_at: 3000,
          book_title: "Alpha",
        },
        {
          id: "h-earlier-ch",
          book_id: "b1",
          cfi_range: "epubcfi(/6/4!/4/2/1:0,/4/2/1:5)",
          color: "green",
          note: null,
          text_content: "Earlier chapter quote",
          created_at: 1000,
          updated_at: 1000,
          book_title: "Alpha",
        },
        {
          id: "h-pdf",
          book_id: "b2",
          cfi_range: "epubcfi(/6/6!/4/2/1:0)",
          color: "blue",
          note: null,
          text_content: "PDF passage",
          created_at: 2000,
          updated_at: 2000,
          book_title: "Manual",
        },
      ];

      mocks.invoke.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
        if (cmd === "get_highlight_counts") return counts;
        if (cmd === "list_all_highlights") {
          const q = (args?.search as string | null)?.toLowerCase();
          return list.filter((h) =>
            !q || (h.text_content ?? "").toLowerCase().includes(q),
          );
        }
        if (cmd === "update_highlight_note") {
          list = list.map((h) => (h.id === args?.id ? { ...h, note: String(args?.note) } : h));
          return null;
        }
        if (cmd === "update_highlight_color") {
          list = list.map((h) => (h.id === args?.id ? { ...h, color: String(args?.color) } : h));
          return null;
        }
        if (cmd === "remove_highlight") {
          list = list.filter((h) => h.id !== args?.id);
          return null;
        }
        return null;
      });

      await act(async () => {
        root.render(
          <HighlightsView booksById={booksById} onNavigateToLibrary={vi.fn()} />,
        );
      });
      await flushMicrotasks();

      // Selected rail icon and count use text-accent-fg for dark-mode contrast on bg-accent-tint
      const activeRailBtn = container.querySelector<HTMLButtonElement>('aside button[aria-current="true"]');
      expect(activeRailBtn?.querySelector("svg")?.getAttribute("class")).toContain("text-accent-fg");
      expect(activeRailBtn?.querySelector(".font-mono")?.className).toContain("text-accent-fg");
      expect(activeRailBtn?.querySelector(".text-accent")).toBeNull();

      // Switch sort to Book chapter order -> Earlier chapter quote comes before Later chapter quote
      const sortBtn = container.querySelector<HTMLButtonElement>('button[aria-label="Sort highlights"]');
      await act(async () => {
        sortBtn?.click();
      });
      const chapterOpt = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')).find(
        (b) => b.textContent?.includes("Book chapter order"),
      );
      await act(async () => {
        chapterOpt?.click();
      });
      await flushMicrotasks();

      const cardOrder = Array.from(
        container.querySelectorAll<HTMLElement>("article[data-highlight-id]"),
      ).map((el) => el.dataset.highlightId);
      expect(cardOrder).toEqual(["h-earlier-ch", "h-later-ch", "h-pdf"]);

      // Color filter: Pink has no highlights -> no-match state + Clear filters
      const pinkFilter = container.querySelector<HTMLButtonElement>('button[aria-label="Pink"]');
      await act(async () => {
        pinkFilter?.click();
      });
      expect(container.textContent).toContain("No highlights match your filter");
      const clearBtn = Array.from(container.querySelectorAll("button")).find((b) =>
        b.textContent?.includes("Clear filters"),
      );
      await act(async () => {
        clearBtn?.click();
      });
      expect(container.querySelectorAll("article[data-highlight-id]")).toHaveLength(3);

      // Recolor first card to Blue
      const firstCard = container.querySelector<HTMLElement>('article[data-highlight-id="h-earlier-ch"]')!;
      const recolorBlue = firstCard.querySelector<HTMLButtonElement>(
        'button[aria-label="Change highlight color to Blue"]',
      );
      await act(async () => {
        recolorBlue?.click();
      });
      expect(mocks.invoke).toHaveBeenCalledWith("update_highlight_color", {
        id: "h-earlier-ch",
        color: "blue",
      });

      // Inline note edit + Save Note
      const editBtn = firstCard.querySelector<HTMLButtonElement>('button[aria-label="Edit note"]');
      await act(async () => {
        editBtn?.click();
      });
      const textarea = firstCard.querySelector<HTMLTextAreaElement>("textarea")!;
      await act(async () => {
        setInputValue(textarea, "Updated margin note");
      });
      const saveBtn = Array.from(firstCard.querySelectorAll("button")).find((b) =>
        b.textContent?.includes("Save Note"),
      );
      await act(async () => {
        saveBtn?.click();
      });
      await flushMicrotasks();
      expect(mocks.invoke).toHaveBeenCalledWith("update_highlight_note", {
        id: "h-earlier-ch",
        note: "Updated margin note",
      });
      expect(firstCard.textContent).toContain("Updated margin note");

      // Saved note span keeps select-text; pointer selection ignores click while keyboard-style click (detail=0) edits
      const noteSpan = Array.from(firstCard.querySelectorAll("button span")).find((s) =>
        s.textContent?.includes("Updated margin note"),
      )!;
      const noteBtn = noteSpan.closest("button")!;
      expect(noteSpan.className).toContain("select-text");

      const range = document.createRange();
      range.selectNodeContents(noteSpan);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);

      await act(async () => {
        noteBtn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 }));
      });
      expect(firstCard.querySelector("textarea")).toBeNull();

      await act(async () => {
        noteBtn.click();
      });
      expect(firstCard.querySelector("textarea")).not.toBeNull();
      const cancelNoteBtn = Array.from(firstCard.querySelectorAll("button")).find((b) =>
        b.textContent?.includes("Cancel"),
      );
      await act(async () => {
        cancelNoteBtn?.click();
      });
      sel?.removeAllRanges();

      // Delete confirmation popover -> Remove
      const delBtn = firstCard.querySelector<HTMLButtonElement>('button[aria-label="Delete highlight"]');
      await act(async () => {
        delBtn?.click();
      });
      expect(firstCard.textContent).toContain("Remove this highlight & note?");
      const removeBtn = Array.from(firstCard.querySelectorAll("button")).find(
        (b) => b.textContent === "Remove",
      );
      await act(async () => {
        removeBtn?.click();
      });
      await flushMicrotasks();
      expect(mocks.invoke).toHaveBeenCalledWith("remove_highlight", { id: "h-earlier-ch" });
      expect(container.querySelectorAll("article[data-highlight-id]")).toHaveLength(2);
    });
  });

  describe("WordsView", () => {
    it("renders empty state when 0 words saved", async () => {
      mocks.invoke.mockResolvedValue([]);
      const onNavigateToLibrary = vi.fn();

      await act(async () => {
        root.render(
          <WordsView booksById={new Map()} onNavigateToLibrary={onNavigateToLibrary} />,
        );
      });
      await flushMicrotasks();

      expect(container.textContent).toContain("No saved words yet");
      const cta = Array.from(container.querySelectorAll("button")).find((b) =>
        b.textContent?.includes("Browse Library"),
      );
      await act(async () => {
        cta?.click();
      });
      expect(onNavigateToLibrary).toHaveBeenCalledTimes(1);
    });

    it("hides speaker button when no voices exist, filters no-match in left rail, sorts A-Z, and uses 3s two-click delete (#322)", async () => {
      vi.useFakeTimers();

      const getVoicesMock = vi.fn(() => []);
      vi.stubGlobal("speechSynthesis", {
        getVoices: getVoicesMock,
        cancel: vi.fn(),
        speak: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      });
      vi.stubGlobal("SpeechSynthesisUtterance", function (this: { text: string }, t: string) {
        this.text = t;
      });

      const words: DictionaryWord[] = [
        {
          id: "w1",
          book_id: "b1",
          word: "ponderous",
          definition: "/ˈpɒndərəs/ adjective. Slow and heavy.",
          context_sentence: "Each ponderous movement.",
          context_explanation: "Emphasizes weight.",
          cfi: "epubcfi(/6/4!/4/2/1:0)",
          mastery: "learning",
          review_count: 0,
          next_review_at: null,
          created_at: new Date("2026-07-06T12:00:00Z").getTime(),
          updated_at: new Date("2026-07-06T12:00:00Z").getTime(),
          book_title: "Art",
        },
        {
          id: "w2",
          book_id: "b1",
          word: "ephemeral",
          definition: "/ɪˈfɛmərəl/ adjective. Short-lived.",
          context_sentence: null,
          context_explanation: null,
          cfi: null,
          mastery: "learning",
          review_count: 0,
          next_review_at: null,
          created_at: new Date("2026-08-12T12:00:00Z").getTime(),
          updated_at: new Date("2026-08-12T12:00:00Z").getTime(),
          book_title: "Art",
        },
      ];

      mocks.invoke.mockImplementation(async (cmd: string) => {
        if (cmd === "list_all_vocab_words") return [...words];
        if (cmd === "remove_vocab_word") return null;
        return null;
      });

      await act(async () => {
        root.render(
          <WordsView
            booksById={new Map([["b1", makeBook("b1", { title: "Art", author: "Will" })]])}
            onNavigateToLibrary={vi.fn()}
          />,
        );
      });
      await flushMicrotasks();

      // Scrollbar must remain visible (#322)
      const leftRail = container.querySelector<HTMLElement>('aside[aria-label="Saved words"]')!;
      expect(leftRail.className).not.toContain("scrollbar-none");

      // Speech button hidden when no voices available
      expect(container.querySelector('button[aria-label="Pronounce word"]')).toBeNull();

      // Recent list layout puts select-text only on briefGloss, suppressing pointer click when selected
      const recentPonderousBtn = Array.from(leftRail.querySelectorAll("button")).find((b) =>
        b.textContent?.includes("ponderous"),
      )!;
      const recentGlossSpan = Array.from(recentPonderousBtn.querySelectorAll("span")).find((s) =>
        s.textContent?.includes("Slow and heavy."),
      )!;
      expect(recentGlossSpan.className).toContain("select-text");
      const recentWordSpan = Array.from(recentPonderousBtn.querySelectorAll("span")).find(
        (s) => s.textContent === "ponderous",
      )!;
      expect(recentWordSpan.className).not.toContain("select-text");

      const recentRange = document.createRange();
      recentRange.selectNodeContents(recentGlossSpan);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(recentRange);

      await act(async () => {
        recentPonderousBtn.dispatchEvent(
          new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 }),
        );
      });
      expect(container.querySelector("h2")?.textContent).toBe("ephemeral");
      sel?.removeAllRanges();

      // Switch to A-Z sort and select "ponderous" (which has context + cfi)
      const sortBtn = container.querySelector<HTMLButtonElement>('button[aria-label="Sort words"]');
      await act(async () => {
        sortBtn?.click();
      });
      const azOption = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')).find(
        (b) => b.textContent?.includes("A–Z"),
      );
      await act(async () => {
        azOption?.click();
      });
      expect(container.textContent).toContain("2 saved from 1 book");
      expect(leftRail.textContent).toContain("E — 1");
      expect(leftRail.textContent).toContain("P — 1");

      const ponderousBtn = Array.from(leftRail.querySelectorAll("button")).find((b) =>
        b.textContent?.includes("ponderous"),
      )!;
      const azDefParagraph = ponderousBtn.querySelector("p")!;
      expect(azDefParagraph.className).toContain("select-text");

      const azRange = document.createRange();
      azRange.selectNodeContents(azDefParagraph);
      sel?.removeAllRanges();
      sel?.addRange(azRange);
      await act(async () => {
        ponderousBtn.dispatchEvent(
          new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 }),
        );
      });
      expect(container.querySelector("h2")?.textContent).toBe("ephemeral");

      sel?.removeAllRanges();
      await act(async () => {
        ponderousBtn.dispatchEvent(
          new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 }),
        );
      });
      expect(container.querySelector("h2")?.textContent).toBe("ponderous");

      // Prefix search with 0 hits shows no-match in left rail while keeping detail pane visible
      const searchInput = container.querySelector<HTMLInputElement>('input[placeholder="Filter words…"]')!;
      await act(async () => {
        setInputValue(searchInput, "zzz");
      });
      expect(leftRail.textContent).toContain("No saved words match “zzz”");
      expect(container.textContent).toContain("Go to passage");

      const clearBtn = Array.from(leftRail.querySelectorAll("button")).find((b) =>
        b.textContent?.includes("Clear search"),
      );
      await act(async () => {
        clearBtn?.click();
      });

      // Go to passage jumps to saved CFI
      const goToBtn = Array.from(container.querySelectorAll("button")).find((b) =>
        b.textContent?.includes("Go to passage"),
      );
      await act(async () => {
        goToBtn?.click();
      });
      expect(mocks.openReaderWindow).toHaveBeenCalledWith("b1", {
        openVocab: true,
        cfi: "epubcfi(/6/4!/4/2/1:0)",
      });

      // Two-click delete: first click arms pill; waiting 3000ms disarms without deleting
      const deleteBtn = container.querySelector<HTMLButtonElement>('button[aria-label="Delete saved word"]')!;
      await act(async () => {
        deleteBtn.click();
      });
      expect(container.textContent).toContain("Click again to delete");
      expect(mocks.invoke).not.toHaveBeenCalledWith("remove_vocab_word", expect.anything());

      await act(async () => {
        vi.advanceTimersByTime(3000);
      });
      expect(container.textContent).not.toContain("Click again to delete");

      // Re-arm and click confirmation pill within 3 seconds deletes word
      await act(async () => {
        deleteBtn.click();
      });
      const confirmPill = Array.from(container.querySelectorAll("button")).find((b) =>
        b.textContent?.includes("Click again to delete"),
      );
      await act(async () => {
        confirmPill?.click();
      });
      await flushMicrotasks();
      expect(mocks.invoke).toHaveBeenCalledWith("remove_vocab_word", { id: "w1" });
    });
  });

  describe("ChatsView", () => {
    it("renders empty state when 0 conversations exist", async () => {
      mocks.invoke.mockImplementation(async (cmd: string) => {
        if (cmd === "list_all_chats") return { chats: [], next_cursor: null, total: 0 };
        if (cmd === "get_chat_counts") return { total: 0, by_book: [] };
        return [];
      });
      const onNavigateToLibrary = vi.fn();

      await act(async () => {
        root.render(
          <ChatsView
            booksById={new Map()}
            onOpenSettings={vi.fn()}
            onNavigateToLibrary={onNavigateToLibrary}
          />,
        );
      });
      await flushMicrotasks();

      expect(container.textContent).toContain("No conversations yet");
      const cta = Array.from(container.querySelectorAll("button")).find((b) =>
        b.textContent?.includes("Open a Book"),
      );
      await act(async () => {
        cta?.click();
      });
      expect(onNavigateToLibrary).toHaveBeenCalledTimes(1);
    });

    it("supports visible scrollbar (#322), inline rename, Copy as Markdown, and Delete confirmation modal", async () => {
      const writeTextMock = vi.fn().mockResolvedValue(undefined);
      Object.defineProperty(navigator, "clipboard", {
        value: { writeText: writeTextMock },
        configurable: true,
      });

      const chat: ChatSummary = {
        id: "chat-1",
        book_id: "b1",
        title: "Meaning of nonresistance",
        model: "gpt-4o-mini",
        pinned: false,
        metadata: null,
        created_at: new Date("2026-08-13T10:00:00Z").getTime(),
        updated_at: new Date("2026-08-13T10:00:00Z").getTime(),
        book_title: "The Power of Now",
        message_count: 2,
        last_message: "Inner stillness.",
      };

      mocks.invoke.mockImplementation(async (cmd: string) => {
        if (cmd === "list_all_chats") return { chats: [chat], next_cursor: null, total: 1 };
        if (cmd === "get_chat_counts") {
          return { total: 1, by_book: [{ book_id: "b1", book_title: "The Power of Now", count: 1 }] };
        }
        if (cmd === "list_chats") return [chat];
        if (cmd === "list_chat_messages") {
          return [
            {
              id: "m1",
              chat_id: "chat-1",
              role: "user",
              content: "Explain this passage",
              context: "Turn the other cheek.",
              metadata: JSON.stringify({ contextCfi: "epubcfi(/6/4!/4/2/1:0)" }),
              created_at: 1000,
              updated_at: 1000,
            },
            {
              id: "m2",
              chat_id: "chat-1",
              role: "assistant",
              content: "Tolle means nonresistance.",
              context: null,
              metadata: null,
              created_at: 1100,
              updated_at: 1100,
            },
          ];
        }
        if (cmd === "rename_chat" || cmd === "delete_chat") return null;
        return null;
      });

      await act(async () => {
        root.render(
          <ChatsView
            booksById={new Map([["b1", makeBook("b1", { title: "The Power of Now", author: "Eckhart Tolle" })]])}
            onOpenSettings={vi.fn()}
            onNavigateToLibrary={vi.fn()}
          />,
        );
      });
      await flushMicrotasks();

      const leftList = container.querySelector<HTMLElement>('aside[aria-label="Conversations"]')!;
      expect(leftList.className).not.toContain("scrollbar-none");
      expect(container.textContent).toContain("Turn the other cheek.");
      expect(container.textContent).toContain("Tolle means nonresistance.");

      // Thread menu -> Copy as Markdown
      const moreBtn = container.querySelector<HTMLButtonElement>('button[aria-label="Conversation options"]')!;
      await act(async () => {
        moreBtn.click();
      });
      const copyMdItem = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')).find(
        (b) => b.textContent?.includes("Copy as Markdown"),
      );
      await act(async () => {
        copyMdItem?.click();
      });
      await flushMicrotasks();
      expect(writeTextMock).toHaveBeenCalledWith(
        expect.stringContaining("# Meaning of nonresistance"),
      );
      expect(writeTextMock).toHaveBeenCalledWith(
        expect.stringContaining("Tolle means nonresistance."),
      );

      // Thread menu -> Rename conversation -> Enter saves
      await act(async () => {
        moreBtn.click();
      });
      const renameItem = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')).find(
        (b) => b.textContent?.includes("Rename conversation"),
      );
      await act(async () => {
        renameItem?.click();
      });
      const renameInput = container.querySelector<HTMLInputElement>('input[aria-label="Conversation title"]')!;
      await act(async () => {
        setInputValue(renameInput, "Nonresistance & Peace");
        renameInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      });
      await flushMicrotasks();
      expect(mocks.invoke).toHaveBeenCalledWith("rename_chat", {
        chatId: "chat-1",
        title: "Nonresistance & Peace",
      });

      // Thread menu -> Delete conversation… -> Modal confirms deletion
      await act(async () => {
        moreBtn.click();
      });
      const deleteItem = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')).find(
        (b) => b.textContent?.includes("Delete conversation"),
      );
      await act(async () => {
        deleteItem?.click();
      });
      expect(container.textContent).toContain("Delete conversation?");
      expect(container.textContent).toContain("Your book highlights and margin notes are not affected.");
      const confirmDelete = Array.from(container.querySelectorAll("button")).find(
        (b) => b.textContent === "Delete Conversation",
      );
      await act(async () => {
        confirmDelete?.click();
      });
      await flushMicrotasks();
      expect(mocks.invoke).toHaveBeenCalledWith("delete_chat", { chatId: "chat-1" });
    });

    it("waits for deferred get_chat lookup when initialChatId is outside page 1 (R2) and scrolls on streaming chunks (R5)", async () => {
      const scrollSpy = vi.fn();
      Element.prototype.scrollIntoView = scrollSpy;

      const streamListeners = new Set<(e: { payload: { delta: string; done: boolean } }) => void>();
      mocks.listen.mockImplementation(async (event, cb) => {
        if (event === "ai-stream-chunk") {
          const typed = cb as (e: { payload: { delta: string; done: boolean } }) => void;
          streamListeners.add(typed);
          return () => streamListeners.delete(typed);
        }
        return () => {};
      });

      const newestChat: ChatSummary = {
        id: "chat-newest",
        book_id: "b1",
        title: "Newest Thread",
        model: "gpt-4o-mini",
        pinned: false,
        metadata: null,
        created_at: 9000,
        updated_at: 9000,
        book_title: "Book b1",
        message_count: 1,
        last_message: "Newest",
      };
      const olderChat = {
        id: "chat-old-target",
        book_id: "b1",
        title: "Older Target Thread",
        model: "gpt-4o-mini",
        pinned: false,
        metadata: null,
        created_at: 1000,
        updated_at: 1000,
      };

      let resolveOldChat!: (val: typeof olderChat) => void;
      const oldChatPromise = new Promise<typeof olderChat>((res) => {
        resolveOldChat = res;
      });

      mocks.invoke.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
        if (cmd === "list_all_chats") {
          return { chats: [newestChat], next_cursor: "c2", total: 2 };
        }
        if (cmd === "get_chat_counts") {
          return { total: 2, by_book: [{ book_id: "b1", book_title: "Book b1", count: 2 }] };
        }
        if (cmd === "get_chat" && args?.chatId === "chat-old-target") {
          return oldChatPromise;
        }
        if (cmd === "list_chats") return [newestChat, olderChat];
        if (cmd === "list_chat_messages") return [];
        if (cmd === "save_chat_message") return "msg-saved";
        if (cmd === "ai_chat") return null;
        return null;
      });

      await act(async () => {
        root.render(
          <ChatsView
            booksById={new Map([["b1", makeBook("b1")]])}
            initialBookId={null}
            initialChatId="chat-old-target"
            navigationSeq={1}
            onOpenSettings={vi.fn()}
            onNavigateToLibrary={vi.fn()}
          />,
        );
      });
      await flushMicrotasks();

      // Page 1 resolved, get_chat is still pending -> must NOT fall back to Newest Thread
      expect(container.querySelector("h2")?.textContent).not.toBe("Newest Thread");

      await act(async () => {
        resolveOldChat(olderChat);
      });
      await flushMicrotasks();

      expect(container.querySelector("h2")?.textContent).toBe("Older Target Thread");

      // Send message & emit streaming chunks -> scrollIntoView must fire on chunk updates
      const composer = container.querySelector<HTMLTextAreaElement>(
        'textarea[placeholder="Continue the conversation…"]',
      )!;
      await act(async () => {
        setInputValue(composer, "Hello?");
      });
      scrollSpy.mockClear();
      const sendBtn = container.querySelector<HTMLButtonElement>('button[aria-label="Send message"]')!;
      await act(async () => {
        sendBtn.click();
      });
      await flushMicrotasks();

      const beforeChunkCount = scrollSpy.mock.calls.length;
      expect(beforeChunkCount).toBeGreaterThan(0);

      await act(async () => {
        for (const cb of streamListeners) {
          cb({ payload: { delta: "First paragraph chunk\n\n", done: false } });
        }
      });
      await flushMicrotasks();
      const afterChunk1 = scrollSpy.mock.calls.length;
      expect(afterChunk1).toBeGreaterThan(beforeChunkCount);

      await act(async () => {
        for (const cb of streamListeners) {
          cb({ payload: { delta: "Second paragraph chunk", done: false } });
        }
      });
      await flushMicrotasks();
      expect(scrollSpy.mock.calls.length).toBeGreaterThan(afterChunk1);
      expect(container.textContent).toContain("First paragraph chunk");
      expect(container.textContent).toContain("Second paragraph chunk");
    });
  });

  describe("Regression fixes (R1, R3, R4, R7, R8)", () => {
    it("preserves initialWordId while deferred list_all_vocab_words loads and uses font-reading (R1, R7)", async () => {
      let resolveWords!: (w: DictionaryWord[]) => void;
      const deferredWords = new Promise<DictionaryWord[]>((res) => {
        resolveWords = res;
      });
      mocks.invoke.mockImplementation(async (cmd: string) => {
        if (cmd === "list_all_vocab_words") return deferredWords;
        return null;
      });

      await act(async () => {
        root.render(
          <WordsView
            booksById={new Map([["b1", makeBook("b1")]])}
            initialWordId="w-target"
            navigationSeq={1}
            onNavigateToLibrary={vi.fn()}
          />,
        );
      });
      await flushMicrotasks();

      await act(async () => {
        resolveWords([
          {
            id: "w-newest",
            book_id: "b1",
            word: "ephemeral",
            definition: "Short-lived.",
            context_sentence: null,
            context_explanation: null,
            cfi: null,
            mastery: "learning",
            review_count: 0,
            next_review_at: null,
            created_at: 9000,
            updated_at: 9000,
            book_title: "Book b1",
          },
          {
            id: "w-target",
            book_id: "b1",
            word: "palimpsest",
            definition: "Layered manuscript.",
            context_sentence: "A palimpsest of older streets.",
            context_explanation: null,
            cfi: null,
            mastery: "learning",
            review_count: 0,
            next_review_at: null,
            created_at: 1000,
            updated_at: 1000,
            book_title: "Book b1",
          },
        ]);
      });
      await flushMicrotasks();

      const headword = container.querySelector("h2")!;
      expect(headword.textContent).toBe("palimpsest");
      expect(headword.className).toContain("font-reading");
      expect(headword.className).not.toContain("font-reading-serif");
    });

    it("ignores stale highlight-list responses (R3) and clears filters on repeat navigation (R4)", async () => {
      let resolveAllInitial!: (rows: Highlight[]) => void;
      let resolveBook2!: (rows: Highlight[]) => void;
      let callIndex = 0;

      const hYellow: Highlight = {
        id: "h-yellow",
        book_id: "b1",
        cfi_range: "epubcfi(/6/4!/4/2/1:0)",
        color: "yellow",
        note: null,
        text_content: "Yellow target passage",
        created_at: 1000,
        updated_at: 1000,
        book_title: "Book One",
      };
      const hBook2: Highlight = {
        id: "h-b2",
        book_id: "b2",
        cfi_range: "epubcfi(/6/6!/4/2/1:0)",
        color: "pink",
        note: null,
        text_content: "Book Two Passage",
        created_at: 2000,
        updated_at: 2000,
        book_title: "Book Two",
      };

      const counts: HighlightCounts = {
        total: 2,
        book_count: 2,
        books: [
          { book_id: "b1", book_title: "Book One", book_author: "A", book_progress: 10, cover_path: null, count: 1 },
          { book_id: "b2", book_title: "Book Two", book_author: "B", book_progress: 20, cover_path: null, count: 1 },
        ],
      };

      mocks.invoke.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
        if (cmd === "get_highlight_counts") return counts;
        if (cmd === "list_all_highlights") {
          callIndex += 1;
          if (callIndex === 1) {
            return new Promise<Highlight[]>((res) => {
              resolveAllInitial = res;
            });
          }
          if (callIndex === 2) {
            return new Promise<Highlight[]>((res) => {
              resolveBook2 = res;
            });
          }
          return (args?.bookId === "b1" ? [hYellow] : [hYellow, hBook2]);
        }
        return null;
      });

      const booksById = new Map<string, Book>([
        ["b1", makeBook("b1", { title: "Book One" })],
        ["b2", makeBook("b2", { title: "Book Two" })],
      ]);

      await act(async () => {
        root.render(<HighlightsView booksById={booksById} onNavigateToLibrary={vi.fn()} />);
      });
      await flushMicrotasks();

      // Switch to Book Two while initial all-books query is still in flight
      const rail = container.querySelector<HTMLElement>('aside[aria-label="Highlighted books"]')!;
      const bookTwoBtn = Array.from(rail.querySelectorAll("button")).find((b) =>
        b.textContent?.includes("Book Two"),
      )!;
      await act(async () => {
        bookTwoBtn.click();
      });

      // Newer query (Book Two) resolves FIRST, then stale initial query resolves LAST
      await act(async () => {
        resolveBook2([hBook2]);
      });
      await flushMicrotasks();
      expect(container.textContent).toContain("Book Two Passage");

      await act(async () => {
        resolveAllInitial([hYellow]);
      });
      await flushMicrotasks();
      expect(container.textContent).toContain("Book Two Passage");
      expect(container.textContent).not.toContain("Yellow target passage");

      // Activate Pink filter and search, then receive incoming navigation to Yellow target (R4)
      const pinkBtn = container.querySelector<HTMLButtonElement>('button[aria-label="Pink"]')!;
      const searchInput = container.querySelector<HTMLInputElement>(
        'input[placeholder="Filter highlights…"]',
      )!;
      await act(async () => {
        pinkBtn.click();
        setInputValue(searchInput, "nomatch-filter");
      });

      await act(async () => {
        root.render(
          <HighlightsView
            booksById={booksById}
            initialBookId={null}
            initialHighlightId="h-yellow"
            navigationSeq={1}
            onNavigateToLibrary={vi.fn()}
          />,
        );
      });
      await flushMicrotasks();
      expect(container.textContent).toContain("Yellow target passage");

      // User manually switches to Book Two, then repeats exact same navigation (new navigationSeq)
      const bookTwoBtnAgain = Array.from(rail.querySelectorAll("button")).find((b) =>
        b.textContent?.includes("Book Two"),
      )!;
      await act(async () => {
        bookTwoBtnAgain.click();
      });
      await flushMicrotasks();

      await act(async () => {
        root.render(
          <HighlightsView
            booksById={booksById}
            initialBookId={null}
            initialHighlightId="h-yellow"
            navigationSeq={2}
            onNavigateToLibrary={vi.fn()}
          />,
        );
      });
      await flushMicrotasks();
      expect(container.textContent).toContain("Yellow target passage");
    });

    it("reloads requested thread when AiPanel receives repeated initialChatId via incremented initialChatSeq (R8)", async () => {
      const chatA = {
        id: "chat-A",
        book_id: "b1",
        title: "Thread A",
        model: null,
        pinned: false,
        metadata: null,
        created_at: 1000,
        updated_at: 2000,
      };
      const chatB = {
        id: "chat-B",
        book_id: "b1",
        title: "Thread B",
        model: null,
        pinned: false,
        metadata: null,
        created_at: 1000,
        updated_at: 1500,
      };

      mocks.invoke.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
        if (cmd === "list_chats") return [chatA, chatB];
        if (cmd === "list_chat_messages") {
          return [
            {
              id: `msg-${args?.chatId}`,
              chat_id: args?.chatId,
              role: "assistant",
              content: args?.chatId === "chat-A" ? "Reply from Thread A" : "Reply from Thread B",
              context: null,
              metadata: null,
              created_at: 1000,
              updated_at: 1000,
            },
          ];
        }
        return null;
      });

      await act(async () => {
        root.render(<AiPanel bookId="b1" initialChatId="chat-A" initialChatSeq={1} />);
      });
      await flushMicrotasks();
      expect(container.textContent).toContain("Reply from Thread A");

      // Manually switch in AiPanel thread picker to Thread B
      const pickerBtn = Array.from(container.querySelectorAll("button")).find((b) =>
        b.textContent?.includes("Thread A"),
      )!;
      await act(async () => {
        pickerBtn.click();
      });
      const threadBOption = Array.from(container.querySelectorAll("button")).find((b) =>
        b.textContent?.includes("Thread B"),
      )!;
      await act(async () => {
        threadBOption.click();
      });
      await flushMicrotasks();
      expect(container.textContent).toContain("Reply from Thread B");

      // Repeat deep link to same chatId ("chat-A") with incremented initialChatSeq -> reloads Thread A
      await act(async () => {
        root.render(<AiPanel bookId="b1" initialChatId="chat-A" initialChatSeq={2} />);
      });
      await flushMicrotasks();
      expect(container.textContent).toContain("Reply from Thread A");
    });

    it("guards HomeView bento highlight against stale Book A completion and clears mismatch while Book B loads (R6 follow-up)", async () => {
      let resolveBookAHighlight!: (rows: Highlight[]) => void;
      let resolveBookBHighlight!: (rows: Highlight[]) => void;

      const bookA = makeBook("bA", { title: "Book Alpha", updated_at: 1000, progress: 20 });
      const bookB = makeBook("bB", { title: "Book Beta", updated_at: 9000, progress: 55 });

      mocks.invoke.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
        if (cmd === "list_all_highlights") {
          if (args?.bookId === "bA") {
            return new Promise<Highlight[]>((res) => {
              resolveBookAHighlight = res;
            });
          }
          if (args?.bookId === "bB") {
            return new Promise<Highlight[]>((res) => {
              resolveBookBHighlight = res;
            });
          }
          return [];
        }
        if (cmd === "list_all_vocab_words") return [];
        if (cmd === "list_all_chats") return { chats: [], next_cursor: null, total: 0 };
        return [];
      });

      // Initially Book A is Now reading, then Book B becomes Now reading while Book A's highlight fetch is still pending
      await act(async () => {
        root.render(
          <HomeView
            books={[bookA]}
            totalBooksCount={1}
            booksLoading={false}
            collections={[]}
            onNavigate={vi.fn()}
            onImport={vi.fn()}
            onOpenSettings={vi.fn()}
          />,
        );
      });
      await flushMicrotasks();

      await act(async () => {
        root.render(
          <HomeView
            books={[bookA, bookB]}
            totalBooksCount={2}
            booksLoading={false}
            collections={[]}
            onNavigate={vi.fn()}
            onImport={vi.fn()}
            onOpenSettings={vi.fn()}
          />,
        );
      });
      await flushMicrotasks();

      // Resolve Book B highlight first -> shown cleanly under Book B
      await act(async () => {
        resolveBookBHighlight([
          {
            id: "hl-b",
            book_id: "bB",
            cfi_range: "epubcfi(/6/8!/bB)",
            color: "green",
            note: null,
            text_content: "Beta fresh quote",
            created_at: 2000,
            updated_at: 2000,
          },
        ]);
      });
      await flushMicrotasks();
      expect(container.textContent).toContain("Book Beta");
      expect(container.textContent).toContain("Beta fresh quote");

      // Now stale Book A highlight resolves LAST -> must NOT overwrite Book B's quote or Ask target
      await act(async () => {
        resolveBookAHighlight([
          {
            id: "hl-a",
            book_id: "bA",
            cfi_range: "epubcfi(/6/4!/bA)",
            color: "yellow",
            note: null,
            text_content: "Alpha stale quote",
            created_at: 1000,
            updated_at: 1000,
          },
        ]);
      });
      await flushMicrotasks();

      expect(container.textContent).toContain("Beta fresh quote");
      expect(container.textContent).not.toContain("Alpha stale quote");

      const askBtn = Array.from(container.querySelectorAll("button")).find((b) =>
        b.textContent?.includes("Ask about this part"),
      )!;
      await act(async () => {
        askBtn.click();
      });
      expect(mocks.openReaderWindow).toHaveBeenLastCalledWith("bB", {
        openChat: true,
        quote: "Beta fresh quote",
        cfi: "epubcfi(/6/8!/bB)",
      });

      // Also when flipping to Book C while C's highlight fetch is still pending, B's old quote must NOT leak into Ask C
      const bookC = makeBook("bC", { title: "Book Gamma", updated_at: 99999, progress: 10 });
      await act(async () => {
        root.render(
          <HomeView
            books={[bookA, bookB, bookC]}
            totalBooksCount={3}
            booksLoading={false}
            collections={[]}
            onNavigate={vi.fn()}
            onImport={vi.fn()}
            onOpenSettings={vi.fn()}
          />,
        );
      });
      expect(container.textContent).toContain("Book Gamma");
      expect(container.textContent).not.toContain("Beta fresh quote");
      const askCBtn = Array.from(container.querySelectorAll("button")).find((b) =>
        b.textContent?.includes("Ask about this part"),
      )!;
      await act(async () => {
        askCBtn.click();
      });
      expect(mocks.openReaderWindow).toHaveBeenLastCalledWith("bC", {
        openChat: true,
        quote: undefined,
        cfi: undefined,
      });
    });

    it("scrolls to target highlight on repeat same-target navigation when ID and list are unchanged (R4 follow-up)", async () => {
      const scrollSpy = vi.fn();
      Element.prototype.scrollIntoView = scrollSpy;

      const h1: Highlight = {
        id: "h-same",
        book_id: "b1",
        cfi_range: "epubcfi(/6/4!/4/2/1:0)",
        color: "yellow",
        note: null,
        text_content: "Repeated passage",
        created_at: 1000,
        updated_at: 1000,
        book_title: "Book One",
      };
      const counts: HighlightCounts = {
        total: 1,
        book_count: 1,
        books: [
          { book_id: "b1", book_title: "Book One", book_author: "A", book_progress: 10, cover_path: null, count: 1 },
        ],
      };

      mocks.invoke.mockImplementation(async (cmd: string) => {
        if (cmd === "get_highlight_counts") return counts;
        if (cmd === "list_all_highlights") return [h1];
        return null;
      });

      const booksById = new Map<string, Book>([["b1", makeBook("b1", { title: "Book One" })]]);

      await act(async () => {
        root.render(
          <HighlightsView
            booksById={booksById}
            initialBookId={null}
            initialHighlightId="h-same"
            navigationSeq={1}
            onNavigateToLibrary={vi.fn()}
          />,
        );
      });
      await flushMicrotasks();
      expect(scrollSpy).toHaveBeenCalledTimes(1);

      // Same initialBookId/initialHighlightId and unchanged list, bumped navigationSeq -> scrolls again
      await act(async () => {
        root.render(
          <HighlightsView
            booksById={booksById}
            initialBookId={null}
            initialHighlightId="h-same"
            navigationSeq={2}
            onNavigateToLibrary={vi.fn()}
          />,
        );
      });
      await flushMicrotasks();
      expect(scrollSpy).toHaveBeenCalledTimes(2);
    });

    it("invalidates off-page fallback chat on incompatible book filter and restores on repeat link (R2 follow-up)", async () => {
      const chatOldA = {
        id: "chat-old-A",
        book_id: "bA",
        title: "Older Book A Thread",
        model: "gpt-4o-mini",
        pinned: false,
        metadata: null,
        created_at: 1000,
        updated_at: 1000,
      };
      const chatB: ChatSummary = {
        id: "chat-B1",
        book_id: "bB",
        title: "Book B Thread",
        model: "gpt-4o-mini",
        pinned: false,
        metadata: null,
        created_at: 5000,
        updated_at: 5000,
        book_title: "Book B",
        message_count: 1,
        last_message: "Hi from B",
      };
      const chatANewest: ChatSummary = {
        id: "chat-A-newest",
        book_id: "bA",
        title: "Newest Overall Thread",
        model: "gpt-4o-mini",
        pinned: false,
        metadata: null,
        created_at: 9000,
        updated_at: 9000,
        book_title: "Book A",
        message_count: 1,
        last_message: "Newest",
      };

      mocks.invoke.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
        if (cmd === "list_all_chats") {
          if (args?.bookId === "bB") {
            return { chats: [chatB], next_cursor: null, total: 1 };
          }
          return { chats: [chatANewest, chatB], next_cursor: "c2", total: 3 };
        }
        if (cmd === "get_chat_counts") {
          return {
            total: 3,
            by_book: [
              { book_id: "bA", book_title: "Book A", count: 2 },
              { book_id: "bB", book_title: "Book B", count: 1 },
            ],
          };
        }
        if (cmd === "get_chat" && args?.chatId === "chat-old-A") return chatOldA;
        if (cmd === "list_chats") {
          return args?.bookId === "bB" ? [chatB] : [chatANewest, chatOldA];
        }
        if (cmd === "list_chat_messages") return [];
        return null;
      });

      const booksById = new Map<string, Book>([
        ["bA", makeBook("bA", { title: "Book A" })],
        ["bB", makeBook("bB", { title: "Book B" })],
      ]);

      await act(async () => {
        root.render(
          <ChatsView
            booksById={booksById}
            initialBookId={null}
            initialChatId="chat-old-A"
            navigationSeq={1}
            onOpenSettings={vi.fn()}
            onNavigateToLibrary={vi.fn()}
          />,
        );
      });
      await flushMicrotasks();
      expect(container.querySelector("h2")?.textContent).toBe("Older Book A Thread");

      // User filters Chats to Book B -> must clear Book A fallback & switch right pane to Book B
      const filterTrigger = Array.from(container.querySelectorAll("button")).find((b) =>
        b.textContent?.includes("All books"),
      )!;
      await act(async () => {
        filterTrigger.click();
      });
      const bookBOption = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')).find(
        (b) => b.textContent?.includes("Book B"),
      )!;
      await act(async () => {
        bookBOption.click();
      });
      await flushMicrotasks();

      expect(container.querySelector("h2")?.textContent).toBe("Book B Thread");

      // Incoming repeat link back to chat-old-A (navigationSeq 2) resets book filter and opens chat-old-A again
      await act(async () => {
        root.render(
          <ChatsView
            booksById={booksById}
            initialBookId={null}
            initialChatId="chat-old-A"
            navigationSeq={2}
            onOpenSettings={vi.fn()}
            onNavigateToLibrary={vi.fn()}
          />,
        );
      });
      await flushMicrotasks();
      expect(container.querySelector("h2")?.textContent).toBe("Older Book A Thread");
    });
  });
});
