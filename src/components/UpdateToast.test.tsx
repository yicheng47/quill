/** @vitest-environment jsdom */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EventMessage, UnlistenFn, UpdateHandle } from "../platform/types";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const mocks = vi.hoisted(() => ({
  invoke: vi.fn<(command: string, args?: Record<string, unknown>) => Promise<unknown>>(),
  checkForUpdate: vi.fn<() => Promise<UpdateHandle | null>>(),
  relaunch: vi.fn<() => Promise<void>>(),
  listeners: new Map<string, Set<(event: EventMessage<unknown>) => void>>(),
}));

vi.mock("../platform", () => ({
  invoke: mocks.invoke,
  checkForUpdate: mocks.checkForUpdate,
  relaunch: mocks.relaunch,
  listen: vi.fn(
    async (event: string, handler: (msg: EventMessage<unknown>) => void): Promise<UnlistenFn> => {
      let set = mocks.listeners.get(event);
      if (!set) {
        set = new Set();
        mocks.listeners.set(event, set);
      }
      set.add(handler);
      return () => {
        set?.delete(handler);
      };
    },
  ),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) =>
      params ? `${key}:${JSON.stringify(params)}` : key,
  }),
}));

import { UpdateProvider } from "../contexts/UpdateContext";
import UpdateToast from "./UpdateToast";

async function emitEvent(event: string, payload: unknown = null) {
  const handlers = [...(mocks.listeners.get(event) ?? [])];
  for (const handler of handlers) {
    handler({ payload });
  }
}

describe("UpdateToast + UpdateProvider", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      return setTimeout(() => cb(0), 0) as unknown as number;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => {
      clearTimeout(id);
    });
    mocks.invoke.mockReset();
    mocks.invoke.mockResolvedValue({ auto_check_updates: "true" });
    mocks.checkForUpdate.mockReset();
    mocks.checkForUpdate.mockResolvedValue(null);
    mocks.relaunch.mockReset();
    mocks.relaunch.mockResolvedValue();
    mocks.listeners.clear();

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  async function renderToast() {
    await act(async () => {
      root.render(
        <UpdateProvider>
          <UpdateToast />
        </UpdateProvider>,
      );
      await Promise.resolve();
    });
  }

  it("stays silent on launch auto-check when checkForUpdate immediately resolves null", async () => {
    await renderToast();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });

    expect(mocks.checkForUpdate).toHaveBeenCalledTimes(1);
    expect(container.textContent).toBe("");
  });

  it("shows up-to-date toast on manual menu check when checkForUpdate resolves null immediately", async () => {
    await renderToast();

    await act(async () => {
      await emitEvent("menu:check-for-updates");
    });

    expect(mocks.checkForUpdate).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("update.toast.upToDate");

    // Auto-dismisses after 4000ms + 200ms fade-out.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4200);
    });
    expect(container.textContent).toBe("");
  });

  it("re-shows up-to-date toast and resets timer on repeated manual checks", async () => {
    await renderToast();

    await act(async () => {
      await emitEvent("menu:check-for-updates");
    });
    expect(container.textContent).toContain("update.toast.upToDate");

    // Dismiss manually via the close button, then trigger again before the 200ms fade finishes.
    const closeBtn = container.querySelector("button");
    expect(closeBtn).not.toBeNull();
    await act(async () => {
      closeBtn?.click();
      await vi.advanceTimersByTimeAsync(100);
      await emitEvent("menu:check-for-updates");
      await vi.advanceTimersByTimeAsync(200);
    });

    expect(container.textContent).toContain("update.toast.upToDate");

    // Advances past 3500ms after the second trigger: still visible, then hides at 4200ms.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3500);
    });
    expect(container.textContent).toContain("update.toast.upToDate");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(800);
    });
    expect(container.textContent).toBe("");
  });

  it("promotes an in-flight silent auto-check to show checking then up-to-date", async () => {
    const pending = deferred<UpdateHandle | null>();
    mocks.checkForUpdate.mockReturnValueOnce(pending.promise);

    await renderToast();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(mocks.checkForUpdate).toHaveBeenCalledTimes(1);
    expect(container.textContent).toBe("");

    await act(async () => {
      await emitEvent("menu:check-for-updates");
    });
    expect(container.textContent).toContain("update.toast.checking");

    await act(async () => {
      pending.resolve(null);
      await Promise.resolve();
    });
    expect(container.textContent).toContain("update.toast.upToDate");
  });

  it("recovers from a manual error to up-to-date on immediate Retry", async () => {
    mocks.checkForUpdate
      .mockRejectedValueOnce(new Error("network offline"))
      .mockResolvedValueOnce(null);

    await renderToast();

    await act(async () => {
      await emitEvent("menu:check-for-updates");
    });
    expect(container.textContent).toContain("network offline");

    const retryBtn = [...container.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("update.toast.retry"),
    );
    expect(retryBtn).toBeDefined();

    await act(async () => {
      retryBtn?.click();
      await Promise.resolve();
    });
    expect(container.textContent).toContain("update.toast.upToDate");
  });
});
