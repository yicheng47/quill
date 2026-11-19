/** @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  setWindowBackgroundColor: vi.fn<(color: string) => Promise<void>>(),
}));

vi.mock("../platform", () => ({
  setWindowBackgroundColor: (color: string) =>
    mocks.setWindowBackgroundColor(color),
}));

import {
  applyMainWindowDark,
  applyMainWindowTheme,
  getAppThemeRevision,
  MAIN_DAWN_BG,
  MAIN_NOCTURNE_BG,
  normalizeAppTheme,
  readAppTheme,
  resolveAppThemeIsDark,
  setAppTheme,
  STORAGE_APP_THEME,
} from "./theme";

describe("theme helpers", () => {
  const stored = new Map<string, string>();
  const localStorageMock = {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => {
      stored.set(key, value);
    },
    clear: () => stored.clear(),
  };

  const setPrefersDark = (matches: boolean) => {
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      value: vi.fn(() => ({
        matches,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    });
  };

  beforeEach(() => {
    stored.clear();
    vi.stubGlobal("localStorage", localStorageMock);
    document.documentElement.classList.remove("dawn", "dark");
    mocks.setWindowBackgroundColor.mockReset().mockResolvedValue(undefined);
    setPrefersDark(false);
  });

  afterEach(() => {
    document.documentElement.classList.remove("dawn", "dark");
    vi.unstubAllGlobals();
  });

  it("normalizes missing or unknown stored theme values to light and keeps an explicit system choice", () => {
    expect(normalizeAppTheme(undefined)).toBe("light");
    expect(normalizeAppTheme(null)).toBe("light");
    expect(normalizeAppTheme("")).toBe("light");
    expect(normalizeAppTheme("sepia")).toBe("light");
    expect(normalizeAppTheme("system")).toBe("system");
    expect(normalizeAppTheme("light")).toBe("light");
    expect(normalizeAppTheme("dark")).toBe("dark");
    expect(readAppTheme()).toBe("light");
  });

  it("resolves darkness for system, light, and dark modes across OS appearances", () => {
    expect(resolveAppThemeIsDark("light", false)).toBe(false);
    expect(resolveAppThemeIsDark("light", true)).toBe(false);
    expect(resolveAppThemeIsDark("dark", false)).toBe(true);
    expect(resolveAppThemeIsDark("dark", true)).toBe(true);
    expect(resolveAppThemeIsDark("system", false)).toBe(false);
    expect(resolveAppThemeIsDark("system", true)).toBe(true);
  });

  it("applies .dawn/.dark classes and syncs the main window background color", () => {
    setPrefersDark(true);
    expect(applyMainWindowTheme("system")).toBe(true);
    expect(document.documentElement.classList.contains("dawn")).toBe(true);
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(mocks.setWindowBackgroundColor).toHaveBeenLastCalledWith(MAIN_NOCTURNE_BG);

    expect(applyMainWindowTheme("light")).toBe(false);
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    expect(mocks.setWindowBackgroundColor).toHaveBeenLastCalledWith(MAIN_DAWN_BG);
  });

  it("persists cache and broadcasts a same-window storage event via setAppTheme", () => {
    const storageEvents: Array<string | null> = [];
    const listener = (event: StorageEvent) => {
      if (event.key === STORAGE_APP_THEME) storageEvents.push(event.newValue);
    };
    window.addEventListener("storage", listener);

    setPrefersDark(false);
    const prevRevision = getAppThemeRevision();
    expect(setAppTheme("dark")).toBe(true);
    expect(getAppThemeRevision()).toBe(prevRevision + 1);
    expect(localStorage.getItem(STORAGE_APP_THEME)).toBe("dark");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(mocks.setWindowBackgroundColor).toHaveBeenCalledWith(MAIN_NOCTURNE_BG);
    expect(storageEvents).toEqual(["dark"]);

    expect(applyMainWindowDark(false)).toBe(false);
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    expect(mocks.setWindowBackgroundColor).toHaveBeenLastCalledWith(MAIN_DAWN_BG);

    window.removeEventListener("storage", listener);
  });
});
