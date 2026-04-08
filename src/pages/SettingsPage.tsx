import { useState, useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { invoke } from "@tauri-apps/api/core";
import { ArrowLeft, Bot, BookOpen, SlidersHorizontal, Palette, KeyRound, Shield, Cloud, Loader2, Globe, Sparkles, X } from "lucide-react";
import i18n from "../i18n";
import Button from "../components/ui/Button";
import Select from "../components/ui/Select";
import Input from "../components/ui/Input";
import Toggle from "../components/ui/Toggle";
import Slider from "../components/ui/Slider";
import { useSettings } from "../hooks/useSettings";
import { useTranslation } from "react-i18next";

export default function SettingsPage() {
  const navigate = useNavigate();
  const [showToast, setShowToast] = useState(false);
  const [toastMessage, setToastMessage] = useState("");
  const { settings, loading, save, saveBulk } = useSettings();
  const { t } = useTranslation();
  const [aiDirty, setAiDirty] = useState(false);

  // AI config
  const [provider, setProvider] = useState("openai");
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState("gpt-5.3-codex");
  const [baseUrl, setBaseUrl] = useState("https://api.openai.com");
  const [temperature, setTemperature] = useState(0.3);
  const [keepAlive, setKeepAlive] = useState("30m");

  // OAuth
  const [authMode, setAuthMode] = useState<"api_key" | "oauth">("oauth");
  const [oauthStatus, setOauthStatus] = useState<{ connected: boolean; account_id: string | null }>({ connected: false, account_id: null });
  const [oauthLoading, setOauthLoading] = useState(false);
  const [oauthError, setOauthError] = useState<string | null>(null);
  const [oauthToast, setOauthToast] = useState(false);

  // Reading preferences
  const [autoSave, setAutoSave] = useState(true);

  // Default layout
  const [fontFamily, setFontFamily] = useState("georgia");
  const [fontSize, setFontSize] = useState(26);
  const [lineSpacing, setLineSpacing] = useState(1.8);
  const [charSpacing, setCharSpacing] = useState(0);
  const [wordSpacing, setWordSpacing] = useState(0);
  const [margins, setMargins] = useState(0);

  // Language
  const [language, setLanguage] = useState("en");

  // Lookup
  const [nativeLanguage, setNativeLanguage] = useState("en");
  const [showTranslation, setShowTranslation] = useState(false);

  // Appearance
  const [theme, setTheme] = useState("system");

  // iCloud
  const [icloudAvailable, setIcloudAvailable] = useState(false);
  const [icloudEnabled, setIcloudEnabled] = useState(false);
  const [icloudHasExistingData, setIcloudHasExistingData] = useState(false);
  const [icloudLoading, setIcloudLoading] = useState(false);
  const [icloudError, setIcloudError] = useState<string | null>(null);
  const [icloudConfirm, setIcloudConfirm] = useState<"enable" | "disable" | null>(null);

  const toastTimeout = useRef<ReturnType<typeof setTimeout>>(undefined);
  const showSavedToast = (msg = t("settings.saved")) => {
    if (toastTimeout.current) clearTimeout(toastTimeout.current);
    setToastMessage(msg);
    setShowToast(true);
    toastTimeout.current = setTimeout(() => setShowToast(false), 1500);
  };

  const autoSaveSetting = async (key: string, value: string) => {
    try {
      await save(key, value);
      showSavedToast();
    } catch (err) {
      console.error(`Failed to save ${key}:`, err);
    }
  };

  const handleSaveAI = async () => {
    try {
      await saveBulk({
        ai_provider: provider,
        ai_api_key: apiKey,
        ai_model: model,
        ai_base_url: baseUrl,
        ai_temperature: String(temperature),
        ai_keep_alive: keepAlive,
        ai_auth_mode: authMode,
      });
      setAiDirty(false);
      showSavedToast(t("settings.ai.savedToast"));
    } catch (err) {
      console.error("Failed to save AI settings:", err);
    }
  };

  // Load saved settings
  useEffect(() => {
    if (loading) return;
    if (settings.ai_provider) setProvider(settings.ai_provider);
    if (settings.ai_api_key) setApiKey(settings.ai_api_key);
    if (settings.ai_model) setModel(settings.ai_model);
    if (settings.ai_base_url) setBaseUrl(settings.ai_base_url);
    if (settings.ai_temperature) setTemperature(parseFloat(settings.ai_temperature));
    if (settings.ai_keep_alive) setKeepAlive(settings.ai_keep_alive);
    if (settings.ai_auth_mode) setAuthMode(settings.ai_auth_mode as "api_key" | "oauth");
    if (settings.font_size) setFontSize(parseInt(settings.font_size));
    if (settings.font_family) setFontFamily(settings.font_family);
    if (settings.line_spacing) setLineSpacing(parseFloat(settings.line_spacing));
    if (settings.char_spacing) setCharSpacing(parseInt(settings.char_spacing));
    if (settings.word_spacing) setWordSpacing(parseInt(settings.word_spacing));
    if (settings.margins) setMargins(parseInt(settings.margins));
    if (settings.auto_save) setAutoSave(settings.auto_save === "true");
    if (settings.theme) setTheme(settings.theme);
    if (settings.language) setLanguage(settings.language);
    if (settings.native_language) setNativeLanguage(settings.native_language);
    if (settings.show_translation) setShowTranslation(settings.show_translation === "true");
  }, [settings, loading]);

  // Fetch iCloud status on mount
  useEffect(() => {
    invoke<{ available: boolean; enabled: boolean; has_existing_data: boolean }>("icloud_status")
      .then((status) => {
        setIcloudAvailable(status.available);
        setIcloudEnabled(status.enabled);
        setIcloudHasExistingData(status.has_existing_data);
      })
      .catch(() => {});
  }, []);

  // Apply theme
  useEffect(() => {
    const root = document.documentElement;
    const applyTheme = (dark: boolean) => {
      root.classList.toggle("dark", dark);
    };

    if (theme === "dark") {
      applyTheme(true);
    } else if (theme === "light") {
      applyTheme(false);
    } else {
      const mq = window.matchMedia("(prefers-color-scheme: dark)");
      applyTheme(mq.matches);
      const handler = (e: MediaQueryListEvent) => applyTheme(e.matches);
      mq.addEventListener("change", handler);
      return () => mq.removeEventListener("change", handler);
    }
  }, [theme]);

  // Fetch OAuth status when provider is OpenAI
  useEffect(() => {
    if (provider === "openai") {
      invoke<{ connected: boolean; account_id: string | null }>("openai_oauth_status")
        .then(setOauthStatus)
        .catch(() => setOauthStatus({ connected: false, account_id: null }));
    }
  }, [provider]);

  const handleIcloudToggle = () => {
    setIcloudConfirm(icloudEnabled ? "disable" : "enable");
  };

  const confirmIcloudToggle = async () => {
    const action = icloudConfirm;
    setIcloudConfirm(null);
    setIcloudLoading(true);
    setIcloudError(null);
    try {
      const minDelay = new Promise((r) => setTimeout(r, 1500));
      if (action === "disable") {
        await Promise.all([invoke("icloud_disable"), minDelay]);
        setIcloudEnabled(false);
      } else {
        await Promise.all([invoke("icloud_enable"), minDelay]);
        setIcloudEnabled(true);
      }
    } catch (err) {
      setIcloudError(err instanceof Error ? err.message : String(err));
    } finally {
      setIcloudLoading(false);
    }
  };

  const handleOAuthLogin = async () => {
    setOauthLoading(true);
    setOauthError(null);
    try {
      const result = await invoke<{ connected: boolean; account_id: string | null }>("openai_oauth_login");
      setOauthStatus(result);
      setOauthToast(true);
      setTimeout(() => setOauthToast(false), 2000);
      // Auto-save AI configuration after successful OAuth login
      await saveBulk({
        ai_provider: provider,
        ai_api_key: apiKey,
        ai_model: model,
        ai_base_url: baseUrl,
        ai_temperature: String(temperature),
        ai_keep_alive: keepAlive,
        ai_auth_mode: authMode,
      });
      setAiDirty(false);
    } catch (err) {
      setOauthError(err instanceof Error ? err.message : String(err));
    } finally {
      setOauthLoading(false);
    }
  };

  const handleOAuthLogout = async () => {
    try {
      await invoke("openai_oauth_logout");
      setOauthStatus({ connected: false, account_id: null });
    } catch (err) {
      console.error("Failed to logout:", err);
    }
  };

  return (
    <div className="flex flex-col h-screen bg-bg-page">
      {/* Header */}
      <header className="flex items-center justify-between px-page pt-8 pb-2 bg-bg-surface border-b border-border shrink-0 relative select-none">
        <div data-tauri-drag-region className="absolute top-0 left-0 right-0 h-8" />
        <div className="flex items-center gap-4">
          <Button variant="icon" size="md" onClick={() => navigate(-1)}>
            <ArrowLeft size={16} />
          </Button>
          <div>
            <h1 className="text-[18px] font-semibold text-text-primary">{t("settings.title")}</h1>
            <p className="text-[13px] text-text-muted">
              {t("settings.subtitle")}
            </p>
          </div>
        </div>
        <div /> {/* Spacer for header alignment */}
      </header>

      {/* Content */}
      <main className="flex-1 overflow-auto">
        <div className="max-w-[680px] mx-auto py-8 px-4 space-y-6">
          {/* AI Assistant Configuration */}
          <section className="bg-bg-surface rounded-xl border border-border p-6">
            <div className="flex items-center gap-2 mb-1">
              <Bot size={20} className="text-text-muted" />
              <h2 className="text-[16px] font-semibold text-text-primary">
                {t("settings.ai.title")}
              </h2>
            </div>
            <p className="text-[13px] text-text-muted mb-4">
              {t("settings.ai.subtitle")}
            </p>

            <div className="space-y-5">

              {/* Provider */}
              <Select
                label={t("settings.ai.provider")}
                value={provider}
                onChange={(p) => {
                  setProvider(p);
                  setApiKey("");
                  setAiDirty(true);
                  if (p === "ollama") {
                    setBaseUrl("http://localhost:11434"); setModel("qwen3.5");
                  } else if (p === "openai") {
                    setBaseUrl("https://api.openai.com"); setModel("gpt-5.3-codex"); setAuthMode("oauth");
                  } else if (p === "anthropic") {
                    setBaseUrl(""); setModel("claude-sonnet-4-20250514");
                  } else {
                    setBaseUrl(""); setModel("");
                  }
                }}
                options={[
                  { value: "openai", label: "OpenAI" },
                  { value: "anthropic", label: "Anthropic" },
                  { value: "ollama", label: "Ollama (Local)" },
                ]}
              />
              <p className="-mt-3 text-[12px] text-text-muted">{t("settings.ai.providerHint")}</p>

              {/* Authentication Method (OpenAI only) */}
              {provider === "openai" && (
                <div>
                  <label className="block text-[14px] font-semibold text-text-primary mb-1.5">
                    {t("settings.ai.authMethod")}
                  </label>
                  <div className="flex rounded-lg border border-border overflow-hidden">
                    <button
                      type="button"
                      className={`flex-1 flex items-center justify-center gap-2 h-9 text-[13px] font-medium transition-colors ${
                        authMode === "api_key"
                          ? "bg-accent text-white"
                          : "bg-bg-page text-text-secondary hover:bg-bg-input"
                      }`}
                      onClick={() => { setAuthMode("api_key"); setModel("gpt-4o"); setAiDirty(true); }}
                    >
                      <KeyRound size={14} />
                      {t("settings.ai.apiKey")}
                    </button>
                    <button
                      type="button"
                      className={`flex-1 flex items-center justify-center gap-2 h-9 text-[13px] font-medium transition-colors ${
                        authMode === "oauth"
                          ? "bg-accent text-white"
                          : "bg-bg-page text-text-secondary hover:bg-bg-input"
                      }`}
                      onClick={() => { setAuthMode("oauth"); setModel("gpt-5.3-codex"); setAiDirty(true); }}
                    >
                      <Shield size={14} />
                      {t("settings.ai.oauthLogin")}
                    </button>
                  </div>
                  <p className="text-[12px] text-text-muted mt-1.5">{t("settings.ai.authMethodHint")}</p>
                </div>
              )}

              {/* OAuth Login Panel (OpenAI + OAuth mode) */}
              {provider === "openai" && authMode === "oauth" && (
                <div>
                  {oauthStatus.connected ? (
                    <div className="flex items-center justify-between rounded-lg border border-border px-3 py-2.5">
                      <div className="flex items-center gap-2">
                        <span className="size-2 rounded-full bg-accent" />
                        <span className="size-2 rounded-full bg-green-500" />
                        <span className="text-[13px] text-text-primary font-medium">
                          {t("settings.ai.connected", { account: oauthStatus.account_id ?? "Unknown" })}
                        </span>
                      </div>
                      <button
                        type="button"
                        className="text-[13px] font-medium text-text-muted hover:text-text-primary transition-colors"
                        onClick={handleOAuthLogout}
                      >
                        {t("settings.ai.logout")}
                      </button>
                    </div>
                  ) : (
                    <>
                      <Button
                        variant="primary"
                        size="lg"
                        className="w-full justify-center"
                        disabled={oauthLoading}
                        onClick={handleOAuthLogin}
                      >
                        {oauthLoading ? t("settings.ai.waitingAuth") : t("settings.ai.loginWithOpenAI")}
                      </Button>
                      {oauthError ? (
                        <div className="flex items-center justify-between mt-2 px-3 py-2 rounded-lg bg-red-50 dark:bg-red-950/30">
                          <span className="text-[12px] text-red-600 dark:text-red-400">
                            {t("settings.ai.authFailed")}
                          </span>
                          <button
                            type="button"
                            className="text-[12px] font-medium text-red-600 dark:text-red-400 hover:underline"
                            onClick={handleOAuthLogin}
                          >
                            {t("settings.ai.retry")}
                          </button>
                        </div>
                      ) : (
                        <p className="text-[12px] text-text-muted mt-1.5">
                          {t("settings.ai.oauthHint")}
                        </p>
                      )}
                    </>
                  )}
                </div>
              )}

              {/* Base URL (for Ollama / OpenAI Compatible / Anthropic) */}
              {(provider === "ollama" || (provider === "openai" && authMode === "api_key") || provider === "anthropic") && (
                <div>
                  <label className="block text-[14px] font-semibold text-text-primary mb-1.5">
                    {t("settings.ai.baseUrl")}
                  </label>
                  <Input
                    value={baseUrl}
                    onChange={(e) => { setBaseUrl(e.target.value); setAiDirty(true); }}
                    placeholder={provider === "ollama" ? "http://localhost:11434" : "https://api.openai.com"}
                  />
                  <p className="text-[12px] text-text-muted mt-1.5">
                    {provider === "ollama" ? t("settings.ai.baseUrlOllama") : t("settings.ai.baseUrlGeneric")}
                  </p>
                </div>
              )}

              {/* API Key (for Anthropic / OpenAI Compatible — hidden when OpenAI + OAuth) */}
              {(provider === "anthropic" || (provider === "openai" && authMode === "api_key")) && (
                <div>
                  <label className="block text-[14px] font-semibold text-text-primary mb-1.5">
                    {t("settings.ai.apiKey")}
                  </label>
                  <Input
                    type="password"
                    value={apiKey}
                    onChange={(e) => { setApiKey(e.target.value); setAiDirty(true); }}
                    placeholder={provider === "anthropic" ? "sk-ant-..." : "sk-..."}
                  />
                  <p className="text-[12px] text-text-muted mt-1.5">
                    {t("settings.ai.apiKeyHint")}
                  </p>
                </div>
              )}

              {/* Model */}
              <div>
                <label className="block text-[14px] font-semibold text-text-primary mb-1.5">
                  {t("settings.ai.model")}
                </label>
                <Input
                  value={model}
                  onChange={(e) => { setModel(e.target.value); setAiDirty(true); }}
                  placeholder={
                    provider === "ollama" ? "qwen3.5" :
                    provider === "anthropic" ? "claude-sonnet-4-20250514" :
                    (provider === "openai" && authMode === "oauth") ? "gpt-5.3-codex" :
                    "gpt-4o"
                  }
                />
                <p className="text-[12px] text-text-muted mt-1.5">
                  {t("settings.ai.modelHint")}
                </p>
              </div>

              <div className="h-px bg-border-light" />

              {/* Temperature */}
              <Slider
                label={t("settings.ai.temperature")}
                min={0}
                max={100}
                value={Math.round(temperature * 100)}
                onChange={(v) => { setTemperature(v / 100); setAiDirty(true); }}
                displayValue={temperature.toFixed(1)}
                hint={t("settings.ai.temperatureHint")}
              />

              {/* Keep Alive (Ollama only) */}
              {provider === "ollama" && (
                <div>
                  <label className="block text-[14px] font-semibold text-text-primary mb-1.5">
                    {t("settings.ai.keepAlive")}
                  </label>
                  <Input
                    value={keepAlive}
                    onChange={(e) => { setKeepAlive(e.target.value); setAiDirty(true); }}
                    placeholder="30m"
                  />
                  <p className="text-[12px] text-text-muted mt-1.5">
                    {t("settings.ai.keepAliveHint")}
                  </p>
                </div>
              )}

              {/* Save AI Config */}
              <div className="h-px bg-border-light" />
              <Button variant="primary" size="md" className="w-full justify-center" disabled={!aiDirty} onClick={handleSaveAI}>
                {t("settings.ai.save")}
              </Button>

            </div>
          </section>

          {/* Default Layout */}
          <section className="bg-bg-surface rounded-xl border border-border p-6">
            <div className="flex items-center gap-2 mb-1">
              <SlidersHorizontal size={20} className="text-accent" />
              <h2 className="text-[16px] font-semibold text-text-primary">
                {t("settings.layout.title")}
              </h2>
            </div>
            <p className="text-[13px] text-text-muted mb-4">
              {t("settings.layout.subtitle")}
            </p>

            <div className="space-y-5">
              <Select
                label={t("settings.layout.fontFamily")}
                value={fontFamily}
                onChange={(v) => { setFontFamily(v); autoSaveSetting("font_family", v); }}
                options={[
                  { value: "system", label: t("settings.layout.systemDefault") },
                  { value: "georgia", label: "Georgia" },
                  { value: "palatino", label: "Palatino" },
                  { value: "inter", label: "Inter" },
                  { value: "times", label: "Times New Roman" },
                ]}
              />
              <p className="-mt-3 text-[12px] text-text-muted">{t("settings.layout.fontFamilyHint")}</p>

              <div>
                <label className="block text-[14px] font-semibold text-text-primary mb-1.5">
                  {t("settings.layout.fontSize")}
                </label>
                <Input
                  value={String(fontSize)}
                  onChange={(e) => {
                    const raw = e.target.value.replace(/\D/g, "");
                    const v = raw === "" ? 0 : parseInt(raw);
                    setFontSize(v);
                  }}
                  onBlur={() => {
                    let v = fontSize;
                    if (v < 8) v = 8;
                    else if (v > 48) v = 48;
                    else if (v === 0) v = 18;
                    setFontSize(v);
                    autoSaveSetting("font_size", String(v));
                  }}
                  placeholder="18"
                />
                <p className="text-[12px] text-text-muted mt-1.5">{t("settings.layout.fontSizeHint")}</p>
              </div>

              <div className="h-px bg-border-light" />

              <Slider
                label={t("settings.layout.lineSpacing")}
                min={10}
                max={30}
                value={Math.round(lineSpacing * 10)}
                onChange={(v) => setLineSpacing(v / 10)}
                onChangeEnd={(v) => autoSaveSetting("line_spacing", String(v / 10))}
                displayValue={lineSpacing.toFixed(1)}
                hint={t("settings.layout.lineSpacingHint")}
              />

              <Slider
                label={t("settings.layout.charSpacing")}
                min={-5}
                max={20}
                value={charSpacing}
                onChange={setCharSpacing}
                onChangeEnd={(v) => autoSaveSetting("char_spacing", String(v))}
                displayValue={`${charSpacing}%`}
                hint={t("settings.layout.charSpacingHint")}
              />

              <Slider
                label={t("settings.layout.wordSpacing")}
                min={-10}
                max={50}
                value={wordSpacing}
                onChange={setWordSpacing}
                onChangeEnd={(v) => autoSaveSetting("word_spacing", String(v))}
                displayValue={`${wordSpacing}%`}
                hint={t("settings.layout.wordSpacingHint")}
              />

              <Slider
                label={t("settings.layout.margins")}
                min={0}
                max={120}
                value={margins}
                onChange={setMargins}
                onChangeEnd={(v) => autoSaveSetting("margins", String(v))}
                displayValue={`${margins}px`}
                hint={t("settings.layout.marginsHint")}
              />
            </div>
          </section>

          {/* Reading Preferences */}
          <section className="bg-bg-surface rounded-xl border border-border p-6">
            <div className="flex items-center gap-2 mb-1">
              <BookOpen size={20} className="text-text-muted" />
              <h2 className="text-[16px] font-semibold text-text-primary">
                {t("settings.reading.title")}
              </h2>
            </div>
            <p className="text-[13px] text-text-muted mb-4">
              {t("settings.reading.subtitle")}
            </p>

            <div className="space-y-5">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-[14px] font-semibold text-text-primary">{t("settings.reading.autoSave")}</p>
                  <p className="text-[13px] text-text-muted">{t("settings.reading.autoSaveSub")}</p>
                </div>
                <Toggle checked={autoSave} onChange={(v) => { setAutoSave(v); autoSaveSetting("auto_save", String(v)); }} />
              </div>
            </div>
          </section>

          {/* iCloud Sync */}
          <section className="bg-bg-surface rounded-xl border border-border p-6">
            <div className="flex items-center gap-2 mb-1">
              <Cloud size={20} className="text-text-muted" />
              <h2 className="text-[16px] font-semibold text-text-primary">
                {t("settings.icloud.title")}
              </h2>
            </div>
            <p className="text-[13px] text-text-muted mb-4">
              {t("settings.icloud.subtitle")}
            </p>

            <div className="space-y-4">
              {icloudLoading ? (
                <div className="flex items-center gap-2">
                  <Loader2 size={16} className="text-text-muted animate-spin" />
                  <p className="text-[13px] text-text-muted">
                    {t("settings.icloud.moving")}
                  </p>
                </div>
              ) : (
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-[14px] font-semibold text-text-primary">{t("settings.icloud.enable")}</p>
                    <p className="text-[13px] text-text-muted">{t("settings.icloud.enableSub")}</p>
                  </div>
                  <Toggle
                    checked={icloudEnabled}
                    onChange={handleIcloudToggle}
                    disabled={!icloudAvailable}
                  />
                </div>
              )}

              {!icloudAvailable && !icloudLoading && (
                <p className="text-[12px] text-text-muted">
                  {t("settings.icloud.signIn")}
                </p>
              )}

              {icloudError && (
                <div className="flex items-center justify-between bg-[#fef2f2] border border-[#ffc9c9] rounded-lg px-3.5 py-2">
                  <span className="text-[12px] text-[#e7000b]">
                    {t("settings.icloud.error")}
                  </span>
                  <button
                    type="button"
                    className="text-[12px] font-medium text-[#e7000b] underline"
                    onClick={handleIcloudToggle}
                  >
                    {t("settings.ai.retry")}
                  </button>
                </div>
              )}

              <p className="text-[12px] text-[#9f9fa9]">
                {t("settings.icloud.keysNote")}
              </p>
            </div>
          </section>

          {/* Language */}
          <section className="bg-bg-surface rounded-xl border border-border p-6">
            <div className="flex items-center gap-2 mb-1">
              <Globe size={20} className="text-text-muted" />
              <h2 className="text-[16px] font-semibold text-text-primary">
                {t("settings.language")}
              </h2>
            </div>
            <p className="text-[13px] text-text-muted mb-4">
              {t("settings.languageSub")}
            </p>

            <Select
              label={t("settings.language")}
              value={language}
              onChange={(lang) => {
                setLanguage(lang);
                save("language", lang);
                i18n.changeLanguage(lang);
                showSavedToast();
              }}
              options={[
                { value: "en", label: "English" },
                { value: "zh", label: "简体中文" },
              ]}
            />
          </section>

          {/* Lookup */}
          <section className="bg-bg-surface rounded-xl border border-border p-6">
            <div className="flex items-center gap-2 mb-1">
              <BookOpen size={20} className="text-text-muted" />
              <h2 className="text-[16px] font-semibold text-text-primary">
                {t("settings.lookup.title")}
              </h2>
            </div>
            <p className="text-[13px] text-text-muted mb-4">
              {t("settings.lookup.sub")}
            </p>

            <div className="flex gap-6">
              {/* Left: controls */}
              <div className="flex-1 space-y-4">
                <Select
                  label={t("settings.lookup.nativeLanguage")}
                  value={nativeLanguage}
                  onChange={(lang) => {
                    setNativeLanguage(lang);
                    save("native_language", lang);
                    showSavedToast();
                  }}
                  options={[
                    { value: "en", label: "English" },
                    { value: "zh", label: "简体中文" },
                  ]}
                />
                <p className="text-[12px] text-text-muted -mt-2">
                  {t("settings.lookup.nativeLanguageHint")}
                </p>

                <div className="border-t border-border pt-4">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-[14px] font-medium text-text-primary">
                        {t("settings.lookup.showTranslation")}
                      </p>
                      <p className="text-[12px] text-text-muted mt-0.5">
                        {t("settings.lookup.showTranslationHint")}
                      </p>
                    </div>
                    <Toggle
                      checked={showTranslation}
                      onChange={(checked) => {
                        setShowTranslation(checked);
                        save("show_translation", String(checked));
                        showSavedToast();
                      }}
                    />
                  </div>
                </div>
              </div>

              {/* Right: preview */}
              <div className="w-[280px] shrink-0">
                <div className="bg-bg-surface border border-border/80 rounded-xl shadow-sm overflow-hidden">
                  <div className="flex items-center justify-between px-3 pt-2.5 pb-2 bg-accent-bg border-b border-border/40">
                    <div className="flex items-center gap-1.5">
                      <Sparkles size={13} className="text-accent-text" />
                      <span className="text-[12px] font-medium text-accent-text">{t("lookup.title")}</span>
                    </div>
                    <X size={12} className="text-text-muted" />
                  </div>
                  <div className="px-3 py-2.5">
                    <p className="text-[16px] font-bold text-text-primary mb-1">interfaces</p>
                    {language !== "en" ? (
                      <>
                        <p className="text-[12px] text-text-primary leading-[1.5] mb-2">
                          {language === "zh"
                            ? "名词。两个系统相互连接和交互的点或区域。"
                            : "/ˈɪntəfeɪsɪz/ noun. Points where two systems meet and interact."}
                        </p>
                        <div className="p-2 rounded-md bg-bg-muted border border-border/50">
                          <p className="text-[11px] font-medium text-text-muted mb-0.5">{t("lookup.inContext")}</p>
                          <p className="text-[11px] text-text-secondary leading-[1.5]">
                            {language === "zh"
                              ? "\u5728\u8fd9\u6bb5\u6587\u5b57\u4e2d\uff0cinterfaces \u6307\u7684\u662f\u4eba\u7c7b\u4e0e\u6280\u672f\u4e4b\u95f4\u7684\u8fb9\u754c\u3002"
                              : 'In this passage, "interfaces" refers to the boundaries between humanity and technology.'}
                          </p>
                        </div>
                      </>
                    ) : (
                      <>
                        {showTranslation && nativeLanguage !== "en" && (
                          <p className="text-[13px] text-accent-text mb-2">
                            {nativeLanguage === "zh" ? "界面；接口" : "interfaces"}
                          </p>
                        )}
                        <p className="text-[12px] text-text-primary leading-[1.5] mb-2">
                          /ˈɪntəfeɪsɪz/ noun. Points where two systems meet and interact.
                        </p>
                        <div className="p-2 rounded-md bg-bg-muted border border-border/50">
                          <p className="text-[11px] font-medium text-text-muted mb-0.5">{t("lookup.inContext")}</p>
                          <p className="text-[11px] text-text-secondary leading-[1.5]">
                            In this passage, &quot;interfaces&quot; refers to the boundaries between humanity and technology.
                          </p>
                        </div>
                      </>
                    )}
                  </div>
                  <div className="flex items-center justify-between px-3 py-2 border-t border-border/40">
                    <span className="text-[11px] font-medium text-accent-text">{t("lookup.saveToDict")}</span>
                    <span className="text-[11px] font-medium text-text-muted">{t("lookup.copy")}</span>
                  </div>
                </div>
              </div>
            </div>
          </section>

          {/* Appearance */}
          <section className="bg-bg-surface rounded-xl border border-border p-6">
            <div className="flex items-center gap-2 mb-1">
              <Palette size={20} className="text-text-muted" />
              <h2 className="text-[16px] font-semibold text-text-primary">
                {t("settings.appearance.title")}
              </h2>
            </div>
            <p className="text-[13px] text-text-muted mb-4">
              {t("settings.appearance.subtitle")}
            </p>

            <Select
              label={t("settings.appearance.theme")}
              value={theme}
              onChange={(v) => { setTheme(v); autoSaveSetting("theme", v); }}
              options={[
                { value: "system", label: t("settings.appearance.system") },
                { value: "light", label: t("settings.appearance.light") },
                { value: "dark", label: t("settings.appearance.dark") },
              ]}
            />
            <p className="text-[12px] text-text-muted mt-1.5">{t("settings.appearance.themeHint")}</p>
          </section>
        </div>
      </main>

      {/* iCloud confirmation dialog */}
      {icloudConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-overlay">
          <div className="bg-bg-surface rounded-xl shadow-lg w-[400px] p-6">
            <h3 className="text-[18px] font-semibold text-text-primary mb-2">
              {icloudConfirm === "enable"
                ? icloudHasExistingData
                  ? t("settings.icloud.confirmEnableExisting")
                  : t("settings.icloud.confirmEnable")
                : t("settings.icloud.confirmDisable")}
            </h3>
            <p className="text-[14px] text-text-secondary leading-5 mb-6">
              {icloudConfirm === "enable"
                ? icloudHasExistingData
                  ? t("settings.icloud.confirmEnableExistingMsg")
                  : t("settings.icloud.confirmEnableMsg")
                : t("settings.icloud.confirmDisableMsg")}
            </p>
            <div className="flex justify-end gap-3">
              <Button variant="ghost" size="md" onClick={() => setIcloudConfirm(null)}>
                {t("common.cancel")}
              </Button>
              <Button variant="primary" size="md" onClick={confirmIcloudToggle}>
                {icloudConfirm === "enable"
                  ? icloudHasExistingData ? t("settings.icloud.syncWithIcloud") : t("settings.icloud.moveToIcloud")
                  : t("settings.icloud.moveToLocal")}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Toast */}
      {showToast && (
        <div className="fixed top-6 left-1/2 -translate-x-1/2 z-50 bg-accent text-white text-[13px] font-medium px-4 py-2 rounded-lg shadow-popover transition-opacity">
          {toastMessage}
        </div>
      )}
      {oauthToast && (
        <div className="fixed top-6 left-1/2 -translate-x-1/2 z-50 bg-accent text-white text-[13px] font-medium px-4 py-2 rounded-lg shadow-popover flex items-center gap-2">
          {t("settings.ai.oauthSuccess")}
        </div>
      )}
    </div>
  );
}
