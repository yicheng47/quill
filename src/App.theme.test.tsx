/** @vitest-environment jsdom */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn<(command: string, args?: Record<string, unknown>) => Promise<unknown>>(),
  appReady: vi.fn<() => Promise<void>>(),
}));

vi.mock("./platform", () => ({
  invoke: mocks.invoke,
  appReady: mocks.appReady,
  getCurrentWindowLabel: () => "main",
  onWindowResized: () => Promise.resolve(() => {}),
  setZoom: () => Promise.resolve(),
  setTitlebarZoom: () => Promise.resolve(),
}));

vi.mock("./pages/Home", () => ({ default: () => null }));
vi.mock("./pages/Reader", () => ({ default: () => null }));
vi.mock("./components/UpdateToast", () => ({ default: () => null }));
vi.mock("./contexts/UpdateContext", () => ({
  UpdateProvider: ({ children }: { children: unknown }) => children,
}));
vi.mock("./i18n", () => ({
  reconcileLanguage: () => {},
}));

import App from "./App";

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

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("localStorage", localStorageMock);
    localStorage.clear();
    document.documentElement.classList.remove("dark");
    mocks.invoke.mockReset();
    mocks.appReady.mockReset();
    mocks.appReady.mockResolvedValue();
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      value: vi.fn(() => ({
        matches: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
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
    vi.useRealTimers();
  });

  it("applies stored dark theme before calling appReady when settings resolve normally", async () => {
    const events: string[] = [];
    mocks.invoke.mockResolvedValue({ theme: "dark" });
    mocks.appReady.mockImplementation(async () => {
      events.push(
        `ready:${document.documentElement.classList.contains("dark") ? "dark" : "light"}`,
      );
    });

    await act(async () => {
      root.render(<App />);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(events).toEqual(["ready:dark"]);
    expect(localStorage.getItem("quill-theme")).toBe("dark");
  });

  it("reveals within bounded timeout when get_all_settings hangs and reconciles late response", async () => {
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

    expect(mocks.appReady).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });

    expect(mocks.appReady).toHaveBeenCalledOnce();
    expect(document.documentElement.classList.contains("dark")).toBe(false);

    await act(async () => {
      resolveSettings({ theme: "dark" });
      await Promise.resolve();
    });

    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(localStorage.getItem("quill-theme")).toBe("dark");
  });
});
