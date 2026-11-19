/** @vitest-environment jsdom */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../i18n";
import { isMacOS, isWindows } from "../lib/platformEnv";

const mocks = vi.hoisted(() => ({
  minimizeWindow: vi.fn<() => Promise<void>>(),
  toggleMaximizeWindow: vi.fn<() => Promise<void>>(),
  closeWindow: vi.fn<() => Promise<void>>(),
  isWindowMaximized: vi.fn<() => Promise<boolean>>(),
  maximizedListeners: new Set<(maximized: boolean) => void>(),
}));

vi.mock("../platform", () => ({
  minimizeWindow: () => mocks.minimizeWindow(),
  toggleMaximizeWindow: () => mocks.toggleMaximizeWindow(),
  closeWindow: () => mocks.closeWindow(),
  isWindowMaximized: () => mocks.isWindowMaximized(),
  onWindowMaximized: (cb: (maximized: boolean) => void) => {
    mocks.maximizedListeners.add(cb);
    return Promise.resolve(() => {
      mocks.maximizedListeners.delete(cb);
    });
  },
}));

import WindowControls from "./WindowControls";

const WINDOWS_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";
const MAC_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 15_0) AppleWebKit/537.36";
const LINUX_UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36";

describe("WindowControls and isWindows", () => {
  let container: HTMLDivElement;
  let root: Root;
  let originalUa: string;

  const setUserAgent = (ua: string) => {
    Object.defineProperty(window.navigator, "userAgent", {
      value: ua,
      configurable: true,
    });
  };

  beforeEach(async () => {
    originalUa = navigator.userAgent;
    await i18n.changeLanguage("en");
    mocks.minimizeWindow.mockReset().mockResolvedValue();
    mocks.toggleMaximizeWindow.mockReset().mockResolvedValue();
    mocks.closeWindow.mockReset().mockResolvedValue();
    mocks.isWindowMaximized.mockReset().mockResolvedValue(false);
    mocks.maximizedListeners.clear();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    setUserAgent(originalUa);
  });

  it("detects Windows via isWindows() without false positives on macOS or Linux", () => {
    setUserAgent(WINDOWS_UA);
    expect(isWindows()).toBe(true);
    expect(isMacOS()).toBe(false);

    setUserAgent(MAC_UA);
    expect(isWindows()).toBe(false);
    expect(isMacOS()).toBe(true);

    setUserAgent(LINUX_UA);
    expect(isWindows()).toBe(false);
    expect(isMacOS()).toBe(false);
  });

  it("renders nothing on macOS and Linux and skips window-state subscriptions", async () => {
    for (const ua of [MAC_UA, LINUX_UA]) {
      setUserAgent(ua);
      await act(async () => {
        root.render(<WindowControls />);
      });
      expect(container.innerHTML).toBe("");
    }
    expect(mocks.isWindowMaximized).not.toHaveBeenCalled();
    expect(mocks.maximizedListeners.size).toBe(0);
  });

  it("renders divider, spec sizes/classes, close-hover styling, and triggers IPC on Windows", async () => {
    setUserAgent(WINDOWS_UA);
    await act(async () => {
      root.render(<WindowControls />);
    });

    const divider = container.querySelector("span[aria-hidden='true']");
    expect(divider?.className).toContain("w-px");
    expect(divider?.className).toContain("h-5");
    expect(divider?.className).toContain("bg-border-subtle");

    const group = divider?.nextElementSibling as HTMLElement | null;
    expect(group?.className).toContain("no-drag");
    expect(group?.className).toContain("relative");
    expect(group?.className).toContain("z-[55]");
    expect(group?.className).toContain("gap-1");

    const buttons = Array.from(container.querySelectorAll("button"));
    expect(buttons).toHaveLength(3);
    const [minBtn, maxBtn, closeBtn] = buttons;

    for (const btn of buttons) {
      expect(btn.className).toContain("size-8");
      expect(btn.className).toContain("rounded-control");
      expect(btn.className).toContain("text-text-secondary");
      expect(btn.className).not.toContain("dawn-glass");
    }

    expect(minBtn.getAttribute("aria-label")).toBe("Minimize");
    expect(minBtn.getAttribute("title")).toBe("Minimize");
    expect(minBtn.className).toContain("hover:bg-border-subtle");

    expect(maxBtn.getAttribute("aria-label")).toBe("Maximize");
    expect(maxBtn.getAttribute("title")).toBe("Maximize");
    expect(maxBtn.className).toContain("hover:bg-border-subtle");
    expect(maxBtn.querySelector("svg")?.getAttribute("class")).toContain("lucide-square");

    expect(closeBtn.getAttribute("aria-label")).toBe("Close");
    expect(closeBtn.getAttribute("title")).toBe("Close");
    expect(closeBtn.className).toContain("hover:bg-[#C42B1C]");
    expect(closeBtn.className).toContain("hover:text-white");

    await act(async () => {
      minBtn.click();
      maxBtn.click();
      closeBtn.click();
    });
    expect(mocks.minimizeWindow).toHaveBeenCalledTimes(1);
    expect(mocks.toggleMaximizeWindow).toHaveBeenCalledTimes(1);
    expect(mocks.closeWindow).toHaveBeenCalledTimes(1);
  });

  it("swaps maximize/restore glyph and label from initial state and live maximized events, and supports zh i18n", async () => {
    setUserAgent(WINDOWS_UA);
    mocks.isWindowMaximized.mockResolvedValueOnce(true);

    await act(async () => {
      root.render(<WindowControls />);
    });

    const maxBtn = container.querySelectorAll("button")[1];
    expect(maxBtn.getAttribute("aria-label")).toBe("Restore");
    expect(maxBtn.getAttribute("title")).toBe("Restore");
    expect(maxBtn.querySelector("svg")?.getAttribute("class")).toContain("lucide-copy");

    await act(async () => {
      for (const cb of mocks.maximizedListeners) {
        cb(false);
      }
    });
    expect(maxBtn.getAttribute("aria-label")).toBe("Maximize");
    expect(maxBtn.querySelector("svg")?.getAttribute("class")).toContain("lucide-square");

    await act(async () => {
      for (const cb of mocks.maximizedListeners) {
        cb(true);
      }
    });
    expect(maxBtn.getAttribute("aria-label")).toBe("Restore");
    expect(maxBtn.querySelector("svg")?.getAttribute("class")).toContain("lucide-copy");

    await act(async () => {
      await i18n.changeLanguage("zh");
    });
    const [minBtnZh, maxBtnZh, closeBtnZh] = Array.from(container.querySelectorAll("button"));
    expect(minBtnZh.getAttribute("aria-label")).toBe("最小化");
    expect(maxBtnZh.getAttribute("aria-label")).toBe("向下还原");
    expect(closeBtnZh.getAttribute("aria-label")).toBe("关闭");
  });

  it("supports showDivider={false} and tracks enter/leave full screen from a restored window", async () => {
    setUserAgent(WINDOWS_UA);
    mocks.isWindowMaximized.mockResolvedValueOnce(false);

    await act(async () => {
      root.render(<WindowControls showDivider={false} />);
    });

    expect(container.querySelector("span[aria-hidden='true']")).toBeNull();
    const maxBtn = container.querySelectorAll("button")[1];
    expect(maxBtn.getAttribute("aria-label")).toBe("Maximize");
    expect(maxBtn.querySelector("svg")?.getAttribute("class")).toContain("lucide-square");

    // Enter F11 full screen from restored -> button swaps to Restore (Copy) and clicking invokes toggleMaximizeWindow.
    await act(async () => {
      for (const cb of mocks.maximizedListeners) {
        cb(true);
      }
    });
    expect(maxBtn.getAttribute("aria-label")).toBe("Restore");
    expect(maxBtn.getAttribute("title")).toBe("Restore");
    expect(maxBtn.querySelector("svg")?.getAttribute("class")).toContain("lucide-copy");

    await act(async () => {
      maxBtn.click();
    });
    expect(mocks.toggleMaximizeWindow).toHaveBeenCalledTimes(1);

    // Leave full screen -> button swaps back to Maximize (Square).
    await act(async () => {
      for (const cb of mocks.maximizedListeners) {
        cb(false);
      }
    });
    expect(maxBtn.getAttribute("aria-label")).toBe("Maximize");
    expect(maxBtn.getAttribute("title")).toBe("Maximize");
    expect(maxBtn.querySelector("svg")?.getAttribute("class")).toContain("lucide-square");
  });
});
