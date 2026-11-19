/** @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { electronPlatform } from "./electron";
import type { UpdateProgressEvent } from "./types";

describe("electronPlatform", () => {
  const getPathForFile = vi.fn<(file: File) => string>();
  const invokeMock = vi.fn();
  const checkForUpdateMock = vi.fn();
  const downloadUpdateMock = vi.fn();
  const cancelUpdateDownloadMock = vi.fn();
  const getPlatformInfoMock = vi.fn();
  const relaunchMock = vi.fn();
  const minimizeWindowMock = vi.fn<() => Promise<void>>();
  const toggleMaximizeWindowMock = vi.fn<() => Promise<void>>();
  const closeWindowMock = vi.fn<() => Promise<void>>();
  const isWindowMaximizedMock = vi.fn<() => Promise<boolean>>();
  const maximizedListeners = new Set<(maximized: boolean) => void>();
  const progressListeners = new Set<(event: UpdateProgressEvent) => void>();

  beforeEach(() => {
    getPathForFile.mockReset();
    invokeMock.mockReset();
    checkForUpdateMock.mockReset();
    downloadUpdateMock.mockReset();
    cancelUpdateDownloadMock.mockReset();
    getPlatformInfoMock.mockReset();
    relaunchMock.mockReset();
    minimizeWindowMock.mockReset().mockResolvedValue();
    toggleMaximizeWindowMock.mockReset().mockResolvedValue();
    closeWindowMock.mockReset().mockResolvedValue();
    isWindowMaximizedMock.mockReset().mockResolvedValue(false);
    maximizedListeners.clear();
    progressListeners.clear();
    window.quillShell = {
      getWindowLabel: () => "main",
      getInitialDark: () => true,
      getInitialReaderTheme: () => "paper",
      invoke: invokeMock,
      listen: () => () => {},
      listenCurrentWindow: () => () => {},
      emitTo: async () => {},
      appReady: async () => {},
      setWindowTitle: async () => {},
      setWindowBackgroundColor: async () => {},
      minimizeWindow: minimizeWindowMock,
      toggleMaximizeWindow: toggleMaximizeWindowMock,
      closeWindow: closeWindowMock,
      isWindowMaximized: isWindowMaximizedMock,
      onWindowMaximized: (handler) => {
        maximizedListeners.add(handler);
        return () => {
          maximizedListeners.delete(handler);
        };
      },
      focusWindow: async () => true,
      openReaderWindow: async () => {},
      getOpenReaderCount: async () => 0,
      onWindowResized: () => () => {},
      setZoom: async () => {},
      setTitlebarZoom: async () => {},
      openFileDialog: async () => null,
      openUrl: async () => {},
      getAppVersion: async () => "2.0.0",
      getPlatformInfo: getPlatformInfoMock,
      checkForUpdate: checkForUpdateMock,
      downloadUpdate: downloadUpdateMock,
      cancelUpdateDownload: cancelUpdateDownloadMock,
      onUpdateProgress: (handler) => {
        progressListeners.add(handler);
        return () => {
          progressListeners.delete(handler);
        };
      },
      relaunch: relaunchMock,
      getPathForFile,
    };
  });

  afterEach(() => {
    delete window.quillShell;
  });

  it("encodes arbitrary paths safely into quill-file URLs", () => {
    const url = electronPlatform.convertFileSrc("/Users/test/Books/My #1 Book?.epub");
    const parsed = new URL(url);
    expect(parsed.protocol).toBe("quill-file:");
    expect(parsed.searchParams.get("path")).toBe("/Users/test/Books/My #1 Book?.epub");
  });

  it("tracks nested dragenter/dragleave without flickering and resolves drop paths", async () => {
    const events: string[] = [];
    const droppedPaths: string[][] = [];
    const unlisten = await electronPlatform.onDragDrop((ev) => {
      events.push(ev.type);
      if (ev.type === "drop") droppedPaths.push(ev.paths);
    });

    const file = new File(["epub"], "book.epub");
    getPathForFile.mockReturnValue("/tmp/book.epub");
    const dataTransfer = {
      types: ["Files"],
      files: [file],
      dropEffect: "none",
    } as unknown as DataTransfer;

    const dispatchDrag = (type: string) => {
      const ev = new Event(type, { bubbles: true, cancelable: true }) as Event & {
        dataTransfer: DataTransfer;
      };
      Object.defineProperty(ev, "dataTransfer", { value: dataTransfer });
      window.dispatchEvent(ev);
    };

    dispatchDrag("dragenter");
    dispatchDrag("dragenter");
    dispatchDrag("dragleave");
    dispatchDrag("dragover");
    dispatchDrag("drop");
    expect(events).toEqual(["enter", "over", "drop"]);
    expect(droppedPaths).toEqual([["/tmp/book.epub"]]);

    dispatchDrag("dragenter");
    dispatchDrag("dragleave");
    expect(events).toEqual(["enter", "over", "drop", "enter", "leave"]);

    unlisten();
  });

  it("defaults getCurrentWindowLabel, getInitialDark, and getInitialReaderTheme outside Electron", () => {
    expect(electronPlatform.getInitialDark()).toBe(true);
    expect(electronPlatform.getInitialReaderTheme()).toBe("paper");
    delete window.quillShell;
    expect(electronPlatform.getCurrentWindowLabel()).toBe("main");
    expect(electronPlatform.getInitialDark()).toBeNull();
    expect(electronPlatform.getInitialReaderTheme()).toBe("original");
  });

  it("bridges checkForUpdate null, sizeBytes, DownloadResult, cancelUpdateDownload, and getPlatformInfo", async () => {
    getPlatformInfoMock.mockResolvedValueOnce({ platform: "darwin", arch: "arm64" });
    await expect(electronPlatform.getPlatformInfo()).resolves.toEqual({
      platform: "darwin",
      arch: "arm64",
    });

    checkForUpdateMock.mockResolvedValueOnce(null);
    await expect(electronPlatform.checkForUpdate()).resolves.toBeNull();

    checkForUpdateMock.mockResolvedValueOnce({
      version: "2.0.1",
      body: "Notes",
      sizeBytes: 48_200_000,
    });
    downloadUpdateMock.mockImplementationOnce(async () => {
      for (const listener of progressListeners) {
        listener({ event: "Started", data: { contentLength: 100, chunkLength: 0 } });
        listener({ event: "Progress", data: { chunkLength: 100 } });
        listener({ event: "Finished", data: { chunkLength: 0 } });
      }
      return { cancelled: false };
    });

    const handle = await electronPlatform.checkForUpdate();
    expect(handle?.version).toBe("2.0.1");
    expect(handle?.body).toBe("Notes");
    expect(handle?.sizeBytes).toBe(48_200_000);

    const received: UpdateProgressEvent[] = [];
    const result = await handle!.downloadAndInstall((ev) => received.push(ev));
    expect(result).toEqual({ cancelled: false });
    expect(received).toHaveLength(3);
    expect(progressListeners.size).toBe(0);

    cancelUpdateDownloadMock.mockResolvedValueOnce(true);
    await expect(electronPlatform.cancelUpdateDownload()).resolves.toBe(true);

    relaunchMock.mockResolvedValueOnce(undefined);
    await electronPlatform.relaunch();
    expect(relaunchMock).toHaveBeenCalledTimes(1);

    // Browser fallback vs Electron-only bridge
    delete window.quillShell;
    expect(() => electronPlatform.cancelUpdateDownload()).toThrow(
      "Electron preload bridge",
    );
    await expect(electronPlatform.getPlatformInfo()).resolves.toMatchObject({
      platform: expect.any(String),
      arch: expect.any(String),
    });
  });

  it("bridges window-control actions and maximized-state subscriptions", async () => {
    await electronPlatform.minimizeWindow();
    await electronPlatform.toggleMaximizeWindow();
    await electronPlatform.closeWindow();
    expect(minimizeWindowMock).toHaveBeenCalledTimes(1);
    expect(toggleMaximizeWindowMock).toHaveBeenCalledTimes(1);
    expect(closeWindowMock).toHaveBeenCalledTimes(1);

    isWindowMaximizedMock.mockResolvedValueOnce(true);
    await expect(electronPlatform.isWindowMaximized()).resolves.toBe(true);

    const events: boolean[] = [];
    const unlisten = await electronPlatform.onWindowMaximized((maximized) => {
      events.push(maximized);
    });
    for (const cb of maximizedListeners) cb(true);
    for (const cb of maximizedListeners) cb(false);
    expect(events).toEqual([true, false]);

    unlisten();
    expect(maximizedListeners.size).toBe(0);

    delete window.quillShell;
    await expect(electronPlatform.minimizeWindow()).rejects.toThrow("Electron preload bridge");
    await expect(electronPlatform.isWindowMaximized()).rejects.toThrow("Electron preload bridge");
  });
});
