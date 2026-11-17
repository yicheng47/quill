import path from "node:path";
import { BrowserWindow, nativeTheme, shell } from "electron";
import { isAllowedNavigation, isSafeHttpUrl, resolveWindowUrl } from "./urlSecurity";

export interface ReaderWindowParams {
  label: string;
  url: string;
  title: string;
  width: number;
  height: number;
  minWidth: number;
  minHeight: number;
}

const LIGHT_BG = "#f4f4f5";
const DARK_BG = "#151518";

const windowsByLabel = new Map<string, BrowserWindow>();
const labelByWebContentsId = new Map<number, string>();
const titlebarZoomByLabel = new Map<string, number>();
let quitting = false;

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
  const baseHeight = label === "main" ? 44 : 32;
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
    x: 16,
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
  return true;
}

export function appReadyForWindow(label: string): void {
  const win = getWindow(label);
  if (!win) return;
  if (!win.isVisible()) win.show();
  if (label === "main") {
    win.focus();
  }
}

function createWindow(options: {
  label: string;
  routePath: string;
  title: string;
  width: number;
  height: number;
  minWidth?: number;
  minHeight?: number;
  initialDark: boolean;
}): BrowserWindow {
  const targetUrl = resolveWindowUrl(options.routePath, process.env.ELECTRON_RENDERER_URL);
  const isMac = process.platform === "darwin";
  const isMain = options.label === "main";
  const baseHeight = isMain ? 44 : 32;
  const buttonHeight = 14;

  const win = new BrowserWindow({
    title: options.title,
    width: options.width,
    height: options.height,
    minWidth: options.minWidth,
    minHeight: options.minHeight,
    show: false,
    backgroundColor: options.initialDark ? DARK_BG : LIGHT_BG,
    ...(isMac
      ? {
          titleBarStyle: "hiddenInset" as const,
          trafficLightPosition: {
            x: 16,
            y: Math.round((baseHeight - buttonHeight) / 2),
          },
        }
      : {}),
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.cjs"),
      additionalArguments: [`--quill-window-label=${options.label}`],
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  windowsByLabel.set(options.label, win);
  const wcId = win.webContents.id;
  labelByWebContentsId.set(wcId, options.label);

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
    labelByWebContentsId.delete(wcId);
    titlebarZoomByLabel.delete(options.label);
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
  return createWindow({
    label: params.label,
    routePath: params.url,
    title: params.title,
    width: params.width,
    height: params.height,
    minWidth: params.minWidth,
    minHeight: params.minHeight,
    initialDark,
  });
}
