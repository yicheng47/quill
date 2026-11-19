import type {
  DragDropEvent,
  EventMessage,
  OpenFileDialogOptions,
  Platform,
  PlatformInfo,
  ReaderWindowParams,
  UnlistenFn,
  UpdateHandle,
  UpdateProgressEvent,
  WindowSize,
} from "./types";

interface AvailableUpdateInfo {
  version: string;
  body?: string;
  sizeBytes?: number;
}

interface QuillShellBridge {
  getWindowLabel(): string;
  getInitialDark?(): boolean | null;
  getInitialReaderTheme?(): string;
  invoke<T = unknown>(command: string, args?: Record<string, unknown>): Promise<T>;
  listen<T = unknown>(eventName: string, handler: (payload: T) => void): UnlistenFn;
  listenCurrentWindow<T = unknown>(
    eventName: string,
    handler: (payload: T) => void,
  ): UnlistenFn;
  emitTo<T = unknown>(windowLabel: string, event: string, payload?: T): Promise<void>;
  appReady(): Promise<void>;
  setWindowTitle(title: string): Promise<void>;
  setWindowBackgroundColor(color: string): Promise<void>;
  minimizeWindow(): Promise<void>;
  toggleMaximizeWindow(): Promise<void>;
  closeWindow(): Promise<void>;
  isWindowMaximized(): Promise<boolean>;
  onWindowMaximized(handler: (maximized: boolean) => void): UnlistenFn;
  focusWindow(label: string): Promise<boolean>;
  openReaderWindow(params: ReaderWindowParams): Promise<void>;
  getOpenReaderCount(): Promise<number>;
  onWindowResized(handler: (size: WindowSize) => void): UnlistenFn;
  setZoom(zoom: number): Promise<void>;
  setTitlebarZoom(zoom: number): Promise<void>;
  openFileDialog(options: OpenFileDialogOptions): Promise<string | null>;
  openUrl(url: string): Promise<void>;
  getAppVersion(): Promise<string>;
  getPlatformInfo?(): Promise<PlatformInfo>;
  checkForUpdate(): Promise<AvailableUpdateInfo | null>;
  downloadUpdate(): Promise<{ cancelled: boolean } | void>;
  cancelUpdateDownload?(): Promise<boolean>;
  onUpdateProgress(handler: (event: UpdateProgressEvent) => void): UnlistenFn;
  relaunch(): Promise<void>;
  getPathForFile(file: File): string;
}

function fallbackPlatformInfo(): PlatformInfo {
  if (typeof navigator === "undefined") {
    return { platform: "", arch: "" };
  }
  const ua = navigator.userAgent.toLowerCase();
  const arch =
    ua.includes("arm64") || ua.includes("aarch64")
      ? "arm64"
      : ua.includes("x86_64") || ua.includes("x64")
        ? "x64"
        : "";
  const platform = ua.includes("mac")
    ? "darwin"
    : ua.includes("win")
      ? "win32"
      : ua.includes("linux")
        ? "linux"
        : "";
  return { platform, arch };
}

declare global {
  interface Window {
    quillShell?: QuillShellBridge;
  }
}

function bridge(): QuillShellBridge {
  if (!window.quillShell) {
    throw new Error("Electron preload bridge (window.quillShell) is unavailable");
  }
  return window.quillShell;
}

function hasDraggedFiles(event: DragEvent): boolean {
  const types = event.dataTransfer?.types;
  return Boolean(types && Array.from(types).includes("Files"));
}

export const electronPlatform: Platform = {
  invoke<T = unknown>(command: string, args?: Record<string, unknown>): Promise<T> {
    return bridge().invoke<T>(command, args);
  },

  async listen<T = unknown>(
    event: string,
    handler: (event: EventMessage<T>) => void,
  ): Promise<UnlistenFn> {
    return bridge().listen<T>(event, (payload) => handler({ payload }));
  },

  async listenCurrentWindow<T = unknown>(
    event: string,
    handler: (event: EventMessage<T>) => void,
  ): Promise<UnlistenFn> {
    return bridge().listenCurrentWindow<T>(event, (payload) => handler({ payload }));
  },

  emitTo<T = unknown>(windowLabel: string, event: string, payload?: T): Promise<void> {
    return bridge().emitTo(windowLabel, event, payload);
  },

  getCurrentWindowLabel(): string {
    return window.quillShell ? window.quillShell.getWindowLabel() : "main";
  },

  getInitialDark(): boolean | null {
    return window.quillShell?.getInitialDark?.() ?? null;
  },

  getInitialReaderTheme(): string {
    return window.quillShell?.getInitialReaderTheme?.() ?? "original";
  },

  setWindowTitle(title: string): Promise<void> {
    return bridge().setWindowTitle(title);
  },

  setWindowBackgroundColor(color: string): Promise<void> {
    return bridge().setWindowBackgroundColor(color);
  },

  async minimizeWindow(): Promise<void> {
    return bridge().minimizeWindow();
  },

  async toggleMaximizeWindow(): Promise<void> {
    return bridge().toggleMaximizeWindow();
  },

  async closeWindow(): Promise<void> {
    return bridge().closeWindow();
  },

  async isWindowMaximized(): Promise<boolean> {
    return bridge().isWindowMaximized();
  },

  async onWindowMaximized(handler: (maximized: boolean) => void): Promise<UnlistenFn> {
    return bridge().onWindowMaximized(handler);
  },

  appReady(): Promise<void> {
    return bridge().appReady();
  },

  focusWindow(label: string): Promise<boolean> {
    return bridge().focusWindow(label);
  },

  openReaderWindow(params: ReaderWindowParams): Promise<void> {
    return bridge().openReaderWindow(params);
  },

  getOpenReaderCount(): Promise<number> {
    return bridge().getOpenReaderCount();
  },

  async onWindowResized(handler: (size: WindowSize) => void): Promise<UnlistenFn> {
    return bridge().onWindowResized(handler);
  },

  setZoom(zoom: number): Promise<void> {
    return bridge().setZoom(zoom);
  },

  setTitlebarZoom(zoom: number): Promise<void> {
    return bridge().setTitlebarZoom(zoom);
  },

  async onDragDrop(
    handler: (event: DragDropEvent) => void | Promise<void>,
  ): Promise<UnlistenFn> {
    let dragDepth = 0;

    const onDragEnter = (e: DragEvent) => {
      if (!hasDraggedFiles(e)) return;
      e.preventDefault();
      e.stopPropagation();
      dragDepth += 1;
      if (dragDepth === 1) {
        void handler({ type: "enter", paths: [] });
      }
    };

    const onDragOver = (e: DragEvent) => {
      if (!hasDraggedFiles(e)) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.dataTransfer) {
        e.dataTransfer.dropEffect = "copy";
      }
      void handler({ type: "over" });
    };

    const onDragLeave = (e: DragEvent) => {
      if (!hasDraggedFiles(e)) return;
      dragDepth = Math.max(0, dragDepth - 1);
      if (dragDepth === 0) {
        void handler({ type: "leave" });
      }
    };

    const onDrop = (e: DragEvent) => {
      if (!hasDraggedFiles(e)) return;
      e.preventDefault();
      e.stopPropagation();
      dragDepth = 0;
      const files = Array.from(e.dataTransfer?.files ?? []);
      const paths = files
        .map((file) => bridge().getPathForFile(file))
        .filter((p) => p.length > 0);
      void handler({ type: "drop", paths });
    };

    window.addEventListener("dragenter", onDragEnter, true);
    window.addEventListener("dragover", onDragOver, true);
    window.addEventListener("dragleave", onDragLeave, true);
    window.addEventListener("drop", onDrop, true);

    return () => {
      window.removeEventListener("dragenter", onDragEnter, true);
      window.removeEventListener("dragover", onDragOver, true);
      window.removeEventListener("dragleave", onDragLeave, true);
      window.removeEventListener("drop", onDrop, true);
    };
  },

  convertFileSrc(filePath: string): string {
    return `quill-file://local/?path=${encodeURIComponent(filePath)}`;
  },

  openFileDialog(options: OpenFileDialogOptions): Promise<string | null> {
    return bridge().openFileDialog(options);
  },

  openUrl(url: string): Promise<void> {
    return bridge().openUrl(url);
  },

  getAppVersion(): Promise<string> {
    return bridge().getAppVersion();
  },

  getPlatformInfo(): Promise<PlatformInfo> {
    const fn = window.quillShell?.getPlatformInfo;
    return fn ? fn() : Promise.resolve(fallbackPlatformInfo());
  },

  async checkForUpdate(): Promise<UpdateHandle | null> {
    const info = await bridge().checkForUpdate();
    if (!info) {
      return null;
    }
    return {
      version: info.version,
      body: info.body,
      sizeBytes: info.sizeBytes,
      async downloadAndInstall(
        onEvent?: (event: UpdateProgressEvent) => void,
      ): Promise<{ cancelled: boolean }> {
        const unsubscribe = onEvent
          ? bridge().onUpdateProgress((event) => onEvent(event))
          : undefined;
        try {
          const res = await bridge().downloadUpdate();
          return res ?? { cancelled: false };
        } finally {
          unsubscribe?.();
        }
      },
    };
  },

  cancelUpdateDownload(): Promise<boolean> {
    const fn = bridge().cancelUpdateDownload;
    return fn ? fn() : Promise.resolve(false);
  },

  relaunch(): Promise<void> {
    return bridge().relaunch();
  },
};
