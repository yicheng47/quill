import { contextBridge, ipcRenderer, webUtils } from "electron";

function resolveInitialWindowLabel(): string {
  const arg = process.argv.find((a) => a.startsWith("--quill-window-label="));
  if (arg) {
    return arg.slice("--quill-window-label=".length);
  }
  return ipcRenderer.sendSync("quill:get-window-label") as string;
}

function resolveInitialReaderTheme(): string {
  const arg = process.argv.find((a) => a.startsWith("--quill-reader-theme="));
  return arg ? arg.slice("--quill-reader-theme=".length) : "original";
}

function resolveInitialDark(): boolean | null {
  const arg = process.argv.find((a) => a.startsWith("--quill-initial-dark="));
  if (!arg) return null;
  return arg.slice("--quill-initial-dark=".length) === "1";
}

const initialWindowLabel = resolveInitialWindowLabel();
const initialReaderTheme = resolveInitialReaderTheme();
const initialDark = resolveInitialDark();

const bridge = {
  getWindowLabel(): string {
    return initialWindowLabel;
  },

  getInitialReaderTheme(): string {
    return initialReaderTheme;
  },

  getInitialDark(): boolean | null {
    return initialDark;
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

  minimizeWindow(): Promise<void> {
    return ipcRenderer.invoke("quill:minimize-window");
  },

  toggleMaximizeWindow(): Promise<void> {
    return ipcRenderer.invoke("quill:toggle-maximize-window");
  },

  closeWindow(): Promise<void> {
    return ipcRenderer.invoke("quill:close-window");
  },

  isWindowMaximized(): Promise<boolean> {
    return ipcRenderer.invoke("quill:is-window-maximized");
  },

  onWindowMaximized(handler: (maximized: boolean) => void): () => void {
    const listener = (_e: unknown, maximized: boolean) => {
      handler(maximized);
    };
    ipcRenderer.on("quill:window-maximized", listener);
    return () => {
      ipcRenderer.removeListener("quill:window-maximized", listener);
    };
  },

  setWindowBackgroundColor(color: string): Promise<void> {
    return ipcRenderer.invoke("quill:set-window-background", color);
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
    pageTheme?: string;
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
    allowDirectory?: boolean;
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

  getPlatformInfo(): Promise<{ platform: string; arch: string }> {
    return ipcRenderer.invoke("quill:get-platform-info");
  },

  async checkForUpdate(): Promise<{ version: string; body?: string; sizeBytes?: number } | null> {
    const res = (await ipcRenderer.invoke("quill:check-for-update")) as
      | { ok: true; data: { version: string; body?: string; sizeBytes?: number } | null }
      | { ok: false; error: string };
    if (!res.ok) {
      throw new Error(res.error);
    }
    return res.data;
  },

  async downloadUpdate(): Promise<{ cancelled: boolean }> {
    const res = (await ipcRenderer.invoke("quill:download-update")) as
      | { ok: true; data: { cancelled: boolean } | null }
      | { ok: false; error: string };
    if (!res.ok) {
      throw new Error(res.error);
    }
    return res.data ?? { cancelled: false };
  },

  cancelUpdateDownload(): Promise<boolean> {
    return ipcRenderer.invoke("quill:cancel-update-download");
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
