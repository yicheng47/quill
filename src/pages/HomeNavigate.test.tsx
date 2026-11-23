// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ipcListeners = new Map<string, Array<(event: { payload: unknown }) => void>>();

let vocabListHandler: (() => Promise<unknown[]>) | null = null;
let settingsOverride: Record<string, string> | null = null;

const invokeMock = vi.fn<(cmd: string, args?: unknown) => Promise<unknown>>(async (cmd) => {
  switch (cmd) {
    case "list_books":
      return { books: [], next_cursor: null, total: 0 };
    case "list_collections":
    case "list_bookmarks":
    case "list_chats":
    case "list_all_highlights":
    case "list_all_bookmarks":
      return [];
    case "get_book_counts":
    case "get_collection_counts":
    case "get_highlight_counts":
      return { total: 0, by_book: [] };
    case "list_all_vocab_words":
      if (vocabListHandler) return vocabListHandler();
      return [
        {
          id: "w-1",
          book_id: "b-1",
          book_title: "Dune",
          word: "prescience",
          definition: "先知能力\n/ˈprɛʃəns/ noun. Knowledge of actions before they occur.",
          context_sentence: "Paul felt the weight of prescience.",
          cfi: "epubcfi(/6/2!/4/2)",
          created_at: 1_700_000_000,
        },
      ];
    case "get_all_settings":
      return (
        settingsOverride ?? {
          theme: "light",
          reader_settings_open: "false",
          ai_setup_seen: "true",
        }
      );
    case "codex_status":
      return {
        state: "ready",
        version: "0.170.0",
        min_version: "0.170.0",
        path: "/opt/homebrew/bin/codex",
        from_override: false,
        email: "reader@example.com",
        plan: "pro",
        error: null,
      };
    case "list_codex_models":
      return { models: [] };
    case "get_sync_status":
    case "get_sync_diagnostics":
      return null;
    case "open_book_dialog":
    case "import_book":
    case "import_files":
    case "open_settings_window":
      return null;
    default:
      return null;
  }
});

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      if (key === "words.title") return "Words";
      if (opts?.count !== undefined) return `${key}:${String(opts.count)}`;
      return key;
    },
    i18n: { language: "en", changeLanguage: vi.fn() },
  }),
  initReactI18next: { type: "3rdParty", init: vi.fn() },
}));

vi.mock("../platform", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../platform")>();
  return {
    ...actual,
    invoke: (cmd: string, args?: unknown) => invokeMock(cmd, args),
    listen: vi.fn(async () => () => {}),
    listenCurrentWindow: vi.fn(async (event: string, cb: (e: { payload: unknown }) => void) => {
      const list = ipcListeners.get(event) ?? [];
      list.push(cb);
      ipcListeners.set(event, list);
      return () => {
        const next = (ipcListeners.get(event) ?? []).filter((fn) => fn !== cb);
        ipcListeners.set(event, next);
      };
    }),
    onDragDrop: vi.fn(async () => () => {}),
    emit: vi.fn(async () => {}),
    emitTo: vi.fn(async () => {}),
    focusWindow: vi.fn(async () => {}),
    closeCurrentWindow: vi.fn(async () => {}),
    convertFileSrc: (p: string) => p,
    subscribeAsync: (register: (isActive: () => boolean) => Promise<() => void>) => {
      let active = true;
      let unlisten: (() => void) | null = null;
      void register(() => active).then((fn) => {
        if (active) unlisten = fn;
        else fn();
      });
      return () => {
        active = false;
        unlisten?.();
      };
    },
    isTauri: () => false,
    isElectron: () => true,
    isWeb: () => false,
    getAppVersion: vi.fn(async () => "2.0.0"),
  };
});

vi.mock("../contexts/UpdateContext", () => ({
  useUpdate: () => ({
    status: { state: "idle" },
    checking: false,
    error: null,
    releaseNotes: null,
    dismissed: false,
    checkForUpdate: vi.fn(),
    downloadAndInstall: vi.fn(),
    installAndRelaunch: vi.fn(),
    dismiss: vi.fn(),
  }),
}));

import Home from "./Home";

async function flushMicrotasks(ticks = 6): Promise<void> {
  for (let i = 0; i < ticks; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

describe("Home navigate-main-route integration", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => {
        store.set(k, v);
      },
      removeItem: (k: string) => {
        store.delete(k);
      },
      clear: () => store.clear(),
    });
    ipcListeners.clear();
    vocabListHandler = null;
    settingsOverride = null;
    invokeMock.mockClear();
    window.history.replaceState(null, "", "/");
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.unstubAllGlobals();
  });

  it("switches to the Words route and selects the word when navigate-main-route fires", async () => {
    await act(async () => {
      root.render(<Home />);
    });
    await flushMicrotasks();

    const listeners = ipcListeners.get("navigate-main-route") ?? [];
    expect(listeners.length).toBeGreaterThan(0);

    await act(async () => {
      listeners.forEach((cb) => cb({ payload: { route: "words", wordId: "w-1" } }));
    });
    await flushMicrotasks();

    expect(container.textContent).toContain("prescience");
    expect(invokeMock).toHaveBeenCalledWith("list_all_vocab_words", undefined);
  });

  it("applies ?route=words&wordId=... query parameters on mount in single-window mode", async () => {
    window.history.replaceState(null, "", "/?route=words&wordId=w-1");

    await act(async () => {
      root.render(<Home />);
    });
    await flushMicrotasks();

    expect(container.textContent).toContain("prescience");
    expect(window.location.search).toBe("");
  });

  it("preserves a newly saved wordId selection across a deferred list_all_vocab_words refresh", async () => {
    const wordA = {
      id: "w-a",
      book_id: "b-1",
      book_title: "Dune",
      word: "alphaWord",
      definition: "首词\n/ˈælfə/ noun. First saved definition.",
      context_sentence: "First context sentence.",
      cfi: "epubcfi(/6/2!/4/2)",
      created_at: 1_700_000_000,
    };
    const wordB = {
      id: "w-b",
      book_id: "b-1",
      book_title: "Dune",
      word: "betaWord",
      definition: "次词\n/ˈbeɪtə/ noun. Second saved definition.",
      context_sentence: "Second context sentence.",
      cfi: "epubcfi(/6/2!/4/4)",
      created_at: 1_700_000_100,
    };

    vocabListHandler = async () => [wordA];

    await act(async () => {
      root.render(<Home />);
    });
    await flushMicrotasks();

    const listeners = ipcListeners.get("navigate-main-route") ?? [];
    await act(async () => {
      listeners.forEach((cb) => cb({ payload: { route: "words", wordId: "w-a" } }));
    });
    await flushMicrotasks();
    expect(container.textContent).toContain("First saved definition.");

    // Switch Vocab list to a deferred fetch representing B saved in Reader while Main is already on Words (loading === false)
    let resolveSecondFetch!: (rows: unknown[]) => void;
    vocabListHandler = () =>
      new Promise<unknown[]>((resolve) => {
        resolveSecondFetch = resolve;
      });

    await act(async () => {
      listeners.forEach((cb) => cb({ payload: { route: "words", wordId: "w-b" } }));
    });
    await flushMicrotasks();

    // Deferred fetch returns [A, B]; w-b must remain selected rather than reverting to w-a
    await act(async () => {
      resolveSecondFetch([wordA, wordB]);
    });
    await flushMicrotasks();

    const detailText = container.querySelector("section")?.textContent ?? "";
    expect(detailText).toContain("Second saved definition.");
    expect(detailText).not.toContain("First saved definition.");
  });

  it("starts the Codex app server on mount only on the Codex connection", async () => {
    settingsOverride = { theme: "light", ai_setup_seen: "true", ai_auth_mode: "codex" };
    await act(async () => {
      root.render(<Home />);
    });
    await flushMicrotasks();
    expect(invokeMock).toHaveBeenCalledWith("codex_status", undefined);

    act(() => {
      root.unmount();
    });
    invokeMock.mockClear();
    settingsOverride = { theme: "light", ai_setup_seen: "true", ai_auth_mode: "api_key" };
    root = createRoot(container);
    await act(async () => {
      root.render(<Home />);
    });
    await flushMicrotasks();
    expect(invokeMock).not.toHaveBeenCalledWith("codex_status", undefined);
  });

  it("makes Home inert and suppresses global shortcuts while AiSetupDialog is open, then restores them on dismiss", async () => {
    settingsOverride = { theme: "light", reader_settings_open: "false" };

    await act(async () => {
      root.render(<Home />);
    });
    await flushMicrotasks();

    const dialog = document.querySelector<HTMLElement>('[data-testid="ai-setup-dialog"]');
    expect(dialog).not.toBeNull();
    const homeShell = container.firstElementChild as HTMLElement;
    expect(homeShell.hasAttribute("inert")).toBe(true);

    // Cmd/Ctrl+, and Cmd/Ctrl+O must not pierce the blocking first-launch dialog.
    invokeMock.mockClear();
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: ",", metaKey: true, cancelable: true }));
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "o", metaKey: true, cancelable: true }));
    });
    await flushMicrotasks();

    expect(invokeMock).not.toHaveBeenCalledWith("open_book_dialog", expect.anything());
    expect(invokeMock).not.toHaveBeenCalledWith("open_book_dialog");
    // Dialog remains visible (Settings did not open over it).
    expect(document.querySelector('[data-testid="ai-setup-dialog"]')).not.toBeNull();

    // Dismiss via Skip for now -> inert removed, Cmd/Ctrl+, now opens Settings.
    const skipBtn = [...document.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("aiSetup.skipForNow"),
    )!;
    expect(skipBtn).toBeDefined();
    await act(async () => {
      skipBtn.click();
    });
    await flushMicrotasks();

    expect(document.querySelector('[data-testid="ai-setup-dialog"]')).toBeNull();
    expect(homeShell.hasAttribute("inert")).toBe(false);

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: ",", metaKey: true, cancelable: true }));
    });
    await flushMicrotasks();
    expect(container.textContent).toContain("settings.title");
  });
});
