import fs from "node:fs";
import path from "node:path";
import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import { findRepoRoot, type QuillCoreInstance } from "./core";
import { isSafeHttpUrl } from "./urlSecurity";
import {
  appReadyForWindow,
  createReaderWindow,
  focusManagedWindow,
  getWindow,
  labelForWebContents,
  resolveInitialDark,
  sendEventToWindow,
  setTitlebarZoomForWindow,
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

export function registerIpcHandlers(
  core: QuillCoreInstance,
  onFirstReady?: () => void,
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

  ipcMain.handle("quill:focus-window", (_event, label: string): boolean => {
    return focusManagedWindow(label);
  });

  ipcMain.handle(
    "quill:open-reader-window",
    async (_event, params: ReaderWindowParams) => {
      const dark = await readInitialDark(core);
      createReaderWindow(params, dark);
    },
  );

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
}
