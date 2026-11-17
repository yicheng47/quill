/** @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { electronPlatform } from "./electron";
import type { UpdateProgressEvent } from "./types";

describe("electronPlatform", () => {
  const getPathForFile = vi.fn<(file: File) => string>();
  const invokeMock = vi.fn();
  const checkForUpdateMock = vi.fn();
  const downloadUpdateMock = vi.fn();
  const relaunchMock = vi.fn();
  const progressListeners = new Set<(event: UpdateProgressEvent) => void>();

  beforeEach(() => {
    getPathForFile.mockReset();
    invokeMock.mockReset();
    checkForUpdateMock.mockReset();
    downloadUpdateMock.mockReset();
    relaunchMock.mockReset();
    progressListeners.clear();
    window.quillShell = {
      getWindowLabel: () => "main",
      invoke: invokeMock,
      listen: () => () => {},
      listenCurrentWindow: () => () => {},
      emitTo: async () => {},
      appReady: async () => {},
      setWindowTitle: async () => {},
      focusWindow: async () => true,
      openReaderWindow: async () => {},
      onWindowResized: () => () => {},
      setZoom: async () => {},
      setTitlebarZoom: async () => {},
      openFileDialog: async () => null,
      openUrl: async () => {},
      getAppVersion: async () => "2.0.0",
      checkForUpdate: checkForUpdateMock,
      downloadUpdate: downloadUpdateMock,
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

  it("defaults getCurrentWindowLabel to main outside Electron", () => {
    delete window.quillShell;
    expect(electronPlatform.getCurrentWindowLabel()).toBe("main");
  });

  it("bridges checkForUpdate null, UpdateHandle download progress, and relaunch", async () => {
    checkForUpdateMock.mockResolvedValueOnce(null);
    await expect(electronPlatform.checkForUpdate()).resolves.toBeNull();

    checkForUpdateMock.mockResolvedValueOnce({ version: "2.0.1", body: "Notes" });
    downloadUpdateMock.mockImplementationOnce(async () => {
      for (const listener of progressListeners) {
        listener({ event: "Started", data: { contentLength: 100, chunkLength: 0 } });
        listener({ event: "Progress", data: { chunkLength: 100 } });
        listener({ event: "Finished", data: { chunkLength: 0 } });
      }
    });

    const handle = await electronPlatform.checkForUpdate();
    expect(handle?.version).toBe("2.0.1");
    expect(handle?.body).toBe("Notes");

    const received: UpdateProgressEvent[] = [];
    await handle!.downloadAndInstall((ev) => received.push(ev));
    expect(received).toHaveLength(3);
    expect(progressListeners.size).toBe(0);

    relaunchMock.mockResolvedValueOnce(undefined);
    await electronPlatform.relaunch();
    expect(relaunchMock).toHaveBeenCalledTimes(1);
  });
});
