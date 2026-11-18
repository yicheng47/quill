import fs from "node:fs";
import path from "node:path";

export const DEFAULT_MAIN_WIDTH = 1440;
export const DEFAULT_MAIN_HEIGHT = 960;
export const MAIN_MIN_WIDTH = 700;
export const MAIN_MIN_HEIGHT = 500;
export const WINDOW_STATE_FILENAME = "window-state.json";

const MIN_VISIBLE_TITLEBAR_WIDTH = 100;
const MIN_VISIBLE_TITLEBAR_HEIGHT = 50;

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SavedWindowState {
  x: number;
  y: number;
  width: number;
  height: number;
  isMaximized?: boolean;
  isFullScreen?: boolean;
}

export interface ResolvedMainWindowState {
  width: number;
  height: number;
  x?: number;
  y?: number;
  isMaximized: boolean;
  isFullScreen: boolean;
  restored: boolean;
}

export function defaultMainWindowState(): ResolvedMainWindowState {
  return {
    width: DEFAULT_MAIN_WIDTH,
    height: DEFAULT_MAIN_HEIGHT,
    isMaximized: false,
    isFullScreen: false,
    restored: false,
  };
}

export function parseWindowState(raw: string): SavedWindowState | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    const obj = parsed as Record<string, unknown>;
    if (
      typeof obj.x !== "number" ||
      typeof obj.y !== "number" ||
      typeof obj.width !== "number" ||
      typeof obj.height !== "number" ||
      !Number.isFinite(obj.x) ||
      !Number.isFinite(obj.y) ||
      !Number.isFinite(obj.width) ||
      !Number.isFinite(obj.height) ||
      obj.width <= 0 ||
      obj.height <= 0
    ) {
      return null;
    }
    return {
      x: Math.round(obj.x),
      y: Math.round(obj.y),
      width: Math.round(obj.width),
      height: Math.round(obj.height),
      isMaximized: typeof obj.isMaximized === "boolean" ? obj.isMaximized : false,
      isFullScreen: typeof obj.isFullScreen === "boolean" ? obj.isFullScreen : false,
    };
  } catch {
    return null;
  }
}

function titlebarVisibleInWorkArea(windowBounds: Rect, workArea: Rect): boolean {
  const titlebarHeight = Math.min(MIN_VISIBLE_TITLEBAR_HEIGHT, windowBounds.height);
  const overlapLeft = Math.max(windowBounds.x, workArea.x);
  const overlapRight = Math.min(windowBounds.x + windowBounds.width, workArea.x + workArea.width);
  const overlapTop = Math.max(windowBounds.y, workArea.y);
  const overlapBottom = Math.min(windowBounds.y + titlebarHeight, workArea.y + workArea.height);
  return (
    overlapRight - overlapLeft >= MIN_VISIBLE_TITLEBAR_WIDTH &&
    overlapBottom - overlapTop >= titlebarHeight
  );
}

export function resolveMainWindowState(
  saved: SavedWindowState | null | undefined,
  workAreas: ReadonlyArray<Rect>,
  minSize: { width: number; height: number } = { width: MAIN_MIN_WIDTH, height: MAIN_MIN_HEIGHT },
): ResolvedMainWindowState {
  if (!saved) {
    return defaultMainWindowState();
  }
  const width = Math.max(minSize.width, Math.round(saved.width));
  const height = Math.max(minSize.height, Math.round(saved.height));
  const x = Math.round(saved.x);
  const y = Math.round(saved.y);

  const visible = workAreas.some((area) =>
    titlebarVisibleInWorkArea({ x, y, width, height }, area),
  );
  if (!visible) {
    return defaultMainWindowState();
  }

  return {
    x,
    y,
    width,
    height,
    isMaximized: Boolean(saved.isMaximized),
    isFullScreen: Boolean(saved.isFullScreen),
    restored: true,
  };
}

export function getWindowStatePath(userDataDir: string): string {
  return path.join(userDataDir, WINDOW_STATE_FILENAME);
}

export function loadWindowState(userDataDir: string): SavedWindowState | null {
  try {
    const raw = fs.readFileSync(getWindowStatePath(userDataDir), "utf8");
    return parseWindowState(raw);
  } catch {
    return null;
  }
}

export function saveWindowState(userDataDir: string, state: SavedWindowState): void {
  try {
    const filePath = getWindowStatePath(userDataDir);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(state, null, 2), "utf8");
  } catch (err) {
    console.warn("windows: failed to persist main window state:", err);
  }
}
