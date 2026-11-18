import fs from "node:fs";
import path from "node:path";
import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import { findRepoRoot, type QuillCoreInstance } from "./core";
import type { AvailableUpdateInfo, QuillUpdaterService } from "./updater";
import { isSafeHttpUrl } from "./urlSecurity";
import {
  appReadyForWindow,
  createReaderWindow,
  focusManagedWindow,
  getOpenReaderWindowCount,
  getWindow,
  labelForWebContents,
  markQuitting,
  resolveInitialDark,
  sendEventToWindow,
  setTitlebarZoomForWindow,
  setWindowBackgroundColor,
  type ReaderWindowParams,
} from "./windows";

export type InvokeResult =
  | { ok: true; data: unknown }
  | { ok: false; error: string };

interface OpenFileDialogOptions {
  multiple?: boolean;
  filters?: Array<{ name: string; extensions: string[] }>;
}

const INITIAL_THEME_TIMEOUT_MS = 250;

export async function readInitialDark(
  core: Pick<QuillCoreInstance, "dispatch">,
  timeoutMs = INITIAL_THEME_TIMEOUT_MS,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const raw = await Promise.race([
      core.dispatch("get_setting", JSON.stringify({ key: "theme" })),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs);
      }),
    ]);
    if (raw === null) {
      return resolveInitialDark(null);
    }
    const parsed = JSON.parse(raw) as string | null;
    return resolveInitialDark(parsed);
  } catch {
    return resolveInitialDark(null);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

export async function readStoredReaderTheme(
  core: Pick<QuillCoreInstance, "dispatch">,
  bookOverride?: string | null,
  timeoutMs = INITIAL_THEME_TIMEOUT_MS,
): Promise<string> {
  if (
    bookOverride === "original" ||
    bookOverride === "paper" ||
    bookOverride === "quiet" ||
    bookOverride === "dark"
  ) {
    return bookOverride;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const raw = await Promise.race([
      core.dispatch("get_setting", JSON.stringify({ key: "reader_theme" })),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs);
      }),
    ]);
    if (raw === null) return "original";
    const parsed = JSON.parse(raw) as string | null;
    return parsed || "original";
  } catch {
    return "original";
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

export function registerIpcHandlers(
  core: QuillCoreInstance,
  onFirstReady?: () => void,
  updater?: Pick<QuillUpdaterService, "checkForUpdate" | "downloadAndInstall" | "relaunchAndInstall">,
): void {
  let firstReadyFired = false;

  ipcMain.on("quill:get-window-label", (event) => {
    event.returnValue = labelForWebContents(event.sender.id) ?? "main";
  });

  ipcMain.handle(
    "quill:invoke",
    async (_event, command: string, argsJson: string): Promise<InvokeResult> => {
      try {
        const raw = await core.dispatch(command, argsJson ?? "{}");
        return { ok: true, data: raw ? JSON.parse(raw) : null };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { ok: false, error: msg };
      }
    },
  );

  ipcMain.handle("quill:app-ready", (event) => {
    const label = labelForWebContents(event.sender.id) ?? "main";
    appReadyForWindow(label);
    if (label === "main" && !firstReadyFired) {
      firstReadyFired = true;
      onFirstReady?.();
    }
  });

  ipcMain.handle("quill:set-window-title", (event, title: string) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win && !win.isDestroyed()) {
      win.setTitle(title);
    }
  });

  ipcMain.handle("quill:set-window-background", (event, color: string) => {
    if (typeof color !== "string" || !/^#[0-9a-fA-F]{6}$/.test(color)) return;
    const label = labelForWebContents(event.sender.id);
    if (label) {
      setWindowBackgroundColor(label, color);
      return;
    }
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win && !win.isDestroyed()) {
      win.setBackgroundColor(color);
    }
  });

  ipcMain.handle("quill:focus-window", (_event, label: string): boolean => {
    return focusManagedWindow(label);
  });

  ipcMain.handle(
    "quill:open-reader-window",
    async (_event, params: ReaderWindowParams) => {
      const [dark, pageTheme] = await Promise.all([
        readInitialDark(core),
        readStoredReaderTheme(core, params.pageTheme),
      ]);
      createReaderWindow({ ...params, pageTheme }, dark);
    },
  );

  ipcMain.handle("quill:get-open-reader-count", () => {
    return getOpenReaderWindowCount();
  });

  ipcMain.handle(
    "quill:emit-to",
    (_event, windowLabel: string, eventName: string, payload: unknown) => {
      sendEventToWindow(windowLabel, eventName, payload);
    },
  );

  ipcMain.handle("quill:set-zoom", (event, zoom: number) => {
    event.sender.setZoomFactor(zoom);
  });

  ipcMain.handle("quill:set-titlebar-zoom", (event, zoom: number) => {
    const label = labelForWebContents(event.sender.id);
    if (label) {
      setTitlebarZoomForWindow(label, zoom);
    }
  });

  ipcMain.handle(
    "quill:open-file-dialog",
    async (event, options: OpenFileDialogOptions): Promise<string | null> => {
      const owner = BrowserWindow.fromWebContents(event.sender) ?? getWindow("main");
      const dialogOptions: Electron.OpenDialogOptions = {
        properties: options.multiple ? ["openFile", "multiSelections"] : ["openFile"],
        filters: options.filters,
      };
      const res = owner
        ? await dialog.showOpenDialog(owner, dialogOptions)
        : await dialog.showOpenDialog(dialogOptions);
      if (res.canceled || res.filePaths.length === 0) {
        return null;
      }
      return res.filePaths[0];
    },
  );

  ipcMain.handle("quill:open-url", async (_event, url: string) => {
    if (isSafeHttpUrl(url)) {
      await shell.openExternal(url);
    }
  });

  ipcMain.handle("quill:get-app-version", () => {
    if (app.isPackaged) {
      return app.getVersion();
    }
    try {
      const pkgPath = path.join(findRepoRoot([__dirname, process.cwd()]), "package.json");
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as { version?: string };
      return pkg.version ?? app.getVersion();
    } catch {
      return app.getVersion();
    }
  });

  ipcMain.handle(
    "quill:check-for-update",
    async (): Promise<{ ok: true; data: AvailableUpdateInfo | null } | { ok: false; error: string }> => {
      if (!updater) {
        return { ok: true, data: null };
      }
      try {
        const update = await updater.checkForUpdate();
        return { ok: true, data: update };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { ok: false, error: msg };
      }
    },
  );

  ipcMain.handle(
    "quill:download-update",
    async (event): Promise<{ ok: true; data: null } | { ok: false; error: string }> => {
      if (!updater) {
        return { ok: false, error: "Updater is not configured" };
      }
      try {
        await updater.downloadAndInstall((progressEvent) => {
          if (!event.sender.isDestroyed()) {
            event.sender.send("quill:update-progress", progressEvent);
          }
        });
        return { ok: true, data: null };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { ok: false, error: msg };
      }
    },
  );

  ipcMain.handle(
    "quill:relaunch",
    async (): Promise<{ ok: true } | { ok: false; error: string }> => {
      try {
        if (updater) {
          await updater.relaunchAndInstall();
          return { ok: true };
        }
        if (app.isPackaged) {
          markQuitting();
          app.relaunch();
          app.exit(0);
        }
        return { ok: true };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { ok: false, error: msg };
      }
    },
  );
}
