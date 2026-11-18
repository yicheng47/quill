/** @vitest-environment jsdom */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../i18n";
import type { Book } from "../hooks/useBooks";
import type { Collection } from "../hooks/useCollections";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn<(cmd: string, args?: Record<string, unknown>) => Promise<unknown>>(),
  openReaderWindow: vi.fn<(id: string) => Promise<void>>(),
  collectionsHook: {
    collections: [] as Collection[],
    create: vi.fn<(name: string) => Promise<Collection>>(),
    addBook: vi.fn<(cid: string, bid: string) => Promise<void>>(),
    removeBook: vi.fn<(cid: string, bid: string) => Promise<void>>(),
    getBookCollections: vi.fn<(bid: string) => Promise<string[]>>(),
  },
}));

vi.mock("../platform", () => ({
  invoke: (cmd: string, args?: Record<string, unknown>) => mocks.invoke(cmd, args),
  convertFileSrc: (p: string) => `quill-file://local/${p}`,
}));

vi.mock("../utils/openReaderWindow", () => ({
  openReaderWindow: (id: string) => mocks.openReaderWindow(id),
}));

vi.mock("../hooks/useCollections", () => ({
  useCollections: () => mocks.collectionsHook,
}));

import CommandSearchModal from "./CommandSearchModal";
import CollectionsPopover from "./CollectionsPopover";
import DeleteCollectionModal from "./DeleteCollectionModal";
import AddBooksModal from "./AddBooksModal";
import BookContextMenu from "./BookContextMenu";
import BookGrid from "./BookGrid";
import BookList from "./BookList";

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
    pages: 240,
    status: "unread",
    progress: 0,
    current_cfi: null,
    created_at: 1000,
    updated_at: 1000,
    available: true,
    cover_data: null,
    ...overrides,
  };
}

const sampleBooks: Book[] = [
  makeBook("b1", { title: "Stoner", author: "John Williams", status: "reading", progress: 24 }),
  makeBook("b2", { title: "Neuromancer", author: "William Gibson", status: "unread", progress: 0 }),
  makeBook("b3", { title: "Rework", author: "Jason Fried", status: "finished", progress: 100 }),
];

const sampleCollections: Collection[] = [
  { id: "c1", name: "Sci-Fi", book_count: 2, sort_order: 0, created_at: 100, updated_at: 100 },
  { id: "c2", name: "Favorites", book_count: 1, sort_order: 1, created_at: 101, updated_at: 101 },
];

describe("M2 CommandSearch, Collections, BookList, and BookContextMenu", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    vi.useFakeTimers();
    await i18n.changeLanguage("en");
    mocks.invoke.mockReset();
    mocks.openReaderWindow.mockReset();
    mocks.openReaderWindow.mockResolvedValue();
    mocks.collectionsHook = {
      collections: [...sampleCollections],
      create: vi.fn(async (name: string) => ({
        id: "c-new",
        name,
        book_count: 0,
        sort_order: 2,
        created_at: 200,
        updated_at: 200,
      })),
      addBook: vi.fn().mockResolvedValue(undefined),
      removeBook: vi.fn().mockResolvedValue(undefined),
      getBookCollections: vi.fn().mockResolvedValue(["c1"]),
    };
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    vi.useRealTimers();
  });

  it("CommandSearchModal searches Books, ignores IME composition keys, navigates ArrowDown, opens Enter, closes Escape", async () => {
    mocks.invoke.mockResolvedValue({ books: sampleBooks, next_cursor: null, total: 3 });
    const onClose = vi.fn();

    await act(async () => {
      root.render(<CommandSearchModal open={true} onClose={onClose} />);
    });
    await act(async () => {
      vi.advanceTimersByTime(150);
    });

    expect(mocks.invoke).toHaveBeenCalledWith("list_books", {
      filter: null,
      search: null,
      collectionId: null,
      cursor: null,
      limit: 30,
    });
    expect(container.textContent).toContain("Stoner");
    expect(container.textContent).toContain("Neuromancer");

    // IME composing Enter & keyCode 229 must not open or close
    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true }),
      );
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowDown", isComposing: true, bubbles: true }),
      );
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", keyCode: 229, bubbles: true }),
      );
    });
    expect(mocks.openReaderWindow).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();

    // Real ArrowDown -> Enter opens second item b2
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    });
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });

    expect(mocks.openReaderWindow).toHaveBeenCalledWith("b2");
    expect(onClose).toHaveBeenCalledTimes(1);

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("CollectionsPopover uses raw collection IDs, ignores Enter/Space on child buttons, creates/renames, and triggers DeleteCollectionModal", async () => {
    const onCreate = vi.fn().mockResolvedValue({
      id: "c3",
      name: "Typography",
      book_count: 0,
      sort_order: 2,
      created_at: 300,
      updated_at: 300,
    });
    const onRename = vi.fn().mockResolvedValue(undefined);
    const onRequestDelete = vi.fn();
    const onSelectFilter = vi.fn();
    const onClose = vi.fn();
    const anchor = document.createElement("button");
    document.body.appendChild(anchor);
    const anchorRef = createRef<HTMLElement>() as React.RefObject<HTMLElement | null>;
    anchorRef.current = anchor;

    await act(async () => {
      root.render(
        <CollectionsPopover
          open={true}
          onClose={onClose}
          anchorRef={anchorRef}
          activeFilter="c1"
          onSelectFilter={onSelectFilter}
          totalBooksCount={42}
          collections={sampleCollections}
          onCreate={onCreate}
          onRename={onRename}
          onRequestDelete={onRequestDelete}
          onReorder={vi.fn().mockResolvedValue(undefined)}
        />,
      );
    });

    expect(container.textContent).toContain("All books");
    expect(container.textContent).toContain("42");

    // R8: Pressing Enter/Space on the child Rename button must not select the row or close
    const renameBtn = container.querySelector<HTMLButtonElement>('button[aria-label="Rename Sci-Fi"]');
    expect(renameBtn).not.toBeNull();
    await act(async () => {
      renameBtn?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      renameBtn?.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));
    });
    expect(onSelectFilter).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();

    // Selecting row emits raw collection id "c2" (never "collection:c2")
    const favRow = Array.from(container.querySelectorAll<HTMLElement>('[role="button"]')).find((el) =>
      el.textContent?.includes("Favorites"),
    );
    await act(async () => {
      favRow?.click();
    });
    expect(onSelectFilter).toHaveBeenCalledWith("c2");
    expect(onClose).toHaveBeenCalledTimes(1);

    // Inline create emits raw created id "c3"
    onSelectFilter.mockClear();
    const newTrigger = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("New collection"),
    );
    await act(async () => {
      newTrigger?.click();
    });
    const newInput = container.querySelector<HTMLInputElement>('input[placeholder="Collection name…"]');
    expect(newInput).not.toBeNull();
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(newInput, "Design");
      newInput?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      newInput?.closest("form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(onCreate).toHaveBeenCalledWith("Design");
    expect(onSelectFilter).toHaveBeenCalledWith("c3");

    // Rename inline
    await act(async () => {
      renameBtn?.click();
    });
    const renameInput = container.querySelector<HTMLInputElement>('input[aria-label="Collection name"]');
    expect(renameInput?.value).toBe("Sci-Fi");
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(renameInput, "Science Fiction");
      renameInput?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      renameInput?.closest("form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(onRename).toHaveBeenCalledWith("c1", "Science Fiction");

    // Delete request -> non-destructive DeleteCollectionModal
    const deleteBtn = container.querySelector<HTMLButtonElement>('button[aria-label="Delete Favorites"]');
    await act(async () => {
      deleteBtn?.click();
    });
    expect(onRequestDelete).toHaveBeenCalledWith(sampleCollections[1]);

    const onConfirmDelete = vi.fn().mockResolvedValue(undefined);
    await act(async () => {
      root.render(
        <DeleteCollectionModal
          collection={sampleCollections[0]}
          onClose={vi.fn()}
          onConfirm={onConfirmDelete}
        />,
      );
    });
    expect(container.textContent).toContain('Delete "Sci-Fi"?');
    expect(container.textContent).toContain("All books");
    const confirmDeleteBtn = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Delete Collection"),
    );
    await act(async () => {
      confirmDeleteBtn?.click();
    });
    expect(onConfirmDelete).toHaveBeenCalledWith("c1");

    anchor.remove();
  });

  it("AddBooksModal filters out existing members and batch-adds selected books", async () => {
    mocks.invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "list_books_in_collection") return ["b1"];
      if (cmd === "list_books") return { books: sampleBooks, next_cursor: null, total: 3 };
      return null;
    });
    const onConfirm = vi.fn().mockResolvedValue(undefined);
    const onClose = vi.fn();

    await act(async () => {
      root.render(
        <AddBooksModal
          open={true}
          collection={sampleCollections[0]}
          onClose={onClose}
          onConfirm={onConfirm}
        />,
      );
    });
    await act(async () => {
      vi.advanceTimersByTime(150);
    });

    const checkboxes = container.querySelectorAll<HTMLButtonElement>('[role="checkbox"]');
    expect(checkboxes).toHaveLength(2);
    expect(container.textContent).not.toContain("Stoner");

    await act(async () => {
      checkboxes[0].click();
      checkboxes[1].click();
    });

    const addBtn = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Add 2 books"),
    );
    expect(addBtn).toBeDefined();
    await act(async () => {
      addBtn?.click();
    });
    expect(onConfirm).toHaveBeenCalledWith("c1", ["b2", "b3"]);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("AddBooksModal paginates past full-member pages (>200 books) using next_cursor instead of claiming none eligible", async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => makeBook(`m-${i + 1}`));
    const page2 = Array.from({ length: 100 }, (_, i) => makeBook(`m-${i + 101}`));
    const lastEligible = makeBook("eligible-201", { title: "Book 201 Tail" });
    const all200Members = [...page1, ...page2].map((b) => b.id);

    mocks.invoke.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "list_books_in_collection") return all200Members;
      if (cmd === "list_books") {
        if (args?.cursor === null) {
          return { books: page1, next_cursor: "cur-2", total: 201 };
        }
        if (args?.cursor === "cur-2") {
          return { books: page2, next_cursor: "cur-3", total: 201 };
        }
        return { books: [lastEligible], next_cursor: null, total: 201 };
      }
      return null;
    });

    await act(async () => {
      root.render(
        <AddBooksModal
          open={true}
          collection={sampleCollections[0]}
          onClose={vi.fn()}
          onConfirm={vi.fn()}
        />,
      );
    });

    // Advance timers & flush microtasks across the chained cursor fetches
    for (let i = 0; i < 6; i++) {
      await act(async () => {
        vi.advanceTimersByTime(50);
        await Promise.resolve();
      });
    }

    expect(container.textContent).toContain("Book 201 Tail");
    expect(container.textContent).not.toContain("Every book in your library is already in this collection");
  });

  it("AddBooksModal pauses automatic page loading after a failed page on a saturated first page until Retry", async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => makeBook(`m-${i + 1}`));
    const memberIds = page1.map((b) => b.id);
    const tailBook = makeBook("tail-1", { title: "Recovered Tail Book" });
    let page2Attempts = 0;

    mocks.invoke.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "list_books_in_collection") return memberIds;
      if (cmd === "list_books") {
        if (args?.cursor === null) {
          return { books: page1, next_cursor: "cur-2", total: 101 };
        }
        page2Attempts += 1;
        if (page2Attempts === 1) {
          throw new Error("DB busy");
        }
        return { books: [tailBook], next_cursor: null, total: 101 };
      }
      return null;
    });

    await act(async () => {
      root.render(
        <AddBooksModal
          open={true}
          collection={sampleCollections[0]}
          onClose={vi.fn()}
          onConfirm={vi.fn()}
        />,
      );
    });

    for (let i = 0; i < 6; i++) {
      await act(async () => {
        vi.advanceTimersByTime(50);
        await Promise.resolve();
      });
    }

    // Must stop after 1 failed attempt — no retry loop without user input
    expect(page2Attempts).toBe(1);
    expect(container.textContent).toContain("Couldn't load more books.");
    expect(container.textContent).not.toContain("Loading…");

    const retryBtn = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Retry"),
    );
    expect(retryBtn).toBeDefined();

    await act(async () => {
      retryBtn?.click();
      await Promise.resolve();
    });
    for (let i = 0; i < 4; i++) {
      await act(async () => {
        await Promise.resolve();
      });
    }

    expect(page2Attempts).toBe(2);
    expect(container.textContent).toContain("Recovered Tail Book");
  });

  it("AddBooksModal preserves visible eligible rows, selection, and stops sentinel loops when a later page fails", async () => {
    const eligiblePage1 = Array.from({ length: 25 }, (_, i) =>
      makeBook(`e-${i + 1}`, { title: `Eligible #${i + 1}` }),
    );
    const eligiblePage2 = [makeBook("e-26", { title: "Eligible Page 2" })];
    let page2Calls = 0;
    let shouldFailPage2 = true;

    const origIO = globalThis.IntersectionObserver;
    class AlwaysIntersectingIO {
      cb: IntersectionObserverCallback;
      constructor(cb: IntersectionObserverCallback) {
        this.cb = cb;
      }
      observe() {
        this.cb(
          [{ isIntersecting: true } as IntersectionObserverEntry],
          this as unknown as IntersectionObserver,
        );
      }
      disconnect() {}
      unobserve() {}
      takeRecords() {
        return [];
      }
      root = null;
      rootMargin = "";
      thresholds = [];
    }
    vi.stubGlobal("IntersectionObserver", AlwaysIntersectingIO);

    try {
      mocks.invoke.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
        if (cmd === "list_books_in_collection") return [];
        if (cmd === "list_books") {
          if (args?.cursor === null) {
            return { books: eligiblePage1, next_cursor: "cur-2", total: 26 };
          }
          page2Calls += 1;
          if (shouldFailPage2) {
            throw new Error("Transient IO failure");
          }
          return { books: eligiblePage2, next_cursor: null, total: 26 };
        }
        return null;
      });

      await act(async () => {
        root.render(
          <AddBooksModal
            open={true}
            collection={sampleCollections[0]}
            onClose={vi.fn()}
            onConfirm={vi.fn()}
          />,
        );
      });
      for (let i = 0; i < 6; i++) {
        await act(async () => {
          vi.advanceTimersByTime(50);
          await Promise.resolve();
        });
      }

      // First failure via observer must stop further automatic page-2 calls
      expect(page2Calls).toBe(1);
      expect(container.textContent).toContain("Eligible #1");
      expect(container.textContent).toContain("Couldn't load more books.");

      // Preserve user selection on loaded rows across the failure & Retry recovery
      const firstRow = container.querySelector<HTMLButtonElement>('[role="checkbox"]');
      await act(async () => {
        firstRow?.click();
      });
      expect(container.textContent).toContain("1 selected");

      shouldFailPage2 = false;
      const retryBtn = Array.from(container.querySelectorAll("button")).find((b) =>
        b.textContent?.includes("Retry"),
      );
      await act(async () => {
        retryBtn?.click();
        await Promise.resolve();
      });
      for (let i = 0; i < 4; i++) {
        await act(async () => {
          await Promise.resolve();
        });
      }

      expect(page2Calls).toBe(2);
      expect(container.textContent).toContain("Eligible #1");
      expect(container.textContent).toContain("Eligible Page 2");
      expect(container.textContent).toContain("1 selected");
      expect(container.textContent).not.toContain("Couldn't load more books.");

      // Also verify query change clears any prior failed-page error
      shouldFailPage2 = true;
      const searchInput = container.querySelector<HTMLInputElement>(
        'input[placeholder="Filter books not in collection…"]',
      );
      await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
        setter?.call(searchInput, "Eligible");
        searchInput?.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await act(async () => {
        vi.advanceTimersByTime(150);
        await Promise.resolve();
      });
      expect(container.textContent).toContain("Eligible #1");
    } finally {
      vi.stubGlobal("IntersectionObserver", origIO);
    }
  });

  it("BookList polls asynchronous iCloud hydration until available and does not open reader on child button Enter/Space", async () => {
    const cloudBook = makeBook("b-cloud", {
      title: "Cloud Novel",
      available: false,
      progress: 40,
      status: "reading",
    });
    const onBookAvailable = vi.fn();
    let checks = 0;
    mocks.invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "check_book_available") {
        checks += 1;
        return checks >= 3;
      }
      return null;
    });

    await act(async () => {
      root.render(
        <BookList books={[cloudBook]} onBookAvailable={onBookAvailable} />,
      );
    });

    const downloadBtn = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Download from iCloud"),
    );
    expect(downloadBtn).toBeDefined();

    // R8: keyboard Enter/Space on nested button must NOT open reader
    await act(async () => {
      downloadBtn?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      downloadBtn?.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));
    });
    expect(mocks.openReaderWindow).not.toHaveBeenCalled();

    // R5: click starts polling false -> false -> true across intervals, then calls onBookAvailable
    await act(async () => {
      downloadBtn?.click();
      await Promise.resolve();
    });
    expect(checks).toBe(1);
    expect(downloadBtn?.textContent).toContain("Downloading");
    expect(onBookAvailable).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(2000);
      await Promise.resolve();
    });
    expect(checks).toBe(2);
    expect(downloadBtn?.textContent).toContain("Downloading");
    expect(onBookAvailable).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(2000);
      await Promise.resolve();
    });
    expect(checks).toBe(3);
    expect(onBookAvailable).toHaveBeenCalledWith("b-cloud");
  });

  it("BookContextMenu displays multi-collection checkmarks, toggles membership, and creates+adds a collection", async () => {
    const onBooksChanged = vi.fn();

    await act(async () => {
      root.render(
        <BookContextMenu
          x={120}
          y={120}
          bookId="b1"
          bookStatus="reading"
          bookProgress={24}
          onClose={vi.fn()}
          onOpenBook={vi.fn()}
          onMarkFinished={vi.fn()}
          onMarkReading={vi.fn()}
          onMarkUnread={vi.fn()}
          onEditInfo={vi.fn()}
          onDelete={vi.fn()}
          onBooksChanged={onBooksChanged}
        />,
      );
    });

    expect(mocks.collectionsHook.getBookCollections).toHaveBeenCalledWith("b1");

    const addTrigger = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Add to Collection"),
    );
    await act(async () => {
      addTrigger?.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
      addTrigger?.click();
    });

    const colItems = container.querySelectorAll<HTMLButtonElement>('[role="menuitemcheckbox"]');
    expect(colItems).toHaveLength(2);
    expect(colItems[0].getAttribute("aria-checked")).toBe("true");
    expect(colItems[1].getAttribute("aria-checked")).toBe("false");

    await act(async () => {
      colItems[1].click();
    });
    expect(mocks.collectionsHook.addBook).toHaveBeenCalledWith("c2", "b1");
    expect(onBooksChanged).toHaveBeenCalled();

    const quickInput = container.querySelector<HTMLInputElement>('input[placeholder="Collection name…"]');
    expect(quickInput).not.toBeNull();
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(quickInput, "Essays");
      quickInput?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const createBtn = container.querySelector<HTMLButtonElement>('button[aria-label="Create & Add"]');
    await act(async () => {
      createBtn?.click();
    });
    expect(mocks.collectionsHook.create).toHaveBeenCalledWith("Essays");
    expect(mocks.collectionsHook.addBook).toHaveBeenCalledWith("c-new", "b1");
  });

  it("BookGrid and BookList suppress percent badges/bars on unread books that retain saved progress (Q1)", async () => {
    const books: Book[] = [
      makeBook("b-unread-preserved", {
        title: "Reset Unread Book",
        status: "unread",
        progress: 100,
      }),
      makeBook("b-reading", {
        title: "Active Reading Book",
        status: "reading",
        progress: 35,
      }),
      makeBook("b-finished", {
        title: "Completed Book",
        status: "finished",
        progress: 100,
      }),
    ];

    await act(async () => {
      root.render(<BookGrid books={books} />);
    });

    const cards = container.querySelectorAll("button");
    expect(cards).toHaveLength(3);
    // Unread book keeps stored progress in model, but renders NO percent badge on cover
    expect(cards[0].textContent).not.toContain("100%");
    // Reading book renders its 35% badge; finished book renders DoneBadge (no 100% text)
    expect(cards[1].textContent).toContain("35%");
    expect(cards[2].textContent).not.toContain("100%");

    await act(async () => {
      root.render(<BookList books={books} />);
    });

    const rows = container.querySelectorAll('[role="button"]');
    expect(rows).toHaveLength(3);
    expect(rows[0].textContent).toContain("Not started");
    expect(rows[0].textContent).not.toContain("100%");
    expect(rows[0].querySelector<HTMLElement>('[style*="width"]')?.style.width).toBe("0%");
    expect(rows[1].textContent).toContain("35% complete");
    expect(rows[1].querySelector<HTMLElement>('[style*="width"]')?.style.width).toBe("35%");
    expect(rows[2].textContent).toContain("Finished");
    expect(rows[2].querySelector<HTMLElement>('[style*="width"]')?.style.width).toBe("100%");
  });
});
