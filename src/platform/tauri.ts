import { getVersion } from "@tauri-apps/api/app";
import { convertFileSrc as tauriConvertFileSrc, invoke as tauriInvoke } from "@tauri-apps/api/core";
import { emitTo as tauriEmitTo, listen as tauriListen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWebviewWindow, WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { open as tauriOpenDialog } from "@tauri-apps/plugin-dialog";
import { openUrl as tauriOpenUrl } from "@tauri-apps/plugin-opener";
import { relaunch as tauriRelaunch } from "@tauri-apps/plugin-process";
import { check as tauriCheckUpdate } from "@tauri-apps/plugin-updater";
import type {
  DragDropEvent,
  EventMessage,
  OpenFileDialogOptions,
  Platform,
  ReaderWindowParams,
  UnlistenFn,
  UpdateHandle,
  WindowSize,
} from "./types";

export const tauriPlatform: Platform = {
  invoke<T = unknown>(command: string, args?: Record<string, unknown>): Promise<T> {
    return tauriInvoke<T>(command, args);
  },

  listen<T = unknown>(
    event: string,
    handler: (event: EventMessage<T>) => void,
  ): Promise<UnlistenFn> {
    return tauriListen<T>(event, (e) => handler({ payload: e.payload }));
  },

  listenCurrentWindow<T = unknown>(
    event: string,
    handler: (event: EventMessage<T>) => void,
  ): Promise<UnlistenFn> {
    return getCurrentWebview().listen<T>(event, (e) => handler({ payload: e.payload }));
  },

  emitTo<T = unknown>(windowLabel: string, event: string, payload?: T): Promise<void> {
    return tauriEmitTo(windowLabel, event, payload);
  },

  getCurrentWindowLabel(): string {
    try {
      return getCurrentWebviewWindow().label;
    } catch {
      return "main";
    }
  },

  setWindowTitle(title: string): Promise<void> {
    return getCurrentWebviewWindow().setTitle(title);
  },

  appReady(): Promise<void> {
    return tauriInvoke<void>("app_ready");
  },

  async focusWindow(label: string): Promise<boolean> {
    const existing = await WebviewWindow.getByLabel(label);
    if (!existing) return false;
    await existing.show();
    await existing.unminimize();
    await existing.setFocus();
    return true;
  },

  async openReaderWindow(params: ReaderWindowParams): Promise<void> {
    new WebviewWindow(params.label, {
      url: params.url,
      title: params.title,
      width: params.width,
      height: params.height,
      minWidth: params.minWidth,
      minHeight: params.minHeight,
      titleBarStyle: "overlay",
      hiddenTitle: true,
      visible: false,
    });
  },

  onWindowResized(handler: (size: WindowSize) => void): Promise<UnlistenFn> {
    const appWindow = getCurrentWebviewWindow();
    return appWindow.onResized(async ({ payload }) => {
      try {
        const scale = await appWindow.scaleFactor();
        const logical = payload.toLogical(scale);
        handler({ width: logical.width, height: logical.height });
      } catch {
        // Window may have closed while scaleFactor was in flight.
      }
    });
  },

  setZoom(zoom: number): Promise<void> {
    return getCurrentWebview().setZoom(zoom);
  },

  setTitlebarZoom(zoom: number): Promise<void> {
    return tauriInvoke<void>("window_set_titlebar_zoom", { zoom });
  },

  onDragDrop(handler: (event: DragDropEvent) => void | Promise<void>): Promise<UnlistenFn> {
    return getCurrentWebview().onDragDropEvent((event) => {
      const p = event.payload;
      if (p.type === "enter") {
        void handler({ type: "enter", paths: p.paths });
      } else if (p.type === "over") {
        void handler({ type: "over" });
      } else if (p.type === "drop") {
        void handler({ type: "drop", paths: p.paths });
      } else {
        void handler({ type: "leave" });
      }
    });
  },

  convertFileSrc(filePath: string): string {
    return tauriConvertFileSrc(filePath);
  },

  async openFileDialog(options: OpenFileDialogOptions): Promise<string | null> {
    const selected = await tauriOpenDialog({
      multiple: options.multiple ?? false,
      filters: options.filters,
    });
    if (Array.isArray(selected)) return selected[0] ?? null;
    return selected;
  },

  openUrl(url: string): Promise<void> {
    return tauriOpenUrl(url);
  },

  getAppVersion(): Promise<string> {
    return getVersion();
  },

  async checkForUpdate(): Promise<UpdateHandle | null> {
    const update = await tauriCheckUpdate();
    if (!update) return null;
    return {
      version: update.version,
      body: update.body,
      downloadAndInstall: (onEvent) =>
        update.downloadAndInstall(
          onEvent
            ? (ev) => {
                if (ev.event === "Started") {
                  onEvent({
                    event: "Started",
                    data: {
                      contentLength: ev.data.contentLength,
                      chunkLength: 0,
                    },
                  });
                } else if (ev.event === "Progress") {
                  onEvent({
                    event: "Progress",
                    data: {
                      chunkLength: ev.data.chunkLength,
                    },
                  });
                } else {
                  onEvent({
                    event: "Finished",
                    data: { chunkLength: 0 },
                  });
                }
              }
            : undefined,
        ),
    };
  },

  relaunch(): Promise<void> {
    return tauriRelaunch();
  },
};
