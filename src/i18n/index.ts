import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import en from "./en.json";
import zh from "./zh.json";

const SUPPORTED_LANGUAGES = ["en", "zh"];

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

/**
 * Read persisted language from the settings DB.
 * On first launch (no setting stored), detect from the OS and persist it
 * so the Rust backend (AI system prompts) can also read it.
 */
async function getInitialLanguage(): Promise<string> {
  try {
    const stored = await invoke<string | null>("get_setting", { key: "language" });
    if (stored && SUPPORTED_LANGUAGES.includes(stored)) return stored;

    const detected = detectSystemLanguage();
    await invoke("set_setting", { key: "language", value: detected }).catch(() => {});
    return detected;
  } catch {
    return detectSystemLanguage();
  }
}

export const i18nReady = getInitialLanguage().then((lng) =>
  i18n.use(initReactI18next).init({
    resources: { en: { translation: en }, zh: { translation: zh } },
    lng,
    fallbackLng: "en",
    interpolation: { escapeValue: false },
  })
);

export default i18n;
