import { describe, expect, it, vi } from "vitest";
import {
  LAST_LAUNCHED_VERSION_KEY,
  LSREGISTER_PATH,
  refreshMacBundleIconIfVersionChanged,
  resolveMacAppBundlePath,
  shouldRefreshMacBundleIcon,
} from "./macIconRefresh";

describe("shouldRefreshMacBundleIcon", () => {
  it("returns false for same version", () => {
    expect(
      shouldRefreshMacBundleIcon({
        isPackaged: true,
        platform: "darwin",
        currentVersion: "2.0.1",
        lastLaunchedVersion: "2.0.1",
      }),
    ).toBe(false);
  });

  it("returns true for new version", () => {
    expect(
      shouldRefreshMacBundleIcon({
        isPackaged: true,
        platform: "darwin",
        currentVersion: "2.0.2",
        lastLaunchedVersion: "2.0.1",
      }),
    ).toBe(true);
  });

  it("returns true when setting is missing or empty", () => {
    expect(
      shouldRefreshMacBundleIcon({
        isPackaged: true,
        platform: "darwin",
        currentVersion: "2.0.2",
        lastLaunchedVersion: null,
      }),
    ).toBe(true);
    expect(
      shouldRefreshMacBundleIcon({
        isPackaged: true,
        platform: "darwin",
        currentVersion: "2.0.2",
        lastLaunchedVersion: undefined,
      }),
    ).toBe(true);
    expect(
      shouldRefreshMacBundleIcon({
        isPackaged: true,
        platform: "darwin",
        currentVersion: "2.0.2",
        lastLaunchedVersion: "",
      }),
    ).toBe(true);
  });

  it("returns false in dev build even when version differs", () => {
    expect(
      shouldRefreshMacBundleIcon({
        isPackaged: false,
        platform: "darwin",
        currentVersion: "2.0.2",
        lastLaunchedVersion: null,
      }),
    ).toBe(false);
  });

  it("returns false on non-macOS platforms", () => {
    expect(
      shouldRefreshMacBundleIcon({
        isPackaged: true,
        platform: "win32",
        currentVersion: "2.0.2",
        lastLaunchedVersion: null,
      }),
    ).toBe(false);
    expect(
      shouldRefreshMacBundleIcon({
        isPackaged: true,
        platform: "linux",
        currentVersion: "2.0.2",
        lastLaunchedVersion: null,
      }),
    ).toBe(false);
  });
});

describe("resolveMacAppBundlePath", () => {
  it("derives .app bundle root from packaged macOS execPath", () => {
    expect(resolveMacAppBundlePath("/Applications/Quill.app/Contents/MacOS/Quill")).toBe(
      "/Applications/Quill.app",
    );
    expect(resolveMacAppBundlePath("/usr/local/bin/node")).toBeNull();
  });
});

describe("refreshMacBundleIconIfVersionChanged", () => {
  const execPath = "/Applications/Quill.app/Contents/MacOS/Quill";
  const fixedDate = new Date("2026-11-18T12:00:00.000Z");

  it("skips dispatch and all side effects in dev builds or non-macOS", async () => {
    const dispatch = vi.fn<() => Promise<string>>();
    const utimes = vi.fn<() => Promise<void>>();
    const execFile = vi.fn<() => Promise<void>>();
    const setDockIconFromPath = vi.fn();

    await expect(
      refreshMacBundleIconIfVersionChanged({
        isPackaged: false,
        platform: "darwin",
        currentVersion: "2.0.2",
        execPath,
        dispatch,
        utimes,
        execFile,
        setDockIconFromPath,
      }),
    ).resolves.toBe(false);

    await expect(
      refreshMacBundleIconIfVersionChanged({
        isPackaged: true,
        platform: "win32",
        currentVersion: "2.0.2",
        execPath,
        dispatch,
        utimes,
        execFile,
        setDockIconFromPath,
      }),
    ).resolves.toBe(false);

    expect(dispatch).not.toHaveBeenCalled();
    expect(utimes).not.toHaveBeenCalled();
    expect(execFile).not.toHaveBeenCalled();
    expect(setDockIconFromPath).not.toHaveBeenCalled();
  });

  it("does nothing when stored last_launched_version matches current version", async () => {
    const dispatch = vi.fn().mockResolvedValue(JSON.stringify("2.0.2"));
    const utimes = vi.fn<() => Promise<void>>();
    const execFile = vi.fn<() => Promise<void>>();
    const setDockIconFromPath = vi.fn();

    const refreshed = await refreshMacBundleIconIfVersionChanged({
      isPackaged: true,
      platform: "darwin",
      currentVersion: "2.0.2",
      execPath,
      dispatch,
      utimes,
      execFile,
      setDockIconFromPath,
    });

    expect(refreshed).toBe(false);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(utimes).not.toHaveBeenCalled();
    expect(execFile).not.toHaveBeenCalled();
    expect(setDockIconFromPath).not.toHaveBeenCalled();
  });

  it("touches mtime, calls lsregister, sets Dock icon, and persists version on upgrade", async () => {
    const order: string[] = [];
    const dispatch = vi.fn(async (cmd: string) => {
      order.push(`dispatch:${cmd}`);
      return cmd === "get_setting" ? JSON.stringify("2.0.1") : "null";
    });
    const utimes = vi.fn(async () => {
      order.push("utimes");
    });
    const execFile = vi.fn(async () => {
      order.push("lsregister");
    });
    const setDockIconFromPath = vi.fn(() => {
      order.push("dock");
    });

    const refreshed = await refreshMacBundleIconIfVersionChanged({
      isPackaged: true,
      platform: "darwin",
      currentVersion: "2.0.2",
      execPath,
      dispatch,
      setDockIconFromPath,
      utimes,
      execFile,
      fileExists: (p) => p === "/Applications/Quill.app/Contents/Resources/icon.icns",
      now: () => fixedDate,
    });

    expect(refreshed).toBe(true);
    expect(utimes).toHaveBeenCalledWith("/Applications/Quill.app", fixedDate, fixedDate);
    expect(execFile).toHaveBeenCalledWith(LSREGISTER_PATH, ["-f", "/Applications/Quill.app"]);
    expect(setDockIconFromPath).toHaveBeenCalledWith(
      "/Applications/Quill.app/Contents/Resources/icon.icns",
    );
    expect(dispatch).toHaveBeenLastCalledWith(
      "set_setting",
      JSON.stringify({ key: LAST_LAUNCHED_VERSION_KEY, value: "2.0.2" }),
    );
    expect(order).toEqual([
      "dispatch:get_setting",
      "utimes",
      "lsregister",
      "dock",
      "dispatch:set_setting",
    ]);
  });

  it("logs and continues every step when bundle is read-only or lsregister/dock fails", async () => {
    const warn = vi.fn();
    const dispatch = vi.fn(async (cmd: string) => (cmd === "get_setting" ? "null" : "null"));
    const utimes = vi.fn().mockRejectedValue(new Error("EROFS: read-only file system"));
    const execFile = vi.fn().mockRejectedValue(new Error("lsregister failed"));
    const setDockIconFromPath = vi.fn(() => {
      throw new Error("dock failed");
    });

    const refreshed = await refreshMacBundleIconIfVersionChanged({
      isPackaged: true,
      platform: "darwin",
      currentVersion: "2.0.2",
      execPath,
      dispatch,
      setDockIconFromPath,
      utimes,
      execFile,
      fileExists: () => true,
      now: () => fixedDate,
      log: { warn },
    });

    expect(refreshed).toBe(true);
    expect(utimes).toHaveBeenCalledTimes(1);
    expect(execFile).toHaveBeenCalledTimes(1);
    expect(setDockIconFromPath).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(3);
    expect(dispatch).toHaveBeenLastCalledWith(
      "set_setting",
      JSON.stringify({ key: LAST_LAUNCHED_VERSION_KEY, value: "2.0.2" }),
    );
  });
});
