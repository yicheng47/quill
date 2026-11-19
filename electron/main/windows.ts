import path from "node:path";
import { app, BrowserWindow, nativeTheme, screen, shell, type BaseWindow } from "electron";
import { isAllowedNavigation, isSafeHttpUrl, resolveWindowUrl } from "./urlSecurity";
import {
  loadWindowState,
  MAIN_MIN_HEIGHT,
  MAIN_MIN_WIDTH,
  resolveMainWindowState,
  saveWindowState,
  type SavedWindowState,
} from "./windowState";

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

export interface InitialAppearance {
  /** Native backing color (uses OS appearance if DB lookup timed out or failed). */
  dark: boolean;
  /** Preload seed forwarded to renderer only when DB lookup succeeded. */
  preloadDark: boolean | null;
}

export const MAIN_DAWN_BG = "#EEEBF8";
export const MAIN_NOCTURNE_BG = "#12111A";

export function mainWindowBackgroundColor(isDark: boolean): string {
  return isDark ? MAIN_NOCTURNE_BG : MAIN_DAWN_BG;
}

export const READER_SHELL_BG: Record<ReaderPageTheme, string> = {
  original: "#EEEBF8",
  paper: "#F0E7D4",
  quiet: "#D2D2D8",
  dark: "#12111A",
};

export const READER_CASCADE_OFFSET = 32;
export const WINDOW_STATE_SAVE_DELAY_MS = 250;

function boundsKey(rect: WindowRect): string {
  return `${rect.x},${rect.y},${rect.width},${rect.height}`;
}

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
let mainStateFlush: (() => void) | null = null;
const zoomPrepareHooks = new WeakMap<BaseWindow, () => void>();

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
  mainStateFlush?.();
}

export function toggleWindowZoom(win: BaseWindow | undefined): void {
  if (!win || win.isDestroyed() || win.isFullScreen()) return;
  if (win.isMaximized()) {
    win.unmaximize();
    return;
  }
  zoomPrepareHooks.get(win)?.();
  win.maximize();
}

export function isWindowRestorable(
  win: Pick<BrowserWindow, "isDestroyed" | "isMaximized" | "isFullScreen"> | null | undefined,
): boolean {
  return Boolean(win && !win.isDestroyed() && (win.isMaximized() || win.isFullScreen()));
}

export function toggleWindowMaximizeOrRestore(win: BaseWindow | null | undefined): void {
  if (!win || win.isDestroyed()) return;
  if (win.isFullScreen()) {
    win.setFullScreen(false);
    return;
  }
  toggleWindowZoom(win);
}

export function handleWindowsBeforeInputEvent(
  win: Pick<
    BrowserWindow,
    "isDestroyed" | "isFullScreen" | "setFullScreen" | "minimize" | "close" | "webContents"
  >,
  event: { preventDefault: () => void },
  input: Pick<Electron.Input, "type" | "key" | "control" | "shift" | "alt" | "meta" | "isAutoRepeat">,
  isDev: boolean,
): boolean {
  if (input.type !== "keyDown" || input.isAutoRepeat || win.isDestroyed()) {
    return false;
  }

  const hasModifiers = input.control || input.shift || input.alt || input.meta;
  if (input.key === "F11" && !hasModifiers) {
    event.preventDefault();
    win.setFullScreen(!win.isFullScreen());
    return true;
  }

  if (!input.control || input.alt || input.meta) {
    return false;
  }

  const key = input.key.toLowerCase();
  if (key === "w" && !input.shift) {
    event.preventDefault();
    win.close();
    return true;
  }
  if (key === "m" && !input.shift) {
    event.preventDefault();
    win.minimize();
    return true;
  }

  if (!isDev) {
    return false;
  }

  if (key === "r" && !input.shift) {
    event.preventDefault();
    win.webContents.reload();
    return true;
  }
  if (key === "r" && input.shift) {
    event.preventDefault();
    win.webContents.reloadIgnoringCache();
    return true;
  }
  if (key === "i" && input.shift) {
    event.preventDefault();
    win.webContents.toggleDevTools();
    return true;
  }

  return false;
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
  initialDarkSeed?: boolean | null;
  readerPageTheme?: string;
}): BrowserWindow {
  const targetUrl = resolveWindowUrl(options.routePath, process.env.ELECTRON_RENDERER_URL);
  const isMac = process.platform === "darwin";
  const isWin = process.platform === "win32";
  const isMain = options.label === "main";
  const initialDarkSeed =
    options.initialDarkSeed !== undefined ? options.initialDarkSeed : options.initialDark;
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
      ? mainWindowBackgroundColor(Boolean(options.initialDark))
      : readerBackgroundColorForTheme(options.readerPageTheme),
    ...(defaultWindowIconPath ? { icon: defaultWindowIconPath } : {}),
    ...(isMac && trafficLightPosition
      ? {
          titleBarStyle: "hiddenInset" as const,
          trafficLightPosition,
        }
      : isWin
        ? {
            titleBarStyle: "hidden" as const,
          }
        : {}),
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.cjs"),
      additionalArguments: [
        `--quill-window-label=${options.label}`,
        ...(isMain && initialDarkSeed !== null
          ? [`--quill-initial-dark=${initialDarkSeed ? "1" : "0"}`]
          : !isMain
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

  const sendMaximizedState = () => {
    if (win.isDestroyed()) return;
    win.webContents.send("quill:window-maximized", isWindowRestorable(win));
  };
  win.on("maximize", sendMaximizedState);
  win.on("unmaximize", sendMaximizedState);
  win.on("enter-full-screen", sendMaximizedState);
  win.on("leave-full-screen", sendMaximizedState);

  if (isWin) {
    win.removeMenu();
    win.webContents.on("before-input-event", (event, input) => {
      handleWindowsBeforeInputEvent(win, event, input, !app.isPackaged);
    });
  }

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

export function createMainWindow(
  initialAppearance: boolean | InitialAppearance,
): BrowserWindow {
  const initialDark =
    typeof initialAppearance === "boolean" ? initialAppearance : initialAppearance.dark;
  const initialDarkSeed =
    typeof initialAppearance === "boolean"
      ? initialAppearance
      : initialAppearance.preloadDark;
  const existing = getWindow("main");
  if (existing) {
    focusManagedWindow("main");
    return existing;
  }

  const userDataDir = app.getPath("userData");
  const primaryWorkArea = screen.getPrimaryDisplay().workArea;
  const workAreas = screen.getAllDisplays().map((d) => d.workArea);
  const resolved = resolveMainWindowState(
    loadWindowState(userDataDir),
    workAreas,
    {
      width: MAIN_MIN_WIDTH,
      height: MAIN_MIN_HEIGHT,
    },
    primaryWorkArea,
  );

  const minWidth = resolved.restored
    ? MAIN_MIN_WIDTH
    : Math.min(MAIN_MIN_WIDTH, resolved.width);
  const minHeight = resolved.restored
    ? MAIN_MIN_HEIGHT
    : Math.min(MAIN_MIN_HEIGHT, resolved.height);

  const win = createWindow({
    label: "main",
    routePath: "/",
    title: "Quill",
    width: resolved.width,
    height: resolved.height,
    ...(resolved.x !== undefined && resolved.y !== undefined
      ? { x: resolved.x, y: resolved.y }
      : {}),
    minWidth,
    minHeight,
    initialDark,
    initialDarkSeed,
  });

  let restoring = true;
  let lastNormalBounds: WindowRect = win.getBounds();
  let pendingNormalBounds: WindowRect | null = null;
  let preZoomNormalCommitted = false;
  const knownNormalHistory = new Set<string>([boundsKey(lastNormalBounds)]);
  if (typeof win.getNormalBounds === "function") {
    const initialNative = win.getNormalBounds();
    if (initialNative.width > 0 && initialNative.height > 0) {
      knownNormalHistory.add(boundsKey(initialNative));
    }
  }
  let lastMaximized = resolved.isMaximized;
  let lastFullScreen = resolved.isFullScreen;
  let awaitingInitialMaximize = false;
  let awaitingInitialFullScreen = false;
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  let initialRestoreTimer: ReturnType<typeof setTimeout> | null = null;

  const commitNormalBounds = (bounds: WindowRect) => {
    lastNormalBounds = bounds;
    knownNormalHistory.add(boundsKey(bounds));
  };

  const readUpdatedNativeNormalBounds = (excludeBounds?: WindowRect): WindowRect | null => {
    if (typeof win.getNormalBounds !== "function") return null;
    const candidate = win.getNormalBounds();
    const key = boundsKey(candidate);
    if (
      candidate.width <= 0 ||
      candidate.height <= 0 ||
      (excludeBounds && key === boundsKey(excludeBounds)) ||
      knownNormalHistory.has(key)
    ) {
      return null;
    }
    return candidate;
  };

  const recordNonNormalNativeBounds = () => {
    if (typeof win.getNormalBounds !== "function") return;
    const candidate = win.getNormalBounds();
    if (candidate.width > 0 && candidate.height > 0) {
      knownNormalHistory.add(boundsKey(candidate));
    }
  };

  const promotePendingNormalBounds = (excludeBounds?: WindowRect) => {
    if (preZoomNormalCommitted) {
      pendingNormalBounds = null;
      preZoomNormalCommitted = false;
      return;
    }
    if (
      !lastFullScreen &&
      !lastMaximized &&
      !awaitingInitialMaximize &&
      !awaitingInitialFullScreen
    ) {
      const candidate =
        pendingNormalBounds && (!excludeBounds || boundsKey(pendingNormalBounds) !== boundsKey(excludeBounds))
          ? pendingNormalBounds
          : readUpdatedNativeNormalBounds(excludeBounds);
      if (candidate) {
        commitNormalBounds(candidate);
      }
    }
    pendingNormalBounds = null;
  };

  const captureState = (): SavedWindowState => {
    if (!win.isMinimized()) {
      // macOS NativeWindowMac::IsMaximized returns false while minimized; keep prior non-minimized mode/bounds.
      const wasFullScreen = lastFullScreen;
      const wasMaximized = lastMaximized;
      const currentBounds = win.getBounds();
      const fullScreen = win.isFullScreen();
      const maximized = win.isMaximized();
      if (fullScreen) {
        awaitingInitialFullScreen = false;
      }
      if (maximized) {
        awaitingInitialMaximize = false;
      }
      const nextFullScreen = awaitingInitialFullScreen ? lastFullScreen : fullScreen;
      const nextMaximized = awaitingInitialMaximize ? lastMaximized : maximized;

      if ((!wasFullScreen && nextFullScreen) || (!wasMaximized && nextMaximized)) {
        promotePendingNormalBounds(currentBounds);
        recordNonNormalNativeBounds();
      }

      lastFullScreen = nextFullScreen;
      lastMaximized = nextMaximized;

      if (
        lastFullScreen ||
        lastMaximized ||
        awaitingInitialMaximize ||
        awaitingInitialFullScreen
      ) {
        pendingNormalBounds = null;
      } else {
        // Commit normal bounds only once move/resize settles or during an explicit flush;
        // macOS Window -> Zoom emits resize events at zoomed dimensions before isMaximized() flips true.
        commitNormalBounds(pendingNormalBounds ?? currentBounds);
        pendingNormalBounds = null;
        preZoomNormalCommitted = false;
      }
    }
    return {
      x: lastNormalBounds.x,
      y: lastNormalBounds.y,
      width: lastNormalBounds.width,
      height: lastNormalBounds.height,
      isMaximized: lastMaximized,
      isFullScreen: lastFullScreen,
    };
  };

  const flushState = () => {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    if (win.isDestroyed()) return;
    saveWindowState(userDataDir, captureState());
  };

  const scheduleSave = () => {
    if (restoring || win.isDestroyed()) return;
    if (saveTimer) {
      clearTimeout(saveTimer);
    }
    saveTimer = setTimeout(() => {
      saveTimer = null;
      if (!win.isDestroyed()) {
        saveWindowState(userDataDir, captureState());
      }
    }, WINDOW_STATE_SAVE_DELAY_MS);
  };

  const handleGeometryChange = () => {
    if (restoring || win.isDestroyed() || win.isMinimized()) return;
    if (
      !win.isMaximized() &&
      !win.isFullScreen() &&
      !awaitingInitialMaximize &&
      !awaitingInitialFullScreen
    ) {
      pendingNormalBounds = win.getBounds();
    }
    scheduleSave();
  };

  mainStateFlush = flushState;
  zoomPrepareHooks.set(win, () => {
    if (
      !win.isMinimized() &&
      !win.isMaximized() &&
      !win.isFullScreen() &&
      !awaitingInitialMaximize &&
      !awaitingInitialFullScreen
    ) {
      commitNormalBounds(pendingNormalBounds ?? win.getBounds());
      pendingNormalBounds = null;
      preZoomNormalCommitted = true;
    }
  });

  win.on("move", handleGeometryChange);
  win.on("resize", handleGeometryChange);
  win.on("resized", () => {
    if (
      restoring ||
      win.isDestroyed() ||
      win.isMinimized() ||
      win.isMaximized() ||
      win.isFullScreen() ||
      awaitingInitialMaximize ||
      awaitingInitialFullScreen
    ) {
      return;
    }
    commitNormalBounds(pendingNormalBounds ?? win.getBounds());
    pendingNormalBounds = null;
    scheduleSave();
  });
  win.on("maximize", () => {
    if (restoring || win.isDestroyed()) return;
    awaitingInitialMaximize = false;
    promotePendingNormalBounds(win.getBounds());
    lastMaximized = true;
    recordNonNormalNativeBounds();
    scheduleSave();
  });
  win.on("unmaximize", () => {
    if (restoring || win.isDestroyed()) return;
    awaitingInitialMaximize = false;
    preZoomNormalCommitted = false;
    if (!win.isMinimized()) {
      lastMaximized = false;
      pendingNormalBounds = win.isFullScreen() ? null : win.getBounds();
    }
    scheduleSave();
  });
  win.on("enter-full-screen", () => {
    if (restoring || win.isDestroyed()) return;
    awaitingInitialFullScreen = false;
    promotePendingNormalBounds(win.getBounds());
    lastFullScreen = true;
    lastMaximized = false;
    recordNonNormalNativeBounds();
    scheduleSave();
  });
  win.on("leave-full-screen", () => {
    if (restoring || win.isDestroyed()) return;
    awaitingInitialFullScreen = false;
    preZoomNormalCommitted = false;
    if (!win.isMinimized()) {
      lastFullScreen = false;
      pendingNormalBounds = win.isMaximized() ? null : win.getBounds();
    }
    scheduleSave();
  });
  win.on("minimize", () => {
    if (restoring || win.isDestroyed()) return;
    if (!win.isMaximized()) {
      promotePendingNormalBounds();
    } else {
      pendingNormalBounds = null;
    }
    recordNonNormalNativeBounds();
    scheduleSave();
  });
  win.on("hide", flushState);
  win.on("close", flushState);
  win.on("closed", () => {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    if (initialRestoreTimer) {
      clearTimeout(initialRestoreTimer);
      initialRestoreTimer = null;
    }
    if (mainStateFlush === flushState) {
      mainStateFlush = null;
    }
    zoomPrepareHooks.delete(win);
  });

  if (resolved.isMaximized) {
    awaitingInitialMaximize = true;
    win.maximize();
    if (win.isMaximized()) {
      awaitingInitialMaximize = false;
    }
  }
  if (resolved.isFullScreen) {
    awaitingInitialFullScreen = true;
    win.setFullScreen(true);
    if (win.isFullScreen()) {
      awaitingInitialFullScreen = false;
    }
  }
  if (awaitingInitialMaximize || awaitingInitialFullScreen) {
    initialRestoreTimer = setTimeout(() => {
      initialRestoreTimer = null;
      awaitingInitialMaximize = false;
      awaitingInitialFullScreen = false;
    }, 2000);
  }
  restoring = false;

  return win;
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
