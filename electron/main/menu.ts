import { app, Menu, type MenuItemConstructorOptions } from "electron";
import type { QuillCoreInstance } from "./core";
import {
  broadcastEvent,
  createMainWindow,
  focusManagedWindow,
  toggleWindowZoom,
  whenWindowReady,
  type InitialAppearance,
} from "./windows";

export function installAppMenu(
  core: QuillCoreInstance,
  isInitialDark: () => Promise<boolean | InitialAppearance>,
): void {
  const isMac = process.platform === "darwin";
  const isDev = !app.isPackaged;

  const revealLogsItem: MenuItemConstructorOptions = {
    label: isMac ? "Reveal Logs in Finder" : "Show Logs in Explorer",
    click: () => {
      void core.dispatch("reveal_logs", "{}").catch((err) => {
        console.error("menu: reveal_logs failed:", err);
      });
    },
  };

  const checkForUpdatesItem: MenuItemConstructorOptions = {
    label: "Check for Updates…",
    click: async () => {
      if (!focusManagedWindow("main")) {
        createMainWindow(await isInitialDark());
      }
      whenWindowReady("main", () => {
        broadcastEvent("menu:check-for-updates", null);
      });
    },
  };

  const zoomWindowItem: MenuItemConstructorOptions = {
    label: "Zoom",
    click: (_item, focusedWindow) => {
      toggleWindowZoom(focusedWindow);
    },
  };

  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: "about" as const },
              checkForUpdatesItem,
              { type: "separator" as const },
              { role: "services" as const },
              { type: "separator" as const },
              { role: "hide" as const },
              { role: "hideOthers" as const },
              { role: "unhide" as const },
              { type: "separator" as const },
              { role: "quit" as const },
            ],
          },
        ]
      : []),
    { role: "fileMenu" },
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        ...(isDev
          ? [
              { role: "reload" as const },
              { role: "forceReload" as const },
              { role: "toggleDevTools" as const },
              { type: "separator" as const },
            ]
          : []),
        { role: "togglefullscreen" },
      ],
    },
    ...(isMac
      ? [
          {
            role: "windowMenu" as const,
            submenu: [
              { role: "minimize" as const },
              zoomWindowItem,
              { type: "separator" as const },
              { role: "front" as const },
            ],
          },
        ]
      : [{ role: "windowMenu" as const }]),
    {
      role: "help",
      submenu: isMac ? [revealLogsItem] : [revealLogsItem, checkForUpdatesItem],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
