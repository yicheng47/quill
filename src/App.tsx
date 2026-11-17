import { useEffect } from "react";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import {
  appReady,
  getCurrentWindowLabel,
  invoke,
  onWindowResized,
} from "./platform";
import Home from "./pages/Home";
import Reader from "./pages/Reader";
import { UpdateProvider } from "./contexts/UpdateContext";
import UpdateToast from "./components/UpdateToast";
import { reconcileLanguage } from "./i18n";
import {
  handleAppZoomShortcut,
  restoreAppZoom,
  syncTitlebarZoom,
} from "./lib/appZoom";
import {
  readAppZoom,
  snapAppZoom,
  STORAGE_APP_ZOOM,
  writeAppZoom,
} from "./lib/settings";

const isMainWindow = getCurrentWindowLabel() === "main";

function applyTheme(theme: string) {
  const root = document.documentElement;
  if (theme === "dark") {
    root.classList.add("dark");
  } else if (theme === "light") {
    root.classList.remove("dark");
  } else {
    const dark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    root.classList.toggle("dark", dark);
  }
}

const SETTINGS_REVEAL_TIMEOUT_MS = 250;

export default function App() {
  useEffect(() => {
    const cachedZoom = readAppZoom();
    const cachedZoomReady = restoreAppZoom(cachedZoom);
    applyTheme(localStorage.getItem("quill-theme") ?? "system");

    const settingsReady = invoke<Record<string, string>>("get_all_settings")
      .then((settings) => {
        const theme = settings.theme ?? "system";
        applyTheme(theme);
        localStorage.setItem("quill-theme", theme);
        const persistedZoom = snapAppZoom(settings.app_zoom);
        writeAppZoom(persistedZoom);
        if (persistedZoom !== cachedZoom) {
          return restoreAppZoom(persistedZoom);
        }
      })
      .catch(() => applyTheme("system"));

    // Reconcile the language we picked synchronously from localStorage with
    // the persisted DB value (and persist to the DB on first launch).
    reconcileLanguage();

    // Bound first-launch settings wait so an unresponsive backend never keeps
    // the window hidden indefinitely, while fast persisted dark applies pre-reveal
    // and slower resolutions reconcile cleanly afterward.
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
      if (!document.documentElement.dataset.themeOverride) {
        applyTheme("system");
      }
    };
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (isMainWindow) handleAppZoomShortcut(event);
    };
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, []);

  useEffect(() => {
    const handleStorage = (event: StorageEvent) => {
      if (event.key !== STORAGE_APP_ZOOM || event.storageArea === null) return;
      void restoreAppZoom(readAppZoom());
    };
    window.addEventListener("storage", handleStorage);
    return () => window.removeEventListener("storage", handleStorage);
  }, []);

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
    <>
      {isMainWindow && <UpdateToast />}
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/reader/:bookId" element={<Reader />} />
      </Routes>
    </>
  );

  return (
    <BrowserRouter>
      {isMainWindow ? <UpdateProvider>{content}</UpdateProvider> : content}
    </BrowserRouter>
  );
}
