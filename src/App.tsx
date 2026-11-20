import { useEffect, useRef } from "react";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import {
  appReady,
  getCurrentWindowLabel,
  getInitialDark,
  invoke,
  onWindowResized,
} from "./platform";
import Home from "./pages/Home";
import Reader from "./pages/Reader";
import { UpdateProvider } from "./contexts/UpdateContext";
import { reconcileLanguage } from "./i18n";
import {
  handleAppZoomShortcut,
  restoreAppZoom,
  syncTitlebarZoom,
} from "./lib/appZoom";
import { installFadingScrollbars } from "./lib/fadingScrollbars";
import { applyPlatformClass } from "./lib/platformEnv";
import {
  readAppZoom,
  snapAppZoom,
  STORAGE_APP_ZOOM,
  writeAppZoom,
} from "./lib/settings";
import {
  applyMainWindowDark,
  applyMainWindowTheme,
  bumpAppThemeRevision,
  getAppThemeRevision,
  normalizeAppTheme,
  readAppTheme,
  seedCommittedAppTheme,
  STORAGE_APP_THEME,
  syncCommittedAppTheme,
  writeAppTheme,
  type AppTheme,
} from "./lib/theme";

const SETTINGS_REVEAL_TIMEOUT_MS = 250;

function readInitialMainDark(): boolean | null {
  try {
    return typeof getInitialDark === "function" ? getInitialDark() : null;
  } catch {
    return null;
  }
}

function applyInitialMainAppearance(
  initialDark: boolean | null,
  fallbackTheme: AppTheme,
): void {
  if (document.documentElement.dataset.readerTheme) return;
  if (initialDark !== null) {
    applyMainWindowDark(initialDark);
  } else {
    applyMainWindowTheme(fallbackTheme);
  }
}

export default function App() {
  const isMainWindow = getCurrentWindowLabel() === "main";
  const themeRef = useRef<AppTheme>(readAppTheme());

  useEffect(() => {
    const cachedZoom = readAppZoom();
    const cachedZoomReady = restoreAppZoom(cachedZoom);
    const root = document.documentElement;
    root.classList.add("dawn");
    applyPlatformClass(root);

    const startRevision = getAppThemeRevision();
    const mainInitialDark = isMainWindow ? readInitialMainDark() : null;
    let settingsResolved = false;

    if (isMainWindow) {
      themeRef.current = readAppTheme();
      applyInitialMainAppearance(mainInitialDark, themeRef.current);
    } else if (!root.dataset.readerTheme) {
      // Reader windows follow their page theme only; never adopt main app theme.
      root.classList.remove("dark");
    }

    const settingsReady = invoke<Record<string, string>>("get_all_settings")
      .then((settings) => {
        settingsResolved = true;
        if (isMainWindow && getAppThemeRevision() === startRevision) {
          const theme = normalizeAppTheme(settings.theme);
          themeRef.current = theme;
          writeAppTheme(theme);
          seedCommittedAppTheme(theme);
          if (!document.documentElement.dataset.readerTheme) {
            applyMainWindowTheme(theme);
          }
        } else if (!isMainWindow && !document.documentElement.dataset.readerTheme) {
          document.documentElement.classList.remove("dark");
        }
        const persistedZoom = snapAppZoom(settings.app_zoom);
        writeAppZoom(persistedZoom);
        if (persistedZoom !== cachedZoom) {
          return restoreAppZoom(persistedZoom);
        }
      })
      .catch(() => {
        settingsResolved = true;
        if (isMainWindow && getAppThemeRevision() === startRevision) {
          applyInitialMainAppearance(mainInitialDark, themeRef.current);
        } else if (!isMainWindow && !document.documentElement.dataset.readerTheme) {
          document.documentElement.classList.remove("dark");
        }
      });

    // Reconcile the language we picked synchronously from localStorage with
    // the persisted DB value (and persist to the DB on first launch).
    reconcileLanguage();

    // Bound first-launch settings wait so an unresponsive backend never keeps
    // the window hidden indefinitely, while Electron's initialDark prevents flash.
    let revealTimer: number | undefined;
    const revealTimeout = new Promise<void>((resolve) => {
      revealTimer = window.setTimeout(resolve, SETTINGS_REVEAL_TIMEOUT_MS);
    });
    void Promise.all([
      cachedZoomReady,
      Promise.race([settingsReady, revealTimeout]),
    ]).finally(() => {
      if (revealTimer !== undefined) {
        window.clearTimeout(revealTimer);
      }
      void appReady().catch(() => {});
    });

    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = () => {
      if (!isMainWindow) return;
      if (document.documentElement.dataset.themeOverride) return;
      if (document.documentElement.dataset.readerTheme) return;
      if (!settingsResolved && mainInitialDark !== null && getAppThemeRevision() === startRevision) {
        return;
      }
      applyMainWindowTheme(themeRef.current);
    };
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, [isMainWindow]);

  useEffect(() => installFadingScrollbars(), []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (isMainWindow) handleAppZoomShortcut(event);
    };
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [isMainWindow]);

  useEffect(() => {
    const handleStorage = (event: StorageEvent) => {
      if (event.key === STORAGE_APP_ZOOM) {
        if (event.storageArea === null) return;
        void restoreAppZoom(readAppZoom());
        return;
      }
      if (event.key === STORAGE_APP_THEME && isMainWindow) {
        const nextTheme = readAppTheme();
        themeRef.current = nextTheme;
        bumpAppThemeRevision();
        // Same-window notifications come from setAppTheme (storageArea === null),
        // which has already updated the DOM class and native window background.
        if (event.storageArea !== null && !document.documentElement.dataset.readerTheme) {
          syncCommittedAppTheme(nextTheme);
          applyMainWindowTheme(nextTheme);
        }
      }
    };
    window.addEventListener("storage", handleStorage);
    return () => window.removeEventListener("storage", handleStorage);
  }, [isMainWindow]);

  useEffect(() => {
    let timer: number | null = null;
    const unlisten = onWindowResized(() => {
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        void syncTitlebarZoom(readAppZoom());
      }, 150);
    });
    return () => {
      if (timer !== null) window.clearTimeout(timer);
      void unlisten.then((stop) => stop()).catch(() => {});
    };
  }, []);

  const content = (
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/reader/:bookId" element={<Reader />} />
    </Routes>
  );

  return (
    <BrowserRouter>
      {isMainWindow ? <UpdateProvider>{content}</UpdateProvider> : content}
    </BrowserRouter>
  );
}
