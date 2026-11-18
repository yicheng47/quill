import { beforeEach, describe, expect, it, vi } from "vitest";

type Listener = (...args: unknown[]) => void;

interface MockWindowRecord {
  id: number;
  options: Record<string, unknown>;
  bounds: { x: number; y: number; width: number; height: number };
  fullscreen: boolean;
  minimized: boolean;
  visible: boolean;
  destroyed: boolean;
  setWindowButtonPosition: ReturnType<typeof vi.fn<(pos: { x: number; y: number }) => void>>;
  setBackgroundColor: ReturnType<typeof vi.fn<(color: string) => void>>;
  listeners: Map<string, Listener[]>;
  emit: (event: string, ...args: unknown[]) => void;
}

const mockState = vi.hoisted(() => ({
  nextId: 1,
  instances: [] as MockWindowRecord[],
  cursorPoint: { x: 200, y: 200 },
  displays: [
    {
      id: 1,
      bounds: { x: 0, y: 0, width: 1920, height: 1080 },
      workArea: { x: 0, y: 38, width: 1920, height: 1042 },
    },
  ] as Array<{
    id: number;
    bounds: { x: number; y: number; width: number; height: number };
    workArea: { x: number; y: number; width: number; height: number };
  }>,
}));

function findDisplayForRect(rect: { x: number; y: number; width: number; height: number }) {
  const cx = rect.x + rect.width / 2;
  const cy = rect.y + rect.height / 2;
  return (
    mockState.displays.find(
      (d) =>
        cx >= d.bounds.x &&
        cx < d.bounds.x + d.bounds.width &&
        cy >= d.bounds.y &&
        cy < d.bounds.y + d.bounds.height,
    ) ?? mockState.displays[0]
  );
}

vi.mock("electron", () => {
  class MockBrowserWindow {
    webContents: {
      id: number;
      send: ReturnType<typeof vi.fn>;
      setWindowOpenHandler: ReturnType<typeof vi.fn>;
      on: ReturnType<typeof vi.fn>;
    };
    private record: MockWindowRecord;

    constructor(options: Record<string, unknown> = {}) {
      const id = mockState.nextId++;
      const listeners = new Map<string, Listener[]>();
      const width = Number(options.width ?? 1440);
      const height = Number(options.height ?? 960);
      const workArea = mockState.displays[0].workArea;
      const x =
        typeof options.x === "number"
          ? options.x
          : Math.round(workArea.x + (workArea.width - width) / 2);
      const y =
        typeof options.y === "number"
          ? options.y
          : Math.round(workArea.y + (workArea.height - height) / 2);
      const record: MockWindowRecord = {
        id,
        options,
        bounds: { x, y, width, height },
        fullscreen: false,
        minimized: false,
        visible: true,
        destroyed: false,
        setWindowButtonPosition: vi.fn<(pos: { x: number; y: number }) => void>(),
        setBackgroundColor: vi.fn<(color: string) => void>(),
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
    isMinimized = () => this.record.minimized;
    isVisible = () => this.record.visible;
    show = vi.fn(() => {
      this.record.visible = true;
    });
    restore = vi.fn(() => {
      this.record.minimized = false;
    });
    focus = vi.fn(() => {
      this.record.emit("focus");
    });
    hide = vi.fn(() => {
      this.record.visible = false;
    });
    close = vi.fn();
    getSize = () => [this.record.bounds.width, this.record.bounds.height];
    getBounds = () => ({ ...this.record.bounds });
    setBackgroundColor = (color: string) => this.record.setBackgroundColor(color);
    setWindowButtonPosition = (pos: { x: number; y: number }) =>
      this.record.setWindowButtonPosition(pos);
  }

  return {
    BrowserWindow: MockBrowserWindow,
    nativeTheme: { shouldUseDarkColors: false },
    shell: { openExternal: vi.fn() },
    screen: {
      getDisplayMatching: (rect: { x: number; y: number; width: number; height: number }) =>
        findDisplayForRect(rect),
      getCursorScreenPoint: () => ({ ...mockState.cursorPoint }),
      getDisplayNearestPoint: (pt: { x: number; y: number }) =>
        findDisplayForRect({ x: pt.x, y: pt.y, width: 1, height: 1 }),
    },
  };
});

import {
  appReadyForWindow,
  computeReaderWindowPosition,
  createMainWindow,
  createReaderWindow,
  getOpenReaderWindowCount,
  getTitlebarZoomForWindow,
  getWindow,
  labelForWebContents,
  READER_SHELL_BG,
  scaledTitlebarHeight,
  setDefaultWindowIcon,
  setTitlebarZoomForWindow,
  setWindowBackgroundColor,
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
    mockState.cursorPoint = { x: 200, y: 200 };
    mockState.displays = [
      {
        id: 1,
        bounds: { x: 0, y: 0, width: 1920, height: 1080 },
        workArea: { x: 0, y: 38, width: 1920, height: 1042 },
      },
    ];
  });

  it("tracks titlebar geometry across app zoom levels for main and reader windows", () => {
    expect(scaledTitlebarHeight("main", 0.8, false)).toBeCloseTo(56.8);
    expect(scaledTitlebarHeight("main", 1.0, false)).toBe(71);
    expect(scaledTitlebarHeight("main", 1.5, false)).toBe(106.5);
    expect(scaledTitlebarHeight("reader-book1", 1.0, false)).toBe(64);
    expect(scaledTitlebarHeight("reader-book1", 1.5, false)).toBe(96);

    expect(trafficLightPositionFor("main", 1.0, false)).toEqual({ x: 28, y: 29 });
    expect(trafficLightPositionFor("main", 1.5, false)).toEqual({ x: 42, y: 46 });
    expect(trafficLightPositionFor("reader-book1", 1.0, false)).toEqual({ x: 28, y: 25 });
    expect(trafficLightPositionFor("reader-book1", 1.5, false)).toEqual({ x: 42, y: 41 });

    createMainWindow(true);
    const mainRec = mockState.instances[0];
    expect(mainRec.options.backgroundColor).toBe("#EEEBF8");
    setTitlebarZoomForWindow("main", 1.5, "darwin");
    expect(mainRec.setWindowButtonPosition).toHaveBeenCalledWith({ x: 42, y: 46 });

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
    expect(mainRec.setWindowButtonPosition).toHaveBeenCalledWith({ x: 22, y: 21 });
    expect(readerRec.setWindowButtonPosition).toHaveBeenCalledWith({ x: 42, y: 41 });
    expect(labelForWebContents(mainRec.id)).toBe("main");
    expect(labelForWebContents(readerRec.id)).toBe("reader-book1");
    expect(getOpenReaderWindowCount()).toBe(1);

    readerRec.emit("closed");
    readerRec.destroyed = true;

    expect(getOpenReaderWindowCount()).toBe(0);
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

  it("applies default window icon when configured for dev windows", () => {
    setDefaultWindowIcon("/tmp/dev-icon.png");
    createMainWindow(false);
    const mainRec = mockState.instances[0];
    expect(mainRec.options.icon).toBe("/tmp/dev-icon.png");
    setDefaultWindowIcon(undefined);
    closeIfOpen("main", mainRec);
  });

  it("matches reader window backgroundColor to stored page theme and updates live without matching app dark theme", () => {
    const cases: Array<[string | undefined, string]> = [
      [undefined, READER_SHELL_BG.original],
      ["original", "#EEEBF8"],
      ["paper", "#F0E7D4"],
      ["quiet", "#D2D2D8"],
      ["dark", "#12111A"],
    ];

    for (const [pageTheme, expectedBg] of cases) {
      const label = `reader-theme-${pageTheme ?? "default"}`;
      createReaderWindow(
        {
          label,
          url: `/reader/${label}`,
          title: label,
          width: 1200,
          height: 800,
          minWidth: 700,
          minHeight: 500,
          pageTheme,
        },
        true,
      );
      const rec = mockState.instances[mockState.instances.length - 1];
      expect(rec.options.backgroundColor).toBe(expectedBg);
      expect((rec.options.webPreferences as { additionalArguments?: string[] }).additionalArguments).toContain(
        `--quill-reader-theme=${pageTheme ?? "original"}`,
      );
      closeIfOpen(label, rec);
    }

    createReaderWindow(
      {
        label: "reader-live-bg",
        url: "/reader/live",
        title: "Live",
        width: 1200,
        height: 800,
        minWidth: 700,
        minHeight: 500,
        pageTheme: "original",
      },
      false,
    );
    const liveRec = mockState.instances[mockState.instances.length - 1];
    setWindowBackgroundColor("reader-live-bg", READER_SHELL_BG.dark);
    expect(liveRec.setBackgroundColor).toHaveBeenCalledWith("#12111A");
    closeIfOpen("reader-live-bg", liveRec);
  });

  it("computes reader placement across single display, second display, overflow wrap, and hidden main", () => {
    const primaryWorkArea = { x: 0, y: 38, width: 1600, height: 1000 };
    const secondaryWorkArea = { x: 1600, y: 25, width: 2560, height: 1415 };

    // Single display cascading (+32 per already-open reader)
    const mainPrimary = {
      bounds: { x: 100, y: 80, width: 1200, height: 800 },
      workArea: primaryWorkArea,
    };
    expect(
      computeReaderWindowPosition({
        windowSize: { width: 1200, height: 800 },
        mainWindow: mainPrimary,
        openReaderCount: 0,
        lastFocusedReader: null,
        cursorWorkArea: primaryWorkArea,
      }),
    ).toEqual({ x: 132, y: 112 });
    expect(
      computeReaderWindowPosition({
        windowSize: { width: 1200, height: 800 },
        mainWindow: mainPrimary,
        openReaderCount: 1,
        lastFocusedReader: null,
        cursorWorkArea: primaryWorkArea,
      }),
    ).toEqual({ x: 164, y: 144 });

    // Overflow wrap: availY = (38 + 1000) - 800 - 80 = 158 -> floor(158/32) = 4 steps
    // openReaderCount=4 would step +160 -> bottom 80+160+800=1040 > 1038, so it wraps to +32
    expect(
      computeReaderWindowPosition({
        windowSize: { width: 1200, height: 800 },
        mainWindow: mainPrimary,
        openReaderCount: 4,
        lastFocusedReader: null,
        cursorWorkArea: primaryWorkArea,
      }),
    ).toEqual({ x: 132, y: 112 });

    // Second display: main is on display 2, cursor on primary -> follows main display
    const mainSecondary = {
      bounds: { x: 1700, y: 100, width: 1440, height: 960 },
      workArea: secondaryWorkArea,
    };
    expect(
      computeReaderWindowPosition({
        windowSize: { width: 1440, height: 960 },
        mainWindow: mainSecondary,
        openReaderCount: 0,
        lastFocusedReader: null,
        cursorWorkArea: primaryWorkArea,
      }),
    ).toEqual({ x: 1732, y: 132 });

    // Hidden main + last focused reader: cascade +32 from focused reader, wrap on overflow
    expect(
      computeReaderWindowPosition({
        windowSize: { width: 1200, height: 800 },
        mainWindow: null,
        openReaderCount: 2,
        lastFocusedReader: {
          bounds: { x: 164, y: 144, width: 1200, height: 800 },
          workArea: primaryWorkArea,
        },
        cursorWorkArea: secondaryWorkArea,
      }),
    ).toEqual({ x: 196, y: 176 });

    expect(
      computeReaderWindowPosition({
        windowSize: { width: 1200, height: 800 },
        mainWindow: null,
        openReaderCount: 2,
        lastFocusedReader: {
          bounds: { x: 380, y: 220, width: 1200, height: 800 },
          workArea: primaryWorkArea,
        },
        cursorWorkArea: secondaryWorkArea,
      }),
    ).toEqual({ x: 32, y: 70 });

    // Hidden main + no open readers -> centered on display under cursor
    expect(
      computeReaderWindowPosition({
        windowSize: { width: 1200, height: 800 },
        mainWindow: null,
        openReaderCount: 0,
        lastFocusedReader: null,
        cursorWorkArea: secondaryWorkArea,
      }),
    ).toEqual({ x: 2280, y: 333 });
  });

  it("places opened readers cascading near main, or near last focused reader / cursor display when main is hidden", () => {
    mockState.displays = [
      {
        id: 1,
        bounds: { x: 0, y: 0, width: 1920, height: 1080 },
        workArea: { x: 0, y: 38, width: 1920, height: 1042 },
      },
      {
        id: 2,
        bounds: { x: 1920, y: 0, width: 2560, height: 1440 },
        workArea: { x: 1920, y: 25, width: 2560, height: 1415 },
      },
    ];

    createMainWindow(false);
    const mainRec = mockState.instances[0];
    mainRec.bounds = { x: 2020, y: 100, width: 1440, height: 960 };

    createReaderWindow(
      { label: "reader-b1", url: "/reader/b1", title: "B1", width: 1200, height: 800, minWidth: 700, minHeight: 500 },
      false,
    );
    createReaderWindow(
      { label: "reader-b2", url: "/reader/b2", title: "B2", width: 1200, height: 800, minWidth: 700, minHeight: 500 },
      false,
    );

    const b1 = mockState.instances[1];
    const b2 = mockState.instances[2];
    expect(b1.options.x).toBe(2052);
    expect(b1.options.y).toBe(132);
    expect(b2.options.x).toBe(2084);
    expect(b2.options.y).toBe(164);

    // Hide main and focus reader-b1 -> next reader cascades from reader-b1
    mainRec.visible = false;
    b1.emit("focus");
    createReaderWindow(
      { label: "reader-b3", url: "/reader/b3", title: "B3", width: 1200, height: 800, minWidth: 700, minHeight: 500 },
      false,
    );
    const b3 = mockState.instances[3];
    expect(b3.options.x).toBe(2084);
    expect(b3.options.y).toBe(164);

    closeIfOpen("reader-b3", b3);
    closeIfOpen("reader-b2", b2);
    closeIfOpen("reader-b1", b1);

    // With main hidden and zero readers, center on display under cursor (display 1)
    mockState.cursorPoint = { x: 500, y: 500 };
    createReaderWindow(
      { label: "reader-b4", url: "/reader/b4", title: "B4", width: 1200, height: 800, minWidth: 700, minHeight: 500 },
      false,
    );
    const b4 = mockState.instances[4];
    expect(b4.options.x).toBe(360);
    expect(b4.options.y).toBe(159);

    closeIfOpen("reader-b4", b4);
    closeIfOpen("main", mainRec);
  });
});
