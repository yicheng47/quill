import { notifySameWindowStorage } from "./settings";
import { setWindowBackgroundColor } from "../platform";

export type AppTheme = "system" | "light" | "dark";

export const DEFAULT_APP_THEME: AppTheme = "light";

export interface ThemeSelectionState {
  committedTheme: AppTheme;
  activeTheme: AppTheme;
  pendingWrites: number;
  saveError: boolean;
}

export const STORAGE_APP_THEME = "quill-theme";
export const MAIN_DAWN_BG = "#EEEBF8";
export const MAIN_NOCTURNE_BG = "#12111A";

let appThemeRevision = 0;
let committedTheme: AppTheme = readAppTheme();
let controllerSeeded = false;
let hasUserSelection = false;
let pendingTheme: AppTheme | null = null;
let pendingWrites = 0;
let selectionSeq = 0;
let saveError = false;
let saveQueue: Promise<void> = Promise.resolve();
const selectionListeners = new Set<() => void>();

function emitSelectionChange(): void {
  for (const listener of selectionListeners) {
    listener();
  }
}

export function getAppThemeRevision(): number {
  return appThemeRevision;
}

export function bumpAppThemeRevision(): number {
  appThemeRevision += 1;
  return appThemeRevision;
}

export function normalizeAppTheme(value: string | null | undefined): AppTheme {
  if (value === "light" || value === "dark" || value === "system") return value;
  return DEFAULT_APP_THEME;
}

export function systemPrefersDark(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return false;
  }
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

export function resolveAppThemeIsDark(
  theme: AppTheme,
  prefersDark = systemPrefersDark(),
): boolean {
  return theme === "dark" || (theme === "system" && prefersDark);
}

export function mainWindowBackgroundColor(isDark: boolean): string {
  return isDark ? MAIN_NOCTURNE_BG : MAIN_DAWN_BG;
}

export function readAppTheme(): AppTheme {
  try {
    return normalizeAppTheme(localStorage.getItem(STORAGE_APP_THEME));
  } catch {
    return DEFAULT_APP_THEME;
  }
}

export function writeAppTheme(theme: AppTheme): void {
  try {
    localStorage.setItem(STORAGE_APP_THEME, theme);
  } catch {
    // Ignore storage unavailability in restricted contexts.
  }
}

export function applyMainWindowDark(isDark: boolean): boolean {
  if (typeof document !== "undefined") {
    const root = document.documentElement;
    root.classList.add("dawn");
    root.classList.toggle("dark", isDark);
  }
  try {
    Promise.resolve(
      setWindowBackgroundColor(mainWindowBackgroundColor(isDark)),
    ).catch(() => {});
  } catch {
    // Platform mock or non-Electron runtime may omit or throw synchronously.
  }
  return isDark;
}

export function applyMainWindowTheme(
  theme: AppTheme,
  prefersDark = systemPrefersDark(),
): boolean {
  return applyMainWindowDark(resolveAppThemeIsDark(theme, prefersDark));
}

export function setAppTheme(theme: AppTheme): boolean {
  bumpAppThemeRevision();
  writeAppTheme(theme);
  const isDark = applyMainWindowTheme(theme);
  notifySameWindowStorage(STORAGE_APP_THEME, theme);
  return isDark;
}

export function getThemeSelectionState(): ThemeSelectionState {
  return {
    committedTheme,
    activeTheme: pendingTheme ?? committedTheme,
    pendingWrites,
    saveError,
  };
}

export function subscribeThemeSelection(listener: () => void): () => void {
  selectionListeners.add(listener);
  return () => {
    selectionListeners.delete(listener);
  };
}

export function seedCommittedAppTheme(committed: AppTheme): void {
  if (controllerSeeded || hasUserSelection || pendingWrites > 0) return;
  controllerSeeded = true;
  if (committedTheme === committed && pendingTheme === null) return;
  committedTheme = committed;
  emitSelectionChange();
}

export function syncCommittedAppTheme(committed: AppTheme): void {
  if (pendingWrites > 0) return;
  controllerSeeded = true;
  if (committedTheme === committed && pendingTheme === null) return;
  committedTheme = committed;
  emitSelectionChange();
}

export function clearThemeSaveError(): void {
  if (!saveError) return;
  saveError = false;
  emitSelectionChange();
}

export function selectAndSaveAppTheme(
  next: AppTheme,
  persist?: (key: string, value: string) => Promise<void>,
): Promise<void> {
  if (next === (pendingTheme ?? committedTheme) && pendingWrites === 0 && !saveError) {
    return saveQueue;
  }
  controllerSeeded = true;
  hasUserSelection = true;
  saveError = false;
  const seq = ++selectionSeq;
  pendingWrites += 1;
  pendingTheme = next;
  setAppTheme(next);
  emitSelectionChange();

  const run = saveQueue
    .then(async () => {
      try {
        if (persist) {
          await persist("theme", next);
        }
        committedTheme = next;
        if (selectionSeq === seq) {
          pendingTheme = null;
          saveError = false;
        }
      } catch {
        if (selectionSeq === seq) {
          const fallback = committedTheme;
          pendingTheme = null;
          saveError = true;
          setAppTheme(fallback);
        }
      } finally {
        pendingWrites = Math.max(0, pendingWrites - 1);
        if (pendingWrites === 0) {
          pendingTheme = null;
        }
        emitSelectionChange();
      }
    });

  saveQueue = run;
  return run;
}

export function resetThemeControllerForTests(initial?: AppTheme): void {
  committedTheme = initial ?? readAppTheme();
  controllerSeeded = initial !== undefined;
  hasUserSelection = false;
  pendingTheme = null;
  pendingWrites = 0;
  selectionSeq += 1;
  saveError = false;
  saveQueue = Promise.resolve();
  emitSelectionChange();
}
