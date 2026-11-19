import path from "node:path";
import fs from "node:fs";
import { app, nativeImage, protocol } from "electron";
import { bootQuillCore, findRepoRoot, getLogDir, type QuillCoreInstance } from "./core";
import { registerIpcHandlers, readInitialAppearance } from "./ipc";
import { installAppMenu } from "./menu";
import { refreshMacBundleIconIfVersionChanged } from "./macIconRefresh";
import { registerProtocols } from "./protocols";
import { createElectronUpdaterService } from "./updater";
import {
  broadcastEvent,
  createMainWindow,
  focusManagedWindow,
  markQuitting,
  sendEventToWindow,
  setDefaultWindowIcon,
} from "./windows";

const isDev = !app.isPackaged;

// Keep Chromium's cache/localStorage outside `com.wycstudios.quill(-dev)` so
// the core data directory remains exclusively Quill's DB, secrets, and blobs.
app.setPath(
  "userData",
  path.join(
    app.getPath("appData"),
    isDev ? "com.wycstudios.quill-chromium-dev" : "com.wycstudios.quill-chromium",
  ),
);

protocol.registerSchemesAsPrivileged([
  {
    scheme: "quill-app",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    },
  },
  {
    scheme: "quill-file",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    },
  },
]);

function extractBookPaths(argv: string[]): string[] {
  return argv.filter((arg) => {
    if (arg.startsWith("-")) return false;
    const lower = arg.toLowerCase();
    return (
      (lower.endsWith(".epub") || lower.endsWith(".pdf")) && fs.existsSync(arg)
    );
  });
}

const pendingOpenFiles: string[] = extractBookPaths(process.argv.slice(1));
let mainWindowReady = false;
let core: QuillCoreInstance | null = null;

function dispatchFileOpen(paths: string[]): void {
  if (paths.length === 0) return;
  if (mainWindowReady) {
    focusManagedWindow("main");
    broadcastEvent("file-open", paths);
  } else {
    pendingOpenFiles.push(...paths);
  }
}

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on("open-file", (event, filePath) => {
    event.preventDefault();
    const paths = extractBookPaths([filePath]);
    dispatchFileOpen(paths);
  });

  app.on("second-instance", async (_event, argv) => {
    if (core && !focusManagedWindow("main")) {
      createMainWindow(await readInitialAppearance(core));
    }
    dispatchFileOpen(extractBookPaths(argv.slice(1)));
  });

  app.on("before-quit", () => {
    markQuitting();
  });

  app.on("will-quit", () => {
    core?.shutdown();
  });

  app.on("activate", async () => {
    if (!core) return;
    if (!focusManagedWindow("main")) {
      createMainWindow(await readInitialAppearance(core));
    }
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
      app.quit();
    }
  });

  void app
    .whenReady()
    .then(async () => {
      app.setAppLogsPath(getLogDir(isDev));

      if (isDev) {
        const repoRoot = findRepoRoot([__dirname, process.cwd(), app.getAppPath()]);
        const devIconPath = path.join(repoRoot, "build/icons/icon.png");
        if (fs.existsSync(devIconPath)) {
          if (process.platform === "darwin") {
            app.dock?.setIcon(nativeImage.createFromPath(devIconPath));
          } else {
            setDefaultWindowIcon(devIconPath);
          }
        }
      }

      core = await bootQuillCore({
        emitAll: (event, payload) => broadcastEvent(event, payload),
        emitTo: (windowLabel, event, payload) =>
          sendEventToWindow(windowLabel, event, payload),
      });

      const liveCore = core;
      void refreshMacBundleIconIfVersionChanged({
        isPackaged: app.isPackaged,
        platform: process.platform,
        currentVersion: app.getVersion(),
        execPath: process.execPath,
        dispatch: (cmd, argsJson) => liveCore.dispatch(cmd, argsJson),
        setDockIconFromPath: (icnsPath) => {
          const icon = nativeImage.createFromPath(icnsPath);
          if (!icon.isEmpty()) {
            app.dock?.setIcon(icon);
          }
        },
      });

      const updater = createElectronUpdaterService({
        isPackaged: () => app.isPackaged,
        getVersion: () => app.getVersion(),
        markQuitting,
      });

      registerProtocols(core, path.join(__dirname, "../renderer"));
      registerIpcHandlers(
        core,
        () => {
          mainWindowReady = true;
          if (pendingOpenFiles.length > 0) {
            const batch = pendingOpenFiles.splice(0, pendingOpenFiles.length);
            broadcastEvent("file-open", batch);
          }
        },
        updater,
      );
      installAppMenu(core, () => readInitialAppearance(core!));

      const initialAppearance = await readInitialAppearance(core);
      createMainWindow(initialAppearance);
    })
    .catch((err) => {
      console.error("Failed to boot Quill:", err);
      app.exit(1);
    });
}
