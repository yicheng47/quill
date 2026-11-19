/** @vitest-environment jsdom */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn<(command: string, args?: Record<string, unknown>) => Promise<unknown>>(),
  appReady: vi.fn<() => Promise<void>>(),
  getCurrentWindowLabel: vi.fn<() => string>(() => "main"),
  getInitialDark: vi.fn<() => boolean | null>(() => null),
  setWindowBackgroundColor: vi.fn<(color: string) => Promise<void>>(),
  setZoom: vi.fn<(zoom: number) => Promise<void>>(),
}));

vi.mock("./platform", () => ({
  invoke: mocks.invoke,
  appReady: mocks.appReady,
  getCurrentWindowLabel: mocks.getCurrentWindowLabel,
  getInitialDark: mocks.getInitialDark,
  setWindowBackgroundColor: mocks.setWindowBackgroundColor,
  onWindowResized: () => Promise.resolve(() => {}),
  setZoom: mocks.setZoom,
  setTitlebarZoom: () => Promise.resolve(),
}));

vi.mock("./pages/Home", () => ({ default: () => null }));
vi.mock("./pages/Reader", () => ({ default: () => null }));
vi.mock("./contexts/UpdateContext", () => ({
  UpdateProvider: ({ children }: { children: unknown }) => children,
}));
vi.mock("./i18n", () => ({
  reconcileLanguage: () => {},
}));

import App from "./App";
import { resetThemeControllerForTests, setAppTheme } from "./lib/theme";

describe("App startup theme and reveal", () => {
  const storedValues = new Map<string, string>();
  const localStorageMock = {
    clear: () => storedValues.clear(),
    getItem: (key: string) => storedValues.get(key) ?? null,
    setItem: (key: string, value: string) => {
      storedValues.set(key, value);
    },
  };
  let container: HTMLDivElement;
  let root: Root;
  let mqMatches = false;
  let mqListeners: Array<(e: MediaQueryListEvent) => void> = [];

  const setSystemDark = async (dark: boolean) => {
    mqMatches = dark;
    await act(async () => {
      for (const cb of mqListeners) {
        cb({ matches: dark } as MediaQueryListEvent);
      }
      await Promise.resolve();
    });
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("localStorage", localStorageMock);
    localStorage.clear();
    delete document.documentElement.dataset.readerTheme;
    delete document.documentElement.dataset.themeOverride;
    document.documentElement.classList.remove("dawn", "dark", "platform-mac");
    mocks.invoke.mockReset();
    mocks.appReady.mockReset();
    mocks.appReady.mockResolvedValue();
    mocks.getCurrentWindowLabel.mockReturnValue("main");
    mocks.getInitialDark.mockReset().mockReturnValue(null);
    resetThemeControllerForTests();
    mocks.setWindowBackgroundColor.mockReset().mockResolvedValue();
    mocks.setZoom.mockReset().mockResolvedValue();
    mqMatches = false;
    mqListeners = [];
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      value: vi.fn(() => ({
        get matches() {
          return mqMatches;
        },
        addEventListener: (_type: string, cb: (e: MediaQueryListEvent) => void) => {
          mqListeners.push(cb);
        },
        removeEventListener: (_type: string, cb: (e: MediaQueryListEvent) => void) => {
          mqListeners = mqListeners.filter((entry) => entry !== cb);
        },
      })),
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    delete document.documentElement.dataset.readerTheme;
    delete document.documentElement.dataset.themeOverride;
    document.documentElement.classList.remove("dark", "dawn", "platform-mac");
    vi.useRealTimers();
  });

  it("reveals main window with Electron initial dark appearance even when localStorage, OS, and slow settings disagree", async () => {
    const events: string[] = [];
    mocks.getCurrentWindowLabel.mockReturnValue("main");
    mocks.getInitialDark.mockReturnValue(true);
    localStorage.setItem("quill-theme", "light");
    mqMatches = false;

    let resolveSettings!: (v: Record<string, string>) => void;
    mocks.invoke.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSettings = resolve;
        }),
    );
    mocks.appReady.mockImplementation(async () => {
      events.push(
        `ready:${document.documentElement.classList.contains("dawn") ? "dawn" : "legacy"}:${
          document.documentElement.classList.contains("dark") ? "dark" : "light"
        }`,
      );
    });

    await act(async () => {
      root.render(<App />);
    });

    expect(mocks.appReady).not.toHaveBeenCalled();
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(mocks.setWindowBackgroundColor).toHaveBeenCalledWith("#0D0C0B");
    expect(mocks.setWindowBackgroundColor).not.toHaveBeenCalledWith("#EEEBF8");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });

    expect(events).toEqual(["ready:dawn:dark"]);
    expect(mocks.setWindowBackgroundColor).not.toHaveBeenCalledWith("#EEEBF8");

    await act(async () => {
      resolveSettings({ theme: "dark" });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(localStorage.getItem("quill-theme")).toBe("dark");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });

  it("falls back to cached renderer theme at reveal when preload seed is null and DB reads hang or reject", async () => {
    const events: string[] = [];
    mocks.getCurrentWindowLabel.mockReturnValue("main");
    mocks.getInitialDark.mockReturnValue(null);
    localStorage.setItem("quill-theme", "dark");
    mqMatches = false;

    let rejectSettings!: (reason: unknown) => void;
    mocks.invoke.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          rejectSettings = reject;
        }),
    );
    mocks.appReady.mockImplementation(async () => {
      events.push(
        `ready:${document.documentElement.classList.contains("dawn") ? "dawn" : "legacy"}:${
          document.documentElement.classList.contains("dark") ? "dark" : "light"
        }`,
      );
    });

    await act(async () => {
      root.render(<App />);
    });

    expect(mocks.appReady).not.toHaveBeenCalled();
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(mocks.setWindowBackgroundColor).toHaveBeenCalledWith("#0D0C0B");
    expect(mocks.setWindowBackgroundColor).not.toHaveBeenCalledWith("#EEEBF8");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });

    expect(events).toEqual(["ready:dawn:dark"]);
    expect(mocks.setWindowBackgroundColor).not.toHaveBeenCalledWith("#EEEBF8");

    await act(async () => {
      rejectSettings(new Error("DB unavailable"));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(mocks.setWindowBackgroundColor).toHaveBeenLastCalledWith("#0D0C0B");
    expect(localStorage.getItem("quill-theme")).toBe("dark");
  });

  it("activates Nocturne .dawn.dark and dark window background on main before reveal", async () => {
    const events: string[] = [];
    mocks.getCurrentWindowLabel.mockReturnValue("main");
    mocks.invoke.mockResolvedValue({ theme: "dark" });
    mocks.appReady.mockImplementation(async () => {
      events.push(
        `ready:${document.documentElement.classList.contains("dawn") ? "dawn" : "legacy"}:${
          document.documentElement.classList.contains("dark") ? "dark" : "light"
        }`,
      );
    });

    await act(async () => {
      root.render(<App />);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(events).toEqual(["ready:dawn:dark"]);
    expect(localStorage.getItem("quill-theme")).toBe("dark");
    expect(mocks.setWindowBackgroundColor).toHaveBeenLastCalledWith("#0D0C0B");
  });

  it("keeps Dawn light when theme is light and removes stale .dark before reveal", async () => {
    mocks.getCurrentWindowLabel.mockReturnValue("main");
    document.documentElement.classList.add("dark");
    mocks.invoke.mockResolvedValue({ theme: "light" });

    await act(async () => {
      root.render(<App />);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(document.documentElement.classList.contains("dawn")).toBe(true);
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    expect(mocks.setWindowBackgroundColor).toHaveBeenLastCalledWith("#EEEBF8");
    expect(mocks.appReady).toHaveBeenCalledOnce();
  });

  it("defaults missing stored theme to system without writing DB, tracks OS changes live, and sends one native update per user toggle", async () => {
    mqMatches = true;
    mocks.getCurrentWindowLabel.mockReturnValue("main");
    mocks.invoke.mockResolvedValue({});

    await act(async () => {
      root.render(<App />);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(document.documentElement.classList.contains("dawn")).toBe(true);
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(mocks.setWindowBackgroundColor).toHaveBeenLastCalledWith("#0D0C0B");
    expect(localStorage.getItem("quill-theme")).toBe("system");
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
    expect(mocks.invoke).toHaveBeenCalledWith("get_all_settings");

    await setSystemDark(false);
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    expect(mocks.setWindowBackgroundColor).toHaveBeenLastCalledWith("#EEEBF8");

    await setSystemDark(true);
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(mocks.setWindowBackgroundColor).toHaveBeenLastCalledWith("#0D0C0B");

    // Switching via setAppTheme triggers exactly one native background update.
    mocks.setWindowBackgroundColor.mockClear();
    await act(async () => {
      setAppTheme("light");
      await Promise.resolve();
    });
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    expect(mocks.setWindowBackgroundColor).toHaveBeenCalledTimes(1);
    expect(mocks.setWindowBackgroundColor).toHaveBeenCalledWith("#EEEBF8");

    // On light, OS changes are ignored.
    await setSystemDark(false);
    await setSystemDark(true);
    expect(document.documentElement.classList.contains("dark")).toBe(false);

    // Switching back to system resumes OS tracking.
    mocks.setWindowBackgroundColor.mockClear();
    await act(async () => {
      setAppTheme("system");
      await Promise.resolve();
    });
    expect(mocks.setWindowBackgroundColor).toHaveBeenCalledTimes(1);
    expect(mocks.setWindowBackgroundColor).toHaveBeenCalledWith("#0D0C0B");
    await setSystemDark(false);
    expect(document.documentElement.classList.contains("dark")).toBe(false);
  });

  it("ignores stale main startup settings response when user toggles theme before startup read resolves", async () => {
    mocks.getCurrentWindowLabel.mockReturnValue("main");
    mocks.getInitialDark.mockReturnValue(false);
    let resolveSettings!: (v: Record<string, string>) => void;
    mocks.invoke.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSettings = resolve;
        }),
    );

    await act(async () => {
      root.render(<App />);
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    expect(mocks.appReady).toHaveBeenCalledOnce();
    expect(document.documentElement.classList.contains("dark")).toBe(false);

    mocks.setWindowBackgroundColor.mockClear();
    await act(async () => {
      setAppTheme("dark");
      await Promise.resolve();
    });
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(localStorage.getItem("quill-theme")).toBe("dark");
    expect(mocks.setWindowBackgroundColor).toHaveBeenCalledTimes(1);
    expect(mocks.setWindowBackgroundColor).toHaveBeenCalledWith("#0D0C0B");

    mocks.setZoom.mockClear();
    await act(async () => {
      resolveSettings({ theme: "light", app_zoom: "1.2" });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(localStorage.getItem("quill-theme")).toBe("dark");
    expect(mocks.setWindowBackgroundColor).toHaveBeenCalledTimes(1);
    expect(mocks.setZoom).toHaveBeenCalledWith(1.2);
  });

  it("skips redundant zoom restore for same-window synthetic zoom storage events", async () => {
    mocks.getCurrentWindowLabel.mockReturnValue("main");
    mocks.invoke.mockResolvedValue({ theme: "light", app_zoom: "1.0" });

    await act(async () => {
      root.render(<App />);
      await Promise.resolve();
      await Promise.resolve();
    });

    mocks.setZoom.mockClear();
    await act(async () => {
      window.dispatchEvent(new StorageEvent("storage", { key: "quill-app-zoom", newValue: "1.2" }));
      await Promise.resolve();
    });
    expect(mocks.setZoom).not.toHaveBeenCalled();
  });

  it("never reads or writes quill-theme app cache on reader windows", async () => {
    mocks.getCurrentWindowLabel.mockReturnValue("reader-book1");
    localStorage.setItem("quill-theme", "dark");
    let resolveSettings!: (v: Record<string, string>) => void;
    mocks.invoke.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSettings = resolve;
        }),
    );

    await act(async () => {
      root.render(<App />);
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });

    expect(mocks.appReady).toHaveBeenCalledOnce();
    expect(document.documentElement.classList.contains("dawn")).toBe(true);
    expect(document.documentElement.classList.contains("dark")).toBe(false);

    await act(async () => {
      resolveSettings({ theme: "light" });
      await Promise.resolve();
    });

    expect(localStorage.getItem("quill-theme")).toBe("dark");
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    expect(mocks.setWindowBackgroundColor).not.toHaveBeenCalled();
  });

  it("activates Dawn light without .dark on reader windows even when app theme is dark", async () => {
    mocks.getCurrentWindowLabel.mockReturnValue("reader-book1");
    mocks.invoke.mockResolvedValue({ theme: "dark" });

    await act(async () => {
      root.render(<App />);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(document.documentElement.classList.contains("dawn")).toBe(true);
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    expect(mocks.appReady).toHaveBeenCalledOnce();
    expect(mocks.setWindowBackgroundColor).not.toHaveBeenCalled();
  });

  it("preserves reader-owned Nocturne .dark class across App async settings reconciliation and app theme toggles", async () => {
    mocks.getCurrentWindowLabel.mockReturnValue("reader-book1");
    mocks.invoke.mockResolvedValue({ theme: "light" });
    document.documentElement.dataset.readerTheme = "dark";
    document.documentElement.classList.add("dark");

    await act(async () => {
      root.render(<App />);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(document.documentElement.classList.contains("dawn")).toBe(true);
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(mocks.setWindowBackgroundColor).not.toHaveBeenCalled();

    localStorage.setItem("quill-theme", "light");
    const storageEvent = new StorageEvent("storage", {
      key: "quill-theme",
      newValue: "light",
    });
    Object.defineProperty(storageEvent, "storageArea", { value: localStorage });
    await act(async () => {
      window.dispatchEvent(storageEvent);
      await Promise.resolve();
    });
    await setSystemDark(false);
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(mocks.setWindowBackgroundColor).not.toHaveBeenCalled();
  });

  it("applies platform-mac on documentElement only on macOS", async () => {
    const originalUA = navigator.userAgent;
    try {
      Object.defineProperty(window.navigator, "userAgent", {
        configurable: true,
        value: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
      });
      mocks.invoke.mockResolvedValue({ theme: "light" });
      await act(async () => {
        root.render(<App />);
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(document.documentElement.classList.contains("platform-mac")).toBe(true);

      await act(async () => {
        root.unmount();
      });
      root = createRoot(container);

      Object.defineProperty(window.navigator, "userAgent", {
        configurable: true,
        value: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      });
      await act(async () => {
        root.render(<App />);
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(document.documentElement.classList.contains("platform-mac")).toBe(false);
    } finally {
      Object.defineProperty(window.navigator, "userAgent", {
        configurable: true,
        value: originalUA,
      });
    }
  });
});
