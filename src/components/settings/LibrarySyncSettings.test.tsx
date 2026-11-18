/** @vitest-environment jsdom */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../../i18n";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn<(cmd: string, args?: Record<string, unknown>) => Promise<unknown>>(),
  getAppVersion: vi.fn<() => Promise<string>>(),
  listeners: new Map<string, Set<(e: { payload: unknown }) => void>>(),
}));

vi.mock("../../platform", () => ({
  invoke: (cmd: string, args?: Record<string, unknown>) =>
    args !== undefined ? mocks.invoke(cmd, args) : mocks.invoke(cmd),
  getAppVersion: () => mocks.getAppVersion(),
  listen: (event: string, cb: (e: { payload: unknown }) => void) => {
    const set = mocks.listeners.get(event) ?? new Set();
    set.add(cb);
    mocks.listeners.set(event, set);
    return Promise.resolve(() => {
      set.delete(cb);
    });
  },
}));

import LibrarySyncSettings, { type PeerInfo, type SyncStatus } from "./LibrarySyncSettings";
import type { SettingsProps } from "./types";

function makeStatus(overrides: Partial<SyncStatus> = {}): SyncStatus {
  return {
    enabled: false,
    available: true,
    sync_enabled: false,
    shared_dir: null,
    device_uuid: "mac-local-1",
    device_name: "Jason's MacBook Pro",
    peers: [],
    pending_events: 0,
    last_replay_at: Date.now() - 120_000,
    ...overrides,
  };
}

function makePeer(overrides: Partial<PeerInfo> = {}): PeerInfo {
  return {
    device_uuid: "peer-uuid-1",
    name: "Studio Mac",
    platform: "macos",
    app_version: "2.0.0",
    last_seen: Date.now() - 300_000,
    pending_events: 2,
    ...overrides,
  };
}

describe("LibrarySyncSettings state machine", () => {
  let container: HTMLDivElement;
  let root: Root;
  let onBlockingChange: ReturnType<typeof vi.fn<(blocking: boolean) => void>>;

  const flush = async () => {
    for (let i = 0; i < 4; i++) {
      await act(async () => {
        await Promise.resolve();
      });
    }
  };

  const renderSync = async () => {
    const props: SettingsProps = {
      settings: {},
      loading: false,
      save: vi.fn().mockResolvedValue(undefined),
      saveBulk: vi.fn().mockResolvedValue(undefined),
      showSavedToast: vi.fn(),
    };
    await act(async () => {
      root.render(<LibrarySyncSettings {...props} onBlockingChange={onBlockingChange} />);
    });
    await flush();
  };

  const emitEvent = async (name: string, payload: unknown) => {
    await act(async () => {
      for (const cb of mocks.listeners.get(name) ?? []) {
        cb({ payload });
      }
    });
  };

  beforeEach(async () => {
    await i18n.changeLanguage("en");
    mocks.invoke.mockReset();
    mocks.getAppVersion.mockReset().mockResolvedValue("2.0.0");
    mocks.listeners.clear();
    onBlockingChange = vi.fn();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    vi.useRealTimers();
    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it("renders Off state with merge note and enables sync through confirmation", async () => {
    vi.useFakeTimers();
    let currentStatus = makeStatus({ available: true, sync_enabled: false, enabled: false });
    mocks.invoke.mockImplementation(async (cmd) => {
      if (cmd === "sync_status") return currentStatus;
      if (cmd === "sync_enable") {
        currentStatus = makeStatus({ available: true, sync_enabled: true, enabled: true });
        return null;
      }
      return null;
    });

    await renderSync();

    const toggle = container.querySelector<HTMLButtonElement>(
      'button[role="switch"][aria-label="Sync with iCloud"]',
    );
    expect(toggle?.getAttribute("aria-checked")).toBe("false");
    expect(toggle?.disabled).toBe(false);
    expect(container.textContent).toContain("stored locally on this Mac only");
    expect(container.textContent).toContain("merges it with what's on this Mac");
    expect(container.querySelector('[data-testid="icloud-unavailable-hint"]')).toBeNull();

    await act(async () => {
      toggle?.click();
    });
    const confirmDialog = document.querySelector('[role="dialog"]');
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(confirmDialog?.textContent).toContain("Turn on iCloud Sync?");

    const confirmBtn = Array.from(confirmDialog?.querySelectorAll("button") ?? []).find((b) =>
      b.textContent?.includes("Turn on iCloud Sync"),
    ) as HTMLButtonElement | undefined;
    await act(async () => {
      confirmBtn?.click();
      await vi.advanceTimersByTimeAsync(1500);
    });
    await flush();

    expect(mocks.invoke).toHaveBeenCalledWith("sync_enable");
    expect(
      container.querySelector('button[role="switch"][aria-label="Sync with iCloud"]')?.getAttribute(
        "aria-checked",
      ),
    ).toBe("true");
  });

  it("renders !available state with disabled toggle and warning banner", async () => {
    mocks.invoke.mockResolvedValue(
      makeStatus({ available: false, sync_enabled: false, enabled: false }),
    );
    await renderSync();

    const toggle = container.querySelector<HTMLButtonElement>(
      'button[role="switch"][aria-label="Sync with iCloud"]',
    );
    expect(toggle?.disabled).toBe(true);
    const banner = container.querySelector('[data-testid="icloud-unavailable-hint"]');
    expect(banner?.textContent).toContain("Sign in to iCloud in System Settings");
  });

  it("renders Paused queue-only state when sync_enabled=true and enabled=false", async () => {
    mocks.invoke.mockResolvedValue(
      makeStatus({
        available: false,
        sync_enabled: true,
        enabled: false,
        pending_events: 3,
      }),
    );
    await renderSync();

    const toggle = container.querySelector<HTMLButtonElement>(
      'button[role="switch"][aria-label="Sync with iCloud"]',
    );
    expect(toggle?.getAttribute("aria-checked")).toBe("true");
    expect(toggle?.disabled).toBe(false);
    expect(container.textContent).toContain("Paused");
    expect(container.textContent).toContain("3 queued local changes");
    expect(container.textContent).toContain("3 changes queued locally");

    const compactBtn = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Compact log"),
    );
    const syncNowBtn = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Sync now"),
    );
    const resyncBtn = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Resync"),
    );
    expect(compactBtn?.disabled).toBe(true);
    expect(syncNowBtn?.disabled).toBe(true);
    expect(resyncBtn?.disabled).toBe(true);
  });

  it("renders error banner when enable fails and retries the failed action", async () => {
    vi.useFakeTimers();
    let attempts = 0;
    let status = makeStatus({ available: true, sync_enabled: false, enabled: false });
    mocks.invoke.mockImplementation(async (cmd) => {
      if (cmd === "sync_status") return status;
      if (cmd === "sync_enable") {
        attempts += 1;
        if (attempts === 1) {
          // Simulate half-committed marker before move error
          status = makeStatus({ available: true, sync_enabled: true, enabled: false });
          throw new Error("Failed to move library to iCloud");
        }
        status = makeStatus({ available: true, sync_enabled: true, enabled: true });
        return null;
      }
      return null;
    });

    await renderSync();

    const toggle = container.querySelector<HTMLButtonElement>(
      'button[role="switch"][aria-label="Sync with iCloud"]',
    );
    await act(async () => {
      toggle?.click();
    });
    const confirmBtn = Array.from(document.querySelectorAll('[role="dialog"] button')).find((b) =>
      b.textContent?.includes("Turn on iCloud Sync"),
    ) as HTMLButtonElement | undefined;
    await act(async () => {
      confirmBtn?.click();
      await vi.advanceTimersByTimeAsync(1500);
    });
    await flush();

    const banner = container.querySelector('[data-testid="sync-error-banner"]');
    expect(banner?.textContent).toContain("Failed to move library to iCloud");
    expect(banner?.textContent).toContain("retry to finish syncing");

    const retryBtn = Array.from(banner!.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Retry"),
    );
    await act(async () => {
      retryBtn?.click();
      await vi.advanceTimersByTimeAsync(1500);
    });
    await flush();

    expect(attempts).toBe(2);
    expect(container.querySelector('[data-testid="sync-error-banner"]')).toBeNull();
  });

  it("renders active Syncing progress card and invokes sync_cancel on Cancel", async () => {
    mocks.invoke.mockImplementation(async (cmd) => {
      if (cmd === "sync_status") {
        return makeStatus({ available: true, sync_enabled: true, enabled: true });
      }
      return null;
    });

    await renderSync();
    await emitEvent("sync-progress", { applied: 3, total: 5 });

    const activeCard = container.querySelector('[data-testid="sync-active-card"]');
    expect(activeCard?.textContent).toContain("Syncing with iCloud…");
    expect(activeCard?.textContent).toContain("3 / 5 (60%)");

    const cancelBtn = Array.from(activeCard!.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Cancel"),
    );
    await act(async () => {
      cancelBtn?.click();
    });
    expect(mocks.invoke).toHaveBeenCalledWith("sync_cancel");

    await emitEvent("sync-initial-tick-done", null);
    expect(container.querySelector('[data-testid="sync-active-card"]')).toBeNull();
  });

  it("shows non-dismissible Copying locally modal when turning sync off and tracks blocking state", async () => {
    vi.useFakeTimers();
    let resolveDisable!: () => void;
    let status = makeStatus({ available: true, sync_enabled: true, enabled: true });
    mocks.invoke.mockImplementation(async (cmd) => {
      if (cmd === "sync_status") return status;
      if (cmd === "sync_disable") {
        return new Promise<void>((resolve) => {
          resolveDisable = () => {
            status = makeStatus({ available: true, sync_enabled: false, enabled: false });
            resolve();
          };
        });
      }
      return null;
    });

    await renderSync();

    const toggle = container.querySelector<HTMLButtonElement>(
      'button[role="switch"][aria-label="Sync with iCloud"]',
    );
    await act(async () => {
      toggle?.click();
    });
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("Stop syncing with iCloud?");

    const stopBtn = Array.from(document.querySelectorAll('[role="dialog"] button')).find((b) =>
      b.textContent?.includes("Stop syncing"),
    ) as HTMLButtonElement | undefined;
    await act(async () => {
      stopBtn?.click();
    });

    expect(onBlockingChange).toHaveBeenCalledWith(true);
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    const copyingDialog = document.querySelector('[role="dialog"]');
    expect(copyingDialog?.textContent).toContain("Copying library to this Mac…");
    expect(document.activeElement).toBe(copyingDialog);

    await emitEvent("sync-disable-progress", {
      phase: "copying",
      copied: 3,
      total: 4,
      current: "Dune.epub",
    });
    expect(copyingDialog?.textContent).toContain("Copying · 3 of 4 files");
    expect(copyingDialog?.textContent).toContain("75%");
    expect(copyingDialog?.textContent).toContain("Dune.epub");

    // Escape, Tab, Enter, and Space must be intercepted and NOT dismiss the blocking copy modal
    for (const key of ["Escape", "Tab", "Enter", " "]) {
      const ev = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
      await act(async () => {
        document.dispatchEvent(ev);
      });
      expect(ev.defaultPrevented).toBe(true);
    }
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("Copying library to this Mac…");

    await act(async () => {
      resolveDisable();
      await vi.advanceTimersByTimeAsync(1500);
    });
    await flush();

    expect(onBlockingChange).toHaveBeenLastCalledWith(false);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it("renders single-device empty peers card when peers list is empty", async () => {
    mocks.invoke.mockResolvedValue(
      makeStatus({ available: true, sync_enabled: true, enabled: true, peers: [] }),
    );
    await renderSync();

    expect(container.textContent).toContain("This Mac");
    const emptyCard = container.querySelector('[data-testid="sync-empty-peers-card"]');
    expect(emptyCard?.textContent).toContain("Only this Mac is linked so far");
  });

  it("supports Compact log, Sync now, Cancel-focused Remove peer, and Cancel-focused Rebuild", async () => {
    let status = makeStatus({
      available: true,
      sync_enabled: true,
      enabled: true,
      peers: [makePeer()],
    });
    mocks.invoke.mockImplementation(async (cmd) => {
      if (cmd === "sync_status") return status;
      if (cmd === "sync_remove_peer") {
        status = makeStatus({ available: true, sync_enabled: true, enabled: true, peers: [] });
        return null;
      }
      if (cmd === "sync_compact") {
        return { events_folded: 4, snapshot_written: true, bytes_freed: 1200 };
      }
      if (cmd === "sync_now" || cmd === "sync_rebuild") {
        return { outbox_flushed: 0, snapshots_applied: 0, events_applied: 0, peers_seen: 1 };
      }
      return null;
    });

    await renderSync();
    expect(container.textContent).toContain("Synced");
    expect(container.textContent).toContain("Studio Mac");
    expect(container.textContent).toContain("2 pending");

    const compactBtn = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Compact log"),
    );
    await act(async () => {
      compactBtn?.click();
    });
    await flush();
    expect(mocks.invoke).toHaveBeenCalledWith("sync_compact");

    const syncNowBtn = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Sync now"),
    );
    await act(async () => {
      syncNowBtn?.click();
    });
    await flush();
    expect(mocks.invoke).toHaveBeenCalledWith("sync_now");

    // Remove peer modal focuses Cancel by default, portals to body, and deletes on confirmation
    const trashBtn = container.querySelector<HTMLButtonElement>('button[aria-label="Remove Studio Mac"]');
    await act(async () => {
      trashBtn?.click();
    });
    const removeDialog = document.querySelector('[role="dialog"]');
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(removeDialog?.textContent).toContain('Remove "Studio Mac" from iCloud Sync?');
    expect(document.activeElement?.textContent).toBe("Cancel");

    const confirmRemoveBtn = Array.from(removeDialog!.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Remove device"),
    );
    await act(async () => {
      confirmRemoveBtn?.click();
    });
    await flush();
    expect(mocks.invoke).toHaveBeenCalledWith("sync_remove_peer", { deviceUuid: "peer-uuid-1" });

    // Rebuild modal focuses Cancel by default, portals to body, and invokes sync_rebuild on confirmation
    const rebuildBtn = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent === "Resync",
    );
    await act(async () => {
      rebuildBtn?.click();
    });
    const rebuildDialog = document.querySelector('[role="dialog"]');
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(rebuildDialog?.textContent).toContain("Rebuild local library from iCloud?");
    expect(document.activeElement?.textContent).toBe("Cancel");

    const confirmRebuildBtn = Array.from(rebuildDialog!.querySelectorAll("button")).find(
      (b) => b.textContent === "Resync",
    );
    await act(async () => {
      confirmRebuildBtn?.click();
    });
    await flush();
    expect(mocks.invoke).toHaveBeenCalledWith("sync_rebuild");
  });
});
