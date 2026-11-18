import { contextBridge, ipcRenderer, webUtils } from "electron";

function resolveInitialWindowLabel(): string {
  const arg = process.argv.find((a) => a.startsWith("--quill-window-label="));
  if (arg) {
    return arg.slice("--quill-window-label=".length);
  }
  return ipcRenderer.sendSync("quill:get-window-label") as string;
}

const initialWindowLabel = resolveInitialWindowLabel();

const bridge = {
  getWindowLabel(): string {
    return initialWindowLabel;
  },

  async invoke<T = unknown>(command: string, args?: Record<string, unknown>): Promise<T> {
    const res = (await ipcRenderer.invoke(
      "quill:invoke",
      command,
      JSON.stringify(args ?? {}),
    )) as { ok: true; data: T } | { ok: false; error: string };
    if (!res.ok) {
      throw res.error;
    }
    return res.data;
  },

  listen<T = unknown>(eventName: string, handler: (payload: T) => void): () => void {
    const listener = (_e: unknown, name: string, payload: unknown) => {
      if (name === eventName) {
        handler(payload as T);
      }
    };
    ipcRenderer.on("quill:event", listener);
    return () => {
      ipcRenderer.removeListener("quill:event", listener);
    };
  },

  listenCurrentWindow<T = unknown>(
    eventName: string,
    handler: (payload: T) => void,
  ): () => void {
    const listener = (_e: unknown, name: string, payload: unknown) => {
      if (name === eventName) {
        handler(payload as T);
      }
    };
    ipcRenderer.on("quill:window-event", listener);
    return () => {
      ipcRenderer.removeListener("quill:window-event", listener);
    };
  },

  emitTo<T = unknown>(windowLabel: string, event: string, payload?: T): Promise<void> {
    return ipcRenderer.invoke("quill:emit-to", windowLabel, event, payload);
  },

  appReady(): Promise<void> {
    return ipcRenderer.invoke("quill:app-ready");
  },

  setWindowTitle(title: string): Promise<void> {
    return ipcRenderer.invoke("quill:set-window-title", title);
  },

  focusWindow(label: string): Promise<boolean> {
    return ipcRenderer.invoke("quill:focus-window", label);
  },

  openReaderWindow(params: {
    label: string;
    url: string;
    title: string;
    width: number;
    height: number;
    minWidth: number;
    minHeight: number;
  }): Promise<void> {
    return ipcRenderer.invoke("quill:open-reader-window", params);
  },

  getOpenReaderCount(): Promise<number> {
    return ipcRenderer.invoke("quill:get-open-reader-count");
  },

  onWindowResized(handler: (size: { width: number; height: number }) => void): () => void {
    const listener = (_e: unknown, size: { width: number; height: number }) => {
      handler(size);
    };
    ipcRenderer.on("quill:window-resized", listener);
    return () => {
      ipcRenderer.removeListener("quill:window-resized", listener);
    };
  },

  setZoom(zoom: number): Promise<void> {
    return ipcRenderer.invoke("quill:set-zoom", zoom);
  },

  setTitlebarZoom(zoom: number): Promise<void> {
    return ipcRenderer.invoke("quill:set-titlebar-zoom", zoom);
  },

  openFileDialog(options: {
    multiple?: boolean;
    filters?: Array<{ name: string; extensions: string[] }>;
  }): Promise<string | null> {
    return ipcRenderer.invoke("quill:open-file-dialog", options);
  },

  openUrl(url: string): Promise<void> {
    return ipcRenderer.invoke("quill:open-url", url);
  },

  getAppVersion(): Promise<string> {
    return ipcRenderer.invoke("quill:get-app-version");
  },

  async checkForUpdate(): Promise<{ version: string; body?: string } | null> {
    const res = (await ipcRenderer.invoke("quill:check-for-update")) as
      | { ok: true; data: { version: string; body?: string } | null }
      | { ok: false; error: string };
    if (!res.ok) {
      throw new Error(res.error);
    }
    return res.data;
  },

  async downloadUpdate(): Promise<void> {
    const res = (await ipcRenderer.invoke("quill:download-update")) as
      | { ok: true; data: null }
      | { ok: false; error: string };
    if (!res.ok) {
      throw new Error(res.error);
    }
  },

  onUpdateProgress(
    handler: (event: {
      event: "Started" | "Progress" | "Finished";
      data: { contentLength?: number; chunkLength: number };
    }) => void,
  ): () => void {
    const listener = (
      _e: unknown,
      event: {
        event: "Started" | "Progress" | "Finished";
        data: { contentLength?: number; chunkLength: number };
      },
    ) => {
      handler(event);
    };
    ipcRenderer.on("quill:update-progress", listener);
    return () => {
      ipcRenderer.removeListener("quill:update-progress", listener);
    };
  },

  async relaunch(): Promise<void> {
    const res = (await ipcRenderer.invoke("quill:relaunch")) as
      | { ok: true }
      | { ok: false; error: string }
      | undefined;
    if (res && !res.ok) {
      throw new Error(res.error);
    }
  },

  getPathForFile(file: File): string {
    return webUtils.getPathForFile(file);
  },
};

contextBridge.exposeInMainWorld("quillShell", bridge);
