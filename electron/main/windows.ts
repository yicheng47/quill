import path from "node:path";
import { BrowserWindow, nativeTheme, screen, shell } from "electron";
import { isAllowedNavigation, isSafeHttpUrl, resolveWindowUrl } from "./urlSecurity";

export type ReaderPageTheme = "original" | "paper" | "quiet" | "dark";

export interface ReaderWindowParams {
  label: string;
  url: string;
  title: string;
  width: number;
  height: number;
  minWidth: number;
  minHeight: number;
  pageTheme?: string;
}

const MAIN_DAWN_BG = "#EEEBF8";

export const READER_SHELL_BG: Record<ReaderPageTheme, string> = {
  original: "#EEEBF8",
  paper: "#F0E7D4",
  quiet: "#D2D2D8",
  dark: "#12111A",
};

export const READER_CASCADE_OFFSET = 32;

export interface WindowRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ComputeReaderPlacementInput {
  windowSize: { width: number; height: number };
  mainWindow: { bounds: WindowRect; workArea: WindowRect } | null;
  openReaderCount: number;
  lastFocusedReader: { bounds: WindowRect; workArea: WindowRect } | null;
  cursorWorkArea: WindowRect;
  cascadeStep?: number;
}

const windowsByLabel = new Map<string, BrowserWindow>();
const labelByWebContentsId = new Map<number, string>();
const titlebarZoomByLabel = new Map<string, number>();
const readerFocusOrder: string[] = [];
const readyLabels = new Set<string>();
const pendingReadyCallbacks = new Map<string, Array<() => void>>();
let defaultWindowIconPath: string | undefined;
let quitting = false;

function recordReaderFocus(label: string): void {
  if (label === "main") return;
  const idx = readerFocusOrder.indexOf(label);
  if (idx !== -1) readerFocusOrder.splice(idx, 1);
  readerFocusOrder.unshift(label);
}

function removeReaderFocus(label: string): void {
  const idx = readerFocusOrder.indexOf(label);
  if (idx !== -1) readerFocusOrder.splice(idx, 1);
}

export function readerBackgroundColorForTheme(theme?: string | null): string {
  if (theme === "paper" || theme === "quiet" || theme === "dark") {
    return READER_SHELL_BG[theme];
  }
  return READER_SHELL_BG.original;
}

export function setWindowBackgroundColor(label: string, color: string): void {
  const win = getWindow(label);
  if (win) {
    win.setBackgroundColor(color);
  }
}

export function clampPositionToWorkArea(
  x: number,
  y: number,
  windowSize: { width: number; height: number },
  workArea: WindowRect,
): { x: number; y: number } {
  const maxX = workArea.x + Math.max(0, workArea.width - windowSize.width);
  const maxY = workArea.y + Math.max(0, workArea.height - windowSize.height);
  return {
    x: Math.round(Math.min(Math.max(x, workArea.x), maxX)),
    y: Math.round(Math.min(Math.max(y, workArea.y), maxY)),
  };
}

export function computeReaderWindowPosition(
  input: ComputeReaderPlacementInput,
): { x: number; y: number } {
  const step = input.cascadeStep ?? READER_CASCADE_OFFSET;

  if (input.mainWindow) {
    const { bounds: mainBounds, workArea } = input.mainWindow;
    const clampedBase = clampPositionToWorkArea(
      mainBounds.x,
      mainBounds.y,
      input.windowSize,
      workArea,
    );
    const fitX = Math.floor(
      Math.max(0, workArea.x + workArea.width - input.windowSize.width - clampedBase.x) / step,
    );
    const fitY = Math.floor(
      Math.max(0, workArea.y + workArea.height - input.windowSize.height - clampedBase.y) / step,
    );
    const fitSteps = fitX >= 1 && fitY >= 1 ? Math.min(fitX, fitY) : Math.max(fitX, fitY);
    const maxSteps = Math.max(1, fitSteps);
    const offsetIndex = (Math.max(0, input.openReaderCount) % maxSteps) + 1;
    return clampPositionToWorkArea(
      clampedBase.x + offsetIndex * step,
      clampedBase.y + offsetIndex * step,
      input.windowSize,
      workArea,
    );
  }

  if (input.lastFocusedReader) {
    const { bounds: readerBounds, workArea } = input.lastFocusedReader;
    const nextX = readerBounds.x + step;
    const nextY = readerBounds.y + step;
    const overflowsRight = nextX + input.windowSize.width > workArea.x + workArea.width;
    const overflowsBottom = nextY + input.windowSize.height > workArea.y + workArea.height;
    if (overflowsRight || overflowsBottom) {
      return clampPositionToWorkArea(
        workArea.x + step,
        workArea.y + step,
        input.windowSize,
        workArea,
      );
    }
    return clampPositionToWorkArea(nextX, nextY, input.windowSize, workArea);
  }

  return clampPositionToWorkArea(
    input.cursorWorkArea.x + (input.cursorWorkArea.width - input.windowSize.width) / 2,
    input.cursorWorkArea.y + (input.cursorWorkArea.height - input.windowSize.height) / 2,
    input.windowSize,
    input.cursorWorkArea,
  );
}

export function setDefaultWindowIcon(iconPath: string | undefined): void {
  defaultWindowIconPath = iconPath;
}

export function markQuitting(): void {
  quitting = true;
}

export function isQuitting(): boolean {
  return quitting;
}

export function resolveInitialDark(themeSetting: string | null | undefined): boolean {
  if (themeSetting === "dark") return true;
  if (themeSetting === "light") return false;
  return nativeTheme.shouldUseDarkColors;
}

export function labelForWebContents(id: number): string | undefined {
  return labelByWebContentsId.get(id);
}

export function getWindow(label: string): BrowserWindow | undefined {
  const win = windowsByLabel.get(label);
  return win && !win.isDestroyed() ? win : undefined;
}

export function getAllManagedWindows(): BrowserWindow[] {
  return Array.from(windowsByLabel.values()).filter((w) => !w.isDestroyed());
}

export function getOpenReaderWindowCount(): number {
  let count = 0;
  for (const [label, win] of windowsByLabel) {
    if (label.startsWith("reader-") && !win.isDestroyed()) {
      count += 1;
    }
  }
  return count;
}

export function broadcastEvent(event: string, payload: unknown): void {
  for (const win of getAllManagedWindows()) {
    win.webContents.send("quill:event", event, payload);
  }
}

export function sendEventToWindow(label: string, event: string, payload: unknown): void {
  const win = getWindow(label);
  if (win) {
    win.webContents.send("quill:window-event", event, payload);
  }
}

export function scaledTitlebarHeight(
  label: string,
  zoom: number,
  fullscreen: boolean,
): number | null {
  if (fullscreen) return null;
  const baseHeight = label === "main" ? 71 : 64;
  return baseHeight * zoom;
}

export function trafficLightPositionFor(
  label: string,
  zoom: number,
  fullscreen: boolean,
): { x: number; y: number } | null {
  const height = scaledTitlebarHeight(label, zoom, fullscreen);
  if (height === null) return null;
  const buttonHeight = 14;
  return {
    x: Math.round(28 * zoom),
    y: Math.max(4, Math.round((height - buttonHeight) / 2)),
  };
}

export function getTitlebarZoomForWindow(label: string): number | undefined {
  return titlebarZoomByLabel.get(label);
}

export function setTitlebarZoomForWindow(
  label: string,
  zoom: number,
  platform: NodeJS.Platform = process.platform,
): void {
  if (platform !== "darwin") return;
  titlebarZoomByLabel.set(label, zoom);
  const win = getWindow(label);
  if (!win) return;
  const pos = trafficLightPositionFor(label, zoom, win.isFullScreen());
  if (pos) {
    win.setWindowButtonPosition(pos);
  }
}

export function focusManagedWindow(label: string): boolean {
  const win = getWindow(label);
  if (!win) return false;
  if (win.isMinimized()) win.restore();
  if (!win.isVisible()) win.show();
  win.focus();
  recordReaderFocus(label);
  return true;
}

export function appReadyForWindow(label: string): void {
  const win = getWindow(label);
  if (!win) return;
  if (!win.isVisible()) win.show();
  if (label === "main") {
    win.focus();
  }
  readyLabels.add(label);
  const pending = pendingReadyCallbacks.get(label);
  if (pending) {
    pendingReadyCallbacks.delete(label);
    for (const cb of pending) {
      cb();
    }
  }
}

export function whenWindowReady(label: string, callback: () => void): void {
  if (!getWindow(label)) return;
  if (readyLabels.has(label)) {
    callback();
    return;
  }
  const queue = pendingReadyCallbacks.get(label) ?? [];
  queue.push(callback);
  pendingReadyCallbacks.set(label, queue);
}

function createWindow(options: {
  label: string;
  routePath: string;
  title: string;
  width: number;
  height: number;
  x?: number;
  y?: number;
  minWidth?: number;
  minHeight?: number;
  initialDark: boolean;
  readerPageTheme?: string;
}): BrowserWindow {
  const targetUrl = resolveWindowUrl(options.routePath, process.env.ELECTRON_RENDERER_URL);
  const isMac = process.platform === "darwin";
  const isMain = options.label === "main";
  const trafficLightPosition = isMac ? trafficLightPositionFor(options.label, 1, false) : null;

  const win = new BrowserWindow({
    title: options.title,
    width: options.width,
    height: options.height,
    ...(options.x !== undefined && options.y !== undefined ? { x: options.x, y: options.y } : {}),
    minWidth: options.minWidth,
    minHeight: options.minHeight,
    show: false,
    backgroundColor: isMain
      ? MAIN_DAWN_BG
      : readerBackgroundColorForTheme(options.readerPageTheme),
    ...(defaultWindowIconPath ? { icon: defaultWindowIconPath } : {}),
    ...(isMac && trafficLightPosition
      ? {
          titleBarStyle: "hiddenInset" as const,
          trafficLightPosition,
        }
      : {}),
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.cjs"),
      additionalArguments: [
        `--quill-window-label=${options.label}`,
        ...(!isMain
          ? [`--quill-reader-theme=${options.readerPageTheme ?? "original"}`]
          : []),
      ],
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  windowsByLabel.set(options.label, win);
  recordReaderFocus(options.label);
  const wcId = win.webContents.id;
  labelByWebContentsId.set(wcId, options.label);
  if (options.label.startsWith("reader-")) {
    sendEventToWindow("main", "reader-windows-changed", getOpenReaderWindowCount());
  }

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isSafeHttpUrl(url)) {
      void shell.openExternal(url);
    }
    return { action: "deny" };
  });

  win.webContents.on("will-navigate", (event, url) => {
    if (!isAllowedNavigation(url, process.env.ELECTRON_RENDERER_URL)) {
      event.preventDefault();
      if (isSafeHttpUrl(url)) {
        void shell.openExternal(url);
      }
    }
  });

  win.on("focus", () => {
    recordReaderFocus(options.label);
  });

  win.on("resize", () => {
    if (win.isDestroyed()) return;
    const [width, height] = win.getSize();
    win.webContents.send("quill:window-resized", { width, height });
  });

  if (isMac) {
    win.on("leave-full-screen", () => {
      const saved = titlebarZoomByLabel.get(options.label);
      if (saved !== undefined) {
        setTitlebarZoomForWindow(options.label, saved, process.platform);
      }
    });
  }

  if (isMac && isMain) {
    win.on("close", (event) => {
      if (!quitting) {
        event.preventDefault();
        win.hide();
      }
    });
  }

  win.on("closed", () => {
    windowsByLabel.delete(options.label);
    removeReaderFocus(options.label);
    labelByWebContentsId.delete(wcId);
    titlebarZoomByLabel.delete(options.label);
    readyLabels.delete(options.label);
    pendingReadyCallbacks.delete(options.label);
    if (options.label.startsWith("reader-")) {
      sendEventToWindow("main", "reader-windows-changed", getOpenReaderWindowCount());
    }
    if (!isMac && isMain) {
      for (const other of getAllManagedWindows()) {
        other.close();
      }
    }
  });

  void win.loadURL(targetUrl);
  return win;
}

export function createMainWindow(initialDark: boolean): BrowserWindow {
  const existing = getWindow("main");
  if (existing) {
    focusManagedWindow("main");
    return existing;
  }
  return createWindow({
    label: "main",
    routePath: "/",
    title: "Quill",
    width: 1440,
    height: 960,
    minWidth: 700,
    minHeight: 500,
    initialDark,
  });
}

export function createReaderWindow(
  params: ReaderWindowParams,
  initialDark: boolean,
): BrowserWindow {
  const existing = getWindow(params.label);
  if (existing) {
    focusManagedWindow(params.label);
    return existing;
  }

  const mainWin = getWindow("main");
  const mainWindow =
    mainWin && mainWin.isVisible() && !mainWin.isMinimized()
      ? (() => {
          const bounds = mainWin.getBounds();
          return { bounds, workArea: screen.getDisplayMatching(bounds).workArea };
        })()
      : null;

  const openReaderCount = Array.from(windowsByLabel.entries()).filter(
    ([label, win]) => label !== "main" && !win.isDestroyed(),
  ).length;

  let lastFocusedReader: { bounds: WindowRect; workArea: WindowRect } | null = null;
  if (!mainWindow) {
    for (const label of readerFocusOrder) {
      const win = getWindow(label);
      if (win) {
        const bounds = win.getBounds();
        lastFocusedReader = { bounds, workArea: screen.getDisplayMatching(bounds).workArea };
        break;
      }
    }
  }

  const cursorWorkArea = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  const { x, y } = computeReaderWindowPosition({
    windowSize: { width: params.width, height: params.height },
    mainWindow,
    openReaderCount,
    lastFocusedReader,
    cursorWorkArea,
  });

  return createWindow({
    label: params.label,
    routePath: params.url,
    title: params.title,
    width: params.width,
    height: params.height,
    x,
    y,
    minWidth: params.minWidth,
    minHeight: params.minHeight,
    initialDark,
    readerPageTheme: params.pageTheme,
  });
}
