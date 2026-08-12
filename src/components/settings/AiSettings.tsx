import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { KeyRound, Shield } from "lucide-react";
import { useTranslation } from "react-i18next";
import Button from "../ui/Button";
import Select from "../ui/Select";
import Input from "../ui/Input";
import Slider from "../ui/Slider";
import { CODEX_EFFORT_LEVELS, CURATED_CODEX_MODELS, type CodexModel } from "./codexModels";
import type { SettingsProps } from "./types";

interface AiSettingsProps extends SettingsProps {
  onSaveRef?: (save: (() => void) | null) => void;
  onDirtyChange?: (dirty: boolean) => void;
}

interface CodexModelList {
  models: CodexModel[];
  from_fallback: boolean;
}

const CUSTOM_MODEL = "__custom__";

export default function AiSettings({ settings, loading, saveBulk, showSavedToast, onSaveRef, onDirtyChange }: AiSettingsProps) {
  const { t } = useTranslation();
  const [aiDirty, setAiDirty] = useState(false);

  // AI config
  const [provider, setProvider] = useState("openai");
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState("gpt-5.6-sol");
  const [baseUrl, setBaseUrl] = useState("https://api.openai.com");
  const [temperature, setTemperature] = useState(0.3);
  const [keepAlive, setKeepAlive] = useState("30m");

  // OAuth
  const [authMode, setAuthMode] = useState<"api_key" | "oauth">("oauth");
  const [oauthStatus, setOauthStatus] = useState<{ connected: boolean; account_id: string | null }>({ connected: false, account_id: null });
  const [oauthLoading, setOauthLoading] = useState(false);
  const [oauthError, setOauthError] = useState<string | null>(null);

  // Codex model card + reasoning effort (OpenAI OAuth path only)
  const [codexModels, setCodexModels] = useState<CodexModel[]>(CURATED_CODEX_MODELS);
  const [modelsFromFallback, setModelsFromFallback] = useState(false);
  const [customModel, setCustomModel] = useState(false);
  const [effortQuick, setEffortQuick] = useState("default");
  const [effortDeep, setEffortDeep] = useState("default");

  const isCodexPath = provider === "openai" && authMode === "oauth";

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
    if (settings.ai_effort_quick) setEffortQuick(settings.ai_effort_quick);
    if (settings.ai_effort_deep) setEffortDeep(settings.ai_effort_deep);
  }, [settings, loading]);

  // Fetch OAuth status when provider is OpenAI
  useEffect(() => {
    if (provider === "openai") {
      invoke<{ connected: boolean; account_id: string | null }>("openai_oauth_status")
        .then(setOauthStatus)
        .catch(() => setOauthStatus({ connected: false, account_id: null }));
    }
  }, [provider]);

  // Fetch the Codex model list on the OAuth path; refetched when the OAuth
  // connection state flips so a fresh login upgrades fallback → live list.
  useEffect(() => {
    if (!isCodexPath) return;
    let stale = false;
    invoke<CodexModelList>("list_codex_models")
      .then((list) => {
        if (stale) return;
        setModelsFromFallback(list.from_fallback);
        setCodexModels(list.models);
      })
      .catch(() => {
        if (stale) return;
        setCodexModels(CURATED_CODEX_MODELS);
        setModelsFromFallback(true);
      });
    return () => {
      stale = true;
    };
  }, [isCodexPath, oauthStatus.connected]);

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
        ai_effort_quick: effortQuick,
        ai_effort_deep: effortDeep,
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
      // Auto-save AI configuration after successful OAuth login
      await saveBulk({
        ai_provider: provider,
        ai_api_key: apiKey,
        ai_model: model,
        ai_base_url: baseUrl,
        ai_temperature: String(temperature),
        ai_keep_alive: keepAlive,
        ai_auth_mode: authMode,
        ai_effort_quick: effortQuick,
        ai_effort_deep: effortDeep,
      });
      setAiDirty(false);
      showSavedToast(t("settings.ai.oauthSuccess"));
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

  // A saved model absent from the fetched list renders as the Custom value —
  // never silently switched to something else.
  const modelInList = codexModels.some((m) => m.slug === model);
  const isCustomModel = customModel || !modelInList;

  const modelOptions = [
    ...codexModels.map((m) => ({
      value: m.slug,
      label: m.display_name,
      description: m.description || undefined,
    })),
    { value: CUSTOM_MODEL, label: t("settings.ai.modelCustom") },
  ];

  const effortLabel = (level: string) => {
    const key = `settings.ai.effort.${level}`;
    const label = t(key);
    return label === key ? level : label;
  };

  // Effort options come from the selected model; a saved level the model
  // doesn't support stays visible rather than being silently coerced.
  const selectedCodexModel = codexModels.find((m) => m.slug === model);
  const effortLevels =
    selectedCodexModel && selectedCodexModel.supported_reasoning_levels.length > 0
      ? selectedCodexModel.supported_reasoning_levels
      : CODEX_EFFORT_LEVELS;
  const effortOptions = (saved: string) => {
    const options = [
      { value: "default", label: t("settings.ai.effortDefault") },
      ...effortLevels.map((level) => ({ value: level, label: effortLabel(level) })),
    ];
    if (saved !== "default" && !options.some((o) => o.value === saved)) {
      options.push({ value: saved, label: effortLabel(saved) });
    }
    return options;
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
              setCustomModel(false);
              setAiDirty(true);
              if (p === "ollama") {
                setBaseUrl("http://localhost:11434"); setModel("qwen3.5");
              } else if (p === "openai") {
                setBaseUrl("https://api.openai.com"); setModel("gpt-5.6-sol"); setAuthMode("oauth");
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
              onClick={() => { setAuthMode("api_key"); setModel("gpt-4o"); setCustomModel(false); setAiDirty(true); }}
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
              onClick={() => { setAuthMode("oauth"); setModel("gpt-5.6-sol"); setCustomModel(false); setAiDirty(true); }}
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
      {(provider === "anthropic" || (provider === "openai" && authMode === "api_key")) && (
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

      {/* Base URL (for Ollama / OpenAI Compatible / Anthropic) */}
      {(provider === "ollama" || (provider === "openai" && authMode === "api_key") || provider === "anthropic") && (
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
        {isCodexPath ? (
          <>
            <Select
              value={isCustomModel ? CUSTOM_MODEL : model}
              onChange={(v) => {
                if (v === CUSTOM_MODEL) {
                  setCustomModel(true);
                } else {
                  setCustomModel(false);
                  setModel(v);
                }
                setAiDirty(true);
              }}
              options={modelOptions}
            />
            {isCustomModel && (
              <Input
                className="mt-2"
                value={model}
                onChange={(e) => { setModel(e.target.value); setAiDirty(true); }}
                placeholder="gpt-5.6-sol"
              />
            )}
            <p className="text-[12px] text-text-muted mt-1.5">
              {modelsFromFallback && oauthStatus.connected
                ? t("settings.ai.modelListFallbackHint")
                : isCustomModel
                  ? t("settings.ai.modelHint")
                  : t("settings.ai.modelPickerHint")}
            </p>
          </>
        ) : (
          <>
            <Input
              value={model}
              onChange={(e) => { setModel(e.target.value); setAiDirty(true); }}
              placeholder={
                provider === "ollama" ? "qwen3.5" :
                provider === "anthropic" ? "claude-sonnet-4-20250514" :
                (provider === "openai" && authMode === "oauth") ? "gpt-5.6-sol" :
                "gpt-4o"
              }
            />
            <p className="text-[12px] text-text-muted mt-1.5">
              {t("settings.ai.modelHint")}
            </p>
          </>
        )}
      </div>

      {/* Reasoning effort tiers (OpenAI OAuth path only) */}
      {isCodexPath && (
        <>
          <div className="py-3 border-b border-border">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-[14px] font-medium text-text-primary">{t("settings.ai.effortQuick")}</p>
                <p className="text-[12px] text-text-muted mt-0.5">{t("settings.ai.effortQuickHint")}</p>
              </div>
              <Select
                className="w-[160px] shrink-0"
                value={effortQuick}
                onChange={(v) => { setEffortQuick(v); setAiDirty(true); }}
                options={effortOptions(effortQuick)}
              />
            </div>
          </div>
          <div className="py-3 border-b border-border">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-[14px] font-medium text-text-primary">{t("settings.ai.effortDeep")}</p>
                <p className="text-[12px] text-text-muted mt-0.5">{t("settings.ai.effortDeepHint")}</p>
              </div>
              <Select
                className="w-[160px] shrink-0"
                value={effortDeep}
                onChange={(v) => { setEffortDeep(v); setAiDirty(true); }}
                options={effortOptions(effortDeep)}
              />
            </div>
          </div>
        </>
      )}

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
    </div>
  );
}
