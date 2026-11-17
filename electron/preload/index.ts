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

  getPathForFile(file: File): string {
    return webUtils.getPathForFile(file);
  },
};

contextBridge.exposeInMainWorld("quillShell", bridge);
