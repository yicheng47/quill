import React from "react";
import ReactDOM from "react-dom/client";
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import "@fontsource-variable/literata";
import "@fontsource-variable/literata/wght-italic.css";
import App from "./App";
import "./index.css";
import "./i18n";
import {
  getCurrentWindowLabel,
  getInitialDark,
  getInitialReaderTheme,
} from "./platform";
import { readAppTheme, resolveAppThemeIsDark } from "./lib/theme";

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

// Apply Dawn/Nocturne classes synchronously before React mounts so first paint
// matches Electron main's initial appearance without a white/light flash; reader
// windows follow their own page theme only.
document.documentElement.classList.add("dawn");
if (getCurrentWindowLabel() === "main") {
  const initialDark = getInitialDark();
  document.documentElement.classList.toggle(
    "dark",
    initialDark !== null ? initialDark : resolveAppThemeIsDark(readAppTheme()),
  );
} else {
  document.documentElement.classList.toggle(
    "dark",
    getInitialReaderTheme() === "dark",
  );
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
