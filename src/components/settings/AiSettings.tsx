import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { KeyRound, Shield } from "lucide-react";
import { useTranslation } from "react-i18next";
import Button from "../ui/Button";
import Select from "../ui/Select";
import Input from "../ui/Input";
import Slider from "../ui/Slider";
import type { SettingsProps } from "./types";

interface AiSettingsProps extends SettingsProps {
  onSaveRef?: (save: (() => void) | null) => void;
  onDirtyChange?: (dirty: boolean) => void;
}

export default function AiSettings({ settings, loading, saveBulk, showSavedToast, onSaveRef, onDirtyChange }: AiSettingsProps) {
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
  }, [settings, loading]);

  // Fetch OAuth status when provider is OpenAI
  useEffect(() => {
    if (provider === "openai") {
      invoke<{ connected: boolean; account_id: string | null }>("openai_oauth_status")
        .then(setOauthStatus)
        .catch(() => setOauthStatus({ connected: false, account_id: null }));
    }
  }, [provider]);

  // Expose dirty state and save handler to parent
  useEffect(() => {
    onDirtyChange?.(aiDirty);
  }, [aiDirty, onDirtyChange]);

  useEffect(() => {
    onSaveRef?.(handleSaveAI);
    return () => onSaveRef?.(null);
  });

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
    <div className="space-y-0">
      {/* Provider */}
      <div className="py-3 border-b border-border">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-[14px] font-medium text-text-primary">{t("settings.ai.provider")}</p>
            <p className="text-[12px] text-text-muted mt-0.5">{t("settings.ai.providerHint")}</p>
          </div>
          <Select
            className="w-[160px] shrink-0"
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
              } else if (p === "minimax") {
                setBaseUrl("https://api.minimax.io/anthropic"); setModel("MiniMax-M2.5");
              } else {
                setBaseUrl(""); setModel("");
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
        </div>
      </div>

      {/* Authentication Method (OpenAI only) */}
      {provider === "openai" && (
        <div className="py-3 border-b border-border">
          <p className="text-[14px] font-medium text-text-primary mb-1.5">
            {t("settings.ai.authMethod")}
          </p>
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
        <div className="py-3 border-b border-border">
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

      {/* API Key (for Anthropic / OpenAI Compatible -- hidden when OpenAI + OAuth) */}
      {(provider === "anthropic" || (provider === "openai" && authMode === "api_key") || provider === "minimax") && (
        <div className="py-3 border-b border-border">
          <p className="text-[14px] font-medium text-text-primary mb-1.5">
            {t("settings.ai.apiKey")}
          </p>
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

      {/* Base URL (for Ollama / OpenAI Compatible) */}
      {(provider === "ollama" || (provider === "openai" && authMode === "api_key") || provider === "minimax" || provider === "anthropic") && (
        <div className="py-3 border-b border-border">
          <p className="text-[14px] font-medium text-text-primary mb-1.5">
            {t("settings.ai.baseUrl")}
          </p>
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

      {/* Model */}
      <div className="py-3 border-b border-border">
        <p className="text-[14px] font-medium text-text-primary mb-1.5">
          {t("settings.ai.model")}
        </p>
        <Input
          value={model}
          onChange={(e) => { setModel(e.target.value); setAiDirty(true); }}
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
          {t("settings.ai.modelHint")}
        </p>
      </div>

      {/* Temperature */}
      <div className="py-3 border-b border-border">
        <Slider
          label={t("settings.ai.temperature")}
          min={0}
          max={100}
          value={Math.round(temperature * 100)}
          onChange={(v) => { setTemperature(v / 100); setAiDirty(true); }}
          displayValue={temperature.toFixed(1)}
          hint={t("settings.ai.temperatureHint")}
        />
      </div>

      {/* Keep Alive (Ollama only) */}
      {provider === "ollama" && (
        <div className="py-3 border-b border-border">
          <p className="text-[14px] font-medium text-text-primary mb-1.5">
            {t("settings.ai.keepAlive")}
          </p>
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


      {/* OAuth success toast */}
      {oauthToast && (
        <div className="fixed top-6 left-1/2 -translate-x-1/2 z-50 bg-accent text-white text-[13px] font-medium px-4 py-2 rounded-lg shadow-popover flex items-center gap-2">
          {t("settings.ai.oauthSuccess")}
        </div>
      )}
    </div>
  );
}
