import { beforeEach, describe, expect, it, vi } from "vitest";

type Listener = (...args: unknown[]) => void;

interface MockWindowRecord {
  id: number;
  fullscreen: boolean;
  destroyed: boolean;
  setWindowButtonPosition: ReturnType<typeof vi.fn<(pos: { x: number; y: number }) => void>>;
  listeners: Map<string, Listener[]>;
  emit: (event: string, ...args: unknown[]) => void;
}

const mockState = vi.hoisted(() => ({
  nextId: 1,
  instances: [] as MockWindowRecord[],
}));

vi.mock("electron", () => {
  class MockBrowserWindow {
    webContents: {
      id: number;
      send: ReturnType<typeof vi.fn>;
      setWindowOpenHandler: ReturnType<typeof vi.fn>;
      on: ReturnType<typeof vi.fn>;
    };
    private record: MockWindowRecord;

    constructor() {
      const id = mockState.nextId++;
      const listeners = new Map<string, Listener[]>();
      const record: MockWindowRecord = {
        id,
        fullscreen: false,
        destroyed: false,
        setWindowButtonPosition: vi.fn<(pos: { x: number; y: number }) => void>(),
        listeners,
        emit: (event: string, ...args: unknown[]) => {
          for (const cb of listeners.get(event) ?? []) {
            cb(...args);
          }
        },
      };
      this.record = record;
      mockState.instances.push(record);
      this.webContents = {
        id,
        send: vi.fn(),
        setWindowOpenHandler: vi.fn(),
        on: vi.fn(),
      };
    }

    on(event: string, cb: Listener) {
      const list = this.record.listeners.get(event) ?? [];
      list.push(cb);
      this.record.listeners.set(event, list);
    }
    loadURL = vi.fn().mockResolvedValue(undefined);
    isDestroyed = () => this.record.destroyed;
    isFullScreen = () => this.record.fullscreen;
    isMinimized = () => false;
    isVisible = () => true;
    show = vi.fn();
    restore = vi.fn();
    focus = vi.fn();
    hide = vi.fn();
    close = vi.fn();
    getSize = () => [1440, 960];
    setWindowButtonPosition = (pos: { x: number; y: number }) =>
      this.record.setWindowButtonPosition(pos);
  }

  return {
    BrowserWindow: MockBrowserWindow,
    nativeTheme: { shouldUseDarkColors: false },
    shell: { openExternal: vi.fn() },
  };
});

import {
  appReadyForWindow,
  createMainWindow,
  createReaderWindow,
  getTitlebarZoomForWindow,
  getWindow,
  labelForWebContents,
  scaledTitlebarHeight,
  setTitlebarZoomForWindow,
  trafficLightPositionFor,
  whenWindowReady,
} from "./windows";

function closeIfOpen(label: string, rec: MockWindowRecord | undefined) {
  if (rec && !rec.destroyed) {
    rec.emit("closed");
    rec.destroyed = true;
  }
  expect(getWindow(label)).toBeUndefined();
}

describe("electron windows titlebar & lifecycle", () => {
  beforeEach(() => {
    for (const rec of mockState.instances) {
      if (!rec.destroyed) {
        rec.emit("closed");
        rec.destroyed = true;
      }
    }
    mockState.instances = [];
    mockState.nextId = 1;
  });

  it("tracks titlebar geometry across app zoom levels for main and reader windows", () => {
    expect(scaledTitlebarHeight("main", 0.8, false)).toBe(35.2);
    expect(scaledTitlebarHeight("main", 1.0, false)).toBe(44);
    expect(scaledTitlebarHeight("main", 1.5, false)).toBe(66);
    expect(scaledTitlebarHeight("reader-book1", 1.0, false)).toBe(32);
    expect(scaledTitlebarHeight("reader-book1", 1.5, false)).toBe(48);

    expect(trafficLightPositionFor("main", 1.0, false)).toEqual({ x: 16, y: 15 });
    expect(trafficLightPositionFor("main", 1.5, false)).toEqual({ x: 16, y: 26 });
    expect(trafficLightPositionFor("reader-book1", 1.0, false)).toEqual({ x: 16, y: 9 });
    expect(trafficLightPositionFor("reader-book1", 1.5, false)).toEqual({ x: 16, y: 17 });

    createMainWindow(false);
    const mainRec = mockState.instances[0];
    setTitlebarZoomForWindow("main", 1.5, "darwin");
    expect(mainRec.setWindowButtonPosition).toHaveBeenCalledWith({ x: 16, y: 26 });

    // Non-macOS does not invoke macOS traffic-light placement.
    mainRec.setWindowButtonPosition.mockClear();
    setTitlebarZoomForWindow("main", 1.2, "win32");
    expect(mainRec.setWindowButtonPosition).not.toHaveBeenCalled();

    closeIfOpen("main", mainRec);
  });

  it("skips titlebar repositioning in fullscreen mode", () => {
    expect(scaledTitlebarHeight("main", 1.2, true)).toBeNull();
    expect(trafficLightPositionFor("reader-book1", 1.2, true)).toBeNull();

    createMainWindow(false);
    const mainRec = mockState.instances[0];
    mainRec.fullscreen = true;
    setTitlebarZoomForWindow("main", 1.5, "darwin");
    expect(mainRec.setWindowButtonPosition).not.toHaveBeenCalled();

    closeIfOpen("main", mainRec);
  });

  it("scopes titlebar state per window and cleans up when a reader window closes", () => {
    createMainWindow(false);
    createReaderWindow(
      {
        label: "reader-book1",
        url: "/reader/book1",
        title: "Book 1",
        width: 1200,
        height: 800,
        minWidth: 700,
        minHeight: 500,
      },
      false,
    );

    const [mainRec, readerRec] = mockState.instances;
    setTitlebarZoomForWindow("main", 0.8, "darwin");
    setTitlebarZoomForWindow("reader-book1", 1.5, "darwin");

    expect(getTitlebarZoomForWindow("main")).toBe(0.8);
    expect(getTitlebarZoomForWindow("reader-book1")).toBe(1.5);
    expect(mainRec.setWindowButtonPosition).toHaveBeenCalledWith({ x: 16, y: 11 });
    expect(readerRec.setWindowButtonPosition).toHaveBeenCalledWith({ x: 16, y: 17 });
    expect(labelForWebContents(mainRec.id)).toBe("main");
    expect(labelForWebContents(readerRec.id)).toBe("reader-book1");

    readerRec.emit("closed");
    readerRec.destroyed = true;

    expect(getWindow("reader-book1")).toBeUndefined();
    expect(labelForWebContents(readerRec.id)).toBeUndefined();
    expect(getTitlebarZoomForWindow("reader-book1")).toBeUndefined();
    expect(getTitlebarZoomForWindow("main")).toBe(0.8);

    // Setting zoom for a closed window is a safe no-op and does not leak state.
    expect(() => setTitlebarZoomForWindow("reader-book1", 1.2, "darwin")).not.toThrow();

    closeIfOpen("main", mainRec);
  });

  it("defers whenWindowReady callbacks until appReadyForWindow and discards them if closed", () => {
    createMainWindow(false);
    const mainRec = mockState.instances[0];
    const deferredCb = vi.fn();
    const immediateCb = vi.fn();

    whenWindowReady("main", deferredCb);
    expect(deferredCb).not.toHaveBeenCalled();

    appReadyForWindow("main");
    expect(deferredCb).toHaveBeenCalledTimes(1);

    whenWindowReady("main", immediateCb);
    expect(immediateCb).toHaveBeenCalledTimes(1);

    closeIfOpen("main", mainRec);

    // Reopening a fresh main window resets readiness and drops any pre-close queue.
    createMainWindow(false);
    const secondRec = mockState.instances[1];
    const cancelledCb = vi.fn();
    whenWindowReady("main", cancelledCb);
    expect(cancelledCb).not.toHaveBeenCalled();

    closeIfOpen("main", secondRec);
    appReadyForWindow("main");
    expect(cancelledCb).not.toHaveBeenCalled();
  });
});
