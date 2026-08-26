/** @vitest-environment jsdom */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  setZoom: vi.fn<(zoom: number) => Promise<void>>(),
  invoke: vi.fn<(command: string, args?: object) => Promise<void>>(),
}));
const storedValues = new Map<string, string>();
const localStorageMock = {
  clear: () => storedValues.clear(),
  getItem: (key: string) => storedValues.get(key) ?? null,
  setItem: (key: string, value: string) => storedValues.set(key, value),
};

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mocks.invoke,
}));

vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({
    setZoom: mocks.setZoom,
  }),
}));

import {
  applyAppZoom,
  handleAppZoomShortcut,
  nudgeAppZoom,
  refreshAppZoom,
  syncTitlebarZoom,
  zoomShortcutActionForEvent,
} from "./appZoom";
import {
  readAppZoom,
  snapAppZoom,
  STORAGE_APP_ZOOM,
  ZOOM_STEPS,
} from "./settings";

describe("app zoom", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", localStorageMock);
    localStorage.clear();
    mocks.invoke.mockReset();
    mocks.invoke.mockResolvedValue();
    mocks.setZoom.mockReset();
    mocks.setZoom.mockResolvedValue();
  });

  it("persists and applies zoom to the invoking window", () => {
    applyAppZoom(1.2);

    expect(localStorage.getItem(STORAGE_APP_ZOOM)).toBe("1.2");
    expect(mocks.invoke).toHaveBeenCalledWith("set_setting", {
      key: "app_zoom",
      value: "1.2",
    });
    expect(mocks.invoke).toHaveBeenCalledWith("window_set_titlebar_zoom", {
      zoom: 1.2,
    });
    expect(mocks.setZoom).toHaveBeenCalledWith(1.2);
  });

  it("syncs the native titlebar for the invoking window", async () => {
    await syncTitlebarZoom(0.8);

    expect(mocks.invoke).toHaveBeenCalledWith("window_set_titlebar_zoom", {
      zoom: 0.8,
    });
  });

  it("pulses native zoom to refresh newly loaded frames", async () => {
    localStorage.setItem(STORAGE_APP_ZOOM, "1.1");

    await refreshAppZoom();

    expect(mocks.setZoom).toHaveBeenNthCalledWith(1, 1.101);
    expect(mocks.setZoom).toHaveBeenNthCalledWith(2, 1.1);
    expect(mocks.invoke).not.toHaveBeenCalled();
    expect(localStorage.getItem(STORAGE_APP_ZOOM)).toBe("1.1");
  });

  it("snaps stored values without writing them back", () => {
    localStorage.setItem(STORAGE_APP_ZOOM, "1.26");

    expect(readAppZoom()).toBe(1.3);
    expect(localStorage.getItem(STORAGE_APP_ZOOM)).toBe("1.26");
    expect(snapAppZoom("invalid")).toBe(1);
  });

  it("steps through the fixed zoom levels and clamps at the ends", () => {
    expect(ZOOM_STEPS).toEqual([0.8, 0.9, 1, 1.1, 1.2, 1.3, 1.4, 1.5]);

    localStorage.setItem(STORAGE_APP_ZOOM, "1.0");
    nudgeAppZoom(1);
    expect(readAppZoom()).toBe(1.1);

    localStorage.setItem(STORAGE_APP_ZOOM, "1.5");
    nudgeAppZoom(1);
    expect(readAppZoom()).toBe(1.5);

    nudgeAppZoom("reset");
    expect(readAppZoom()).toBe(1);
  });

  it("matches the app zoom shortcuts", () => {
    const event = {
      metaKey: true,
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
      code: "Equal",
    };

    expect(zoomShortcutActionForEvent(event)).toBe(1);
    expect(zoomShortcutActionForEvent({ ...event, shiftKey: true })).toBeNull();
    expect(zoomShortcutActionForEvent({ ...event, code: "Minus" })).toBe(-1);
    expect(zoomShortcutActionForEvent({ ...event, code: "Digit0" })).toBe("reset");
    expect(
      zoomShortcutActionForEvent({ ...event, code: "Minus", shiftKey: true }),
    ).toBeNull();
  });

  it("prevents default only for matching shortcuts", () => {
    const preventDefault = vi.fn();
    const stopPropagation = vi.fn();
    const event = {
      metaKey: true,
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
      code: "KeyA",
      preventDefault,
      stopPropagation,
    } as unknown as KeyboardEvent;

    expect(handleAppZoomShortcut(event)).toBe(false);
    expect(preventDefault).not.toHaveBeenCalled();

    expect(handleAppZoomShortcut({ ...event, code: "Equal" })).toBe(true);
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(stopPropagation).toHaveBeenCalledOnce();
  });
});
