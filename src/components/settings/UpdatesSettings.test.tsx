/** @vitest-environment jsdom */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../../i18n";
import type { UpdateStatus } from "../../hooks/useUpdateChecker";

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
  getAppVersion: vi.fn<() => Promise<string>>(),
  getOpenReaderCount: vi.fn<() => Promise<number>>(),
  openUrl: vi.fn<(url: string) => Promise<void>>(),
  readerListeners: new Set<(e: { payload: number }) => void>(),
}));

vi.mock("../../contexts/UpdateContext", () => ({
  useUpdate: () => mocks.updateState,
}));

vi.mock("../../platform", () => ({
  getAppVersion: () => mocks.getAppVersion(),
  getOpenReaderCount: () => mocks.getOpenReaderCount(),
  openUrl: (url: string) => mocks.openUrl(url),
  listenCurrentWindow: (event: string, cb: (e: { payload: number }) => void) => {
    if (event === "reader-windows-changed") {
      mocks.readerListeners.add(cb);
    }
    return Promise.resolve(() => {
      mocks.readerListeners.delete(cb);
    });
  },
}));

import UpdatesSettings from "./UpdatesSettings";
import type { SettingsProps } from "./types";

describe("UpdatesSettings hero states and preferences", () => {
  let container: HTMLDivElement;
  let root: Root;
  let saveMock: ReturnType<typeof vi.fn<(k: string, v: string) => Promise<void>>>;

  const renderUpdates = async (settings: Record<string, string> = {}) => {
    const props: SettingsProps = {
      settings,
      loading: false,
      save: saveMock,
      saveBulk: vi.fn().mockResolvedValue(undefined),
      showSavedToast: vi.fn(),
    };
    await act(async () => {
      root.render(<UpdatesSettings {...props} />);
    });
    await act(async () => {
      await Promise.resolve();
    });
  };

  beforeEach(async () => {
    await i18n.changeLanguage("en");
    mocks.getAppVersion.mockReset().mockResolvedValue("2.0.0");
    mocks.getOpenReaderCount.mockReset().mockResolvedValue(0);
    mocks.openUrl.mockReset().mockResolvedValue(undefined);
    mocks.readerListeners.clear();
    saveMock = vi.fn<(k: string, v: string) => Promise<void>>().mockResolvedValue(undefined);
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
  });

  it("renders idle hero, Check for updates action, up-to-date pill, auto-check switch, and Last checked", async () => {
    mocks.updateState.upToDateSeq = 1;
    mocks.updateState.lastCheckedAt = Date.now() - 120_000;
    await renderUpdates({ auto_check_updates: "true" });

    expect(container.textContent).toContain("2.0.0");
    expect(container.querySelector('[data-testid="updates-uptodate-pill"]')?.textContent).toContain(
      "Up to date",
    );
    expect(container.textContent).toContain("checked 2m ago");
    expect(container.querySelector('[data-testid="updates-last-checked"]')?.textContent).toContain(
      "Today,",
    );

    const checkBtn = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Check for updates"),
    );
    await act(async () => {
      checkBtn?.click();
    });
    expect(mocks.updateState.checkForUpdate).toHaveBeenCalledWith({ manual: true });

    const autoSwitch = container.querySelector<HTMLButtonElement>(
      'button[role="switch"][aria-label="Automatically check for updates"]',
    );
    expect(autoSwitch?.getAttribute("aria-checked")).toBe("true");
    await act(async () => {
      autoSwitch?.click();
    });
    expect(saveMock).toHaveBeenCalledWith("auto_check_updates", "false");
  });

  it("renders checking state with disabled button and Never checked fallback", async () => {
    mocks.updateState.status = "checking";
    await renderUpdates({});

    expect(container.textContent).toContain("Checking for updates");
    const checkingBtn = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Checking…"),
    );
    expect(checkingBtn?.disabled).toBe(true);
    expect(container.querySelector('[data-testid="updates-last-checked"]')?.textContent).toBe("Never");
  });

  it("renders available state with size, Skip this version, and Download", async () => {
    mocks.updateState.status = "available";
    mocks.updateState.update = {
      version: "2.1.0",
      currentVersion: "2.0.0",
      sizeBytes: Math.round(48.2 * 1024 * 1024),
    };
    await renderUpdates();

    expect(container.textContent).toContain("Quill 2.1.0 is available · 48.2 MB");

    const skipBtn = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Skip this version"),
    );
    await act(async () => {
      skipBtn?.click();
    });
    expect(mocks.updateState.skipVersion).toHaveBeenCalledWith("2.1.0");

    const dlBtn = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Download"),
    );
    await act(async () => {
      dlBtn?.click();
    });
    expect(mocks.updateState.downloadAndInstall).toHaveBeenCalledTimes(1);
  });

  it("renders downloading byte progress and cancels on Cancel", async () => {
    mocks.updateState.status = "downloading";
    mocks.updateState.update = { version: "2.1.0", currentVersion: "2.0.0" };
    mocks.updateState.progress = 45;
    mocks.updateState.downloadedBytes = Math.round(21.7 * 1024 * 1024);
    mocks.updateState.totalBytes = Math.round(48.2 * 1024 * 1024);
    await renderUpdates();

    expect(container.textContent).toContain("Downloading Quill 2.1.0…");
    expect(container.textContent).toContain("21.7 of 48.2 MB (45%)");
    expect(container.querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow")).toBe("45");

    const cancelBtn = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Cancel"),
    );
    await act(async () => {
      cancelBtn?.click();
    });
    expect(mocks.updateState.cancelDownload).toHaveBeenCalledTimes(1);
  });

  it("renders verifying state and caption", async () => {
    mocks.updateState.status = "verifying";
    mocks.updateState.update = { version: "2.1.0", currentVersion: "2.0.0" };
    await renderUpdates();

    expect(container.textContent).toContain("Verifying Quill 2.1.0…");
    expect(container.textContent).toContain("Checking download signature…");
    const verifyingBtn = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Verifying…"),
    );
    expect(verifyingBtn?.disabled).toBe(true);
  });

  it("renders ready state with open books count, live updates, and Restart", async () => {
    mocks.updateState.status = "ready";
    mocks.updateState.update = { version: "2.1.0", currentVersion: "2.0.0" };
    mocks.updateState.totalBytes = Math.round(48.2 * 1024 * 1024);
    mocks.getOpenReaderCount.mockResolvedValue(2);
    await renderUpdates();

    expect(container.textContent).toContain("Quill 2.1.0 is ready · 48.2 MB downloaded");
    expect(container.textContent).toContain("2 books open");

    await act(async () => {
      for (const cb of mocks.readerListeners) {
        cb({ payload: 1 });
      }
    });
    expect(container.textContent).toContain("1 book open");

    const restartBtn = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Restart to update"),
    );
    await act(async () => {
      restartBtn?.click();
    });
    expect(mocks.updateState.restart).toHaveBeenCalledTimes(1);
  });

  it("renders error state with View downloads and Retry", async () => {
    mocks.updateState.status = "error";
    mocks.updateState.update = { version: "2.1.0", currentVersion: "2.0.0" };
    mocks.updateState.error = "Signature verification failed";
    await renderUpdates();

    expect(container.textContent).toContain("Signature verification failed");

    const dlPageBtn = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("View downloads"),
    );
    await act(async () => {
      dlPageBtn?.click();
    });
    expect(mocks.openUrl).toHaveBeenCalledWith(
      "https://github.com/yicheng47/quill/releases/tag/v2.1.0",
    );

    const retryBtn = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Retry"),
    );
    await act(async () => {
      retryBtn?.click();
    });
    expect(mocks.updateState.downloadAndInstall).toHaveBeenCalledTimes(1);
  });
});
