import { useEffect } from "react";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import Home from "./pages/Home";
import Reader from "./pages/Reader";
import { UpdateProvider } from "./contexts/UpdateContext";
import UpdateToast from "./components/UpdateToast";
import { reconcileLanguage } from "./i18n";

const isMainWindow = getCurrentWebviewWindow().label === "main";

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

export default function App() {
  useEffect(() => {
    invoke<Record<string, string>>("get_all_settings")
      .then((settings) => {
        const theme = settings.theme ?? "system";
        applyTheme(theme);
        localStorage.setItem("quill-theme", theme);
      })
      .catch(() => applyTheme("system"));

    // Reconcile the language we picked synchronously from localStorage with
    // the persisted DB value (and persist to the DB on first launch).
    reconcileLanguage();

    // Tell the backend the UI has mounted so it can show the (currently
    // hidden) main window. We don't wrap this in requestAnimationFrame —
    // macOS pauses rAF for hidden windows, so the callback would never fire.
    // useEffect runs after React commits the DOM, which is good enough; the
    // OS composites the committed tree when window.show() is called.
    if (isMainWindow) {
      invoke("app_ready").catch(() => {});
    }

    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = () => {
      if (!document.documentElement.dataset.themeOverride) {
        applyTheme("system");
      }
    };
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);

  const content = (
    <>
      {isMainWindow && (
        <UpdateToast
          onOpenSettings={() => window.dispatchEvent(new CustomEvent("open-settings", { detail: "about" }))}
        />
      )}
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
