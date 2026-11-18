/** @vitest-environment jsdom */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UpdateProgressEvent } from "../platform";

const mocks = vi.hoisted(() => ({
  checkForUpdate: vi.fn(),
  relaunch: vi.fn<() => Promise<void>>(),
}));

vi.mock("../platform", () => ({
  checkForUpdate: () => mocks.checkForUpdate(),
  relaunch: () => mocks.relaunch(),
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
    mocks.checkForUpdate.mockReset();
    mocks.relaunch.mockReset();
    mocks.relaunch.mockResolvedValue();
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

  it("transitions available -> downloading -> verifying -> ready without auto-relaunch, then relaunches on restart()", async () => {
    let emitProgress: ((e: UpdateProgressEvent) => void) | undefined;
    let resolveInstall!: () => void;
    const downloadAndInstall = vi.fn(
      (onProgress?: (e: UpdateProgressEvent) => void) => {
        emitProgress = onProgress;
        return new Promise<void>((resolve) => {
          resolveInstall = resolve;
        });
      },
    );

    mocks.checkForUpdate.mockResolvedValue({
      version: "1.3.0",
      currentVersion: "1.2.0",
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

    await act(async () => {
      emitProgress?.({ event: "Finished", data: { chunkLength: 0 } });
    });
    expect(latestState?.progress).toBe(100);
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
});
