/** @vitest-environment jsdom */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UpdateProgressEvent } from "../platform";

const mocks = vi.hoisted(() => ({
  checkForUpdate: vi.fn(),
  cancelUpdateDownload: vi.fn<() => Promise<boolean>>(),
  relaunch: vi.fn<() => Promise<void>>(),
  invoke: vi.fn<(cmd: string, args?: Record<string, unknown>) => Promise<unknown>>(),
  settingsMap: {} as Record<string, string>,
}));

vi.mock("../platform", () => ({
  checkForUpdate: () => mocks.checkForUpdate(),
  cancelUpdateDownload: () => mocks.cancelUpdateDownload(),
  relaunch: () => mocks.relaunch(),
  invoke: (cmd: string, args?: Record<string, unknown>) => mocks.invoke(cmd, args),
}));

import { useUpdateChecker, type UpdateState } from "./useUpdateChecker";

function Harness({ onChange }: { onChange: (state: UpdateState) => void }) {
  const state = useUpdateChecker();
  useEffect(() => {
    onChange(state);
  }, [state, onChange]);
  return null;
}

describe("useUpdateChecker quiet update lifecycle", () => {
  let container: HTMLDivElement;
  let root: Root;
  let latestState: UpdateState | null = null;
  const setLatest = (state: UpdateState) => {
    latestState = state;
  };

  beforeEach(() => {
    latestState = null;
    mocks.settingsMap = {};
    mocks.checkForUpdate.mockReset();
    mocks.cancelUpdateDownload.mockReset();
    mocks.cancelUpdateDownload.mockResolvedValue(true);
    mocks.relaunch.mockReset();
    mocks.relaunch.mockResolvedValue();
    mocks.invoke.mockReset();
    mocks.invoke.mockImplementation(async (cmd, args) => {
      if (cmd === "get_all_settings") {
        return { ...mocks.settingsMap };
      }
      if (cmd === "set_setting" && args) {
        mocks.settingsMap[String(args.key)] = String(args.value);
        return null;
      }
      return null;
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it("tracks bytes, persists last_update_check_at, and transitions available -> downloading -> verifying -> ready", async () => {
    let emitProgress: ((e: UpdateProgressEvent) => void) | undefined;
    let resolveInstall!: () => void;
    const downloadAndInstall = vi.fn(
      (onProgress?: (e: UpdateProgressEvent) => void) => {
        emitProgress = onProgress;
        return new Promise<{ cancelled: boolean }>((resolve) => {
          resolveInstall = () => resolve({ cancelled: false });
        });
      },
    );

    mocks.checkForUpdate.mockResolvedValue({
      version: "1.3.0",
      currentVersion: "1.2.0",
      sizeBytes: 200,
      downloadAndInstall,
    });

    await act(async () => {
      root.render(<Harness onChange={setLatest} />);
    });

    expect(latestState?.status).toBe("idle");

    await act(async () => {
      await latestState?.checkForUpdate();
    });
    expect(latestState?.status).toBe("available");
    expect(latestState?.totalBytes).toBe(200);
    expect(latestState?.lastCheckedAt).toBeTypeOf("number");
    expect(mocks.invoke).toHaveBeenCalledWith("set_setting", {
      key: "last_update_check_at",
      value: expect.stringMatching(/^\d+$/),
    });

    let dlPromise!: Promise<void>;
    await act(async () => {
      dlPromise = latestState!.downloadAndInstall();
    });
    expect(latestState?.status).toBe("downloading");

    await act(async () => {
      emitProgress?.({ event: "Started", data: { contentLength: 200, chunkLength: 0 } });
      emitProgress?.({ event: "Progress", data: { chunkLength: 100 } });
    });
    expect(latestState?.progress).toBe(50);
    expect(latestState?.downloadedBytes).toBe(100);
    expect(latestState?.totalBytes).toBe(200);

    await act(async () => {
      emitProgress?.({ event: "Finished", data: { chunkLength: 0 } });
    });
    expect(latestState?.progress).toBe(100);
    expect(latestState?.downloadedBytes).toBe(200);
    expect(latestState?.status).toBe("verifying");

    await act(async () => {
      resolveInstall();
      await dlPromise;
    });
    expect(latestState?.status).toBe("ready");
    expect(mocks.relaunch).not.toHaveBeenCalled();

    await act(async () => {
      await latestState?.restart();
    });
    expect(mocks.relaunch).toHaveBeenCalledTimes(1);
  });

  it("cancels download cleanly back to available and respects skipped_update_version on background checks", async () => {
    mocks.settingsMap = {
      skipped_update_version: "1.3.0",
      last_update_check_at: "1700000000000",
    };

    let resolveDownload!: (val: { cancelled: boolean }) => void;
    const downloadAndInstall = vi.fn(
      () =>
        new Promise<{ cancelled: boolean }>((resolve) => {
          resolveDownload = resolve;
        }),
    );
    mocks.cancelUpdateDownload.mockImplementation(async () => {
      resolveDownload({ cancelled: true });
      return true;
    });
    mocks.checkForUpdate.mockResolvedValue({
      version: "1.3.0",
      currentVersion: "1.2.0",
      sizeBytes: 50_000,
      downloadAndInstall,
    });

    await act(async () => {
      root.render(<Harness onChange={setLatest} />);
    });
    // Wait for initial settings load
    await act(async () => {
      await Promise.resolve();
    });
    expect(latestState?.skippedVersion).toBe("1.3.0");
    expect(latestState?.lastCheckedAt).toBe(1_700_000_000_000);

    // Background check ignores skipped version
    await act(async () => {
      await latestState?.checkForUpdate({ manual: false });
    });
    expect(latestState?.status).toBe("idle");
    expect(latestState?.update).toBeNull();

    // Manual check still surfaces skipped version
    await act(async () => {
      await latestState?.checkForUpdate({ manual: true });
    });
    expect(latestState?.status).toBe("available");
    expect(latestState?.update?.version).toBe("1.3.0");

    // Downloading -> cancelled returns to available without error
    let dlPromise!: Promise<void>;
    await act(async () => {
      dlPromise = latestState!.downloadAndInstall();
    });
    expect(latestState?.status).toBe("downloading");
    await act(async () => {
      await latestState?.cancelDownload();
      await dlPromise;
    });
    expect(mocks.cancelUpdateDownload).toHaveBeenCalledTimes(1);
    expect(latestState?.status).toBe("available");
    expect(latestState?.error).toBeNull();

    // Skipping persists skipped_update_version and clears available update
    await act(async () => {
      await latestState?.skipVersion("1.3.0");
    });
    expect(latestState?.status).toBe("idle");
    expect(latestState?.skippedVersion).toBe("1.3.0");
    expect(mocks.settingsMap.skipped_update_version).toBe("1.3.0");
  });

  it("lets promoted manual checks surface skipped versions and lets authoritative DownloadResult decide cancel races", async () => {
    mocks.settingsMap = { skipped_update_version: "2.1.0" };

    let resolveCheck!: (val: unknown) => void;
    mocks.checkForUpdate.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveCheck = resolve;
        }),
    );

    let emitProgress: ((e: UpdateProgressEvent) => void) | undefined;
    let settleDownload!: (res: { cancelled: boolean }) => void;
    let rejectDownload!: (err: unknown) => void;
    const makeUpdate = () => ({
      version: "2.1.0",
      currentVersion: "2.0.0",
      sizeBytes: 1000,
      downloadAndInstall: vi.fn((onProgress?: (e: UpdateProgressEvent) => void) => {
        emitProgress = onProgress;
        return new Promise<{ cancelled: boolean }>((resolve, reject) => {
          settleDownload = resolve;
          rejectDownload = reject;
        });
      }),
    });

    await act(async () => {
      root.render(<Harness onChange={setLatest} />);
    });
    await act(async () => {
      await Promise.resolve();
    });

    // 1. Promoted manual check during an in-flight background check surfaces skipped version
    let checkPromise!: Promise<void>;
    await act(async () => {
      checkPromise = latestState!.checkForUpdate({ manual: false });
    });
    await act(async () => {
      await latestState!.checkForUpdate({ manual: true });
    });
    expect(latestState?.manualCheck).toBe(true);
    await act(async () => {
      resolveCheck(makeUpdate());
      await checkPromise;
    });
    expect(latestState?.status).toBe("available");
    expect(latestState?.update?.version).toBe("2.1.0");

    // 2. cancelUpdateDownload() returning false must NOT suppress progress or block completion -> ready
    mocks.cancelUpdateDownload.mockResolvedValueOnce(false);
    let dl1!: Promise<void>;
    await act(async () => {
      dl1 = latestState!.downloadAndInstall();
    });
    await act(async () => {
      await latestState?.cancelDownload();
    });
    await act(async () => {
      emitProgress?.({ event: "Started", data: { contentLength: 1000, chunkLength: 0 } });
      emitProgress?.({ event: "Progress", data: { chunkLength: 600 } });
    });
    expect(latestState?.progress).toBe(60);
    await act(async () => {
      emitProgress?.({ event: "Finished", data: { chunkLength: 0 } });
      settleDownload({ cancelled: false });
      await dl1;
    });
    expect(latestState?.status).toBe("ready");

    // Reset to available to test late cancel + error outcomes
    mocks.checkForUpdate.mockResolvedValueOnce(makeUpdate());
    await act(async () => {
      await latestState?.checkForUpdate({ manual: true });
    });

    // 3. Late cancel returns true but native still resolves { cancelled: false } -> ready
    mocks.cancelUpdateDownload.mockResolvedValueOnce(true);
    let dl2!: Promise<void>;
    await act(async () => {
      dl2 = latestState!.downloadAndInstall();
    });
    await act(async () => {
      await latestState?.cancelDownload();
      settleDownload({ cancelled: false });
      await dl2;
    });
    expect(latestState?.status).toBe("ready");

    // 4. Cancel returns/rejects while download rejects with real error -> error must NOT be swallowed
    mocks.checkForUpdate.mockResolvedValueOnce(makeUpdate());
    await act(async () => {
      await latestState?.checkForUpdate({ manual: true });
    });
    mocks.cancelUpdateDownload.mockRejectedValueOnce(new Error("IPC disconnected"));
    let dl3!: Promise<void>;
    await act(async () => {
      dl3 = latestState!.downloadAndInstall();
    });
    await act(async () => {
      await latestState?.cancelDownload();
      rejectDownload(new Error("Squirrel signature verification failed"));
      await dl3;
    });
    expect(latestState?.status).toBe("error");
    expect(latestState?.error).toBe("Squirrel signature verification failed");
  });
});
