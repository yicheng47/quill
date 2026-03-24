import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";
import { i18nReady } from "./i18n";

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

i18nReady.then(() => {
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
});
