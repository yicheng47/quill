import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MenuItemConstructorOptions } from "electron";

const menuState = vi.hoisted(() => ({
  builtTemplate: [] as MenuItemConstructorOptions[],
  readyWindow: false,
  hasMainWindow: false,
}));

const mocks = vi.hoisted(() => ({
  broadcastEvent: vi.fn(),
  createMainWindow: vi.fn(() => {
    menuState.hasMainWindow = true;
  }),
  focusManagedWindow: vi.fn(() => menuState.hasMainWindow),
  whenWindowReady: vi.fn((_label: string, cb: () => void) => {
    if (menuState.readyWindow) {
      cb();
    } else {
      queuedCallbacks.push(cb);
    }
  }),
}));

const queuedCallbacks: Array<() => void> = [];

vi.mock("electron", () => ({
  app: { name: "Quill", isPackaged: false },
  Menu: {
    buildFromTemplate: vi.fn((template: MenuItemConstructorOptions[]) => {
      menuState.builtTemplate = template;
      return {};
    }),
    setApplicationMenu: vi.fn(),
  },
}));

vi.mock("./windows", () => ({
  broadcastEvent: mocks.broadcastEvent,
  createMainWindow: mocks.createMainWindow,
  focusManagedWindow: mocks.focusManagedWindow,
  whenWindowReady: mocks.whenWindowReady,
}));

import { installAppMenu } from "./menu";
import type { QuillCoreInstance } from "./core";

function findCheckForUpdatesItem(): MenuItemConstructorOptions {
  for (const top of menuState.builtTemplate) {
    const submenu = Array.isArray(top.submenu) ? top.submenu : [];
    const found = submenu.find((item) => item.label === "Check for Updates…");
    if (found) return found;
  }
  throw new Error("Check for Updates menu item not found");
}

describe("installAppMenu Check for Updates", () => {
  const core = { dispatch: vi.fn() } as unknown as QuillCoreInstance;

  beforeEach(() => {
    menuState.builtTemplate = [];
    menuState.readyWindow = false;
    menuState.hasMainWindow = false;
    queuedCallbacks.length = 0;
    mocks.broadcastEvent.mockReset();
    mocks.createMainWindow.mockClear();
    mocks.focusManagedWindow.mockClear();
    mocks.whenWindowReady.mockClear();
  });

  it("focuses existing ready main window and broadcasts immediately", async () => {
    menuState.hasMainWindow = true;
    menuState.readyWindow = true;

    installAppMenu(core, async () => false);
    const item = findCheckForUpdatesItem();
    await item.click?.({} as never, undefined, {} as never);

    expect(mocks.focusManagedWindow).toHaveBeenCalledWith("main");
    expect(mocks.createMainWindow).not.toHaveBeenCalled();
    expect(mocks.broadcastEvent).toHaveBeenCalledWith("menu:check-for-updates", null);
  });

  it("creates main window when missing and waits until ready before broadcasting", async () => {
    installAppMenu(core, async () => true);
    const item = findCheckForUpdatesItem();
    await item.click?.({} as never, undefined, {} as never);

    expect(mocks.createMainWindow).toHaveBeenCalledWith(true);
    expect(mocks.broadcastEvent).not.toHaveBeenCalled();

    for (const cb of queuedCallbacks.splice(0)) {
      cb();
    }
    expect(mocks.broadcastEvent).toHaveBeenCalledWith("menu:check-for-updates", null);
  });
});
