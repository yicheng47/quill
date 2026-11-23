/** @vitest-environment jsdom */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import fs from "node:fs";
import path from "node:path";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../i18n";

const testState = vi.hoisted(() => ({
  initialReaderTheme: "original",
  windowLabel: "reader-book-1",
  setWindowBackgroundColor: vi.fn<(color: string) => Promise<void>>(() => Promise.resolve()),
  emitTo: vi.fn<(windowLabel: string, event: string, payload?: unknown) => Promise<void>>(() => Promise.resolve()),
  getBook: vi.fn(),
  updateBookStatus: vi.fn<(id: string, status: "reading" | "finished" | "unread") => Promise<void>>(() => Promise.resolve()),
  getAllSettings: vi.fn(),
  viewGoTo: vi.fn<(target: string) => Promise<void>>(() => Promise.resolve()),
  viewInit: vi.fn(() => Promise.resolve()),
  viewOpen: vi.fn(() => Promise.resolve()),
  minimizeWindow: vi.fn<() => Promise<void>>(() => Promise.resolve()),
  toggleMaximizeWindow: vi.fn<() => Promise<void>>(() => Promise.resolve()),
  closeWindow: vi.fn<() => Promise<void>>(() => Promise.resolve()),
  resizeObservers: [] as Array<{ el: Element; cb: ResizeObserverCallback }>,
  navigateListeners: new Set<(e: { payload: unknown }) => void>(),
  invoke: vi.fn<(cmd: string, args?: unknown) => Promise<unknown>>(() => Promise.resolve([])),
  listenCallbacks: new Map<string, (e: { payload: unknown }) => void>(),
  lastBookmarksResolvePages: undefined as ((cfis: Iterable<string>) => Promise<Map<string, number>>) | undefined,
  lastBookmarksOnAsk: undefined as ((text: string, cfi?: string, page?: number | null) => void) | undefined,
  lastVocabResolvePages: undefined as ((cfis: Iterable<string>) => Promise<Map<string, number>>) | undefined,
}));

vi.mock("../platform", () => ({
  convertFileSrc: (p: string) => `quill-file://local/${p}`,
  emitTo: (windowLabel: string, event: string, payload?: unknown) => testState.emitTo(windowLabel, event, payload),
  focusWindow: () => Promise.resolve(true),
  getCurrentWindowLabel: () => testState.windowLabel,
  getInitialReaderTheme: () => testState.initialReaderTheme,
  invoke: (cmd: string, args?: unknown) => testState.invoke(cmd, args),
  listen: (event: string, cb: (e: { payload: unknown }) => void) => {
    testState.listenCallbacks.set(event, cb);
    return Promise.resolve(() => {
      testState.listenCallbacks.delete(event);
    });
  },
  listenCurrentWindow: (event: string, cb: (e: { payload: unknown }) => void) => {
    if (event === "reader-navigate") {
      testState.navigateListeners.add(cb);
      return Promise.resolve(() => {
        testState.navigateListeners.delete(cb);
      });
    }
    return Promise.resolve(() => {});
  },
  onWindowResized: () => Promise.resolve(() => {}),
  setWindowBackgroundColor: testState.setWindowBackgroundColor,
  setWindowTitle: () => Promise.resolve(),
  setZoom: () => Promise.resolve(),
  setTitlebarZoom: () => Promise.resolve(),
  minimizeWindow: () => testState.minimizeWindow(),
  toggleMaximizeWindow: () => testState.toggleMaximizeWindow(),
  closeWindow: () => testState.closeWindow(),
  isWindowMaximized: () => Promise.resolve(false),
  onWindowMaximized: () => Promise.resolve(() => {}),
}));

vi.mock("../hooks/useBooks", () => ({
  getBook: (...args: unknown[]) => testState.getBook(...args),
  updateBookStatus: (id: string, status: "reading" | "finished" | "unread") => testState.updateBookStatus(id, status),
  updateReadingProgress: () => Promise.resolve(),
  checkBookAvailable: () => Promise.resolve(true),
  checkBookReadable: () => Promise.resolve(true),
}));

vi.mock("../hooks/useSettings", () => ({
  getAllSettings: (...args: unknown[]) => testState.getAllSettings(...args),
}));

vi.mock("../components/AiPanel", () => ({
  default: (props: {
    context?: { text: string; cfi?: string; page?: number | null };
    initialChatId?: string;
    initialChatSeq?: number;
    visible?: boolean;
  }) => (
    <div
      data-testid="ai-panel-stub"
      data-quote={props.context?.text ?? ""}
      data-quote-cfi={props.context?.cfi ?? ""}
      data-quote-page={props.context?.page != null ? String(props.context.page) : ""}
      data-chat-id={props.initialChatId ?? ""}
      data-chat-seq={String(props.initialChatSeq ?? 0)}
      data-visible={String(props.visible ?? true)}
    >
      AI Panel
    </div>
  ),
}));

vi.mock("../components/DictionaryPanel", () => ({
  default: (props: { resolvePages?: (cfis: Iterable<string>) => Promise<Map<string, number>> }) => {
    testState.lastVocabResolvePages = props.resolvePages;
    return <div data-testid="vocab-panel-stub">Vocab Panel</div>;
  },
}));

vi.mock("../components/BookmarksPanel", () => ({
  default: (props: {
    resolvePages?: (cfis: Iterable<string>) => Promise<Map<string, number>>;
    onAsk?: (text: string, cfi?: string, page?: number | null) => void;
  }) => {
    testState.lastBookmarksResolvePages = props.resolvePages;
    testState.lastBookmarksOnAsk = props.onAsk;
    return <div data-testid="bookmarks-panel-stub">Bookmarks Panel</div>;
  },
}));

import Reader, { getPdfOverlays, getReaderScrollbarVars } from "./Reader";
import { getPageInfoFromRelocate } from "../utils/savedItemPages";
import { getThemeStyles } from "../components/ReaderSettings";

class MockFoliateView extends HTMLElement {
  book = { toc: [], sections: [] as Array<Record<string, unknown>> };
  renderer = {
    setAttribute: vi.fn(),
    setStyles: vi.fn(),
    getContents: (): Array<{ index?: number }> => [],
  };
  history = Object.assign(new EventTarget(), {
    canGoBack: false,
    canGoForward: false,
    back: vi.fn(),
    forward: vi.fn(),
  });
  lastLocation = null;
  open = testState.viewOpen;
  init = testState.viewInit;
  goTo = testState.viewGoTo;
  prev = vi.fn(() => Promise.resolve());
  next = vi.fn(() => Promise.resolve());
  close = vi.fn();
  getCFI = (index: number) => `epubcfi(/6/${(index + 1) * 2}!/4/2/1:0)`;
  resolveCFI = vi.fn(() => null);
  getLocationOf = vi.fn(() => null);
  addAnnotation = vi.fn(() => Promise.resolve());
  deleteAnnotation = vi.fn(() => Promise.resolve());
  deselect = vi.fn();
}

if (!customElements.get("foliate-view")) {
  customElements.define("foliate-view", MockFoliateView);
}

function selectorSpecificity(selector: string): number {
  const cleaned = selector.trim();
  const idCount = (cleaned.match(/#[a-zA-Z0-9_-]+/g) ?? []).length;
  const classAttrPseudo = (cleaned.match(/(?:\.[a-zA-Z0-9_-]+|\[[^\]]+\]|:(?!not\()[a-zA-Z0-9_-]+)/g) ?? []).length;
  return idCount * 100 + classAttrPseudo;
}

function resolveInheritedCssVars(el: Element, sheet: CSSStyleSheet): Record<string, string> {
  const chain: Element[] = [];
  for (let cur: Element | null = el; cur; cur = cur.parentElement) {
    chain.unshift(cur);
  }
  const rules = Array.from(sheet.cssRules).filter(
    (r): r is CSSStyleRule => r.type === CSSRule.STYLE_RULE,
  );
  const resolved: Record<string, string> = {};
  for (const node of chain) {
    const matched = rules
      .map((rule, order) => ({ rule, order }))
      .filter(({ rule }) =>
        rule.selectorText.split(",").some((sel) => {
          try {
            return node.matches(sel.trim());
          } catch {
            return false;
          }
        }),
      )
      .sort((a, b) => {
        const diff = selectorSpecificity(a.rule.selectorText) - selectorSpecificity(b.rule.selectorText);
        return diff !== 0 ? diff : a.order - b.order;
      });
    for (const { rule } of matched) {
      for (let i = 0; i < rule.style.length; i++) {
        const name = rule.style[i];
        if (name.startsWith("--")) {
          resolved[name] = rule.style.getPropertyValue(name).trim();
        }
      }
    }
  }
  return resolved;
}

function extractCssRuleBlock(css: string, selector: string): string {
  const idx = css.indexOf(`${selector} {`);
  if (idx === -1) return "";
  let depth = 0;
  let start = -1;
  for (let i = idx; i < css.length; i++) {
    if (css[i] === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (css[i] === "}") {
      depth--;
      if (depth === 0 && start !== -1) {
        return css.slice(idx, i + 1);
      }
    }
  }
  return "";
}

function installReaderThemeStyles(): HTMLStyleElement {
  const cssPath = path.resolve(process.cwd(), "src/index.css");
  const raw = fs.readFileSync(cssPath, "utf8");
  const blocks = [
    extractCssRuleBlock(raw, "@theme").replace(/^@theme/, ":root"),
    extractCssRuleBlock(raw, ".dawn"),
    extractCssRuleBlock(raw, ".dawn.dark"),
    extractCssRuleBlock(raw, ".dark"),
  ]
    .filter(Boolean)
    .join("\n");
  const style = document.createElement("style");
  style.textContent = blocks;
  document.head.appendChild(style);
  return style;
}

describe("Reader shell themes, cascade, and startup navigation", () => {
  const stored = new Map<string, string>();
  const localStorageMock = {
    get length() {
      return stored.size;
    },
    clear: () => stored.clear(),
    key: (i: number) => Array.from(stored.keys())[i] ?? null,
    getItem: (k: string) => stored.get(k) ?? null,
    setItem: (k: string, v: string) => {
      stored.set(k, v);
    },
    removeItem: (k: string) => {
      stored.delete(k);
    },
  };

  let container: HTMLDivElement;
  let root: Root;
  let styleEl: HTMLStyleElement | null = null;

  beforeEach(async () => {
    vi.stubGlobal("localStorage", localStorageMock);
    localStorage.clear();
    testState.initialReaderTheme = "original";
    testState.windowLabel = "reader-book-1";
    testState.setWindowBackgroundColor.mockClear();
    testState.emitTo.mockReset().mockResolvedValue(undefined);
    testState.getBook.mockReset();
    testState.updateBookStatus.mockReset().mockResolvedValue(undefined);
    testState.getAllSettings.mockReset();
    testState.viewGoTo.mockClear();
    testState.viewInit.mockClear();
    testState.viewOpen.mockClear();
    testState.minimizeWindow.mockClear();
    testState.toggleMaximizeWindow.mockClear();
    testState.closeWindow.mockClear();
    testState.resizeObservers = [];
    testState.navigateListeners.clear();
    testState.invoke.mockReset().mockResolvedValue([]);
    testState.listenCallbacks.clear();
    testState.lastBookmarksResolvePages = undefined;
    testState.lastBookmarksOnAsk = undefined;
    testState.lastVocabResolvePages = undefined;

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ blob: async () => new Blob(["epub"]) })),
    );
    vi.stubGlobal(
      "ResizeObserver",
      class {
        cb: ResizeObserverCallback;
        constructor(cb: ResizeObserverCallback) {
          this.cb = cb;
        }
        observe(el: Element) {
          testState.resizeObservers.push({ el, cb: this.cb });
        }
        disconnect() {}
        unobserve() {}
      },
    );

    document.documentElement.classList.remove("dawn", "dark");
    delete document.documentElement.dataset.readerTheme;
    await i18n.changeLanguage("en");

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    styleEl?.remove();
    styleEl = null;
    document.documentElement.classList.remove("dawn", "dark");
    delete document.documentElement.dataset.readerTheme;
    vi.unstubAllGlobals();
  });

  async function renderReader(initialUrl: string) {
    window.history.replaceState({}, "", initialUrl);
    await act(async () => {
      root.render(
        <MemoryRouter initialEntries={[initialUrl]}>
          <Routes>
            <Route path="/reader/:bookId" element={<Reader />} />
          </Routes>
        </MemoryRouter>,
      );
    });
  }

  async function flushAsync() {
    for (let i = 0; i < 6; i++) {
      await act(async () => {
        await Promise.resolve();
      });
    }
  }

  it("inherits Nocturne tokens down into Reader toolbar and content without a nested .dawn reset", async () => {
    styleEl = installReaderThemeStyles();
    testState.initialReaderTheme = "dark";
    localStorage.setItem("reader-settings-book-1", JSON.stringify({ theme: "dark" }));
    testState.getBook.mockResolvedValue({
      id: "book-1",
      title: "Notes from Underground",
      author: "Dostoevsky",
      format: "epub",
      file_path: "/tmp/notes.epub",
      progress: 0,
      available: true,
    });
    testState.getAllSettings.mockResolvedValue({ reader_theme: "original" });

    await renderReader("/reader/book-1");
    await flushAsync();

    expect(document.documentElement.classList.contains("dawn")).toBe(true);
    expect(document.documentElement.classList.contains("dark")).toBe(true);

    const rootWrapper = container.firstElementChild as HTMLElement;
    expect(rootWrapper.className).not.toContain("dawn ");
    expect(rootWrapper.className.split(/\s+/)).not.toContain("dawn");

    const titleEl = container.querySelector("h1")!;
    expect(titleEl.textContent).toBe("Notes from Underground");
    const vars = resolveInheritedCssVars(titleEl, styleEl.sheet!);
    expect(vars["--color-text-primary"]).toBe("#f0eae1");
    expect(vars["--color-text-secondary"]).toBe("#b6aea2");
    expect(vars["--color-accent"]).toBe("#6f62da");
    expect(vars["--color-accent-fg"]).toBe("#a193f5");

    // Verify nested .dawn on rootWrapper WOULD override inherited Nocturne colors if reintroduced
    rootWrapper.classList.add("dawn");
    expect(resolveInheritedCssVars(titleEl, styleEl.sheet!)["--color-text-primary"]).toBe("#15151a");
    rootWrapper.classList.remove("dawn");
  });

  it("applies global page theme on frame 0 before getAllSettings resolves and preserves per-book override", async () => {
    testState.initialReaderTheme = "dark";
    testState.getBook.mockReturnValue(new Promise(() => {}));
    testState.getAllSettings.mockReturnValue(new Promise(() => {}));

    await renderReader("/reader/book-2");

    // First frame must already be Nocturne dark (#0D0C0B), never flashing light #EEEBF8
    expect(document.documentElement.classList.contains("dawn")).toBe(true);
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(testState.setWindowBackgroundColor).toHaveBeenCalledWith("#0D0C0B");
    expect(testState.setWindowBackgroundColor).not.toHaveBeenCalledWith("#EEEBF8");

    await act(async () => {
      root.unmount();
    });
    testState.setWindowBackgroundColor.mockClear();

    // Per-book localStorage override takes precedence over global initialReaderTheme
    localStorage.setItem("reader-settings-book-3", JSON.stringify({ theme: "paper" }));
    root = createRoot(container);
    await renderReader("/reader/book-3");
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    expect(testState.setWindowBackgroundColor).toHaveBeenCalledWith("#F0E7D4");
    expect((container.firstElementChild as HTMLElement).className).toContain("reader-shell-sepia");
  });

  it("does not replay ?openVocab or ?openChat navigation when resizing across the dual-island breakpoint", async () => {
    testState.getBook.mockResolvedValue({
      id: "book-1",
      title: "Mock EPUB",
      author: "Author",
      format: "epub",
      file_path: "/tmp/book.epub",
      progress: 0,
      available: true,
    });
    testState.getAllSettings.mockResolvedValue({});

    // Start wide (1440px -> 1400px workspace) with ?openVocab=true&cfi=epubcfi(/6/4)
    Object.defineProperty(window, "innerWidth", { writable: true, configurable: true, value: 1440 });
    await renderReader("/reader/book-1?openVocab=true&cfi=epubcfi(/6/4)");
    await flushAsync();

    expect(testState.viewGoTo).toHaveBeenCalledTimes(1);
    expect(testState.viewGoTo).toHaveBeenCalledWith("epubcfi(/6/4)");
    expect(container.querySelector('[data-testid="vocab-panel-stub"]')).not.toBeNull();
    expect(
      container.querySelector('[data-testid="vocab-panel-stub"]')?.parentElement?.className.split(/\s+/),
    ).not.toContain("hidden");

    // User closes Words panel, then resizes window across dual-island threshold (1440 -> 700 -> 1440)
    const vocabBtn = container.querySelector<HTMLButtonElement>('button[aria-label="Words in Book"]')!;
    await act(async () => {
      vocabBtn.click();
    });
    expect(container.querySelector('[data-testid="vocab-panel-stub"]')).toBeNull();

    for (const width of [700, 1440]) {
      Object.defineProperty(window, "innerWidth", { writable: true, configurable: true, value: width });
      await act(async () => {
        window.dispatchEvent(new Event("resize"));
        for (const obs of testState.resizeObservers) {
          Object.defineProperty(obs.el, "clientWidth", { configurable: true, value: width });
          obs.cb([], {} as ResizeObserver);
        }
      });
    }
    await flushAsync();

    expect(testState.viewGoTo).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[data-testid="vocab-panel-stub"]')).toBeNull();

    // Same invariant for ?openChat=true&chatId=chat-9
    await act(async () => {
      root.unmount();
    });
    testState.viewGoTo.mockClear();
    root = createRoot(container);
    await renderReader("/reader/book-4?openChat=true&chatId=chat-9");
    await flushAsync();

    const aiContainer = container.querySelector('[data-testid="ai-panel-stub"]')?.parentElement;
    expect(aiContainer?.className.split(/\s+/)).not.toContain("hidden");

    const askBtn = container.querySelector<HTMLButtonElement>('button[aria-label="AI Assistant"]')!;
    await act(async () => {
      askBtn.click();
    });
    expect(aiContainer?.className.split(/\s+/)).toContain("hidden");

    Object.defineProperty(window, "innerWidth", { writable: true, configurable: true, value: 700 });
    await act(async () => {
      window.dispatchEvent(new Event("resize"));
    });
    await flushAsync();
    expect(aiContainer?.className.split(/\s+/)).toContain("hidden");
  });

  it("handles standalone ?cfi=, ?quote= Ask Quill deep links, and reader-navigate events on an open window", async () => {
    testState.getBook.mockResolvedValue({
      id: "book-1",
      title: "Invisible Cities",
      author: "Italo Calvino",
      format: "epub",
      file_path: "/tmp/ic.epub",
      progress: 0,
      available: true,
    });
    testState.getAllSettings.mockResolvedValue({});

    // Standalone ?cfi= jumps to location without opening side panels (AiPanel stays mounted but hidden)
    await renderReader("/reader/book-1?cfi=epubcfi%28%2F6%2F6%21%2F4%2F2%29");
    await flushAsync();
    expect(testState.viewGoTo).toHaveBeenCalledWith("epubcfi(/6/6!/4/2)");
    const hiddenAi = container.querySelector('[data-testid="ai-panel-stub"]')?.parentElement;
    expect(hiddenAi?.className.split(/\s+/)).toContain("hidden");
    expect(container.querySelector('[data-testid="vocab-panel-stub"]')).toBeNull();

    // Deliver reader-navigate event carrying quote + cfi to already-open reader window
    testState.viewGoTo.mockClear();
    await act(async () => {
      for (const cb of testState.navigateListeners) {
        cb({
          payload: {
            openChat: true,
            cfi: "epubcfi(/6/8!/4/2)",
            quote: "Cities, like dreams, are made of desires.",
          },
        });
      }
    });
    await flushAsync();
    expect(testState.viewGoTo).toHaveBeenCalledWith("epubcfi(/6/8!/4/2)");
    const aiStub = container.querySelector('[data-testid="ai-panel-stub"]')!;
    expect(aiStub.parentElement?.className.split(/\s+/)).not.toContain("hidden");
    expect(aiStub.getAttribute("data-quote")).toBe("Cities, like dreams, are made of desires.");
    expect(aiStub.getAttribute("data-quote-cfi")).toBe("epubcfi(/6/8!/4/2)");

    // Opening directly with ?quote=...&cfi=...&openChat=true quotes into AI panel and jumps to CFI
    await act(async () => {
      root.unmount();
    });
    testState.viewGoTo.mockClear();
    root = createRoot(container);
    await renderReader(
      "/reader/book-1?openChat=true&cfi=epubcfi%28%2F6%2F10%21%2F4%2F2%29&quote=Memory%20vs%20blueprint",
    );
    await flushAsync();
    expect(testState.viewGoTo).toHaveBeenCalledWith("epubcfi(/6/10!/4/2)");
    const directAiStub = container.querySelector('[data-testid="ai-panel-stub"]')!;
    expect(directAiStub.getAttribute("data-quote")).toBe("Memory vs blueprint");
    expect(directAiStub.getAttribute("data-quote-cfi")).toBe("epubcfi(/6/10!/4/2)");

    // Repeated reader-navigate for the same chatId bumps initialChatSeq so AiPanel reloads it (R8)
    await act(async () => {
      for (const cb of testState.navigateListeners) {
        cb({ payload: { openChat: true, chatId: "chat-A" } });
      }
    });
    await flushAsync();
    const seq1 = Number(directAiStub.getAttribute("data-chat-seq"));
    expect(directAiStub.getAttribute("data-chat-id")).toBe("chat-A");

    await act(async () => {
      for (const cb of testState.navigateListeners) {
        cb({ payload: { openChat: true, chatId: "chat-A" } });
      }
    });
    await flushAsync();
    expect(directAiStub.getAttribute("data-chat-id")).toBe("chat-A");
    expect(Number(directAiStub.getAttribute("data-chat-seq"))).toBeGreaterThan(seq1);
  });

  it("marks unread books as reading once on open and leaves reading/finished untouched", async () => {
    testState.getAllSettings.mockResolvedValue({});

    testState.getBook.mockResolvedValue({
      id: "book-unread",
      title: "Unread Book",
      author: "Author",
      format: "epub",
      file_path: "/tmp/unread.epub",
      status: "unread",
      progress: 0,
      available: true,
    });

    await renderReader("/reader/book-unread");
    await flushAsync();

    expect(testState.updateBookStatus).toHaveBeenCalledTimes(1);
    expect(testState.updateBookStatus).toHaveBeenCalledWith("book-unread", "reading");
    expect(testState.emitTo).toHaveBeenCalledWith("main", "book-status-changed", "book-unread");

    // Progress updates (relocate) do not re-trigger updateBookStatus
    testState.updateBookStatus.mockClear();
    testState.emitTo.mockClear();
    const viewEl = container.querySelector("foliate-view");
    await act(async () => {
      viewEl?.dispatchEvent(
        new CustomEvent("relocate", {
          detail: { fraction: 0.2, cfi: "epubcfi(/6/4!/2)" },
        }),
      );
    });
    await flushAsync();
    expect(testState.updateBookStatus).not.toHaveBeenCalled();

    // Reopening a book already in "reading" does not call updateBookStatus
    await act(async () => {
      root.unmount();
    });
    testState.updateBookStatus.mockClear();
    testState.emitTo.mockClear();
    testState.getBook.mockResolvedValue({
      id: "book-reading",
      title: "Reading Book",
      author: "Author",
      format: "epub",
      file_path: "/tmp/reading.epub",
      status: "reading",
      progress: 35,
      available: true,
    });
    root = createRoot(container);
    await renderReader("/reader/book-reading");
    await flushAsync();

    expect(testState.updateBookStatus).not.toHaveBeenCalled();
    expect(testState.emitTo).not.toHaveBeenCalledWith("main", "book-status-changed", expect.anything());

    // Reopening a "finished" book keeps it finished (e.g. looking up a quote)
    await act(async () => {
      root.unmount();
    });
    testState.updateBookStatus.mockClear();
    testState.emitTo.mockClear();
    testState.getBook.mockResolvedValue({
      id: "book-finished",
      title: "Finished Book",
      author: "Author",
      format: "epub",
      file_path: "/tmp/finished.epub",
      status: "finished",
      progress: 100,
      available: true,
    });
    root = createRoot(container);
    await renderReader("/reader/book-finished");
    await flushAsync();

    expect(testState.updateBookStatus).not.toHaveBeenCalled();
    expect(testState.emitTo).not.toHaveBeenCalledWith("main", "book-status-changed", expect.anything());
  });

  it("renders Reader toolbar drag region without window controls on macOS, and with WindowControls on Windows", async () => {
    testState.getBook.mockResolvedValue({
      id: "book-1",
      title: "Notes from Underground",
      author: "Fyodor Dostoevsky",
      format: "epub",
      file_path: "/tmp/notes.epub",
      progress: 0,
      available: true,
    });
    testState.getAllSettings.mockResolvedValue({});

    const origUa = navigator.userAgent;
    try {
      Object.defineProperty(window.navigator, "userAgent", {
        value: "Mozilla/5.0 (Macintosh; Intel Mac OS X 15_0)",
        configurable: true,
      });
      await renderReader("/reader/book-1");
      await flushAsync();

      const macHeader = container.querySelector("header")!;
      expect(macHeader.hasAttribute("data-drag-region")).toBe(true);
      expect(macHeader.querySelector(".w-\\[60px\\]")).not.toBeNull();
      expect(macHeader.querySelector('button[aria-label="Minimize"]')).toBeNull();
      expect(macHeader.querySelector('button[aria-label="Close"]')).toBeNull();

      await act(async () => {
        root.unmount();
      });
      root = createRoot(container);

      Object.defineProperty(window.navigator, "userAgent", {
        value: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
        configurable: true,
      });
      await renderReader("/reader/book-1");
      await flushAsync();

      const winHeader = container.querySelector("header")!;
      expect(winHeader.hasAttribute("data-drag-region")).toBe(true);
      expect(winHeader.className).toContain("px-3 sm:px-6");
      expect(winHeader.className).not.toMatch(/\bz-\d/);
      expect(winHeader.querySelector(".w-\\[60px\\]")).toBeNull();
      const rightCluster = winHeader.lastElementChild as HTMLElement;
      const minBtn = rightCluster.querySelector<HTMLButtonElement>('button[aria-label="Minimize"]')!;
      const maxBtn = rightCluster.querySelector<HTMLButtonElement>('button[aria-label="Maximize"]')!;
      const closeBtn = rightCluster.querySelector<HTMLButtonElement>('button[aria-label="Close"]')!;
      expect(minBtn).not.toBeNull();
      expect(maxBtn).not.toBeNull();
      expect(closeBtn).not.toBeNull();
      expect(minBtn.parentElement?.className).toContain("z-[55]");

      // Opening Typography popover puts a z-40 dismiss backdrop in place while WindowControls stays above at z-[55].
      const typographyBtn = rightCluster.querySelector<HTMLButtonElement>('button[aria-label="Typography"]')!;
      await act(async () => {
        typographyBtn.click();
      });
      const backdrop = container.querySelector<HTMLElement>(".fixed.inset-0.z-40");
      expect(backdrop).not.toBeNull();
      expect(container.querySelector('[role="dialog"][aria-label="Typography"]')).not.toBeNull();

      // Clicking Minimize (full mousedown -> mouseup -> click sequence) operates the window.
      await act(async () => {
        minBtn.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
        minBtn.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
        minBtn.click();
      });
      expect(testState.minimizeWindow).toHaveBeenCalledTimes(1);

      // Re-open Typography and verify backdrop mousedown still dismisses the popover.
      await act(async () => {
        typographyBtn.click();
      });
      const reopenedBackdrop = container.querySelector<HTMLElement>(".fixed.inset-0.z-40")!;
      expect(reopenedBackdrop).not.toBeNull();
      await act(async () => {
        reopenedBackdrop.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
      });
      expect(container.querySelector('[role="dialog"][aria-label="Typography"]')).toBeNull();
    } finally {
      Object.defineProperty(window.navigator, "userAgent", {
        value: origUa,
        configurable: true,
      });
    }
  });

  it("keeps a draggable header with working WindowControls on Windows when getBook is pending or fails", async () => {
    testState.getAllSettings.mockResolvedValue({});
    const origUa = navigator.userAgent;

    try {
      // Pending getBook() on Windows still mounts draggable header and caption buttons (no divider).
      Object.defineProperty(window.navigator, "userAgent", {
        value: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
        configurable: true,
      });
      testState.getBook.mockReturnValue(new Promise(() => {}));
      await renderReader("/reader/book-pending");

      const pendingHeader = container.querySelector("header")!;
      expect(pendingHeader).not.toBeNull();
      expect(pendingHeader.hasAttribute("data-drag-region")).toBe(true);
      expect(pendingHeader.querySelector("span[aria-hidden='true']")).toBeNull();
      const pendingMin = pendingHeader.querySelector<HTMLButtonElement>('button[aria-label="Minimize"]')!;
      const pendingClose = pendingHeader.querySelector<HTMLButtonElement>('button[aria-label="Close"]')!;
      expect(pendingMin).not.toBeNull();
      expect(pendingClose).not.toBeNull();
      await act(async () => {
        pendingMin.click();
        pendingClose.click();
      });
      expect(testState.minimizeWindow).toHaveBeenCalledTimes(1);
      expect(testState.closeWindow).toHaveBeenCalledTimes(1);

      // Rejected getBook() on Windows keeps draggable header and working controls on the error screen.
      await act(async () => {
        root.unmount();
      });
      root = createRoot(container);
      testState.minimizeWindow.mockClear();
      testState.closeWindow.mockClear();
      testState.getBook.mockRejectedValue(new Error("not found"));
      await renderReader("/reader/book-missing");
      await flushAsync();

      const failedHeader = container.querySelector("header")!;
      expect(failedHeader).not.toBeNull();
      expect(failedHeader.hasAttribute("data-drag-region")).toBe(true);
      expect(failedHeader.querySelector("span[aria-hidden='true']")).toBeNull();
      const failedClose = failedHeader.querySelector<HTMLButtonElement>('button[aria-label="Close"]')!;
      expect(failedClose).not.toBeNull();
      await act(async () => {
        failedClose.click();
      });
      expect(testState.closeWindow).toHaveBeenCalledTimes(1);

      // macOS loading/failed screens remain header-free.
      await act(async () => {
        root.unmount();
      });
      root = createRoot(container);
      Object.defineProperty(window.navigator, "userAgent", {
        value: "Mozilla/5.0 (Macintosh; Intel Mac OS X 15_0)",
        configurable: true,
      });
      await renderReader("/reader/book-missing");
      await flushAsync();
      expect(container.querySelector("header")).toBeNull();
    } finally {
      Object.defineProperty(window.navigator, "userAgent", {
        value: origUa,
        configurable: true,
      });
    }
  });
  it("passes visible=false to mounted AiPanel on ordinary book open and visible=true when Ask Quill opens (#358)", async () => {
    testState.getBook.mockResolvedValue({
      id: "book-1",
      title: "Dune",
      author: "Frank Herbert",
      format: "epub",
      file_path: "/tmp/dune.epub",
      current_cfi: null,
      progress: 0,
      status: "reading",
    });
    testState.getAllSettings.mockResolvedValue({
      theme: "light",
      reader_theme: "original",
      ai_auth_mode: "codex",
    });

    await renderReader("/reader/book-1");
    await flushAsync();

    const aiStub = container.querySelector('[data-testid="ai-panel-stub"]');
    expect(aiStub?.getAttribute("data-visible")).toBe("false");

    const askBtn = container.querySelector<HTMLButtonElement>('button[aria-label="AI Assistant"]');
    expect(askBtn).not.toBeNull();
    await act(async () => {
      askBtn!.click();
    });
    await flushAsync();

    expect(container.querySelector('[data-testid="ai-panel-stub"]')?.getAttribute("data-visible")).toBe(
      "true",
    );
  });

  it("injects transparent-track inset iframe scrollbar CSS on both macOS and Windows", async () => {
    const originalUA = navigator.userAgent;
    const epubBook = {
      id: "book-1",
      title: "Stoner",
      author: "John Williams",
      format: "epub",
      file_path: "/tmp/stoner.epub",
      progress: 0,
      status: "reading",
      current_cfi: null,
    };

    try {
      for (const ua of [
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      ]) {
        Object.defineProperty(window.navigator, "userAgent", {
          configurable: true,
          value: ua,
        });
        testState.getBook.mockResolvedValue(epubBook);
        testState.getAllSettings.mockResolvedValue({ reader_theme: "dark" });

        await renderReader("/reader/book-1");
        await flushAsync();

        const view = container.querySelector("foliate-view") as MockFoliateView | null;
        const calls = view?.renderer.setStyles.mock.calls ?? [];
        const css = calls[calls.length - 1]?.[0] as string;
        expect(css).toContain("color-scheme: dark;");
        expect(css).toContain("::-webkit-scrollbar { width: 8px; height: 8px; }");
        expect(css).toContain("::-webkit-scrollbar-track");
        expect(css).toContain("::-webkit-scrollbar-corner { background: transparent; }");
        expect(css).toContain("border: 2px solid transparent;");
        expect(css).toContain("background-clip: content-box;");
        expect(css).toContain("::-webkit-scrollbar-thumb:hover");
        expect(css).toContain("::-webkit-scrollbar-thumb:active");

        await act(async () => {
          root.unmount();
        });
        root = createRoot(container);
      }
    } finally {
      Object.defineProperty(window.navigator, "userAgent", {
        configurable: true,
        value: originalUA,
      });
    }
  });

  it("uses detail.section for PDF pageInfo (index 50 of 100 -> 51 of 100), jump-back, and wires one resolver to both islands", async () => {
    testState.getBook.mockResolvedValue({
      id: "pdf-1",
      title: "US Budget Appendix",
      author: "OMB",
      format: "pdf",
      file_path: "/tmp/budget.pdf",
      pages: 100,
      progress: 0,
      status: "reading",
      current_cfi: null,
      available: true,
    });
    testState.getAllSettings.mockResolvedValue({
      reading_mode: "scrolling",
      page_columns: "1",
    });

    await renderReader("/reader/pdf-1");
    await flushAsync();

    const viewEl = container.querySelector("foliate-view") as MockFoliateView | null;
    expect(viewEl).not.toBeNull();
    viewEl!.book.sections = Array.from({ length: 100 }, () => ({}));

    // Simulate foliate-js relocate on page 51 (index 50) of a 100-page PDF where
    // SectionProgress's 1500-byte location math would mistakenly report 34 of 67.
    await act(async () => {
      viewEl!.dispatchEvent(
        new CustomEvent("relocate", {
          detail: {
            fraction: 0.5,
            section: { current: 50, total: 100 },
            location: { current: 33, total: 67 },
            cfi: "epubcfi(/6/102)",
          },
        }),
      );
    });
    await flushAsync();

    expect(container.textContent).toContain("Page 51 of 100");
    expect(container.textContent).not.toContain("Page 34 of 67");

    // Triggering a jump records real PDF page 51 on the Back button
    await act(async () => {
      viewEl!.dispatchEvent(new CustomEvent("link"));
      viewEl!.history.canGoBack = true;
      viewEl!.history.dispatchEvent(new Event("index-change"));
    });
    expect(container.textContent).toContain("Back to p. 51");
    expect(container.textContent).not.toContain("Back to p. 34");

    // Both islands receive the same per-book resolvePages function
    const bookmarksBtn = container.querySelector<HTMLButtonElement>('button[aria-label="Highlights & Bookmarks"]')!;
    await act(async () => {
      bookmarksBtn.click();
    });
    const bmResolver = testState.lastBookmarksResolvePages;
    expect(typeof bmResolver).toBe("function");

    const vocabBtn = container.querySelector<HTMLButtonElement>('button[aria-label="Words in Book"]')!;
    await act(async () => {
      vocabBtn.click();
    });
    const vocabResolver = testState.lastVocabResolvePages;
    expect(vocabResolver).toBe(bmResolver);

    const resolved = await bmResolver!(["epubcfi(/6/102!/4/2/1:0)"]);
    expect(resolved.get("epubcfi(/6/102!/4/2/1:0)")).toBe(51);

    // Two-page scrolling spread uses real PDF page numbers (Pages 51–52 of 100)
    await act(async () => {
      root.unmount();
    });
    localStorage.clear();
    root = createRoot(container);
    testState.getAllSettings.mockResolvedValue({
      reading_mode: "scrolling",
      page_columns: "2",
    });
    await renderReader("/reader/pdf-1");
    await flushAsync();

    const spreadView = container.querySelector("foliate-view") as MockFoliateView | null;
    await act(async () => {
      spreadView!.dispatchEvent(
        new CustomEvent("relocate", {
          detail: {
            fraction: 0.5,
            section: { current: 50, total: 100 },
            location: { current: 33, total: 67 },
            cfi: "epubcfi(/6/102)",
          },
        }),
      );
    });
    await flushAsync();
    expect(container.textContent).toContain("Pages 51–52 of 100");
    expect(container.textContent).not.toContain("of 67");

    // Two-page paginated spread uses real PDF total (Pages 50–51 of 100)
    await act(async () => {
      root.unmount();
    });
    localStorage.clear();
    root = createRoot(container);
    testState.getAllSettings.mockResolvedValue({
      reading_mode: "paginated",
      page_columns: "2",
    });
    await renderReader("/reader/pdf-1");
    await flushAsync();

    const paginatedView = container.querySelector("foliate-view") as MockFoliateView | null;
    paginatedView!.renderer.getContents = () => [{ index: 49 }, { index: 50 }];
    await act(async () => {
      paginatedView!.dispatchEvent(
        new CustomEvent("relocate", {
          detail: {
            fraction: 0.5,
            section: { current: 50, total: 100 },
            location: { current: 33, total: 67 },
            cfi: "epubcfi(/6/102)",
          },
        }),
      );
    });
    await flushAsync();
    expect(container.textContent).toContain("Pages 50–51 of 100");
    expect(container.textContent).not.toContain("of 67");
  });

  it("uses the quoted PDF passage's own page across context menu, explain, highlight toolbar, and highlights island when active and quoted pages differ", async () => {
    testState.getBook.mockResolvedValue({
      id: "pdf-spread",
      title: "US Budget Appendix",
      author: "OMB",
      format: "pdf",
      file_path: "/tmp/budget.pdf",
      pages: 100,
      progress: 0,
      status: "reading",
      current_cfi: null,
      available: true,
    });
    testState.getAllSettings.mockResolvedValue({
      reading_mode: "paginated",
      page_columns: "2",
    });

    await renderReader("/reader/pdf-spread");
    await flushAsync();

    const viewEl = container.querySelector("foliate-view") as MockFoliateView | null;
    expect(viewEl).not.toBeNull();
    viewEl!.book.sections = Array.from({ length: 100 }, () => ({}));
    viewEl!.renderer.getContents = () => [{ index: 49 }, { index: 50 }];

    // Active section is index 49 (page 50) in a 50–51 spread
    await act(async () => {
      viewEl!.dispatchEvent(
        new CustomEvent("relocate", {
          detail: {
            fraction: 0.49,
            section: { current: 49, total: 100 },
            location: { current: 32, total: 67 },
            cfi: "epubcfi(/6/100)",
          },
        }),
      );
    });
    await flushAsync();
    expect(container.textContent).toContain("Pages 50–51 of 100");

    // Mount page 51 (index 50) document and select text on page 51 while page 50 is active
    const page51Doc = document.implementation.createHTMLDocument("Page 51");
    page51Doc.body.innerHTML = "<p>Budget authority for page fifty-one.</p>";
    const pText = page51Doc.querySelector("p")!.firstChild as Text;
    const selRange = page51Doc.createRange();
    selRange.setStart(pText, 0);
    selRange.setEnd(pText, 16);
    Object.defineProperty(page51Doc, "getSelection", {
      configurable: true,
      value: () => ({
        rangeCount: 1,
        toString: () => "Budget authority",
        getRangeAt: () => selRange,
      }),
    });

    await act(async () => {
      viewEl!.dispatchEvent(new CustomEvent("load", { detail: { doc: page51Doc, index: 50 } }));
    });

    // 1. Context menu -> Quote in Chat on page 51 reports page 51 (not active page 50)
    await act(async () => {
      page51Doc.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      page51Doc.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 40, clientY: 40 }));
    });
    const quoteBtn = Array.from(container.querySelectorAll("button")).find((el) =>
      el.textContent?.includes("Quote in Chat"),
    );
    expect(quoteBtn).toBeDefined();
    await act(async () => {
      quoteBtn!.click();
    });
    const aiStub = container.querySelector('[data-testid="ai-panel-stub"]')!;
    expect(aiStub.getAttribute("data-quote")).toBe("Budget authority");
    expect(aiStub.getAttribute("data-quote-cfi")).toBe("epubcfi(/6/102!/4/2/1:0)");
    expect(aiStub.getAttribute("data-quote-page")).toBe("51");

    // 2. Context menu -> Explain -> Quote in Chat on page 51 also reports page 51
    let explainRequestId = "";
    testState.invoke.mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === "ai_explain") {
        explainRequestId = String((args as { requestId?: string })?.requestId ?? "");
        return null;
      }
      if (cmd === "list_highlights") {
        return [
          {
            id: "hl-51",
            book_id: "pdf-spread",
            cfi_range: "epubcfi(/6/102!/4/2/1:0)",
            color: "yellow",
            note: null,
            text_content: "Saved highlight on page 51",
            created_at: 1_700_000_000,
            updated_at: 1_700_000_000,
          },
        ];
      }
      return [];
    });

    await act(async () => {
      page51Doc.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 40, clientY: 40 }));
    });
    const explainBtn = Array.from(container.querySelectorAll("button")).find((el) =>
      el.textContent?.includes("Explain"),
    );
    expect(explainBtn).toBeDefined();
    await act(async () => {
      explainBtn!.click();
    });
    await flushAsync();

    const explainCb = testState.listenCallbacks.get(`ai-lookup-chunk-${explainRequestId}`);
    expect(explainCb).toBeDefined();
    await act(async () => {
      explainCb!({ payload: { delta: "Authority to incur obligations.", done: false } });
      explainCb!({ payload: { delta: "", done: true } });
    });
    await flushAsync();

    const explainQuoteBtn = Array.from(container.querySelectorAll("button")).find((el) =>
      el.textContent?.includes("Quote in Chat"),
    );
    expect(explainQuoteBtn).toBeDefined();
    await act(async () => {
      explainQuoteBtn!.click();
    });
    expect(aiStub.getAttribute("data-quote-page")).toBe("51");

    // 3. HighlightToolbar -> Ask on a saved highlight on page 51 (even without sectionIndex) reports page 51
    const mockRange = {
      getBoundingClientRect: () => ({ left: 10, top: 20, width: 100, height: 14 }),
      startContainer: { ownerDocument: { defaultView: { frameElement: null } } },
    };
    await act(async () => {
      viewEl!.dispatchEvent(
        new CustomEvent("show-annotation", {
          detail: {
            value: "epubcfi(/6/102!/4/2/1:0)",
            range: mockRange,
          },
        }),
      );
    });
    await flushAsync();

    const toolbarAskBtn = Array.from(container.querySelectorAll("button")).find(
      (el) => el.textContent?.trim() === "Ask",
    );
    expect(toolbarAskBtn).toBeDefined();
    await act(async () => {
      toolbarAskBtn!.click();
    });
    expect(aiStub.getAttribute("data-quote")).toBe("Saved highlight on page 51");
    expect(aiStub.getAttribute("data-quote-page")).toBe("51");

    // 4. Highlights island Ask forwards its resolved page (e.g. page 12 while reading page 50)
    const bookmarksBtn = container.querySelector<HTMLButtonElement>('button[aria-label="Highlights & Bookmarks"]')!;
    await act(async () => {
      bookmarksBtn.click();
    });
    expect(typeof testState.lastBookmarksOnAsk).toBe("function");
    await act(async () => {
      testState.lastBookmarksOnAsk!("Earlier passage", "epubcfi(/6/24!/4/2/1:0)", 12);
    });
    expect(aiStub.getAttribute("data-quote")).toBe("Earlier passage");
    expect(aiStub.getAttribute("data-quote-page")).toBe("12");
  });
});

describe("getPageInfoFromRelocate", () => {
  it("maps PDF relocate section index 50 of 100 to 51 of 100 regardless of location", () => {
    expect(
      getPageInfoFromRelocate(
        { section: { current: 50, total: 100 }, location: { current: 33, total: 67 } },
        "pdf",
      ),
    ).toEqual({ current: 51, total: 100 });
  });

  it("keeps foliate location mapping for EPUBs", () => {
    expect(
      getPageInfoFromRelocate(
        { section: { current: 2, total: 10 }, location: { current: 33, total: 67 } },
        "epub",
      ),
    ).toEqual({ current: 34, total: 67 });
  });

  it("returns null for missing or invalid page bounds", () => {
    expect(getPageInfoFromRelocate({ location: { current: 0, total: 10 } }, "pdf")).toBeNull();
    expect(getPageInfoFromRelocate({ section: { current: -1, total: 100 } }, "pdf")).toBeNull();
    expect(getPageInfoFromRelocate({ section: { current: 0, total: 0 } }, "pdf")).toBeNull();
    expect(getPageInfoFromRelocate({}, "epub")).toBeNull();
  });
});

function parseHexChannelTuple(hex: string): [number, number, number] {
  const clean = hex.replace(/^#/, "");
  return [
    parseInt(clean.slice(0, 2), 16),
    parseInt(clean.slice(2, 4), 16),
    parseInt(clean.slice(4, 6), 16),
  ];
}

function compositePdfLayers(
  baseRgb: [number, number, number],
  layers: React.CSSProperties[],
): [number, number, number] {
  let channels = baseRgb.map((c) => c / 255) as [number, number, number];
  for (const layer of layers) {
    const src = parseHexChannelTuple(String(layer.backgroundColor)).map((c) => c / 255);
    channels = channels.map((b, i) => {
      const s = src[i];
      switch (layer.mixBlendMode) {
        case "difference":
          return Math.abs(b - s);
        case "multiply":
          return b * s;
        case "screen":
          return b + s - b * s;
        default:
          throw new Error(`Unexpected blend mode: ${String(layer.mixBlendMode)}`);
      }
    }) as [number, number, number];
  }
  return channels.map((c) => Math.round(c * 255)) as [number, number, number];
}

describe("getPdfOverlays", () => {
  it("maps dark PDF white pages to dark.body, black glyphs to dark.text, and mid-tones linearly", () => {
    const dark = getThemeStyles("dark");
    const overlay = getPdfOverlays("dark");
    expect(overlay).not.toBeNull();
    expect(overlay!.layers).toHaveLength(3);
    expect(overlay!.layers.map((l) => l.mixBlendMode)).toEqual(["difference", "multiply", "screen"]);

    const expectedPage = parseHexChannelTuple(dark.body);
    const expectedText = parseHexChannelTuple(dark.text);

    const compositedWhite = compositePdfLayers([255, 255, 255], overlay!.layers);
    const compositedBlack = compositePdfLayers([0, 0, 0], overlay!.layers);
    const compositedMid = compositePdfLayers([128, 128, 128], overlay!.layers);

    for (let i = 0; i < 3; i++) {
      expect(Math.abs(compositedWhite[i] - expectedPage[i])).toBeLessThanOrEqual(1);
      expect(Math.abs(compositedBlack[i] - expectedText[i])).toBeLessThanOrEqual(1);
      const t = 128 / 255;
      const expectedMid = Math.round(t * expectedPage[i] + (1 - t) * expectedText[i]);
      expect(Math.abs(compositedMid[i] - expectedMid)).toBeLessThanOrEqual(1);
    }
  });

  it("preserves original, paper, and quiet PDF overlays unchanged", () => {
    expect(getPdfOverlays("original")).toBeNull();
    expect(getPdfOverlays("paper")).toEqual({
      layers: [{ backgroundColor: getThemeStyles("paper").body, mixBlendMode: "multiply" }],
    });
    expect(getPdfOverlays("quiet")).toEqual({
      layers: [{ backgroundColor: getThemeStyles("quiet").body, mixBlendMode: "multiply" }],
    });
  });
});

describe("getReaderScrollbarVars", () => {
  const luminance = ([r, g, b]: [number, number, number]) => {
    const lin = (c: number) => {
      const v = c / 255;
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  };
  const contrast = (a: [number, number, number], b: [number, number, number]) => {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  };
  const over = (hexWithAlpha: string, backdrop: [number, number, number]) => {
    const rgb = parseHexChannelTuple(hexWithAlpha.slice(0, 7));
    const alpha = parseInt(hexWithAlpha.slice(7, 9), 16) / 255;
    return rgb.map((c, i) => Math.round(c * alpha + backdrop[i] * (1 - alpha))) as [number, number, number];
  };

  it.each(["original", "paper", "quiet", "dark"] as const)(
    "keeps the thumb distinguishable from the page in %s for EPUB and PDF",
    (theme) => {
      const page = parseHexChannelTuple(getThemeStyles(theme).body);
      const epub = getReaderScrollbarVars("epub", theme);
      expect(contrast(over(epub["--scrollbar-thumb"], page), page)).toBeGreaterThan(1.25);

      const pdf = getReaderScrollbarVars("pdf", theme);
      const layers = getPdfOverlays(theme)?.layers ?? [];
      const white: [number, number, number] = [255, 255, 255];
      const pdfPage = compositePdfLayers(white, layers);
      for (const key of ["--scrollbar-thumb", "--scrollbar-thumb-hover"]) {
        const thumb = compositePdfLayers(over(pdf[key], white), layers);
        expect(contrast(thumb, pdfPage)).toBeGreaterThan(1.25);
      }
    },
  );
});
