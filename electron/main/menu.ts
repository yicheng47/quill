import { app, Menu, type MenuItemConstructorOptions } from "electron";
import type { QuillCoreInstance } from "./core";
import { broadcastEvent, createMainWindow, focusManagedWindow, whenWindowReady } from "./windows";

export function installAppMenu(
  core: QuillCoreInstance,
  isInitialDark: () => Promise<boolean>,
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
    { role: "windowMenu" },
    {
      role: "help",
      submenu: isMac ? [revealLogsItem] : [revealLogsItem, checkForUpdatesItem],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
