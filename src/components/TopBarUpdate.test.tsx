/** @vitest-environment jsdom */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../i18n";
import type { UpdateStatus } from "../hooks/useUpdateChecker";

const mocks = vi.hoisted(() => ({
  updateState: {
    status: "idle" as UpdateStatus,
    update: null as { version: string; currentVersion: string; sizeBytes?: number } | null,
    progress: 0,
    downloadedBytes: 0,
    totalBytes: 0,
    lastCheckedAt: null as number | null,
    skippedVersion: null as string | null,
    error: null as string | null,
    manualCheck: false,
    upToDateSeq: 0,
    checkForUpdate: vi.fn(),
    downloadAndInstall: vi.fn(),
    cancelDownload: vi.fn(),
    skipVersion: vi.fn(),
    restart: vi.fn(),
  },
  getOpenReaderCount: vi.fn<() => Promise<number>>(),
  openUrl: vi.fn<(url: string) => Promise<void>>(),
  minimizeWindow: vi.fn<() => Promise<void>>(),
  toggleMaximizeWindow: vi.fn<() => Promise<void>>(),
  closeWindow: vi.fn<() => Promise<void>>(),
  isWindowMaximized: vi.fn<() => Promise<boolean>>(),
  readerChangedListeners: new Set<(e: { payload: number }) => void>(),
  genericListeners: new Map<string, Set<(e: { payload: unknown }) => void>>(),
}));

vi.mock("../contexts/UpdateContext", () => ({
  useUpdate: () => mocks.updateState,
}));

vi.mock("../platform", () => ({
  getOpenReaderCount: () => mocks.getOpenReaderCount(),
  openUrl: (url: string) => mocks.openUrl(url),
  minimizeWindow: () => mocks.minimizeWindow(),
  toggleMaximizeWindow: () => mocks.toggleMaximizeWindow(),
  closeWindow: () => mocks.closeWindow(),
  isWindowMaximized: () => mocks.isWindowMaximized(),
  onWindowMaximized: () => Promise.resolve(() => {}),
  listenCurrentWindow: (event: string, cb: (e: { payload: number }) => void) => {
    if (event === "reader-windows-changed") {
      mocks.readerChangedListeners.add(cb);
    }
    return Promise.resolve(() => {
      mocks.readerChangedListeners.delete(cb);
    });
  },
  listen: (event: string, cb: (e: { payload: unknown }) => void) => {
    if (!mocks.genericListeners.has(event)) {
      mocks.genericListeners.set(event, new Set());
    }
    mocks.genericListeners.get(event)!.add(cb);
    return Promise.resolve(() => {
      mocks.genericListeners.get(event)?.delete(cb);
    });
  },
}));

import TopBar, { type MainRoute } from "./TopBar";
import type { SettingsSection } from "./settings/types";

describe("TopBar and UpdateIndicator states", () => {
  let container: HTMLDivElement;
  let root: Root;

  const setPlatform = (platform: string) => {
    Object.defineProperty(window.navigator, "platform", {
      value: platform,
      configurable: true,
    });
  };

  const renderTopBar = async (overrides?: {
    settingsOpen?: boolean;
    onOpenSettings?: (section?: SettingsSection) => void;
    onRouteChange?: (route: MainRoute) => void;
    onOpenSearch?: () => void;
    onImport?: () => void;
  }) => {
    const onOpenSettings = overrides?.onOpenSettings ?? vi.fn<(section?: SettingsSection) => void>();
    const onRouteChange = overrides?.onRouteChange ?? vi.fn<(route: MainRoute) => void>();
    const onOpenSearch = overrides?.onOpenSearch ?? vi.fn<() => void>();
    const onImport = overrides?.onImport ?? vi.fn<() => void>();
    await act(async () => {
      root.render(
        <TopBar
          activeRoute="library"
          onRouteChange={onRouteChange}
          searchOpen={false}
          onOpenSearch={onOpenSearch}
          importing={false}
          onImport={onImport}
          settingsOpen={overrides?.settingsOpen ?? false}
          onOpenSettings={onOpenSettings}
        />,
      );
    });
    return { onOpenSettings, onRouteChange, onOpenSearch, onImport };
  };

  beforeEach(async () => {
    vi.useFakeTimers();
    await i18n.changeLanguage("en");
    setPlatform("MacIntel");
    mocks.readerChangedListeners.clear();
    mocks.genericListeners.clear();
    mocks.getOpenReaderCount.mockReset();
    mocks.getOpenReaderCount.mockResolvedValue(0);
    mocks.openUrl.mockReset();
    mocks.openUrl.mockResolvedValue();
    mocks.minimizeWindow.mockReset().mockResolvedValue();
    mocks.toggleMaximizeWindow.mockReset().mockResolvedValue();
    mocks.closeWindow.mockReset().mockResolvedValue();
    mocks.isWindowMaximized.mockReset().mockResolvedValue(false);
    mocks.updateState = {
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
      checkForUpdate: vi.fn().mockResolvedValue(null),
      downloadAndInstall: vi.fn().mockResolvedValue(undefined),
      cancelDownload: vi.fn().mockResolvedValue(undefined),
      skipVersion: vi.fn().mockResolvedValue(undefined),
      restart: vi.fn().mockResolvedValue(undefined),
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

  it("hides the update indicator when idle or during background checks", async () => {
    await renderTopBar();
    expect(container.querySelector('[data-testid="update-indicator"]')).toBeNull();
    expect(container.querySelector('[data-testid="update-manual-checking"]')).toBeNull();
    expect(container.querySelector('[data-testid="update-manual-uptodate"]')).toBeNull();

    mocks.updateState.status = "checking";
    mocks.updateState.manualCheck = false;
    await renderTopBar();
    expect(container.querySelector('[data-testid="update-indicator"]')).toBeNull();
    expect(container.querySelector('[data-testid="update-manual-checking"]')).toBeNull();
  });

  it("shows non-toast inline feedback for manual check -> up-to-date and auto-dismisses", async () => {
    mocks.updateState.status = "checking";
    mocks.updateState.manualCheck = true;
    await renderTopBar();

    const checkingChip = container.querySelector('[data-testid="update-manual-checking"]');
    expect(checkingChip?.textContent).toContain("Checking for updates");

    mocks.updateState.status = "idle";
    mocks.updateState.manualCheck = false;
    mocks.updateState.upToDateSeq = 1;
    await renderTopBar();

    const upToDateChip = container.querySelector('[data-testid="update-manual-uptodate"]');
    expect(upToDateChip?.textContent).toContain("Up to date");

    await act(async () => {
      vi.advanceTimersByTime(4000);
    });
    expect(container.querySelector('[data-testid="update-manual-uptodate"]')).toBeNull();
  });

  it("renders Available state and starts download on click", async () => {
    mocks.updateState.status = "available";
    mocks.updateState.update = { version: "1.2.3", currentVersion: "1.2.0" };
    await renderTopBar();

    const btn = container.querySelector<HTMLButtonElement>('[data-testid="update-indicator"]');
    expect(btn?.getAttribute("data-update-status")).toBe("available");
    expect(btn?.getAttribute("title")).toContain("1.2.3");

    await act(async () => {
      btn?.click();
    });
    expect(mocks.updateState.downloadAndInstall).toHaveBeenCalledTimes(1);
  });

  it("renders Downloading and Verifying progress rings without opening a popover", async () => {
    mocks.updateState.status = "downloading";
    mocks.updateState.update = { version: "1.2.3", currentVersion: "1.2.0" };
    mocks.updateState.progress = 45;
    await renderTopBar();

    const dlBtn = container.querySelector<HTMLButtonElement>('[data-testid="update-indicator"]');
    expect(dlBtn?.getAttribute("data-update-status")).toBe("downloading");
    expect(dlBtn?.getAttribute("title")).toContain("45%");
    expect(dlBtn?.getAttribute("aria-disabled")).toBe("true");
    await act(async () => {
      dlBtn?.click();
    });
    expect(container.querySelector('[role="dialog"]')).toBeNull();

    mocks.updateState.status = "verifying";
    await renderTopBar();
    const verifyBtn = container.querySelector<HTMLButtonElement>('[data-testid="update-indicator"]');
    expect(verifyBtn?.getAttribute("data-update-status")).toBe("verifying");
    expect(verifyBtn?.getAttribute("title")).toContain("Verifying");
  });

  it("renders Ready state with 264px popover, live reader count, restart, release notes, and Later", async () => {
    mocks.getOpenReaderCount.mockResolvedValue(2);
    mocks.updateState.status = "ready";
    mocks.updateState.update = { version: "1.2.3", currentVersion: "1.2.0" };
    await renderTopBar();

    const readyBtn = container.querySelector<HTMLButtonElement>('[data-testid="update-indicator"]');
    expect(readyBtn?.getAttribute("data-update-status")).toBe("ready");

    await act(async () => {
      readyBtn?.click();
    });

    const popover = container.querySelector('[role="dialog"]');
    expect(popover).not.toBeNull();
    expect(popover?.textContent).toContain("Quill 1.2.3 ready");
    expect(popover?.textContent).toContain("Will close 2 open reader windows on restart.");

    await act(async () => {
      for (const cb of mocks.readerChangedListeners) {
        cb({ payload: 0 });
      }
    });
    expect(popover?.textContent).not.toContain("reader window");

    const whatsNewBtn = Array.from(popover!.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("What's new"),
    );
    await act(async () => {
      whatsNewBtn?.click();
    });
    expect(mocks.openUrl).toHaveBeenCalledWith(
      "https://github.com/yicheng47/quill/releases/tag/v1.2.3",
    );

    const laterBtn = Array.from(popover!.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Later"),
    );
    await act(async () => {
      laterBtn?.click();
    });
    expect(container.querySelector('[role="dialog"]')).toBeNull();

    await act(async () => {
      readyBtn?.click();
    });
    const restartBtn = Array.from(container.querySelectorAll('[role="dialog"] button')).find((b) =>
      b.textContent?.includes("Restart to update"),
    ) as HTMLButtonElement | undefined;
    await act(async () => {
      restartBtn?.click();
    });
    expect(mocks.updateState.restart).toHaveBeenCalledTimes(1);
  });

  it("renders Failed state and opens Settings when clicked", async () => {
    const onOpenSettings = vi.fn();
    mocks.updateState.status = "error";
    mocks.updateState.error = "Checksum mismatch";
    await renderTopBar({ onOpenSettings });

    const errBtn = container.querySelector<HTMLButtonElement>('[data-testid="update-indicator"]');
    expect(errBtn?.getAttribute("data-update-status")).toBe("error");
    expect(errBtn?.getAttribute("title")).toBe("Checksum mismatch");

    await act(async () => {
      errBtn?.click();
    });
    expect(onOpenSettings).toHaveBeenCalledWith("updates");
  });

  it("omits traffic-light spacer on Windows and displays live sync progress chip", async () => {
    setPlatform("Win32");
    await renderTopBar();
    const header = container.querySelector("header");
    expect(header?.hasAttribute("data-drag-region")).toBe(true);
    expect(container.querySelector(".w-\\[60px\\]")).toBeNull();

    await act(async () => {
      for (const cb of mocks.genericListeners.get("sync-progress") ?? []) {
        cb({ payload: { applied: 21, total: 50 } });
      }
    });
    const chip = container.querySelector('[data-testid="topbar-sync-chip"]');
    expect(chip?.textContent).toContain("42%");
    expect(chip?.className).not.toContain("no-drag");

    await act(async () => {
      for (const cb of mocks.genericListeners.get("sync-initial-tick-done") ?? []) {
        cb({ payload: null });
      }
    });
    expect(container.querySelector('[data-testid="topbar-sync-chip"]')).toBeNull();
  });

  it("renders a 60px macOS traffic-light spacer and leaves empty right-cluster wrapper draggable", async () => {
    const origUa = navigator.userAgent;
    Object.defineProperty(window.navigator, "userAgent", {
      value: "Mozilla/5.0 (Macintosh; Intel Mac OS X 15_0)",
      configurable: true,
    });
    try {
      await renderTopBar();
      const spacer = container.querySelector("header .w-\\[60px\\]");
      expect(spacer).toBeTruthy();

      const header = container.querySelector("header")!;
      const leftCluster = header.firstElementChild as HTMLElement;
      const nav = header.querySelector("nav")!;
      const rightCluster = header.lastElementChild as HTMLElement;
      expect(header.className).toContain("z-30");
      expect(header.className).toContain("pl-7 pr-4 lg:px-7");
      expect(nav.parentElement).toBe(header);
      expect(leftCluster.className).toContain("min-w-fit");
      expect(rightCluster.className).toContain("min-w-fit");
      expect(rightCluster.className).not.toContain("no-drag");
      expect(container.querySelector('button[aria-label="Minimize"]')).toBeNull();
      expect(container.querySelector('button[aria-label="Maximize"]')).toBeNull();
      expect(container.querySelector('button[aria-label="Close"]')).toBeNull();
      expect(leftCluster.querySelector("span")?.className).toContain("hidden sm:inline");
      for (const tab of Array.from(nav.querySelectorAll("button"))) {
        expect(tab.className).toContain("whitespace-nowrap");
        expect(tab.className).toContain("px-2 sm:px-3 md:px-4");
      }
    } finally {
      Object.defineProperty(window.navigator, "userAgent", {
        value: origUa,
        configurable: true,
      });
    }
  });

  it("centers Windows nav from 920px+ (two full wings) and wraps into a compact two-row layout below 920px", async () => {
    const origUa = navigator.userAgent;
    Object.defineProperty(window.navigator, "userAgent", {
      value: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
      configurable: true,
    });
    try {
      await renderTopBar();
      const header = container.querySelector("header")!;
      const leftCluster = header.firstElementChild as HTMLElement;
      const nav = header.querySelector("nav")!;
      const navRow = nav.parentElement as HTMLElement;
      const rightCluster = header.lastElementChild as HTMLElement;

      // Header avoids trapping WindowControls in a z-30 stacking context and uses symmetric padding for centering.
      expect(header.className).not.toContain("z-30");
      expect(header.className).toContain("px-3 min-[920px]:px-5 lg:px-7");
      expect(header.className).toContain("max-[920px]:flex-wrap");
      expect(header.className).toContain("max-[920px]:h-auto");
      expect(header.className).toContain("min-[920px]:h-[71px]");
      expect(header.className).toContain("min-[920px]:flex-nowrap");

      // Both clusters flex equally once two 225px wings + nav fit (920px+, including 1000px and 1440px),
      // and wrap cleanly below 920px (including 768px, 800px, 919px, and 700 DIP @ 150% = ~467 CSS px).
      expect(leftCluster.className).toContain("flex-1");
      expect(leftCluster.className).toContain("basis-0");
      expect(leftCluster.className).toContain("max-[920px]:order-1");
      expect(rightCluster.className).toContain("max-[920px]:order-2");
      expect(rightCluster.className).toContain("min-[920px]:flex-1");
      expect(rightCluster.className).toContain("min-[920px]:basis-0");
      expect(rightCluster.className).toContain("min-[920px]:min-w-fit");
      expect(rightCluster.className).not.toContain("no-drag");

      expect(navRow).not.toBe(header);
      expect(navRow.className).toContain("max-[920px]:order-3");
      expect(navRow.className).toContain("max-[920px]:basis-full");
      expect(navRow.className).toContain("max-[920px]:justify-center");
      expect(navRow.className).toContain("min-[920px]:contents");
      expect(nav.className).toContain("max-w-full");
      expect(nav.className).toContain("overflow-x-auto");

      expect(container.querySelector("header .w-\\[60px\\]")).toBeNull();

      const minBtn = rightCluster.querySelector('button[aria-label="Minimize"]');
      const maxBtn = rightCluster.querySelector('button[aria-label="Maximize"]');
      const closeBtn = rightCluster.querySelector('button[aria-label="Close"]');
      const divider = rightCluster.querySelector("span[aria-hidden='true']");
      expect(divider).not.toBeNull();
      expect(minBtn).not.toBeNull();
      expect(maxBtn).not.toBeNull();
      expect(closeBtn).not.toBeNull();
      expect(divider?.nextElementSibling).toBe(rightCluster.lastElementChild);
      expect(rightCluster.lastElementChild?.className).toContain("z-[55]");
      expect(rightCluster.lastElementChild?.contains(closeBtn!)).toBe(true);
    } finally {
      Object.defineProperty(window.navigator, "userAgent", {
        value: origUa,
        configurable: true,
      });
    }
  });

  it("clears nav route active pill when settingsOpen is true and highlights gear", async () => {
    const onOpenSettings = vi.fn();
    await renderTopBar({ settingsOpen: true, onOpenSettings });

    const nav = container.querySelector("nav");
    const activeRoute = Array.from(nav?.querySelectorAll("button") ?? []).find((b) =>
      b.className.includes("bg-accent-tint"),
    );
    expect(activeRoute).toBeUndefined();

    const gearBtn = container.querySelector<HTMLButtonElement>('button[aria-label="Settings"]');
    expect(gearBtn?.className).toContain("bg-accent-tint");

    await act(async () => {
      gearBtn?.click();
    });
    expect(onOpenSettings).toHaveBeenCalledWith();
  });

  it("keeps TopBar bounded below lg during manual update feedback so actions stay onscreen", async () => {
    mocks.updateState.status = "checking";
    mocks.updateState.manualCheck = true;
    await renderTopBar();

    const header = container.querySelector("header")!;
    const leftCluster = header.firstElementChild as HTMLElement;
    const rightCluster = header.lastElementChild as HTMLElement;
    expect(leftCluster.className).toContain("min-w-0");
    expect(leftCluster.className).toContain("lg:min-w-fit");
    expect(rightCluster.className).toContain("shrink-0");
    expect(rightCluster.className).toContain("lg:flex-1");

    const wordmark = leftCluster.querySelector("span");
    expect(wordmark?.textContent).toBe("Quill");
    expect(wordmark?.className).toContain("hidden lg:inline");

    const checkingChip = container.querySelector('[data-testid="update-manual-checking"]');
    expect(checkingChip?.className).toContain("min-w-0");
    expect(checkingChip?.className).not.toContain("shrink-0");
    expect(checkingChip?.textContent).toContain("Checking…");
    expect(checkingChip?.textContent).toContain("Checking for updates");

    mocks.updateState.status = "idle";
    mocks.updateState.manualCheck = false;
    mocks.updateState.upToDateSeq = 1;
    await renderTopBar();

    const upToDateChip = container.querySelector('[data-testid="update-manual-uptodate"]');
    expect(upToDateChip?.className).toContain("min-w-0");
    expect(upToDateChip?.className).not.toContain("shrink-0");
    expect(wordmark?.className).toContain("hidden lg:inline");

    await act(async () => {
      vi.advanceTimersByTime(4000);
    });
    expect(container.querySelector('[data-testid="update-manual-uptodate"]')).toBeNull();
    expect(wordmark?.className).toContain("hidden sm:inline");
  });
});
