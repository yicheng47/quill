export type UnlistenFn = () => void;

export interface EventMessage<T = unknown> {
  payload: T;
}

export type DragDropEvent =
  | { type: "enter"; paths: string[] }
  | { type: "over" }
  | { type: "drop"; paths: string[] }
  | { type: "leave" };

export interface OpenDialogFilter {
  name: string;
  extensions: string[];
}

export interface OpenFileDialogOptions {
  multiple?: boolean;
  allowDirectory?: boolean;
  directoryOnly?: boolean;
  filters?: OpenDialogFilter[];
}

export interface ReaderWindowParams {
  label: string;
  url: string;
  title: string;
  width: number;
  height: number;
  minWidth: number;
  minHeight: number;
  pageTheme?: string;
}

export interface WindowSize {
  width: number;
  height: number;
}

export interface UpdateProgressEvent {
  event: "Started" | "Progress" | "Finished";
  data: {
    contentLength?: number;
    chunkLength: number;
  };
}

export interface PlatformInfo {
  platform: string;
  arch: string;
}

export interface UpdateHandle {
  version: string;
  body?: string;
  sizeBytes?: number;
  downloadAndInstall(
    onEvent?: (event: UpdateProgressEvent) => void,
  ): Promise<{ cancelled: boolean } | void>;
}

export interface Platform {
  invoke<T = unknown>(command: string, args?: Record<string, unknown>): Promise<T>;
  listen<T = unknown>(event: string, handler: (event: EventMessage<T>) => void): Promise<UnlistenFn>;
  listenCurrentWindow<T = unknown>(
    event: string,
    handler: (event: EventMessage<T>) => void,
  ): Promise<UnlistenFn>;
  emitTo<T = unknown>(windowLabel: string, event: string, payload?: T): Promise<void>;

  getCurrentWindowLabel(): string;
  getInitialDark(): boolean | null;
  getInitialReaderTheme(): string;
  setWindowTitle(title: string): Promise<void>;
  setWindowBackgroundColor(color: string): Promise<void>;
  minimizeWindow(): Promise<void>;
  toggleMaximizeWindow(): Promise<void>;
  closeWindow(): Promise<void>;
  isWindowMaximized(): Promise<boolean>;
  onWindowMaximized(handler: (maximized: boolean) => void): Promise<UnlistenFn>;
  appReady(): Promise<void>;
  focusWindow(label: string): Promise<boolean>;
  openReaderWindow(params: ReaderWindowParams): Promise<void>;
  getOpenReaderCount(): Promise<number>;
  onWindowResized(handler: (size: WindowSize) => void): Promise<UnlistenFn>;

  setZoom(zoom: number): Promise<void>;
  setTitlebarZoom(zoom: number): Promise<void>;

  onDragDrop(handler: (event: DragDropEvent) => void | Promise<void>): Promise<UnlistenFn>;
  convertFileSrc(filePath: string): string;
  openFileDialog(options: OpenFileDialogOptions): Promise<string | null>;

  openUrl(url: string): Promise<void>;
  getAppVersion(): Promise<string>;
  getPlatformInfo(): Promise<PlatformInfo>;

  checkForUpdate(): Promise<UpdateHandle | null>;
  cancelUpdateDownload(): Promise<boolean>;
  relaunch(): Promise<void>;
}
