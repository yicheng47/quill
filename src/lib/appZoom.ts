import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import {
  notifySameWindowStorage,
  readAppZoom,
  STORAGE_APP_ZOOM,
  writeAppZoom,
  ZOOM_STEPS,
} from "./settings";

export function syncTitlebarZoom(zoom: number): Promise<void> {
  try {
    return invoke<void>("window_set_titlebar_zoom", { zoom }).catch(() => {});
  } catch {
    return Promise.resolve();
  }
}

export function restoreAppZoom(zoom: number): Promise<void> {
  const titlebarZoom = syncTitlebarZoom(zoom);
  let webviewZoom = Promise.resolve();
  try {
    webviewZoom = getCurrentWebview().setZoom(zoom).catch(() => {});
  } catch {
    // Browser preview has no Tauri webview.
  }
  return Promise.all([titlebarZoom, webviewZoom]).then(() => {});
}

export function refreshAppZoom(): Promise<void> {
  const zoom = readAppZoom();
  if (zoom === 1) return Promise.resolve();
  try {
    const webview = getCurrentWebview();
    const refreshZoom = zoom === ZOOM_STEPS[ZOOM_STEPS.length - 1]
      ? zoom - 0.001
      : zoom + 0.001;
    return webview.setZoom(refreshZoom)
      .then(() => webview.setZoom(zoom))
      .catch(() => {});
  } catch {
    return Promise.resolve();
  }
}

export function applyAppZoom(next: number): void {
  writeAppZoom(next);
  try {
    void invoke("set_setting", {
      key: "app_zoom",
      value: String(next),
    }).catch(() => {});
  } catch {
    // Browser preview has no Tauri command runtime.
  }
  void restoreAppZoom(next);
  notifySameWindowStorage(STORAGE_APP_ZOOM, String(next));
}

export function nudgeAppZoom(direction: 1 | -1 | "reset"): void {
  if (direction === "reset") {
    applyAppZoom(1.0);
    return;
  }

  const index = ZOOM_STEPS.indexOf(readAppZoom());
  const safeIndex = index === -1 ? ZOOM_STEPS.indexOf(1.0) : index;
  const nextIndex =
    direction === 1
      ? Math.min(ZOOM_STEPS.length - 1, safeIndex + 1)
      : Math.max(0, safeIndex - 1);
  applyAppZoom(ZOOM_STEPS[nextIndex]);
}

export function zoomShortcutActionForEvent(
  event: Pick<
    KeyboardEvent,
    "altKey" | "code" | "ctrlKey" | "metaKey" | "shiftKey"
  >,
): 1 | -1 | "reset" | null {
  if (!(event.metaKey || event.ctrlKey) || event.altKey) return null;
  if (event.shiftKey) return null;
  if (event.code === "Equal") return 1;
  if (event.code === "Minus") return -1;
  if (event.code === "Digit0") return "reset";
  return null;
}

export function handleAppZoomShortcut(event: KeyboardEvent): boolean {
  const action = zoomShortcutActionForEvent(event);
  if (action === null) return false;
  event.preventDefault();
  event.stopPropagation();
  nudgeAppZoom(action);
  return true;
}
