import { BrowserWindow } from "electron";
import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  systemDark: false,
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
}));

vi.mock("electron", () => ({
  app: { isPackaged: false, getVersion: () => "2.0.0", getAppPath: () => process.cwd() },
  BrowserWindow: Object.assign(vi.fn(), { fromWebContents: vi.fn() }),
  dialog: { showOpenDialog: vi.fn() },
  ipcMain: {
    on: vi.fn(),
    handle: vi.fn((channel: string, fn: (...args: unknown[]) => unknown) => {
      state.handlers.set(channel, fn);
    }),
  },
  shell: { openExternal: vi.fn() },
  nativeTheme: {
    get shouldUseDarkColors() {
      return state.systemDark;
    },
  },
}));

import {
  readInitialAppearance,
  readInitialDark,
  readStoredReaderTheme,
  registerIpcHandlers,
} from "./ipc";

afterEach(() => {
  state.systemDark = false;
  state.handlers.clear();
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

  it("distinguishes confirmed DB lookup from timeout or error in readInitialAppearance", async () => {
    const confirmedDark = {
      dispatch: vi.fn().mockResolvedValue(JSON.stringify("dark")),
    };
    await expect(readInitialAppearance(confirmedDark, 50)).resolves.toEqual({
      dark: true,
      preloadDark: true,
    });

    // Confirmed missing row ("null") resolves as System and produces a confirmed seed.
    state.systemDark = false;
    const confirmedMissing = {
      dispatch: vi.fn().mockResolvedValue("null"),
    };
    await expect(readInitialAppearance(confirmedMissing, 50)).resolves.toEqual({
      dark: false,
      preloadDark: false,
    });

    // Hung DB query uses OS appearance for native backing, but leaves preloadDark null.
    vi.useFakeTimers();
    state.systemDark = true;
    const hangingCore = {
      dispatch: vi.fn(() => new Promise<string>(() => {})),
    };
    const timeoutPromise = readInitialAppearance(hangingCore, 100);
    await vi.advanceTimersByTimeAsync(100);
    await expect(timeoutPromise).resolves.toEqual({
      dark: true,
      preloadDark: null,
    });

    // Rejected DB query also falls back provisionally with preloadDark null.
    state.systemDark = false;
    const failingCore = {
      dispatch: vi.fn().mockRejectedValue(new Error("db error")),
    };
    await expect(readInitialAppearance(failingCore, 50)).resolves.toEqual({
      dark: false,
      preloadDark: null,
    });
  });
});

describe("readStoredReaderTheme", () => {
  it("prefers valid per-book override without querying global reader_theme", async () => {
    const core = { dispatch: vi.fn() };
    await expect(readStoredReaderTheme(core, "paper", 50)).resolves.toBe("paper");
    expect(core.dispatch).not.toHaveBeenCalled();
  });

  it("reads global reader_theme when book override is absent and falls back to original on timeout", async () => {
    const core = {
      dispatch: vi.fn().mockResolvedValue(JSON.stringify("dark")),
    };
    await expect(readStoredReaderTheme(core, undefined, 50)).resolves.toBe("dark");
    expect(core.dispatch).toHaveBeenCalledWith(
      "get_setting",
      JSON.stringify({ key: "reader_theme" }),
    );

    vi.useFakeTimers();
    const hangingCore = {
      dispatch: vi.fn(() => new Promise<string>(() => {})),
    };
    const promise = readStoredReaderTheme(hangingCore, undefined, 50);
    await vi.advanceTimersByTimeAsync(50);
    await expect(promise).resolves.toBe("original");
  });
});

describe("registerIpcHandlers platform and updater channels", () => {
  it("exposes quill:get-platform-info and update download/cancel channels", async () => {
    const core = { dispatch: vi.fn() } as never;
    const updater = {
      checkForUpdate: vi.fn(),
      downloadAndInstall: vi.fn().mockResolvedValue({ cancelled: true }),
      cancelDownload: vi.fn().mockReturnValue(true),
      relaunchAndInstall: vi.fn(),
    } as never;

    registerIpcHandlers(core, undefined, updater);

    const getPlatform = state.handlers.get("quill:get-platform-info");
    expect(getPlatform?.()).toEqual({
      platform: process.platform,
      arch: process.arch,
    });

    const download = state.handlers.get("quill:download-update");
    const fakeEvent = {
      sender: { isDestroyed: () => false, send: vi.fn() },
    };
    await expect(download?.(fakeEvent)).resolves.toEqual({
      ok: true,
      data: { cancelled: true },
    });

    const cancel = state.handlers.get("quill:cancel-update-download");
    expect(cancel?.()).toBe(true);
    expect((updater as { cancelDownload: ReturnType<typeof vi.fn> }).cancelDownload).toHaveBeenCalledTimes(1);
  });

  it("handles window-control IPC actions for the sender window only", () => {
    const core = { dispatch: vi.fn() } as never;
    registerIpcHandlers(core);

    const winState = {
      destroyed: false,
      maximized: false,
      fullscreen: false,
    };
    const fakeWin = {
      isDestroyed: () => winState.destroyed,
      isMaximized: () => winState.maximized,
      isFullScreen: () => winState.fullscreen,
      minimize: vi.fn(),
      maximize: vi.fn(() => {
        winState.maximized = true;
      }),
      unmaximize: vi.fn(() => {
        winState.maximized = false;
      }),
      setFullScreen: vi.fn((flag: boolean) => {
        winState.fullscreen = flag;
      }),
      close: vi.fn(),
    };
    const fromWebContents = vi.mocked(BrowserWindow.fromWebContents);
    fromWebContents.mockReturnValue(fakeWin as never);

    const senderEvent = { sender: { id: 42 } };
    const minimize = state.handlers.get("quill:minimize-window")!;
    const toggleMaximize = state.handlers.get("quill:toggle-maximize-window")!;
    const close = state.handlers.get("quill:close-window")!;
    const isMaximized = state.handlers.get("quill:is-window-maximized")!;

    expect(isMaximized(senderEvent)).toBe(false);
    expect(fromWebContents).toHaveBeenCalledWith(senderEvent.sender);

    minimize(senderEvent);
    expect(fakeWin.minimize).toHaveBeenCalledTimes(1);

    toggleMaximize(senderEvent);
    expect(fakeWin.maximize).toHaveBeenCalledTimes(1);
    expect(isMaximized(senderEvent)).toBe(true);

    toggleMaximize(senderEvent);
    expect(fakeWin.unmaximize).toHaveBeenCalledTimes(1);
    expect(isMaximized(senderEvent)).toBe(false);

    // Entering F11 full screen from a restored window reports restorable=true and clicking exits full screen.
    winState.fullscreen = true;
    expect(isMaximized(senderEvent)).toBe(true);
    toggleMaximize(senderEvent);
    expect(fakeWin.setFullScreen).toHaveBeenCalledWith(false);
    expect(fakeWin.maximize).toHaveBeenCalledTimes(1);
    expect(isMaximized(senderEvent)).toBe(false);

    close(senderEvent);
    expect(fakeWin.close).toHaveBeenCalledTimes(1);

    // Destroyed or missing sender windows are safe no-ops.
    winState.destroyed = true;
    minimize(senderEvent);
    close(senderEvent);
    expect(isMaximized(senderEvent)).toBe(false);
    expect(fakeWin.minimize).toHaveBeenCalledTimes(1);
    expect(fakeWin.close).toHaveBeenCalledTimes(1);

    fromWebContents.mockReturnValue(null);
    minimize(senderEvent);
    toggleMaximize(senderEvent);
    close(senderEvent);
    expect(isMaximized(senderEvent)).toBe(false);
  });
});
