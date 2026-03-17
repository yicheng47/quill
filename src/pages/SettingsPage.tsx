import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { invoke } from "@tauri-apps/api/core";
import { ArrowLeft, Bot, BookOpen, SlidersHorizontal, Palette, Save, KeyRound, Shield, Cloud, Loader2 } from "lucide-react";
import Button from "../components/ui/Button";
import Select from "../components/ui/Select";
import Input from "../components/ui/Input";
import Toggle from "../components/ui/Toggle";
import Slider from "../components/ui/Slider";
import SaveDialog from "../components/SaveDialog";
import { useSettings } from "../hooks/useSettings";

export default function SettingsPage() {
  const navigate = useNavigate();
  const [saveDialogOpen, setSaveDialogOpen] = useState(false);
  const [showToast, setShowToast] = useState(false);
  const { settings, loading, saveBulk } = useSettings();

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

  // Appearance
  const [theme, setTheme] = useState("system");

  // iCloud
  const [icloudAvailable, setIcloudAvailable] = useState(false);
  const [icloudEnabled, setIcloudEnabled] = useState(false);
  const [icloudLoading, setIcloudLoading] = useState(false);
  const [icloudError, setIcloudError] = useState<string | null>(null);

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
  }, [settings, loading]);

  // Fetch iCloud status on mount
  useEffect(() => {
    invoke<{ available: boolean; enabled: boolean }>("icloud_status")
      .then((status) => {
        setIcloudAvailable(status.available);
        setIcloudEnabled(status.enabled);
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

  const handleSave = async () => {
    try {
      await saveBulk({
        ai_provider: provider,
        ai_api_key: apiKey,
        ai_model: model,
        ai_base_url: baseUrl,
        ai_temperature: String(temperature),
        ai_keep_alive: keepAlive,
        ai_auth_mode: authMode,
        font_size: String(fontSize),
        font_family: fontFamily,
        line_spacing: String(lineSpacing),
        char_spacing: String(charSpacing),
        word_spacing: String(wordSpacing),
        margins: String(margins),
        auto_save: String(autoSave),
        theme,
      });
      setSaveDialogOpen(false);
      setShowToast(true);
      setTimeout(() => setShowToast(false), 2000);
    } catch (err) {
      console.error("Failed to save settings:", err);
    }
  };

  const handleIcloudToggle = async () => {
    setIcloudLoading(true);
    setIcloudError(null);
    try {
      if (icloudEnabled) {
        await invoke("icloud_disable");
        setIcloudEnabled(false);
      } else {
        await invoke("icloud_enable");
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
      <header className="flex items-center justify-between px-page pt-8 pb-2 bg-bg-surface border-b border-border shrink-0 relative">
        <div data-tauri-drag-region className="absolute top-0 left-0 right-0 h-8" />
        <div className="flex items-center gap-4">
          <Button variant="icon" size="md" onClick={() => navigate(-1)}>
            <ArrowLeft size={16} />
          </Button>
          <div>
            <h1 className="text-[18px] font-semibold text-text-primary">Settings</h1>
            <p className="text-[13px] text-text-muted">
              Manage your reading preferences and AI configuration
            </p>
          </div>
        </div>
        <Button
          variant="primary"
          size="md"
          onClick={() => setSaveDialogOpen(true)}
        >
          <Save size={16} />
          Save Changes
        </Button>
      </header>

      {/* Content */}
      <main className="flex-1 overflow-auto">
        <div className="max-w-[560px] mx-auto py-8 px-4 space-y-6">
          {/* AI Assistant Configuration */}
          <section className="bg-bg-surface rounded-xl border border-border p-6">
            <div className="flex items-center gap-2 mb-1">
              <Bot size={20} className="text-text-muted" />
              <h2 className="text-[16px] font-semibold text-text-primary">
                AI Assistant Configuration
              </h2>
            </div>
            <p className="text-[13px] text-text-muted mb-4">
              Configure your AI provider and model preferences for the reading assistant
            </p>

            <div className="space-y-5">

              {/* Provider */}
              <Select
                label="AI Provider"
                value={provider}
                onChange={(p) => {
                  setProvider(p);
                  if (p === "ollama") {
                    setBaseUrl("http://localhost:11434");
                    setModel("qwen3.5");
                  } else if (p === "openai") {
                    setBaseUrl("https://api.openai.com");
                    setModel("gpt-4o");
                  } else if (p === "anthropic") {
                    setModel("claude-sonnet-4-20250514");
                  } else if (p === "minimax") {
                    setBaseUrl("https://api.minimax.io/anthropic");
                    setModel("MiniMax-M2.5");
                  }
                }}
                options={[
                  { value: "openai", label: "OpenAI" },
                  { value: "anthropic", label: "Anthropic" },
                  { value: "minimax", label: "MiniMax" },
                  { value: "google", label: "Google AI" },
                  { value: "ollama", label: "Ollama (Local)" },
                ]}
              />
              <p className="-mt-3 text-[12px] text-text-muted">Choose your preferred AI service provider</p>

              {/* Authentication Method (OpenAI only) */}
              {provider === "openai" && (
                <div>
                  <label className="block text-[14px] font-semibold text-text-primary mb-1.5">
                    Authentication Method
                  </label>
                  <div className="flex rounded-lg border border-border overflow-hidden">
                    <button
                      type="button"
                      className={`flex-1 flex items-center justify-center gap-2 h-9 text-[13px] font-medium transition-colors ${
                        authMode === "api_key"
                          ? "bg-accent text-white"
                          : "bg-bg-page text-text-secondary hover:bg-bg-input"
                      }`}
                      onClick={() => { setAuthMode("api_key"); setModel("gpt-4o"); }}
                    >
                      <KeyRound size={14} />
                      API Key
                    </button>
                    <button
                      type="button"
                      className={`flex-1 flex items-center justify-center gap-2 h-9 text-[13px] font-medium transition-colors ${
                        authMode === "oauth"
                          ? "bg-accent text-white"
                          : "bg-bg-page text-text-secondary hover:bg-bg-input"
                      }`}
                      onClick={() => { setAuthMode("oauth"); setModel("gpt-5.3-codex"); }}
                    >
                      <Shield size={14} />
                      OAuth Login
                    </button>
                  </div>
                  <p className="text-[12px] text-text-muted mt-1.5">Choose how to authenticate with OpenAI</p>
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
                          Connected: {oauthStatus.account_id ?? "Unknown"}
                        </span>
                      </div>
                      <button
                        type="button"
                        className="text-[13px] font-medium text-text-muted hover:text-text-primary transition-colors"
                        onClick={handleOAuthLogout}
                      >
                        Logout
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
                        {oauthLoading ? "Waiting for authentication..." : "Login with OpenAI"}
                      </Button>
                      {oauthError ? (
                        <div className="flex items-center justify-between mt-2 px-3 py-2 rounded-lg bg-red-50 dark:bg-red-950/30">
                          <span className="text-[12px] text-red-600 dark:text-red-400">
                            Authentication failed. Please try again.
                          </span>
                          <button
                            type="button"
                            className="text-[12px] font-medium text-red-600 dark:text-red-400 hover:underline"
                            onClick={handleOAuthLogin}
                          >
                            Retry
                          </button>
                        </div>
                      ) : (
                        <p className="text-[12px] text-text-muted mt-1.5">
                          Sign in with your OpenAI account. A browser window will open for authentication.
                        </p>
                      )}
                    </>
                  )}
                </div>
              )}

              {/* Base URL (for Ollama / OpenAI Compatible) */}
              {(provider === "ollama" || (provider === "openai" && authMode === "api_key") || provider === "minimax" || provider === "anthropic") && (
                <div>
                  <label className="block text-[14px] font-semibold text-text-primary mb-1.5">
                    Base URL
                  </label>
                  <Input
                    value={baseUrl}
                    onChange={(e) => setBaseUrl(e.target.value)}
                    placeholder={provider === "ollama" ? "http://localhost:11434" : "https://api.openai.com"}
                  />
                  <p className="text-[12px] text-text-muted mt-1.5">
                    {provider === "ollama" ? "Ollama server address" : "API base URL (e.g. https://api.openai.com)"}
                  </p>
                </div>
              )}

              {/* API Key (for Anthropic / OpenAI Compatible — hidden when OpenAI + OAuth) */}
              {(provider === "anthropic" || (provider === "openai" && authMode === "api_key") || provider === "minimax") && (
                <div>
                  <label className="block text-[14px] font-semibold text-text-primary mb-1.5">
                    API Key
                  </label>
                  <Input
                    type="password"
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    placeholder={provider === "anthropic" ? "sk-ant-..." : "sk-..."}
                  />
                  <p className="text-[12px] text-text-muted mt-1.5">
                    Your API key is stored locally and never shared
                  </p>
                </div>
              )}

              {/* Model */}
              <div>
                <label className="block text-[14px] font-semibold text-text-primary mb-1.5">
                  Model
                </label>
                <Input
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  placeholder={
                    provider === "ollama" ? "qwen3.5" :
                    provider === "anthropic" ? "claude-sonnet-4-20250514" :
                    provider === "minimax" ? "MiniMax-M2.5" :
                    provider === "google" ? "gemini-2.0-flash" :
                    (provider === "openai" && authMode === "oauth") ? "gpt-5.3-codex" :
                    "gpt-4o"
                  }
                />
                <p className="text-[12px] text-text-muted mt-1.5">
                  Enter the model name supported by your provider
                </p>
              </div>

              <div className="h-px bg-border-light" />

              {/* Temperature */}
              <Slider
                label="Temperature"
                min={0}
                max={100}
                value={Math.round(temperature * 100)}
                onChange={(v) => setTemperature(v / 100)}
                displayValue={temperature.toFixed(1)}
                hint="Lower = more focused, Higher = more creative"
              />

              {/* Keep Alive (Ollama only) */}
              {provider === "ollama" && (
                <div>
                  <label className="block text-[14px] font-semibold text-text-primary mb-1.5">
                    Keep Alive
                  </label>
                  <Input
                    value={keepAlive}
                    onChange={(e) => setKeepAlive(e.target.value)}
                    placeholder="30m"
                  />
                  <p className="text-[12px] text-text-muted mt-1.5">
                    How long to keep the model loaded in memory (e.g. "30m", "1h", "-1" for never unload)
                  </p>
                </div>
              )}

            </div>
          </section>

          {/* Default Layout */}
          <section className="bg-bg-surface rounded-xl border border-border p-6">
            <div className="flex items-center gap-2 mb-1">
              <SlidersHorizontal size={20} className="text-accent" />
              <h2 className="text-[16px] font-semibold text-text-primary">
                Default Layout
              </h2>
            </div>
            <p className="text-[13px] text-text-muted mb-4">
              Set default font and spacing applied when opening books
            </p>

            <div className="space-y-5">
              <Select
                label="Font Family"
                value={fontFamily}
                onChange={setFontFamily}
                options={[
                  { value: "system", label: "System Default" },
                  { value: "georgia", label: "Georgia" },
                  { value: "palatino", label: "Palatino" },
                  { value: "inter", label: "Inter" },
                  { value: "times", label: "Times New Roman" },
                ]}
              />
              <p className="-mt-3 text-[12px] text-text-muted">Choose your preferred reading font</p>

              <div>
                <label className="block text-[14px] font-semibold text-text-primary mb-1.5">
                  Font Size
                </label>
                <Input
                  value={String(fontSize)}
                  onChange={(e) => {
                    const raw = e.target.value.replace(/\D/g, "");
                    const v = raw === "" ? 0 : parseInt(raw);
                    setFontSize(v);
                  }}
                  onBlur={() => {
                    if (fontSize < 8) setFontSize(8);
                    else if (fontSize > 48) setFontSize(48);
                    else if (fontSize === 0) setFontSize(18);
                  }}
                  placeholder="18"
                />
                <p className="text-[12px] text-text-muted mt-1.5">Default font size in pixels (8–48)</p>
              </div>

              <div className="h-px bg-border-light" />

              <Slider
                label="Line Spacing"
                min={10}
                max={30}
                value={Math.round(lineSpacing * 10)}
                onChange={(v) => setLineSpacing(v / 10)}
                displayValue={lineSpacing.toFixed(1)}
                hint="Default space between lines of text"
              />

              <Slider
                label="Character Spacing"
                min={-5}
                max={20}
                value={charSpacing}
                onChange={setCharSpacing}
                displayValue={`${charSpacing}%`}
                hint="Default space between individual characters"
              />

              <Slider
                label="Word Spacing"
                min={-10}
                max={50}
                value={wordSpacing}
                onChange={setWordSpacing}
                displayValue={`${wordSpacing}%`}
                hint="Default space between words"
              />

              <Slider
                label="Margins"
                min={0}
                max={120}
                value={margins}
                onChange={setMargins}
                displayValue={`${margins}px`}
                hint="Default margins around the reading area"
              />
            </div>
          </section>

          {/* Reading Preferences */}
          <section className="bg-bg-surface rounded-xl border border-border p-6">
            <div className="flex items-center gap-2 mb-1">
              <BookOpen size={20} className="text-text-muted" />
              <h2 className="text-[16px] font-semibold text-text-primary">
                Reading Preferences
              </h2>
            </div>
            <p className="text-[13px] text-text-muted mb-4">
              Customize your reading experience
            </p>

            <div className="space-y-5">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-[14px] font-semibold text-text-primary">Auto-save Progress</p>
                  <p className="text-[13px] text-text-muted">Automatically save your reading position</p>
                </div>
                <Toggle checked={autoSave} onChange={setAutoSave} />
              </div>
            </div>
          </section>

          {/* iCloud Sync */}
          <section className="bg-bg-surface rounded-xl border border-border p-6">
            <div className="flex items-center gap-2 mb-1">
              <Cloud size={20} className="text-text-muted" />
              <h2 className="text-[16px] font-semibold text-text-primary">
                iCloud Sync
              </h2>
            </div>
            <p className="text-[13px] text-text-muted mb-4">
              Sync your books, reading progress, and highlights across your Macs
            </p>

            <div className="space-y-4">
              {icloudLoading ? (
                <div className="flex items-center gap-2">
                  <Loader2 size={16} className="text-text-muted animate-spin" />
                  <p className="text-[13px] text-text-muted">
                    Moving files to iCloud Drive...
                  </p>
                </div>
              ) : (
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-[14px] font-semibold text-text-primary">Enable iCloud Sync</p>
                    <p className="text-[13px] text-text-muted">Store your library in iCloud Drive</p>
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
                  Sign in to iCloud on your Mac to enable sync
                </p>
              )}

              {icloudError && (
                <div className="flex items-center justify-between bg-[#fef2f2] border border-[#ffc9c9] rounded-lg px-3.5 py-2">
                  <span className="text-[12px] text-[#e7000b]">
                    Failed to enable iCloud Sync. Please try again.
                  </span>
                  <button
                    type="button"
                    className="text-[12px] font-medium text-[#e7000b] underline"
                    onClick={handleIcloudToggle}
                  >
                    Retry
                  </button>
                </div>
              )}

              <p className="text-[12px] text-[#9f9fa9]">
                API keys and login tokens are stored locally and will not sync
              </p>
            </div>
          </section>

          {/* Appearance */}
          <section className="bg-bg-surface rounded-xl border border-border p-6">
            <div className="flex items-center gap-2 mb-1">
              <Palette size={20} className="text-text-muted" />
              <h2 className="text-[16px] font-semibold text-text-primary">
                Appearance
              </h2>
            </div>
            <p className="text-[13px] text-text-muted mb-4">
              Customize the look and feel of the app
            </p>

            <Select
              label="Theme"
              value={theme}
              onChange={setTheme}
              options={[
                { value: "system", label: "System" },
                { value: "light", label: "Light" },
                { value: "dark", label: "Dark" },
              ]}
            />
            <p className="text-[12px] text-text-muted mt-1.5">Choose your preferred color scheme</p>
          </section>
        </div>
      </main>

      <SaveDialog
        open={saveDialogOpen}
        onCancel={() => setSaveDialogOpen(false)}
        onSave={handleSave}
      />

      {showToast && (
        <div className="fixed top-6 left-1/2 -translate-x-1/2 z-50 bg-accent text-white text-[14px] font-medium px-4 py-2.5 rounded-lg shadow-popover">
          Settings saved successfully
        </div>
      )}
      {oauthToast && (
        <div className="fixed top-6 left-1/2 -translate-x-1/2 z-50 bg-accent text-white text-[14px] font-medium px-4 py-2.5 rounded-lg shadow-popover flex items-center gap-2">
          Successfully authenticated with OpenAI
        </div>
      )}
    </div>
  );
}
