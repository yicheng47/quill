export const STORAGE_APP_ZOOM = "quill-app-zoom";

export const ZOOM_STEPS: readonly number[] = [
  0.8, 0.9, 1.0, 1.1, 1.2, 1.3, 1.4, 1.5,
];

const DEFAULT_APP_ZOOM = 1.0;

export function snapAppZoom(value: string | number | null | undefined): number {
  const parsed = typeof value === "number" ? value : Number.parseFloat(value ?? "");
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_APP_ZOOM;

  let nearest = ZOOM_STEPS[0];
  let best = Math.abs(nearest - parsed);
  for (let i = 1; i < ZOOM_STEPS.length; i += 1) {
    const distance = Math.abs(ZOOM_STEPS[i] - parsed);
    if (distance < best) {
      best = distance;
      nearest = ZOOM_STEPS[i];
    }
  }
  return nearest;
}

export function readAppZoom(): number {
  try {
    return snapAppZoom(localStorage.getItem(STORAGE_APP_ZOOM));
  } catch {
    return DEFAULT_APP_ZOOM;
  }
}

export function writeAppZoom(value: number): void {
  try {
    localStorage.setItem(STORAGE_APP_ZOOM, String(value));
  } catch {
    // Persistence is best-effort when localStorage is unavailable.
  }
}

export function notifySameWindowStorage(key: string, value: string): void {
  try {
    window.dispatchEvent(new StorageEvent("storage", { key, newValue: value }));
  } catch {
    // Older webviews may not support constructing StorageEvent.
  }
}
