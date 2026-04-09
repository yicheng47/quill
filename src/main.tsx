import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";
import "./i18n";

// Polyfill Map.getOrInsertComputed for PDF.js v5.5+ (Stage 3 proposal, not yet in WebKit)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
if (!(Map.prototype as any).getOrInsertComputed) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (Map.prototype as any).getOrInsertComputed = function (key: any, callbackFn: (key: any) => any) {
    if (this.has(key)) return this.get(key);
    const value = callbackFn(key);
    this.set(key, value);
    return value;
  };
}

// Apply cached theme synchronously before React mounts so the window doesn't
// flash light-mode on cold start. Reconciled with the DB in App.tsx.
const cachedTheme = localStorage.getItem("quill-theme") ?? "system";
const prefersDark =
  cachedTheme === "dark" ||
  (cachedTheme === "system" &&
    window.matchMedia("(prefers-color-scheme: dark)").matches);
if (prefersDark) document.documentElement.classList.add("dark");

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
