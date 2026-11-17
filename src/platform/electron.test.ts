/** @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { electronPlatform } from "./electron";

describe("electronPlatform", () => {
  const getPathForFile = vi.fn<(file: File) => string>();
  const invokeMock = vi.fn();

  beforeEach(() => {
    getPathForFile.mockReset();
    invokeMock.mockReset();
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
      getAppVersion: async () => "1.3.4",
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
});
