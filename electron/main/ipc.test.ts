import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  systemDark: false,
}));

vi.mock("electron", () => ({
  app: { isPackaged: false, getVersion: () => "2.0.0", getAppPath: () => process.cwd() },
  BrowserWindow: vi.fn(),
  dialog: { showOpenDialog: vi.fn() },
  ipcMain: { on: vi.fn(), handle: vi.fn() },
  shell: { openExternal: vi.fn() },
  nativeTheme: {
    get shouldUseDarkColors() {
      return state.systemDark;
    },
  },
}));

import { readInitialDark } from "./ipc";

afterEach(() => {
  state.systemDark = false;
  vi.useRealTimers();
});

describe("readInitialDark", () => {
  it("returns persisted dark theme immediately when dispatch resolves in time", async () => {
    const core = {
      dispatch: vi.fn().mockResolvedValue(JSON.stringify("dark")),
    };
    await expect(readInitialDark(core, 50)).resolves.toBe(true);
    expect(core.dispatch).toHaveBeenCalledWith(
      "get_setting",
      JSON.stringify({ key: "theme" }),
    );
  });

  it("falls back within timeout when dispatch hangs", async () => {
    vi.useFakeTimers();
    state.systemDark = true;
    const core = {
      dispatch: vi.fn(() => new Promise<string>(() => {})),
    };

    const promise = readInitialDark(core, 100);
    await vi.advanceTimersByTimeAsync(100);
    await expect(promise).resolves.toBe(true);
  });
});
