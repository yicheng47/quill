import { useEffect } from "react";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import { invoke } from "@tauri-apps/api/core";
import Home from "./pages/Home";
import Reader from "./pages/Reader";
import { UpdateProvider } from "./contexts/UpdateContext";
import UpdateToast from "./components/UpdateToast";

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
      .then((settings) => applyTheme(settings.theme ?? "system"))
      .catch(() => applyTheme("system"));

    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = () => {
      if (!document.documentElement.dataset.themeOverride) {
        applyTheme("system");
      }
    };
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);

  return (
    <UpdateProvider>
      <BrowserRouter>
        <UpdateToast
          onOpenSettings={() => window.dispatchEvent(new CustomEvent("open-settings", { detail: "about" }))}
        />
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/reader/:bookId" element={<Reader />} />
        </Routes>
      </BrowserRouter>
    </UpdateProvider>
  );
}
