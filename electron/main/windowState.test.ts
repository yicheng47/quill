import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_MAIN_HEIGHT,
  DEFAULT_MAIN_WIDTH,
  defaultMainWindowState,
  getWindowStatePath,
  loadWindowState,
  parseWindowState,
  resolveMainWindowState,
  saveWindowState,
} from "./windowState";

const primaryWorkArea = { x: 0, y: 38, width: 1920, height: 1042 };
const secondWorkArea = { x: 1920, y: 25, width: 2560, height: 1415 };
const leftWorkArea = { x: -1920, y: 0, width: 1920, height: 1080 };

describe("windowState pure validation and persistence", () => {
  const tmpDirs: string[] = [];

  afterEach(() => {
    for (const dir of tmpDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  const makeTmpDir = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "quill-winstate-"));
    tmpDirs.push(dir);
    return dir;
  };

  it("restores saved bounds on the primary display and enforces minWidth/minHeight", () => {
    expect(
      resolveMainWindowState(
        { x: 120, y: 100, width: 1100, height: 750, isMaximized: false, isFullScreen: false },
        [primaryWorkArea],
      ),
    ).toEqual({
      x: 120,
      y: 100,
      width: 1100,
      height: 750,
      isMaximized: false,
      isFullScreen: false,
      restored: true,
    });

    // Clamps below-minimum dimensions while preserving valid position and state flags
    expect(
      resolveMainWindowState(
        { x: 100, y: 80, width: 400, height: 300, isMaximized: true, isFullScreen: false },
        [primaryWorkArea],
      ),
    ).toEqual({
      x: 100,
      y: 80,
      width: 700,
      height: 500,
      isMaximized: true,
      isFullScreen: false,
      restored: true,
    });
  });

  it("restores bounds on a second display (including negative-x arranged displays)", () => {
    expect(
      resolveMainWindowState(
        { x: 2100, y: 120, width: 1200, height: 800, isMaximized: false, isFullScreen: true },
        [primaryWorkArea, secondWorkArea],
      ),
    ).toEqual({
      x: 2100,
      y: 120,
      width: 1200,
      height: 800,
      isMaximized: false,
      isFullScreen: true,
      restored: true,
    });

    expect(
      resolveMainWindowState(
        { x: -1600, y: 100, width: 1200, height: 800 },
        [primaryWorkArea, leftWorkArea],
      ),
    ).toMatchObject({
      x: -1600,
      y: 100,
      width: 1200,
      height: 800,
      restored: true,
    });
  });

  it("falls back to default centered bounds when a previously used display is removed", () => {
    expect(
      resolveMainWindowState(
        { x: 2100, y: 120, width: 1200, height: 800, isMaximized: true },
        [primaryWorkArea],
      ),
    ).toEqual({
      width: DEFAULT_MAIN_WIDTH,
      height: DEFAULT_MAIN_HEIGHT,
      isMaximized: false,
      isFullScreen: false,
      restored: false,
    });
  });

  it("checks whether at least 100x50 of the titlebar fits inside a display workArea for partly off-screen windows", () => {
    // Reachable: 170px wide x 50px high of top titlebar inside workArea (>= 100x50)
    expect(
      resolveMainWindowState(
        { x: 1750, y: 80, width: 800, height: 600 },
        [primaryWorkArea],
      ),
    ).toMatchObject({ x: 1750, y: 80, restored: true });

    // Too far off-screen horizontally: only 70px (< 100px) visible
    expect(
      resolveMainWindowState(
        { x: 1850, y: 80, width: 800, height: 600 },
        [primaryWorkArea],
      ),
    ).toEqual({
      width: DEFAULT_MAIN_WIDTH,
      height: DEFAULT_MAIN_HEIGHT,
      isMaximized: false,
      isFullScreen: false,
      restored: false,
    });

    // Titlebar trapped above workArea menu bar (only 12px height below workArea.y=38, < 50px)
    expect(
      resolveMainWindowState(
        { x: 200, y: 0, width: 1000, height: 700 },
        [primaryWorkArea],
      ),
    ).toEqual({
      width: DEFAULT_MAIN_WIDTH,
      height: DEFAULT_MAIN_HEIGHT,
      isMaximized: false,
      isFullScreen: false,
      restored: false,
    });
  });

  it("handles missing or corrupt window-state.json safely", () => {
    expect(parseWindowState("")).toBeNull();
    expect(parseWindowState("{not json")).toBeNull();
    expect(parseWindowState(JSON.stringify([]))).toBeNull();
    expect(parseWindowState(JSON.stringify({ x: 10, y: 20, width: 0, height: 600 }))).toBeNull();
    expect(parseWindowState(JSON.stringify({ x: "bad", y: 20, width: 800, height: 600 }))).toBeNull();

    const dir = makeTmpDir();
    expect(loadWindowState(dir)).toBeNull();

    fs.writeFileSync(getWindowStatePath(dir), "{broken", "utf8");
    expect(loadWindowState(dir)).toBeNull();
    expect(resolveMainWindowState(loadWindowState(dir), [primaryWorkArea])).toEqual({
      width: DEFAULT_MAIN_WIDTH,
      height: DEFAULT_MAIN_HEIGHT,
      isMaximized: false,
      isFullScreen: false,
      restored: false,
    });

    saveWindowState(dir, {
      x: 150,
      y: 90,
      width: 1120,
      height: 780,
      isMaximized: true,
      isFullScreen: false,
    });
    expect(loadWindowState(dir)).toEqual({
      x: 150,
      y: 90,
      width: 1120,
      height: 780,
      isMaximized: true,
      isFullScreen: false,
    });
  });

  it("clamps the default main window size to the primary display work area without altering saved state", () => {
    expect(defaultMainWindowState()).toEqual({
      width: DEFAULT_MAIN_WIDTH,
      height: DEFAULT_MAIN_HEIGHT,
      isMaximized: false,
      isFullScreen: false,
      restored: false,
    });

    // 14" MacBook work area (~1512x945): width stays 1440, height clamps to 945
    const macbook14 = { x: 0, y: 37, width: 1512, height: 945 };
    expect(resolveMainWindowState(null, [macbook14])).toEqual({
      width: 1440,
      height: 945,
      isMaximized: false,
      isFullScreen: false,
      restored: false,
    });

    // Smaller laptop display clamps both width and height
    const smallLaptop = { x: 0, y: 25, width: 1280, height: 775 };
    expect(resolveMainWindowState(null, [smallLaptop])).toEqual({
      width: 1280,
      height: 775,
      isMaximized: false,
      isFullScreen: false,
      restored: false,
    });

    // Explicit primaryWorkArea overrides display list order (e.g. secondary display appears first)
    expect(
      resolveMainWindowState(null, [secondWorkArea, macbook14], undefined, macbook14),
    ).toEqual({
      width: 1440,
      height: 945,
      isMaximized: false,
      isFullScreen: false,
      restored: false,
    });

    // Off-screen saved state fallback also clamps to primaryWorkArea
    expect(
      resolveMainWindowState(
        { x: 3000, y: 120, width: 1440, height: 960 },
        [macbook14],
        undefined,
        macbook14,
      ),
    ).toEqual({
      width: 1440,
      height: 945,
      isMaximized: false,
      isFullScreen: false,
      restored: false,
    });

    // Existing saved window state still overrides the clamped default untouched
    expect(
      resolveMainWindowState(
        { x: 20, y: 50, width: 1500, height: 960, isMaximized: false, isFullScreen: false },
        [macbook14],
        undefined,
        macbook14,
      ),
    ).toEqual({
      x: 20,
      y: 50,
      width: 1500,
      height: 960,
      isMaximized: false,
      isFullScreen: false,
      restored: true,
    });
  });
});
