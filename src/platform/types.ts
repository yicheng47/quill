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

export interface UpdateHandle {
  version: string;
  body?: string;
  downloadAndInstall(onEvent?: (event: UpdateProgressEvent) => void): Promise<void>;
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
  setWindowTitle(title: string): Promise<void>;
  appReady(): Promise<void>;
  focusWindow(label: string): Promise<boolean>;
  openReaderWindow(params: ReaderWindowParams): Promise<void>;
  onWindowResized(handler: (size: WindowSize) => void): Promise<UnlistenFn>;

  setZoom(zoom: number): Promise<void>;
  setTitlebarZoom(zoom: number): Promise<void>;

  onDragDrop(handler: (event: DragDropEvent) => void | Promise<void>): Promise<UnlistenFn>;
  convertFileSrc(filePath: string): string;
  openFileDialog(options: OpenFileDialogOptions): Promise<string | null>;

  openUrl(url: string): Promise<void>;
  getAppVersion(): Promise<string>;

  checkForUpdate(): Promise<UpdateHandle | null>;
  relaunch(): Promise<void>;
}
