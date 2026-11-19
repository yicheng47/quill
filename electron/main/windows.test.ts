import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Listener = (...args: unknown[]) => void;

interface MockWindowRecord {
  id: number;
  options: Record<string, unknown>;
  bounds: { x: number; y: number; width: number; height: number };
  normalBounds: { x: number; y: number; width: number; height: number };
  maximized: boolean;
  fullscreen: boolean;
  minimized: boolean;
  visible: boolean;
  destroyed: boolean;
  setWindowButtonPosition: ReturnType<typeof vi.fn<(pos: { x: number; y: number }) => void>>;
  setBackgroundColor: ReturnType<typeof vi.fn<(color: string) => void>>;
  removeMenu: ReturnType<typeof vi.fn<() => void>>;
  minimize: ReturnType<typeof vi.fn<() => void>>;
  close: ReturnType<typeof vi.fn<() => void>>;
  maximize: ReturnType<typeof vi.fn<() => void>>;
  unmaximize: ReturnType<typeof vi.fn<() => void>>;
  setFullScreen: ReturnType<typeof vi.fn<(flag: boolean) => void>>;
  webContents: {
    id: number;
    send: ReturnType<typeof vi.fn>;
    reload: ReturnType<typeof vi.fn>;
    reloadIgnoringCache: ReturnType<typeof vi.fn>;
    toggleDevTools: ReturnType<typeof vi.fn>;
    emit: (event: string, ...args: unknown[]) => void;
  };
  listeners: Map<string, Listener[]>;
  emit: (event: string, ...args: unknown[]) => void;
}

const mockState = vi.hoisted(() => ({
  nextId: 1,
  instances: [] as MockWindowRecord[],
  cursorPoint: { x: 200, y: 200 },
  userDataDir: "",
  asyncFullScreen: false,
  primaryDisplayIndex: 0,
  isPackaged: false,
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
      reload: ReturnType<typeof vi.fn>;
      reloadIgnoringCache: ReturnType<typeof vi.fn>;
      toggleDevTools: ReturnType<typeof vi.fn>;
    };
    private record: MockWindowRecord;

    constructor(options: Record<string, unknown> = {}) {
      const id = mockState.nextId++;
      const listeners = new Map<string, Listener[]>();
      const webContentsListeners = new Map<string, Listener[]>();
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
      const webContents = {
        id,
        send: vi.fn(),
        setWindowOpenHandler: vi.fn(),
        on: vi.fn((event: string, cb: Listener) => {
          const list = webContentsListeners.get(event) ?? [];
          list.push(cb);
          webContentsListeners.set(event, list);
        }),
        reload: vi.fn(),
        reloadIgnoringCache: vi.fn(),
        toggleDevTools: vi.fn(),
      };
      const record: MockWindowRecord = {
        id,
        options,
        bounds: { x, y, width, height },
        normalBounds: { x, y, width, height },
        maximized: false,
        fullscreen: false,
        minimized: false,
        visible: true,
        destroyed: false,
        setWindowButtonPosition: vi.fn<(pos: { x: number; y: number }) => void>(),
        setBackgroundColor: vi.fn<(color: string) => void>(),
        removeMenu: vi.fn<() => void>(),
        minimize: vi.fn(() => {
          record.minimized = true;
        }),
        close: vi.fn<() => void>(),
        maximize: vi.fn(() => {
          record.maximized = true;
          record.bounds = { ...workArea };
        }),
        unmaximize: vi.fn(() => {
          record.maximized = false;
          record.bounds = { ...record.normalBounds };
        }),
        setFullScreen: vi.fn((flag: boolean) => {
          if (!mockState.asyncFullScreen) {
            record.fullscreen = flag;
          }
        }),
        webContents: {
          id,
          send: webContents.send,
          reload: webContents.reload,
          reloadIgnoringCache: webContents.reloadIgnoringCache,
          toggleDevTools: webContents.toggleDevTools,
          emit: (event: string, ...args: unknown[]) => {
            for (const cb of webContentsListeners.get(event) ?? []) {
              cb(...args);
            }
          },
        },
        listeners,
        emit: (event: string, ...args: unknown[]) => {
          for (const cb of listeners.get(event) ?? []) {
            cb(...args);
          }
        },
      };
      this.record = record;
      mockState.instances.push(record);
      this.webContents = webContents;
    }

    on(event: string, cb: Listener) {
      const list = this.record.listeners.get(event) ?? [];
      list.push(cb);
      this.record.listeners.set(event, list);
    }
    loadURL = vi.fn().mockResolvedValue(undefined);
    isDestroyed = () => this.record.destroyed;
    isMaximized = () => (this.record.minimized ? false : this.record.maximized);
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
      this.record.emit("hide");
    });
    close = () => this.record.close();
    minimize = () => this.record.minimize();
    removeMenu = () => this.record.removeMenu();
    maximize = () => this.record.maximize();
    unmaximize = () => this.record.unmaximize();
    setFullScreen = (flag: boolean) => this.record.setFullScreen(flag);
    getSize = () => [this.record.bounds.width, this.record.bounds.height];
    getBounds = () => ({ ...this.record.bounds });
    getNormalBounds = () => ({ ...this.record.normalBounds });
    setBackgroundColor = (color: string) => this.record.setBackgroundColor(color);
    setWindowButtonPosition = (pos: { x: number; y: number }) =>
      this.record.setWindowButtonPosition(pos);
  }

  return {
    app: {
      getPath: () => mockState.userDataDir,
      get isPackaged() {
        return mockState.isPackaged;
      },
    },
    BrowserWindow: MockBrowserWindow,
    nativeTheme: { shouldUseDarkColors: false },
    shell: { openExternal: vi.fn() },
    screen: {
      getPrimaryDisplay: () =>
        mockState.displays[mockState.primaryDisplayIndex] ?? mockState.displays[0],
      getAllDisplays: () => mockState.displays,
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
  markQuitting,
  READER_SHELL_BG,
  scaledTitlebarHeight,
  setDefaultWindowIcon,
  setTitlebarZoomForWindow,
  setWindowBackgroundColor,
  toggleWindowZoom,
  trafficLightPositionFor,
  whenWindowReady,
  WINDOW_STATE_SAVE_DELAY_MS,
} from "./windows";
import { getWindowStatePath } from "./windowState";

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
    mockState.asyncFullScreen = false;
    mockState.primaryDisplayIndex = 0;
    mockState.isPackaged = false;
    mockState.userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "quill-win-test-"));
    mockState.displays = [
      {
        id: 1,
        bounds: { x: 0, y: 0, width: 1920, height: 1080 },
        workArea: { x: 0, y: 38, width: 1920, height: 1042 },
      },
    ];
  });

  afterEach(() => {
    vi.useRealTimers();
    if (mockState.userDataDir) {
      fs.rmSync(mockState.userDataDir, { recursive: true, force: true });
      mockState.userDataDir = "";
    }
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
    expect(mainRec.options.backgroundColor).toBe("#12111A");
    expect(
      (mainRec.options.webPreferences as { additionalArguments?: string[] } | undefined)
        ?.additionalArguments,
    ).toContain("--quill-initial-dark=1");
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
    expect(mainRec.options.backgroundColor).toBe("#EEEBF8");
    expect(
      (mainRec.options.webPreferences as { additionalArguments?: string[] } | undefined)
        ?.additionalArguments,
    ).toContain("--quill-initial-dark=0");
    mainRec.fullscreen = true;
    setTitlebarZoomForWindow("main", 1.5, "darwin");
    expect(mainRec.setWindowButtonPosition).not.toHaveBeenCalled();

    closeIfOpen("main", mainRec);
  });

  it("omits --quill-initial-dark preload argument when InitialAppearance.preloadDark is null", () => {
    createMainWindow({ dark: false, preloadDark: null });
    const mainRec = mockState.instances[0];
    expect(mainRec.options.backgroundColor).toBe("#EEEBF8");
    const args =
      (mainRec.options.webPreferences as { additionalArguments?: string[] } | undefined)
        ?.additionalArguments ?? [];
    expect(args.some((arg) => arg.startsWith("--quill-initial-dark="))).toBe(false);
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

  it("persists normal main window bounds and maximized/fullscreen state across close, hide, and quit", () => {
    vi.useFakeTimers();

    createMainWindow(false);
    const first = mockState.instances[0];
    expect(first.options.width).toBe(1440);
    expect(first.options.height).toBe(960);
    expect(first.options.x).toBeUndefined();
    expect(first.options.y).toBeUndefined();

    // Move and resize -> debounced save writes window-state.json
    first.bounds = { x: 210, y: 110, width: 1180, height: 760 };
    first.normalBounds = { ...first.bounds };
    first.emit("move");
    first.emit("resize");
    expect(fs.existsSync(getWindowStatePath(mockState.userDataDir))).toBe(false);
    vi.advanceTimersByTime(WINDOW_STATE_SAVE_DELAY_MS);
    expect(JSON.parse(fs.readFileSync(getWindowStatePath(mockState.userDataDir), "utf8"))).toEqual({
      x: 210,
      y: 110,
      width: 1180,
      height: 760,
      isMaximized: false,
      isFullScreen: false,
    });

    // Maximize keeps normal bounds instead of maximized bounds, and hide flushes synchronously
    first.maximize();
    first.emit("maximize");
    first.emit("hide");
    expect(JSON.parse(fs.readFileSync(getWindowStatePath(mockState.userDataDir), "utf8"))).toEqual({
      x: 210,
      y: 110,
      width: 1180,
      height: 760,
      isMaximized: true,
      isFullScreen: false,
    });

    // Simulate quit & relaunch -> restores saved normal bounds + re-applies maximize
    markQuitting();
    closeIfOpen("main", first);

    createMainWindow(false);
    const second = mockState.instances[1];
    expect(second.options.x).toBe(210);
    expect(second.options.y).toBe(110);
    expect(second.options.width).toBe(1180);
    expect(second.options.height).toBe(760);
    expect(second.maximize).toHaveBeenCalledTimes(1);

    closeIfOpen("main", second);
  });

  it("preserves maximized state through minimize -> quit before debounce and restores fullscreen", () => {
    vi.useFakeTimers();

    createMainWindow(false);
    const first = mockState.instances[0];
    first.bounds = { x: 180, y: 95, width: 1100, height: 720 };
    first.normalBounds = { ...first.bounds };
    first.emit("move");
    first.emit("resize");
    vi.advanceTimersByTime(WINDOW_STATE_SAVE_DELAY_MS);

    // Maximize -> immediately minimize -> quit BEFORE the debounce fires.
    // On macOS isMaximized() returns false while minimized, so non-minimized mode must be preserved.
    first.maximize();
    first.emit("maximize");
    first.minimized = true;
    first.emit("minimize");
    markQuitting();
    expect(JSON.parse(fs.readFileSync(getWindowStatePath(mockState.userDataDir), "utf8"))).toEqual({
      x: 180,
      y: 95,
      width: 1100,
      height: 720,
      isMaximized: true,
      isFullScreen: false,
    });
    closeIfOpen("main", first);

    createMainWindow(false);
    const second = mockState.instances[1];
    expect(second.options.x).toBe(180);
    expect(second.options.y).toBe(95);
    expect(second.options.width).toBe(1100);
    expect(second.options.height).toBe(720);
    expect(second.maximize).toHaveBeenCalledTimes(1);

    // Unmaximize back to normal, resize, then enter fullscreen and quit -> restores fullscreen with normal bounds
    second.maximized = false;
    second.emit("unmaximize");
    second.bounds = { x: 240, y: 120, width: 1024, height: 680 };
    second.normalBounds = { ...second.bounds };
    second.emit("move");
    second.emit("resize");

    second.setFullScreen(true);
    second.bounds = { x: 0, y: 0, width: 1920, height: 1080 };
    second.emit("enter-full-screen");
    markQuitting();
    expect(JSON.parse(fs.readFileSync(getWindowStatePath(mockState.userDataDir), "utf8"))).toEqual({
      x: 240,
      y: 120,
      width: 1024,
      height: 680,
      isMaximized: false,
      isFullScreen: true,
    });
    closeIfOpen("main", second);

    createMainWindow(false);
    const third = mockState.instances[2];
    expect(third.options.x).toBe(240);
    expect(third.options.y).toBe(120);
    expect(third.options.width).toBe(1024);
    expect(third.options.height).toBe(680);
    expect(third.setFullScreen).toHaveBeenCalledWith(true);

    closeIfOpen("main", third);
  });

  it("preserves normal bounds when macOS Zoom emits resize at zoomed bounds before isMaximized and maximize", () => {
    vi.useFakeTimers();
    mockState.displays = [
      {
        id: 1,
        bounds: { x: 0, y: 0, width: 2560, height: 1440 },
        workArea: { x: 0, y: 30, width: 2540, height: 1309 },
      },
    ];

    createMainWindow(false);
    const first = mockState.instances[0];
    first.bounds = { x: 0, y: 30, width: 1281, height: 660 };
    first.normalBounds = { ...first.bounds };
    first.emit("move");
    first.emit("resize");
    vi.advanceTimersByTime(WINDOW_STATE_SAVE_DELAY_MS);

    // Simulate macOS Window -> Zoom: Cocoa animates/resizes to the zoomed frame and emits
    // resize BEFORE [window isZoomed] returns true or handleZoomEnd emits maximize.
    first.bounds = { x: 0, y: 30, width: 2540, height: 1309 };
    first.maximized = false;
    first.emit("resize");
    first.maximized = true;
    first.emit("maximize");
    vi.advanceTimersByTime(WINDOW_STATE_SAVE_DELAY_MS);

    expect(JSON.parse(fs.readFileSync(getWindowStatePath(mockState.userDataDir), "utf8"))).toEqual({
      x: 0,
      y: 30,
      width: 1281,
      height: 660,
      isMaximized: true,
      isFullScreen: false,
    });

    markQuitting();
    closeIfOpen("main", first);

    createMainWindow(false);
    const second = mockState.instances[1];
    expect(second.options.x).toBe(0);
    expect(second.options.y).toBe(30);
    expect(second.options.width).toBe(1281);
    expect(second.options.height).toBe(660);
    expect(second.maximize).toHaveBeenCalledTimes(1);

    // Leaving maximized mode after relaunch persists the restored normal bounds.
    second.maximized = false;
    second.bounds = { x: 0, y: 30, width: 1281, height: 660 };
    second.emit("resize");
    second.emit("unmaximize");
    vi.advanceTimersByTime(WINDOW_STATE_SAVE_DELAY_MS);
    expect(JSON.parse(fs.readFileSync(getWindowStatePath(mockState.userDataDir), "utf8"))).toEqual({
      x: 0,
      y: 30,
      width: 1281,
      height: 660,
      isMaximized: false,
      isFullScreen: false,
    });

    closeIfOpen("main", second);
  });

  it("preserves normal bounds during fullscreen resize transitions and async startup restore", () => {
    vi.useFakeTimers();

    createMainWindow(false);
    const first = mockState.instances[0];
    first.bounds = { x: 40, y: 50, width: 1120, height: 700 };
    first.emit("move");
    first.emit("resize");

    // Once fullscreen style mask flips, resize events during transition must not clobber pending normal bounds.
    first.fullscreen = true;
    first.bounds = { x: 0, y: 0, width: 1920, height: 1080 };
    first.emit("resize");
    first.emit("enter-full-screen");
    vi.advanceTimersByTime(WINDOW_STATE_SAVE_DELAY_MS);

    expect(JSON.parse(fs.readFileSync(getWindowStatePath(mockState.userDataDir), "utf8"))).toEqual({
      x: 40,
      y: 50,
      width: 1120,
      height: 700,
      isMaximized: false,
      isFullScreen: true,
    });

    markQuitting();
    closeIfOpen("main", first);

    // Simulate async startup fullscreen where setFullScreen(true) does not synchronously flip isFullScreen().
    mockState.asyncFullScreen = true;
    createMainWindow(false);
    const second = mockState.instances[1];
    // Simulate a late resize tick arriving before enter-full-screen settles on launch.
    expect(second.fullscreen).toBe(false);
    second.bounds = { x: 0, y: 0, width: 1920, height: 1080 };
    second.emit("resize");
    vi.advanceTimersByTime(WINDOW_STATE_SAVE_DELAY_MS);
    expect(JSON.parse(fs.readFileSync(getWindowStatePath(mockState.userDataDir), "utf8"))).toEqual({
      x: 40,
      y: 50,
      width: 1120,
      height: 700,
      isMaximized: false,
      isFullScreen: true,
    });

    second.fullscreen = true;
    second.emit("enter-full-screen");
    vi.advanceTimersByTime(WINDOW_STATE_SAVE_DELAY_MS);

    expect(JSON.parse(fs.readFileSync(getWindowStatePath(mockState.userDataDir), "utf8"))).toEqual({
      x: 40,
      y: 50,
      width: 1120,
      height: 700,
      isMaximized: false,
      isFullScreen: true,
    });

    closeIfOpen("main", second);
  });

  it("captures immediate normal resize via macOS Window -> Zoom menu action and resized completion even with stale getNormalBounds", () => {
    vi.useFakeTimers();
    mockState.displays = [
      {
        id: 1,
        bounds: { x: 0, y: 0, width: 2560, height: 1440 },
        workArea: { x: 0, y: 30, width: 2540, height: 1309 },
      },
    ];

    const firstWin = createMainWindow(false);
    const first = mockState.instances[0];
    first.bounds = { x: 200, y: 100, width: 1440, height: 960 };
    first.normalBounds = { ...first.bounds };
    first.emit("move");
    first.emit("resize");
    vi.advanceTimersByTime(WINDOW_STATE_SAVE_DELAY_MS);

    // Move/resize to new normal bounds BEFORE debounce, leaving native normalBounds STALE at 1440x960.
    first.bounds = { x: 0, y: 30, width: 1281, height: 660 };
    first.emit("move");
    first.emit("resize");

    // Simulate Window -> Zoom triggering multi-frame async resize animation while isMaximized is still false
    // and normalBounds remains stale until maximize runs.
    first.maximize.mockImplementationOnce(() => {
      first.maximized = false;
      first.bounds = { x: 0, y: 30, width: 1600, height: 820 };
      first.emit("resize");
      vi.advanceTimersByTime(16);
      first.bounds = { x: 0, y: 30, width: 2100, height: 1080 };
      first.emit("resize");
      vi.advanceTimersByTime(16);
      first.bounds = { x: 0, y: 30, width: 2540, height: 1309 };
      first.emit("resize");
      first.maximized = true;
      first.emit("maximize");
    });

    toggleWindowZoom(firstWin);
    markQuitting();

    expect(JSON.parse(fs.readFileSync(getWindowStatePath(mockState.userDataDir), "utf8"))).toEqual({
      x: 0,
      y: 30,
      width: 1281,
      height: 660,
      isMaximized: true,
      isFullScreen: false,
    });
    closeIfOpen("main", first);

    const secondWin = createMainWindow(false);
    const second = mockState.instances[1];
    expect(second.options.x).toBe(0);
    expect(second.options.y).toBe(30);
    expect(second.options.width).toBe(1281);
    expect(second.options.height).toBe(660);
    expect(second.maximize).toHaveBeenCalledTimes(1);

    // Clicking Window -> Zoom again unmaximizes cleanly to restored normal bounds.
    second.unmaximize.mockImplementationOnce(() => {
      second.maximized = false;
      second.bounds = { x: 0, y: 30, width: 1281, height: 660 };
      second.emit("resize");
      second.emit("unmaximize");
    });
    toggleWindowZoom(secondWin);
    markQuitting();
    expect(JSON.parse(fs.readFileSync(getWindowStatePath(mockState.userDataDir), "utf8"))).toEqual({
      x: 0,
      y: 30,
      width: 1281,
      height: 660,
      isMaximized: false,
      isFullScreen: false,
    });

    // Interactive user drag-resize completion ("resized" while !maximized) also commits normal bounds
    // immediately before any non-menu zoom animation even when getNormalBounds stays stale.
    second.bounds = { x: 40, y: 50, width: 1120, height: 700 };
    second.emit("move");
    second.emit("resize");
    second.emit("resized");

    second.maximized = false;
    second.bounds = { x: 0, y: 30, width: 1600, height: 820 };
    second.emit("resize");
    vi.advanceTimersByTime(16);
    second.bounds = { x: 0, y: 30, width: 2100, height: 1080 };
    second.emit("resize");
    vi.advanceTimersByTime(16);
    second.bounds = { x: 0, y: 30, width: 2540, height: 1309 };
    second.emit("resize");
    second.maximized = true;
    second.emit("maximize");
    markQuitting();

    expect(JSON.parse(fs.readFileSync(getWindowStatePath(mockState.userDataDir), "utf8"))).toEqual({
      x: 40,
      y: 50,
      width: 1120,
      height: 700,
      isMaximized: true,
      isFullScreen: false,
    });

    // toggleWindowZoom ignores fullscreen windows.
    second.fullscreen = true;
    second.unmaximize.mockClear();
    second.maximize.mockClear();
    toggleWindowZoom(secondWin);
    expect(second.unmaximize).not.toHaveBeenCalled();
    expect(second.maximize).not.toHaveBeenCalled();

    closeIfOpen("main", second);
  });

  it("preserves immediate normal move/resize via restored bounds across multi-frame Zoom before debounce", () => {
    vi.useFakeTimers();
    mockState.displays = [
      {
        id: 1,
        bounds: { x: 0, y: 0, width: 2560, height: 1440 },
        workArea: { x: 0, y: 30, width: 2540, height: 1309 },
      },
    ];

    createMainWindow(false);
    const first = mockState.instances[0];
    first.bounds = { x: 200, y: 100, width: 1440, height: 960 };
    first.normalBounds = { ...first.bounds };
    first.emit("move");
    first.emit("resize");
    vi.advanceTimersByTime(WINDOW_STATE_SAVE_DELAY_MS);

    // Move/resize to new normal bounds (updating native getNormalBounds), then immediately
    // emit multi-frame Zoom animation ticks while isMaximized() is still false before debounce.
    first.bounds = { x: 0, y: 30, width: 1281, height: 660 };
    first.normalBounds = { ...first.bounds };
    first.emit("move");
    first.emit("resize");
    first.maximized = false;
    first.bounds = { x: 0, y: 30, width: 1600, height: 820 };
    first.emit("resize");
    vi.advanceTimersByTime(16);
    first.bounds = { x: 0, y: 30, width: 2100, height: 1080 };
    first.emit("resize");
    vi.advanceTimersByTime(16);
    first.bounds = { x: 0, y: 30, width: 2540, height: 1309 };
    first.emit("resize");
    first.maximized = true;
    first.emit("maximize");
    markQuitting();

    expect(JSON.parse(fs.readFileSync(getWindowStatePath(mockState.userDataDir), "utf8"))).toEqual({
      x: 0,
      y: 30,
      width: 1281,
      height: 660,
      isMaximized: true,
      isFullScreen: false,
    });
    closeIfOpen("main", first);

    createMainWindow(false);
    const second = mockState.instances[1];
    expect(second.options.x).toBe(0);
    expect(second.options.y).toBe(30);
    expect(second.options.width).toBe(1281);
    expect(second.options.height).toBe(660);
    expect(second.maximize).toHaveBeenCalledTimes(1);

    second.maximized = false;
    second.bounds = { x: 0, y: 30, width: 1281, height: 660 };
    second.normalBounds = { ...second.bounds };
    second.emit("resize");
    second.emit("unmaximize");
    markQuitting();
    expect(JSON.parse(fs.readFileSync(getWindowStatePath(mockState.userDataDir), "utf8"))).toEqual({
      x: 0,
      y: 30,
      width: 1281,
      height: 660,
      isMaximized: false,
      isFullScreen: false,
    });

    closeIfOpen("main", second);
  });

  it("preserves settled normal bounds across 2-frame and 3-frame Zoom animations even when getNormalBounds is stale", () => {
    vi.useFakeTimers();
    mockState.displays = [
      {
        id: 1,
        bounds: { x: 0, y: 0, width: 2560, height: 1440 },
        workArea: { x: 0, y: 30, width: 2540, height: 1309 },
      },
    ];

    createMainWindow(false);
    const first = mockState.instances[0];
    // Simulate macOS NativeWindowMac leaving normalBounds stale at an earlier minimize/initial frame.
    first.bounds = { x: 0, y: 30, width: 1281, height: 660 };
    first.emit("move");
    first.emit("resize");
    vi.advanceTimersByTime(WINDOW_STATE_SAVE_DELAY_MS);

    // 2-frame Zoom animation (intermediate 1600x820 -> zoomed 2540x1309 at 16ms gap) with stale normalBounds.
    first.maximized = false;
    first.bounds = { x: 0, y: 30, width: 1600, height: 820 };
    first.emit("resize");
    vi.advanceTimersByTime(16);
    first.bounds = { x: 0, y: 30, width: 2540, height: 1309 };
    first.emit("resize");
    first.maximized = true;
    first.emit("maximize");
    markQuitting();

    expect(JSON.parse(fs.readFileSync(getWindowStatePath(mockState.userDataDir), "utf8"))).toEqual({
      x: 0,
      y: 30,
      width: 1281,
      height: 660,
      isMaximized: true,
      isFullScreen: false,
    });

    // Also verify minimize updates stale native normal tracking without clobbering newer settled normal bounds.
    first.maximized = false;
    first.emit("unmaximize");
    first.bounds = { x: 0, y: 30, width: 1281, height: 660 };
    first.normalBounds = { ...first.bounds };
    first.minimized = true;
    first.emit("minimize");
    first.minimized = false;
    first.emit("restore");

    // Settled resize to new normal bounds (while macOS original_frame_ stays stale at 1281x660).
    first.bounds = { x: 20, y: 40, width: 1000, height: 700 };
    first.emit("move");
    first.emit("resize");
    vi.advanceTimersByTime(WINDOW_STATE_SAVE_DELAY_MS);

    // 3-frame Zoom animation with stale normalBounds still at 1281x660.
    first.bounds = { x: 0, y: 30, width: 1600, height: 820 };
    first.emit("resize");
    vi.advanceTimersByTime(16);
    first.bounds = { x: 0, y: 30, width: 2100, height: 1080 };
    first.emit("resize");
    vi.advanceTimersByTime(16);
    first.bounds = { x: 0, y: 30, width: 2540, height: 1309 };
    first.emit("resize");
    first.maximized = true;
    first.emit("maximize");
    markQuitting();

    expect(JSON.parse(fs.readFileSync(getWindowStatePath(mockState.userDataDir), "utf8"))).toEqual({
      x: 20,
      y: 40,
      width: 1000,
      height: 700,
      isMaximized: true,
      isFullScreen: false,
    });

    closeIfOpen("main", first);
  });

  it("preserves immediate normal move/resize before maximize and quit before debounce", () => {
    vi.useFakeTimers();
    mockState.displays = [
      {
        id: 1,
        bounds: { x: 0, y: 0, width: 2560, height: 1440 },
        workArea: { x: 0, y: 30, width: 2540, height: 1309 },
      },
    ];

    createMainWindow(false);
    const first = mockState.instances[0];

    // Move and resize to new normal bounds, then maximize and quit BEFORE debounce elapses.
    first.bounds = { x: 0, y: 30, width: 1281, height: 660 };
    first.emit("move");
    first.emit("resize");
    first.maximize();
    first.emit("maximize");
    markQuitting();

    expect(JSON.parse(fs.readFileSync(getWindowStatePath(mockState.userDataDir), "utf8"))).toEqual({
      x: 0,
      y: 30,
      width: 1281,
      height: 660,
      isMaximized: true,
      isFullScreen: false,
    });
    closeIfOpen("main", first);

    createMainWindow(false);
    const second = mockState.instances[1];
    expect(second.options.x).toBe(0);
    expect(second.options.y).toBe(30);
    expect(second.options.width).toBe(1281);
    expect(second.options.height).toBe(660);
    expect(second.maximize).toHaveBeenCalledTimes(1);

    second.maximized = false;
    second.bounds = { x: 0, y: 30, width: 1281, height: 660 };
    second.emit("resize");
    second.emit("unmaximize");
    markQuitting();
    expect(JSON.parse(fs.readFileSync(getWindowStatePath(mockState.userDataDir), "utf8"))).toEqual({
      x: 0,
      y: 30,
      width: 1281,
      height: 660,
      isMaximized: false,
      isFullScreen: false,
    });

    closeIfOpen("main", second);
  });

  it("preserves immediate normal move/resize through minimize and quit before debounce", () => {
    vi.useFakeTimers();

    createMainWindow(false);
    const first = mockState.instances[0];
    first.bounds = { x: 120, y: 90, width: 1080, height: 700 };
    first.emit("move");
    first.emit("resize");
    first.minimized = true;
    first.emit("minimize");
    markQuitting();

    expect(JSON.parse(fs.readFileSync(getWindowStatePath(mockState.userDataDir), "utf8"))).toEqual({
      x: 120,
      y: 90,
      width: 1080,
      height: 700,
      isMaximized: false,
      isFullScreen: false,
    });

    closeIfOpen("main", first);
  });

  it("clamps first-launch main window dimensions to screen.getPrimaryDisplay().workArea", () => {
    mockState.displays = [
      {
        id: 1,
        bounds: { x: -2560, y: 0, width: 2560, height: 1440 },
        workArea: { x: -2560, y: 25, width: 2560, height: 1415 },
      },
      {
        id: 2,
        bounds: { x: 0, y: 0, width: 1512, height: 982 },
        workArea: { x: 0, y: 37, width: 1512, height: 945 },
      },
    ];
    mockState.primaryDisplayIndex = 1;

    createMainWindow(false);
    const win = mockState.instances[0];
    expect(win.options.width).toBe(1440);
    expect(win.options.height).toBe(945);
    expect(win.options.minWidth).toBe(700);
    expect(win.options.minHeight).toBe(500);

    closeIfOpen("main", win);
  });

  it("caps native BrowserWindow minimum dimensions to the clamped work area for sub-minimum displays", () => {
    mockState.displays = [
      {
        id: 1,
        bounds: { x: 0, y: 0, width: 1024, height: 500 },
        workArea: { x: 0, y: 20, width: 1024, height: 480 },
      },
    ];
    mockState.primaryDisplayIndex = 0;

    createMainWindow(false);
    const win = mockState.instances[0];
    expect(win.options.width).toBe(1024);
    expect(win.options.height).toBe(480);
    expect(win.options.minWidth).toBe(700);
    expect(win.options.minHeight).toBe(480);

    closeIfOpen("main", win);
  });

  it("configures win32 windows with hidden titleBarStyle, no overlay/menu, maximized events, and menu-only shortcuts", () => {
    const originalPlatform = process.platform;
    const withPlatform = (platform: NodeJS.Platform, fn: () => void) => {
      Object.defineProperty(process, "platform", { value: platform, configurable: true });
      try {
        fn();
      } finally {
        Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
      }
    };

    withPlatform("darwin", () => {
      createMainWindow(false);
      const macRec = mockState.instances[0];
      expect(macRec.options.titleBarStyle).toBe("hiddenInset");
      expect(macRec.options.trafficLightPosition).toEqual({ x: 28, y: 29 });
      expect(macRec.removeMenu).not.toHaveBeenCalled();

      const preventDefault = vi.fn();
      macRec.webContents.emit(
        "before-input-event",
        { preventDefault },
        { type: "keyDown", key: "F11", control: false, shift: false, alt: false, meta: false, isAutoRepeat: false },
      );
      expect(macRec.setFullScreen).not.toHaveBeenCalled();
      expect(preventDefault).not.toHaveBeenCalled();
      closeIfOpen("main", macRec);
    });

    withPlatform("win32", () => {
      createMainWindow(false);
      createReaderWindow(
        {
          label: "reader-win",
          url: "/reader/win",
          title: "Win Book",
          width: 1200,
          height: 800,
          minWidth: 700,
          minHeight: 500,
        },
        false,
      );

      const mainRec = mockState.instances[1];
      const readerRec = mockState.instances[2];
      for (const rec of [mainRec, readerRec]) {
        expect(rec.options.titleBarStyle).toBe("hidden");
        expect(rec.options.titleBarOverlay).toBeUndefined();
        expect(rec.options.trafficLightPosition).toBeUndefined();
        expect(rec.removeMenu).toHaveBeenCalledTimes(1);
      }

      // Maximized/restorable-state events push to the window's renderer for both main and reader windows,
      // including entering and leaving F11 full screen from a restored window.
      readerRec.maximized = true;
      readerRec.emit("maximize");
      expect(readerRec.webContents.send).toHaveBeenLastCalledWith("quill:window-maximized", true);
      readerRec.maximized = false;
      readerRec.emit("unmaximize");
      expect(readerRec.webContents.send).toHaveBeenLastCalledWith("quill:window-maximized", false);

      readerRec.fullscreen = true;
      readerRec.emit("enter-full-screen");
      expect(readerRec.webContents.send).toHaveBeenLastCalledWith("quill:window-maximized", true);
      readerRec.fullscreen = false;
      readerRec.emit("leave-full-screen");
      expect(readerRec.webContents.send).toHaveBeenLastCalledWith("quill:window-maximized", false);

      readerRec.maximized = true;
      readerRec.emit("leave-full-screen");
      expect(readerRec.webContents.send).toHaveBeenLastCalledWith("quill:window-maximized", true);

      // Menu-only shortcuts in dev: F11, Ctrl+W, Ctrl+M, Ctrl+R, Ctrl+Shift+R, Ctrl+Shift+I.
      const baseInput = {
        type: "keyDown",
        control: false,
        shift: false,
        alt: false,
        meta: false,
        isAutoRepeat: false,
      };
      const f11Prevent = vi.fn();
      mainRec.webContents.emit("before-input-event", { preventDefault: f11Prevent }, { ...baseInput, key: "F11" });
      expect(mainRec.setFullScreen).toHaveBeenCalledWith(true);
      expect(f11Prevent).toHaveBeenCalledTimes(1);

      mainRec.setFullScreen.mockClear();
      mainRec.webContents.emit("before-input-event", { preventDefault: f11Prevent }, { ...baseInput, key: "F11", isAutoRepeat: true });
      expect(mainRec.setFullScreen).not.toHaveBeenCalled();

      mainRec.webContents.emit("before-input-event", { preventDefault: f11Prevent }, { ...baseInput, key: "F11" });
      expect(mainRec.setFullScreen).toHaveBeenCalledWith(false);

      const wmPrevent = vi.fn();
      readerRec.webContents.emit("before-input-event", { preventDefault: wmPrevent }, { ...baseInput, key: "m", control: true });
      expect(readerRec.minimize).toHaveBeenCalledTimes(1);
      expect(wmPrevent).toHaveBeenCalledTimes(1);

      readerRec.webContents.emit("before-input-event", { preventDefault: wmPrevent }, { ...baseInput, key: "w", control: true });
      expect(readerRec.close).toHaveBeenCalledTimes(1);
      expect(wmPrevent).toHaveBeenCalledTimes(2);

      // Modified variants Ctrl+Shift+W / Ctrl+Shift+M do not trigger close/minimize.
      readerRec.webContents.emit("before-input-event", { preventDefault: wmPrevent }, { ...baseInput, key: "W", control: true, shift: true });
      readerRec.webContents.emit("before-input-event", { preventDefault: wmPrevent }, { ...baseInput, key: "M", control: true, shift: true });
      expect(readerRec.close).toHaveBeenCalledTimes(1);
      expect(readerRec.minimize).toHaveBeenCalledTimes(1);
      expect(wmPrevent).toHaveBeenCalledTimes(2);

      const reloadPrevent = vi.fn();
      mainRec.webContents.emit("before-input-event", { preventDefault: reloadPrevent }, { ...baseInput, key: "r", control: true });
      expect(mainRec.webContents.reload).toHaveBeenCalledTimes(1);
      expect(reloadPrevent).toHaveBeenCalledTimes(1);

      mainRec.webContents.emit("before-input-event", { preventDefault: reloadPrevent }, { ...baseInput, key: "R", control: true, shift: true });
      expect(mainRec.webContents.reloadIgnoringCache).toHaveBeenCalledTimes(1);

      const devToolsPrevent = vi.fn();
      readerRec.webContents.emit("before-input-event", { preventDefault: devToolsPrevent }, { ...baseInput, key: "I", control: true, shift: true });
      expect(readerRec.webContents.toggleDevTools).toHaveBeenCalledTimes(1);
      expect(devToolsPrevent).toHaveBeenCalledTimes(1);

      // Packaged builds keep F11, Ctrl+W, and Ctrl+M, but disable Reload and Toggle DevTools.
      mockState.isPackaged = true;
      mainRec.webContents.reload.mockClear();
      mainRec.webContents.reloadIgnoringCache.mockClear();
      readerRec.webContents.toggleDevTools.mockClear();
      mainRec.setFullScreen.mockClear();
      mainRec.minimize.mockClear();
      mainRec.close.mockClear();

      const prodPrevent = vi.fn();
      mainRec.webContents.emit("before-input-event", { preventDefault: prodPrevent }, { ...baseInput, key: "r", control: true });
      mainRec.webContents.emit("before-input-event", { preventDefault: prodPrevent }, { ...baseInput, key: "R", control: true, shift: true });
      readerRec.webContents.emit("before-input-event", { preventDefault: prodPrevent }, { ...baseInput, key: "I", control: true, shift: true });
      expect(mainRec.webContents.reload).not.toHaveBeenCalled();
      expect(mainRec.webContents.reloadIgnoringCache).not.toHaveBeenCalled();
      expect(readerRec.webContents.toggleDevTools).not.toHaveBeenCalled();
      expect(prodPrevent).not.toHaveBeenCalled();

      mainRec.webContents.emit("before-input-event", { preventDefault: prodPrevent }, { ...baseInput, key: "F11" });
      expect(mainRec.setFullScreen).toHaveBeenCalledWith(true);
      mainRec.webContents.emit("before-input-event", { preventDefault: prodPrevent }, { ...baseInput, key: "m", control: true });
      expect(mainRec.minimize).toHaveBeenCalledTimes(1);
      mainRec.webContents.emit("before-input-event", { preventDefault: prodPrevent }, { ...baseInput, key: "w", control: true });
      expect(mainRec.close).toHaveBeenCalledTimes(1);
      expect(prodPrevent).toHaveBeenCalledTimes(3);

      closeIfOpen("reader-win", readerRec);
      closeIfOpen("main", mainRec);
    });
  });
});
