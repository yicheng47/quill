import { electronPlatform } from "./electron";
import { tauriPlatform } from "./tauri";
import type { Platform } from "./types";

export type {
  DragDropEvent,
  EventMessage,
  OpenDialogFilter,
  OpenFileDialogOptions,
  Platform,
  ReaderWindowParams,
  UnlistenFn,
  UpdateHandle,
  UpdateProgressEvent,
  WindowSize,
} from "./types";

const isElectron = typeof window !== "undefined" && Boolean(window.quillShell);

export const platform: Platform = isElectron ? electronPlatform : tauriPlatform;

export const invoke: Platform["invoke"] = (command, args) => platform.invoke(command, args);
export const listen: Platform["listen"] = (event, handler) => platform.listen(event, handler);
export const listenCurrentWindow: Platform["listenCurrentWindow"] = (event, handler) =>
  platform.listenCurrentWindow(event, handler);
export const emitTo: Platform["emitTo"] = (windowLabel, event, payload) =>
  platform.emitTo(windowLabel, event, payload);
export const getCurrentWindowLabel: Platform["getCurrentWindowLabel"] = () =>
  platform.getCurrentWindowLabel();
export const setWindowTitle: Platform["setWindowTitle"] = (title) =>
  platform.setWindowTitle(title);
export const appReady: Platform["appReady"] = () => platform.appReady();
export const focusWindow: Platform["focusWindow"] = (label) => platform.focusWindow(label);
export const openReaderWindow: Platform["openReaderWindow"] = (params) =>
  platform.openReaderWindow(params);
export const onWindowResized: Platform["onWindowResized"] = (handler) =>
  platform.onWindowResized(handler);
export const setZoom: Platform["setZoom"] = (zoom) => platform.setZoom(zoom);
export const setTitlebarZoom: Platform["setTitlebarZoom"] = (zoom) =>
  platform.setTitlebarZoom(zoom);
export const onDragDrop: Platform["onDragDrop"] = (handler) => platform.onDragDrop(handler);
export const convertFileSrc: Platform["convertFileSrc"] = (filePath) =>
  platform.convertFileSrc(filePath);
export const openFileDialog: Platform["openFileDialog"] = (options) =>
  platform.openFileDialog(options);
export const openUrl: Platform["openUrl"] = (url) => platform.openUrl(url);
export const getAppVersion: Platform["getAppVersion"] = () => platform.getAppVersion();
export const checkForUpdate: Platform["checkForUpdate"] = () => platform.checkForUpdate();
export const relaunch: Platform["relaunch"] = () => platform.relaunch();
