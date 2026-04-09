import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import en from "./en.json";
import zh from "./zh.json";

const SUPPORTED_LANGUAGES = ["en", "zh"];
const CACHE_KEY = "quill-language";

/**
 * Detect the system language from the browser locale.
 * Matches "zh", "zh-CN", "zh-Hans", "zh-Hans-CN" etc. → "zh".
 * Traditional Chinese (zh-TW, zh-Hant) falls back to "en" for now.
 */
function detectSystemLanguage(): string {
  const locale = navigator.language || "";
  const primary = locale.split("-")[0].toLowerCase();
  if (primary === "zh") {
    const isTrad = /\b(TW|HK|Hant)\b/i.test(locale);
    return isTrad ? "en" : "zh";
  }
  return SUPPORTED_LANGUAGES.includes(primary) ? primary : "en";
}

// Resolve initial language synchronously from localStorage cache (or OS), so
// React can mount immediately without waiting on a Tauri IPC roundtrip.
function initialLanguage(): string {
  const cached = localStorage.getItem(CACHE_KEY);
  if (cached && SUPPORTED_LANGUAGES.includes(cached)) return cached;
  return detectSystemLanguage();
}

i18n.use(initReactI18next).init({
  resources: { en: { translation: en }, zh: { translation: zh } },
  lng: initialLanguage(),
  fallbackLng: "en",
  interpolation: { escapeValue: false },
});

// Reconcile with the persisted setting in the DB after mount. If the stored
// value differs from the cache, swap languages and update the cache. On first
// launch (no stored value), persist the detected language so the Rust backend
// (AI system prompts) can read it too.
export async function reconcileLanguage(): Promise<void> {
  try {
    const stored = await invoke<string | null>("get_setting", { key: "language" });
    if (stored && SUPPORTED_LANGUAGES.includes(stored)) {
      if (stored !== i18n.language) await i18n.changeLanguage(stored);
      localStorage.setItem(CACHE_KEY, stored);
      return;
    }
    const detected = detectSystemLanguage();
    await invoke("set_setting", { key: "language", value: detected }).catch(() => {});
    localStorage.setItem(CACHE_KEY, detected);
  } catch {
    // Best-effort — keep the synchronously-resolved language
  }
}

export default i18n;
