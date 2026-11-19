/** @vitest-environment jsdom */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { StrictMode, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../i18n";
import type { Book } from "../hooks/useBooks";
import type { Collection } from "../hooks/useCollections";

type DragDropCallback = (event: { type: string; paths: string[] }) => void;

const mocks = vi.hoisted(() => ({
  invoke: vi.fn<(cmd: string, args?: Record<string, unknown>) => Promise<unknown>>(),
  openFileDialog: vi.fn<() => Promise<string | null>>(),
  openReaderWindow: vi.fn<(id: string) => Promise<void>>(),
  minimizeWindow: vi.fn<() => Promise<void>>(),
  toggleMaximizeWindow: vi.fn<() => Promise<void>>(),
  closeWindow: vi.fn<() => Promise<void>>(),
  isWindowMaximized: vi.fn<() => Promise<boolean>>(),
  dragDropListeners: new Set<DragDropCallback>(),
  fileOpenListeners: new Set<(e: { payload: string[] }) => void>(),
  genericListeners: new Map<string, Set<(e: { payload: unknown }) => void>>(),
}));

vi.mock("../platform", () => ({
  invoke: (cmd: string, args?: Record<string, unknown>) => mocks.invoke(cmd, args),
  openFileDialog: () => mocks.openFileDialog(),
  convertFileSrc: (p: string) => `quill-file://local/${p}`,
  openUrl: vi.fn().mockResolvedValue(undefined),
  getOpenReaderCount: vi.fn().mockResolvedValue(0),
  minimizeWindow: () => mocks.minimizeWindow(),
  toggleMaximizeWindow: () => mocks.toggleMaximizeWindow(),
  closeWindow: () => mocks.closeWindow(),
  isWindowMaximized: () => mocks.isWindowMaximized(),
  onWindowMaximized: () => Promise.resolve(() => {}),
  listenCurrentWindow: (event: string, cb: (e: { payload: unknown }) => void) => {
    const set = mocks.genericListeners.get(event) ?? new Set();
    set.add(cb);
    mocks.genericListeners.set(event, set);
    return Promise.resolve(() => {
      set.delete(cb);
    });
  },
  listen: (event: string, cb: (e: { payload: unknown }) => void) => {
    if (event === "file-open") {
      const typed = cb as (e: { payload: string[] }) => void;
      mocks.fileOpenListeners.add(typed);
      return Promise.resolve(() => {
        mocks.fileOpenListeners.delete(typed);
      });
    }
    const set = mocks.genericListeners.get(event) ?? new Set();
    set.add(cb);
    mocks.genericListeners.set(event, set);
    return Promise.resolve(() => {
      set.delete(cb);
    });
  },
  onDragDrop: (cb: DragDropCallback) => {
    mocks.dragDropListeners.add(cb);
    return Promise.resolve(() => {
      mocks.dragDropListeners.delete(cb);
    });
  },
}));

vi.mock("../contexts/UpdateContext", () => ({
  useUpdate: () => ({
    status: "idle",
    update: null,
    progress: 0,
    downloadedBytes: 0,
    totalBytes: 0,
    lastCheckedAt: null,
    skippedVersion: null,
    error: null,
    manualCheck: false,
    upToDateSeq: 0,
    checkForUpdate: vi.fn(),
    downloadAndInstall: vi.fn(),
    cancelDownload: vi.fn(),
    skipVersion: vi.fn(),
    restart: vi.fn(),
  }),
}));

vi.mock("../utils/openReaderWindow", () => ({
  openReaderWindow: (id: string) => mocks.openReaderWindow(id),
}));

vi.mock("../components/HighlightsView", () => ({
  default: () => <div data-testid="highlights-view" />,
}));
vi.mock("../components/WordsView", () => ({
  default: () => <div data-testid="words-view" />,
}));
vi.mock("../components/ChatsView", () => ({
  default: () => <div data-testid="chats-view" />,
}));
vi.mock("../components/settings/SettingsView", () => ({
  default: ({
    section,
    onSelectSection,
    onClose,
    onBlockingChange,
  }: {
    section: string;
    onSelectSection: (s: string) => void;
    onClose: () => void;
    onBlockingChange?: (b: boolean) => void;
  }) => (
    <div data-testid="settings-view" data-section={section}>
      <button type="button" onClick={() => onSelectSection("updates")}>
        mock-tab-updates
      </button>
      <button type="button" onClick={() => onBlockingChange?.(true)}>
        mock-block
      </button>
      <button type="button" onClick={() => onBlockingChange?.(false)}>
        mock-unblock
      </button>
      <button type="button" onClick={onClose}>
        mock-close-settings
      </button>
    </div>
  ),
}));

import Home from "./Home";

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

describe("Home integration flows (R1, R2, R3, R6)", () => {
  const storage = new Map<string, string>();
  const localStorageMock = {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, val: string) => {
      storage.set(key, val);
    },
    clear: () => storage.clear(),
  };

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
    vi.stubGlobal("localStorage", localStorageMock);
    localStorage.clear();
    await i18n.changeLanguage("en");
    mocks.invoke.mockReset();
    mocks.openFileDialog.mockReset();
    mocks.openReaderWindow.mockReset();
    mocks.minimizeWindow.mockReset().mockResolvedValue();
    mocks.toggleMaximizeWindow.mockReset().mockResolvedValue();
    mocks.closeWindow.mockReset().mockResolvedValue();
    mocks.isWindowMaximized.mockReset().mockResolvedValue(false);
    mocks.dragDropListeners.clear();
    mocks.fileOpenListeners.clear();
    mocks.genericListeners.clear();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it("integrates Home + real CollectionsPopover for create, select, scoped import, and active-collection delete (R1)", async () => {
    let collections: Collection[] = [
      { id: "c1", name: "Existing", book_count: 1, sort_order: 0, created_at: 10, updated_at: 10 },
    ];
    const membership = new Map<string, string[]>([["c1", ["b1"]]]);
    const allBooks = [makeBook("b1", { title: "Existing Book" })];

    mocks.openFileDialog.mockResolvedValue("/tmp/scoped.epub");
    mocks.invoke.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "list_collections") return collections;
      if (cmd === "list_books_in_collection") {
        return membership.get(String(args?.collectionId)) ?? [];
      }
      if (cmd === "get_book_counts") {
        const colId = args?.collectionId as string | null;
        if (!colId) return { all: allBooks.length, reading: 0, finished: 0, unread: allBooks.length };
        const count = membership.get(colId)?.length ?? 0;
        return { all: count, reading: 0, finished: 0, unread: count };
      }
      if (cmd === "list_books") {
        const colId = args?.collectionId as string | null;
        const filtered = colId
          ? allBooks.filter((b) => (membership.get(colId) ?? []).includes(b.id))
          : allBooks;
        return { books: filtered, next_cursor: null, total: filtered.length };
      }
      if (cmd === "create_collection") {
        const created: Collection = {
          id: "c2",
          name: String(args?.name),
          book_count: 0,
          sort_order: 1,
          created_at: 20,
          updated_at: 20,
        };
        collections = [...collections, created];
        return created;
      }
      if (cmd === "import_book") {
        const imported = makeBook("b-scoped", { title: "Scoped Book" });
        allBooks.push(imported);
        return imported;
      }
      if (cmd === "add_book_to_collection") {
        const colId = String(args?.collectionId);
        const bookId = String(args?.bookId);
        membership.set(colId, [...(membership.get(colId) ?? []), bookId]);
        return null;
      }
      if (cmd === "delete_collection") {
        collections = collections.filter((c) => c.id !== args?.id);
        return null;
      }
      return null;
    });

    await act(async () => {
      root.render(<Home />);
    });
    await flushMicrotasks();

    // Home is default route; navigate to Library for collection flows
    const libraryTab = Array.from(
      container.querySelectorAll<HTMLButtonElement>("nav button"),
    ).find((b) => b.textContent === "Library");
    expect(libraryTab).toBeTruthy();
    await act(async () => {
      libraryTab?.click();
    });
    await flushMicrotasks();

    // Open CollectionsPopover and select Existing ("c1") via raw ID contract
    const triggerBtn = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("All collections"),
    );
    await act(async () => {
      triggerBtn?.click();
    });
    const existingRow = Array.from(container.querySelectorAll<HTMLElement>('[role="button"]')).find((el) =>
      el.textContent?.includes("Existing"),
    );
    await act(async () => {
      existingRow?.click();
    });
    await flushMicrotasks();

    expect(container.querySelector("h1")?.textContent).toBe("Existing");
    expect(container.textContent).toContain("Add Books");

    // Reopen popover -> Create "Favorites" -> selects new collection & shows empty collection card
    const existingTrigger = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Existing"),
    );
    await act(async () => {
      existingTrigger?.click();
    });
    const newTrigger = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("New collection"),
    );
    await act(async () => {
      newTrigger?.click();
    });
    const newInput = container.querySelector<HTMLInputElement>('input[placeholder="Collection name…"]');
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(newInput, "Favorites");
      newInput?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      newInput?.closest("form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    await flushMicrotasks();

    expect(container.querySelector("h1")?.textContent).toBe("Favorites");
    expect(container.textContent).toContain('"Favorites" is empty');

    // Empty collection "Import File…" imports and links to "c2" (NOT "collection:c2")
    const importFileBtn = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Import File"),
    );
    await act(async () => {
      importFileBtn?.click();
    });
    await flushMicrotasks();

    expect(mocks.invoke).toHaveBeenCalledWith("add_book_to_collection", {
      collectionId: "c2",
      bookId: "b-scoped",
    });
    expect(container.textContent).toContain("Scoped Book");

    // Delete active collection "c2" returns cleanly to "Library"
    const favTrigger = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Favorites"),
    );
    await act(async () => {
      favTrigger?.click();
    });
    const deleteFavBtn = container.querySelector<HTMLButtonElement>('button[aria-label="Delete Favorites"]');
    await act(async () => {
      deleteFavBtn?.click();
    });
    const confirmDelete = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Delete Collection"),
    );
    await act(async () => {
      confirmDelete?.click();
    });
    await flushMicrotasks();

    expect(container.querySelector("h1")?.textContent).toBe("Library");
  });

  it("cleans up async drag-drop & file-open subscriptions under StrictMode without duplicate imports (R2)", async () => {
    mocks.invoke.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "list_collections") return [];
      if (cmd === "get_book_counts") return { all: 0, reading: 0, finished: 0, unread: 0 };
      if (cmd === "list_books") return { books: [], next_cursor: null, total: 0 };
      if (cmd === "import_book") return makeBook(String(args?.filePath));
      return null;
    });

    await act(async () => {
      root.render(
        <StrictMode>
          <Home />
        </StrictMode>,
      );
    });
    await flushMicrotasks();

    expect(mocks.dragDropListeners.size).toBe(1);
    expect(mocks.fileOpenListeners.size).toBe(1);

    await act(async () => {
      for (const cb of mocks.dragDropListeners) {
        cb({ type: "drop", paths: ["/tmp/one.epub"] });
      }
    });
    await flushMicrotasks();

    const importCalls = mocks.invoke.mock.calls.filter(([cmd]) => cmd === "import_book");
    expect(importCalls).toHaveLength(1);
    expect(importCalls[0][1]).toEqual({ filePath: "/tmp/one.epub" });
  });

  it("continues importing remaining valid files after a failed file and refreshes successful imports (R3)", async () => {
    const library: Book[] = [];
    mocks.invoke.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "list_collections") return [];
      if (cmd === "get_book_counts") return { all: library.length, reading: 0, finished: 0, unread: library.length };
      if (cmd === "list_books") return { books: [...library], next_cursor: null, total: library.length };
      if (cmd === "import_book") {
        if (String(args?.filePath).endsWith("bad.epub")) {
          throw new Error("Corrupted archive");
        }
        const good = makeBook("good-1", { title: "Good Recovered Book" });
        library.push(good);
        return good;
      }
      return null;
    });

    await act(async () => {
      root.render(<Home />);
    });
    await flushMicrotasks();

    await act(async () => {
      for (const cb of mocks.dragDropListeners) {
        cb({ type: "drop", paths: ["/tmp/bad.epub", "/tmp/good.epub"] });
      }
    });
    await flushMicrotasks();

    const importCalls = mocks.invoke.mock.calls.filter(([cmd]) => cmd === "import_book");
    expect(importCalls).toHaveLength(2);
    expect(container.textContent).toContain("Good Recovered Book");
    const toast = container.querySelector('[data-testid="import-error-toast"]');
    expect(toast?.textContent).toContain("bad.epub: Corrupted archive");
  });

  it("preserves 40 loaded books and keeps BookContextMenu + submenu open on book mutations (R6)", async () => {
    const page1 = Array.from({ length: 20 }, (_, i) => makeBook(`b-${i + 1}`, { title: `Book #${i + 1}` }));
    const page2 = Array.from({ length: 20 }, (_, i) => makeBook(`b-${i + 21}`, { title: `Book #${i + 21}` }));
    const collections: Collection[] = [
      { id: "c1", name: "Sci-Fi", book_count: 0, sort_order: 0, created_at: 10, updated_at: 10 },
      { id: "c2", name: "Favorites", book_count: 0, sort_order: 1, created_at: 11, updated_at: 11 },
    ];
    const memberCols: string[] = [];

    mocks.invoke.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "list_collections") return collections;
      if (cmd === "list_books_in_collection") return [];
      if (cmd === "list_book_collections") return [...memberCols];
      if (cmd === "get_book_counts") return { all: 40, reading: 0, finished: 0, unread: 40 };
      if (cmd === "add_book_to_collection") {
        memberCols.push(String(args?.collectionId));
        return null;
      }
      if (cmd === "list_books") {
        if (args?.cursor === "cur-2") {
          return { books: page2, next_cursor: null, total: 40 };
        }
        const limit = (args?.limit as number | null) ?? 20;
        if (limit >= 40) {
          return { books: [...page1, ...page2], next_cursor: null, total: 40 };
        }
        return { books: page1, next_cursor: "cur-2", total: 40 };
      }
      return null;
    });

    let loadMoreSpy = false;
    const origIO = globalThis.IntersectionObserver;
    class ImmediateIO {
      cb: IntersectionObserverCallback;
      constructor(cb: IntersectionObserverCallback) {
        this.cb = cb;
      }
      observe() {
        if (!loadMoreSpy) {
          loadMoreSpy = true;
          this.cb([{ isIntersecting: true } as IntersectionObserverEntry], this as unknown as IntersectionObserver);
        }
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
    vi.stubGlobal("IntersectionObserver", ImmediateIO);

    try {
      await act(async () => {
        root.render(<Home />);
      });
      await flushMicrotasks();

      const libraryTab = Array.from(
        container.querySelectorAll<HTMLButtonElement>("nav button"),
      ).find((b) => b.textContent === "Library");
      await act(async () => {
        libraryTab?.click();
      });
      await flushMicrotasks();

      expect(container.textContent).toContain("Book #40");

      // Right-click Book #1 and open Add to Collection submenu
      const firstBookBtn = Array.from(container.querySelectorAll("button")).find((b) =>
        b.textContent?.includes("Book #1"),
      );
      await act(async () => {
        firstBookBtn?.dispatchEvent(
          new MouseEvent("contextmenu", { bubbles: true, clientX: 40, clientY: 40 }),
        );
      });
      await flushMicrotasks();

      const addToColBtn = Array.from(container.querySelectorAll("button")).find((b) =>
        b.textContent?.includes("Add to Collection"),
      );
      await act(async () => {
        addToColBtn?.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
        addToColBtn?.click();
      });

      const subItems = container.querySelectorAll<HTMLButtonElement>('[role="menuitemcheckbox"]');
      expect(subItems).toHaveLength(2);

      // Toggle first collection: must silently refresh 40 books AND keep menu + submenu open
      await act(async () => {
        subItems[0].click();
      });
      await flushMicrotasks();

      const listCallsAfterToggle = mocks.invoke.mock.calls.filter(
        ([cmd, args]) => cmd === "list_books" && (args?.limit as number | undefined) !== 500,
      );
      const latestLimit = listCallsAfterToggle[listCallsAfterToggle.length - 1]?.[1]?.limit;
      expect(latestLimit).toBe(40);
      expect(container.textContent).toContain("Book #40");
      expect(container.querySelectorAll('[role="menuitemcheckbox"]')).toHaveLength(2);
    } finally {
      vi.stubGlobal("IntersectionObserver", origIO);
    }
  });

  it("opens on Home by default and switches across all 5 TopBar routes", async () => {
    mocks.invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "list_collections") return [];
      if (cmd === "get_book_counts") return { all: 0, reading: 0, finished: 0, unread: 0 };
      if (cmd === "list_books") return { books: [], next_cursor: null, total: 0 };
      return [];
    });

    await act(async () => {
      root.render(<Home />);
    });
    await flushMicrotasks();

    expect(container.querySelector("h1")?.textContent).toBe("Your quiet reading room");
    expect(Array.from(container.querySelectorAll("nav button")).map((b) => b.textContent)).toEqual([
      "Home",
      "Library",
      "Highlights",
      "Words",
      "Chats",
    ]);

    for (const [label, selector] of [
      ["Highlights", '[data-testid="highlights-view"]'],
      ["Words", '[data-testid="words-view"]'],
      ["Chats", '[data-testid="chats-view"]'],
    ] as const) {
      const btn = Array.from(
        container.querySelectorAll<HTMLButtonElement>("nav button"),
      ).find((b) => b.textContent === label);
      await act(async () => {
        btn?.click();
      });
      await flushMicrotasks();
      expect(container.querySelector(selector)).toBeTruthy();
    }

    // Navigate to Library: no inline filter field; Cmd+F opens Cmd+K scoped to Books
    const libraryBtn = Array.from(
      container.querySelectorAll<HTMLButtonElement>("nav button"),
    ).find((b) => b.textContent === "Library");
    await act(async () => {
      libraryBtn?.click();
    });
    await flushMicrotasks();
    expect(container.querySelector('input[placeholder="Filter library…"]')).toBeNull();

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "f", metaKey: true, bubbles: true }));
    });
    await flushMicrotasks();

    const dialog = container.querySelector('[role="dialog"]');
    expect(dialog).toBeTruthy();
    const booksTab = Array.from(dialog?.querySelectorAll('[role="tab"]') ?? []).find((t) =>
      t.textContent?.includes("Books"),
    );
    expect(booksTab?.getAttribute("aria-selected")).toBe("true");
  });

  it("refreshes Home bento book progress and ordering when returning window focus after reading (R6)", async () => {
    let book1 = makeBook("b1", {
      title: "Older Book",
      status: "reading",
      progress: 15,
      pages: 200,
      updated_at: 1000,
    });
    let book2 = makeBook("b2", {
      title: "Newly Read Book",
      status: "unread",
      progress: 0,
      pages: 100,
      updated_at: 500,
    });

    mocks.invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "list_collections") return [];
      if (cmd === "get_book_counts") return { all: 2, reading: 1, finished: 0, unread: 1 };
      if (cmd === "list_books") return { books: [book1, book2], next_cursor: null, total: 2 };
      if (cmd === "list_all_highlights") return [];
      if (cmd === "list_all_vocab_words") return [];
      if (cmd === "list_all_chats") return { chats: [], next_cursor: null, total: 0 };
      return [];
    });

    await act(async () => {
      root.render(<Home />);
    });
    await flushMicrotasks();
    expect(container.textContent).toContain("Older Book");
    expect(container.textContent).toContain("15%");

    // Simulate reading Book 2 in reader window and returning focus to main window
    book2 = { ...book2, status: "reading", progress: 80, updated_at: 9999 };
    book1 = { ...book1, progress: 15, updated_at: 1000 };

    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    await flushMicrotasks();

    const nowReadingCard = Array.from(container.querySelectorAll("section")).find((el) =>
      el.textContent?.includes("Now reading"),
    );
    expect(nowReadingCard?.textContent).toContain("Newly Read Book");
    expect(nowReadingCard?.textContent).toContain("80%");
  });

  it("refreshes Home hero and Library filter counts immediately on book-status-changed from a side-by-side reader", async () => {
    let book1 = makeBook("b1", {
      title: "Older Book",
      status: "reading",
      progress: 15,
      updated_at: 1000,
    });
    let book2 = makeBook("b2", {
      title: "Just Opened Unread",
      status: "unread",
      progress: 0,
      updated_at: 500,
    });
    let counts = { all: 2, reading: 1, finished: 0, unread: 1 };

    mocks.invoke.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "list_collections") return [];
      if (cmd === "get_book_counts") return counts;
      if (cmd === "list_books") {
        const all = [book1, book2];
        const filter = args?.filter as string | null;
        const filtered = filter ? all.filter((b) => b.status === filter) : all;
        return { books: filtered, next_cursor: null, total: filtered.length };
      }
      if (cmd === "list_all_highlights") return [];
      if (cmd === "list_all_vocab_words") return [];
      if (cmd === "list_all_chats") return { chats: [], next_cursor: null, total: 0 };
      return [];
    });

    await act(async () => {
      root.render(<Home />);
    });
    await flushMicrotasks();

    expect(container.textContent).toContain("Older Book");

    // Simulate standalone reader opening book2 and emitting book-status-changed without focusing main
    book2 = { ...book2, status: "reading", updated_at: 9999 };
    book1 = { ...book1 };
    counts = { all: 2, reading: 2, finished: 0, unread: 0 };

    await act(async () => {
      for (const cb of mocks.genericListeners.get("book-status-changed") ?? []) {
        cb({ payload: "b2" });
      }
    });
    await flushMicrotasks();

    const nowReadingCard = Array.from(container.querySelectorAll("section")).find((el) =>
      el.textContent?.includes("Now reading"),
    );
    expect(nowReadingCard?.textContent).toContain("Just Opened Unread");

    const libraryTab = Array.from(
      container.querySelectorAll<HTMLButtonElement>("nav button"),
    ).find((b) => b.textContent === "Library");
    await act(async () => {
      libraryTab?.click();
    });
    await flushMicrotasks();

    const readingFilterBtn = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Reading"),
    );
    expect(readingFilterBtn?.textContent).toContain("2");
  });

  it("toggles in-window Settings via gear and Cmd+,, exits on route click, and routes open-settings sections", async () => {
    mocks.invoke.mockImplementation(async (cmd) => {
      if (cmd === "list_books") return { books: [], next_cursor: null, total: 0 };
      if (cmd === "list_collections") return [];
      if (cmd === "get_book_counts") return { all: 0, reading: 0, finished: 0, unread: 0 };
      if (cmd === "get_collection_book_counts") return {};
      if (cmd === "get_book_collections_map") return {};
      return [];
    });

    await act(async () => {
      root.render(<Home />);
    });
    await flushMicrotasks();

    expect(container.querySelector('[data-testid="settings-view"]')).toBeNull();
    expect(container.querySelector("h1")?.textContent).toBe("Your quiet reading room");

    // Gear toggles Settings open and closed from Home
    const gearBtn = container.querySelector<HTMLButtonElement>('button[aria-label="Settings"]');
    await act(async () => {
      gearBtn?.click();
    });
    expect(container.querySelector('[data-testid="settings-view"]')?.getAttribute("data-section")).toBe("general");
    await act(async () => {
      gearBtn?.click();
    });
    expect(container.querySelector('[data-testid="settings-view"]')).toBeNull();
    expect(container.querySelector("h1")?.textContent).toBe("Your quiet reading room");

    // Cmd+, toggles Settings open from Home, clicking Home route exits back to Home
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: ",", metaKey: true, bubbles: true }));
    });
    expect(container.querySelector('[data-testid="settings-view"]')).not.toBeNull();
    const homeBtn = Array.from(container.querySelectorAll<HTMLButtonElement>("nav button")).find((b) =>
      b.textContent === "Home",
    );
    await act(async () => {
      homeBtn?.click();
    });
    await flushMicrotasks();
    expect(container.querySelector('[data-testid="settings-view"]')).toBeNull();
    expect(container.querySelector("h1")?.textContent).toBe("Your quiet reading room");

    // Enter Library, open Settings via Cmd+,, and exit via Library route click
    const libraryBtn = Array.from(container.querySelectorAll<HTMLButtonElement>("nav button")).find((b) =>
      b.textContent?.includes("Library"),
    );
    await act(async () => {
      libraryBtn?.click();
    });
    await flushMicrotasks();
    expect(container.querySelector("h1")?.textContent).toBe("Library");

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: ",", metaKey: true, bubbles: true }));
    });
    expect(container.querySelector('[data-testid="settings-view"]')).not.toBeNull();

    // Clicking TopBar route exits Settings even back to Library
    await act(async () => {
      libraryBtn?.click();
    });
    expect(container.querySelector('[data-testid="settings-view"]')).toBeNull();
    expect(container.querySelector("h1")?.textContent).toBe("Library");

    // Cmd+, again opens, then Cmd+, toggles closed
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: ",", metaKey: true, bubbles: true }));
    });
    expect(container.querySelector('[data-testid="settings-view"]')).not.toBeNull();
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: ",", metaKey: true, bubbles: true }));
    });
    expect(container.querySelector('[data-testid="settings-view"]')).toBeNull();

    // Cross-window open-settings routes updates / lookup -> tools
    await act(async () => {
      for (const cb of mocks.genericListeners.get("open-settings") ?? []) {
        cb({ payload: "updates" });
      }
    });
    expect(container.querySelector('[data-testid="settings-view"]')?.getAttribute("data-section")).toBe("updates");

    await act(async () => {
      window.dispatchEvent(new CustomEvent("open-settings", { detail: { section: "lookup" } }));
    });
    expect(container.querySelector('[data-testid="settings-view"]')?.getAttribute("data-section")).toBe("tools");

    // Blocking sync marks the background shell inert and blocks TopBar actions + shortcuts
    const blockBtn = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
      (b) => b.textContent === "mock-block",
    );
    await act(async () => {
      blockBtn?.click();
    });
    expect(container.firstElementChild?.hasAttribute("inert")).toBe(true);

    const searchBtn = container.querySelector<HTMLButtonElement>('button[aria-label="Search Quill"]');
    const importBtn = container.querySelector<HTMLButtonElement>('button[aria-label="Import book"]');
    await act(async () => {
      searchBtn?.click();
      importBtn?.click();
      window.dispatchEvent(new KeyboardEvent("keydown", { key: ",", metaKey: true, bubbles: true }));
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true }));
      gearBtn?.click();
    });
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(mocks.openFileDialog).not.toHaveBeenCalled();
    expect(container.querySelector('[data-testid="settings-view"]')).not.toBeNull();

    const wordsBtn = Array.from(container.querySelectorAll<HTMLButtonElement>("nav button")).find((b) =>
      b.textContent?.includes("Words"),
    );
    await act(async () => {
      wordsBtn?.click();
    });
    expect(container.querySelector('[data-testid="settings-view"]')).not.toBeNull();

    const unblockBtn = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
      (b) => b.textContent === "mock-unblock",
    );
    await act(async () => {
      unblockBtn?.click();
    });
    expect(container.firstElementChild?.hasAttribute("inert")).toBe(false);
    await act(async () => {
      wordsBtn?.click();
    });
    expect(container.querySelector('[data-testid="settings-view"]')).toBeNull();
  });

  it("keeps Windows caption buttons stacked and operable above CommandSearchModal while backdrop click still closes search", async () => {
    mocks.invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "list_collections") return [];
      if (cmd === "get_book_counts") return { all: 0, reading: 0, finished: 0, unread: 0 };
      if (cmd === "list_books") return { books: [], next_cursor: null, total: 0 };
      if (cmd === "list_highlights" || cmd === "list_vocabulary" || cmd === "list_chats") return [];
      return null;
    });

    const origUa = navigator.userAgent;
    Object.defineProperty(window.navigator, "userAgent", {
      value: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
      configurable: true,
    });
    try {
      await act(async () => {
        root.render(<Home />);
      });
      await act(async () => {
        await Promise.resolve();
      });

      const searchBtn = container.querySelector<HTMLButtonElement>('button[aria-label="Search Quill"]');
      await act(async () => {
        searchBtn?.click();
      });

      const searchDialog = container.querySelector('[role="dialog"][aria-label="Search Quill"]');
      expect(searchDialog).not.toBeNull();
      const backdrop = searchDialog!.parentElement as HTMLElement;
      expect(backdrop.className).toContain("z-50");

      const header = container.querySelector("header")!;
      expect(header.className).not.toContain("z-30");
      const minBtn = container.querySelector<HTMLButtonElement>('button[aria-label="Minimize"]')!;
      const closeBtn = container.querySelector<HTMLButtonElement>('button[aria-label="Close"]')!;
      expect(minBtn.parentElement?.className).toContain("z-[55]");

      await act(async () => {
        minBtn.click();
        closeBtn.click();
      });
      expect(mocks.minimizeWindow).toHaveBeenCalledTimes(1);
      expect(mocks.closeWindow).toHaveBeenCalledTimes(1);
      expect(container.querySelector('[role="dialog"][aria-label="Search Quill"]')).not.toBeNull();

      // Clicking the search backdrop itself still dismisses search.
      await act(async () => {
        backdrop.click();
      });
      expect(container.querySelector('[role="dialog"][aria-label="Search Quill"]')).toBeNull();
    } finally {
      Object.defineProperty(window.navigator, "userAgent", {
        value: origUa,
        configurable: true,
      });
    }
  });
});
