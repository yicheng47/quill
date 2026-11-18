import {
  useState,
  useEffect,
  useRef,
  useCallback,
  type ChangeEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import {
  AlertCircle,
  Clock,
  Cpu,
  ExternalLink,
  Eye,
  EyeOff,
  KeyRound,
  Loader2,
  LogOut,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import { invoke, listenCurrentWindow } from "../../platform";
import { isMacOS } from "../../lib/platformEnv";
import Button from "../ui/Button";
import Select from "../ui/Select";
import { SegmentedControl } from "../ui/Segment";
import { StatusBadge } from "../ui/Badge";
import Stepper from "../ui/Stepper";
import { SettingsGroup, SettingsOverline, SettingsRow } from "../ui/SettingsRow";
import { CODEX_EFFORT_LEVELS, CURATED_CODEX_MODELS, type CodexModel } from "./codexModels";
import type { SettingsProps } from "./types";

type AiProvider = "openai" | "anthropic" | "ollama";
type OpenAiAuthMode = "oauth" | "api_key";
type TextFieldKey = "ai_api_key" | "ai_base_url" | "ai_model";

interface OAuthStatus {
  connected: boolean;
  account_id: string | null;
  email?: string | null;
}

interface CodexModelList {
  models: CodexModel[];
  from_fallback: boolean;
}

interface OllamaStatus {
  running: boolean;
}

const CUSTOM_MODEL = "__custom__";
const DEFAULT_OPENAI_URL = "https://api.openai.com";
const DEFAULT_ANTHROPIC_URL = "https://api.anthropic.com";
const DEFAULT_OLLAMA_URL = "http://localhost:11434";
const TEXT_SAVE_DEBOUNCE_MS = 450;

const KEEP_ALIVE_PRESETS = [
  { value: "5m", labelKey: "settings.ai.keepAlive5m" },
  { value: "15m", labelKey: "settings.ai.keepAlive15m" },
  { value: "30m", labelKey: "settings.ai.keepAlive30m" },
  { value: "1h", labelKey: "settings.ai.keepAlive1h" },
  { value: "-1", labelKey: "settings.ai.keepAliveForever" },
  { value: "0", labelKey: "settings.ai.keepAliveUnload" },
] as const;

const DISCONNECTED_OAUTH: OAuthStatus = {
  connected: false,
  account_id: null,
  email: null,
};

function normalizeProvider(raw?: string): AiProvider {
  if (raw === "anthropic" || raw === "ollama" || raw === "openai") return raw;
  return "openai";
}

function normalizeAuthMode(raw?: string): OpenAiAuthMode {
  return raw === "api_key" ? "api_key" : "oauth";
}

function defaultModelFor(provider: AiProvider, authMode: OpenAiAuthMode): string {
  if (provider === "ollama") return "qwen3.5";
  if (provider === "anthropic") return "claude-sonnet-4-20250514";
  return authMode === "api_key" ? "gpt-4o" : "gpt-5.6-sol";
}

function clampTemperature(raw?: string): number {
  if (!raw) return 0.3;
  const parsed = parseFloat(raw);
  if (Number.isNaN(parsed)) return 0.3;
  return Math.min(1, Math.max(0, Math.round(parsed * 10) / 10));
}

function stepTemperatureValue(current: number, delta: number): number {
  return Math.min(1, Math.max(0, Math.round((current + delta) * 10) / 10));
}

const monoInputClass =
  "h-9 px-3 rounded-[10px] bg-surface-solid border border-border-default font-mono text-[12.5px] text-text-primary placeholder:text-text-disabled focus:outline-none focus:border-accent focus:ring-[3px] focus:ring-focus-ring transition-colors";

interface SignOutConfirmModalProps {
  open: boolean;
  email?: string | null;
  isMac: boolean;
  signingOut: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

function SignOutConfirmModal({
  open,
  email,
  isMac,
  signingOut,
  onCancel,
  onConfirm,
}: SignOutConfirmModalProps) {
  const { t } = useTranslation();

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      if (!signingOut) onCancel();
    };
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [open, signingOut, onCancel]);

  if (!open) return null;

  const trimmedEmail = email?.trim();
  const body = trimmedEmail
    ? isMac
      ? t("settings.ai.signOutConfirmBodyWithEmailMac", { email: trimmedEmail })
      : t("settings.ai.signOutConfirmBodyWithEmailOther", { email: trimmedEmail })
    : isMac
      ? t("settings.ai.signOutConfirmBodyMac")
      : t("settings.ai.signOutConfirmBodyOther");

  return createPortal(
    <div
      className="fixed inset-0 z-50 bg-scrim backdrop-blur-[6px] flex items-center justify-center p-4"
      onClick={() => {
        if (!signingOut) onCancel();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="signout-dialog-title"
        data-testid="oauth-signout-dialog"
        className="w-full max-w-[420px] bg-surface-solid border border-border-subtle rounded-[24px] p-6 shadow-xl flex flex-col gap-[18px]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3">
          <div className="size-8 rounded-[10px] bg-danger-tint text-danger flex items-center justify-center shrink-0">
            <LogOut size={15} />
          </div>
          <h3 id="signout-dialog-title" className="text-[16px] font-semibold text-text-primary leading-snug">
            {t("settings.ai.signOutConfirmTitle")}
          </h3>
        </div>

        <p className="text-[13.5px] text-text-secondary leading-[1.5]">{body}</p>

        <div className="flex items-center justify-end gap-2.5 pt-1">
          <Button
            type="button"
            appearance="dawn"
            variant="secondary"
            size="sm"
            disabled={signingOut}
            onClick={onCancel}
          >
            {t("common.cancel")}
          </Button>
          <Button
            type="button"
            appearance="dawn"
            variant="primary"
            size="sm"
            disabled={signingOut}
            onClick={onConfirm}
            className="!bg-danger hover:!bg-danger-hover !text-text-on-accent"
          >
            <LogOut size={13.5} />
            <span>{t("settings.ai.signOut")}</span>
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

interface AiSettingsProps extends SettingsProps {
  refreshNonce?: number;
}

export default function AiSettings({
  settings,
  loading,
  save,
  saveBulk,
  showSavedToast,
  refreshNonce = 0,
}: AiSettingsProps) {
  const { t } = useTranslation();
  const isMac = isMacOS();

  const [provider, setProvider] = useState<AiProvider>(() => normalizeProvider(settings.ai_provider));
  const [authMode, setAuthMode] = useState<OpenAiAuthMode>(() => normalizeAuthMode(settings.ai_auth_mode));
  const [apiKey, setApiKey] = useState(() => settings.ai_api_key ?? "");
  const [persistedApiKey, setPersistedApiKey] = useState(() => settings.ai_api_key ?? "");
  const [showApiKey, setShowApiKey] = useState(false);
  const [model, setModel] = useState(
    () =>
      settings.ai_model ??
      defaultModelFor(normalizeProvider(settings.ai_provider), normalizeAuthMode(settings.ai_auth_mode)),
  );
  const [baseUrl, setBaseUrl] = useState(() => settings.ai_base_url ?? DEFAULT_OPENAI_URL);
  const [temperature, setTemperature] = useState(() => clampTemperature(settings.ai_temperature));
  const [keepAlive, setKeepAlive] = useState(() => settings.ai_keep_alive ?? "30m");

  const [oauthStatus, setOauthStatus] = useState<OAuthStatus>(DISCONNECTED_OAUTH);
  const [oauthLoading, setOauthLoading] = useState(false);
  const [oauthError, setOauthError] = useState<string | null>(null);
  const [signOutConfirmOpen, setSignOutConfirmOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);

  const [codexModels, setCodexModels] = useState<CodexModel[]>(CURATED_CODEX_MODELS);
  const [modelsFromFallback, setModelsFromFallback] = useState(false);
  const [customModel, setCustomModel] = useState(false);
  const [effortQuick, setEffortQuick] = useState(() => settings.ai_effort_quick ?? "default");
  const [effortDeep, setEffortDeep] = useState(() => settings.ai_effort_deep ?? "default");

  const [ollamaRunning, setOllamaRunning] = useState<boolean | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);

  const isCodexPath = provider === "openai" && authMode === "oauth";
  const isApiKeyPath = provider === "anthropic" || (provider === "openai" && authMode === "api_key");

  // Track uncommitted text drafts so unrelated settings updates don't stomp
  // active edits and unmounting flushes pending drafts.
  const dirtyTextRef = useRef<Record<TextFieldKey, boolean>>({
    ai_api_key: false,
    ai_base_url: false,
    ai_model: false,
  });
  const textTimersRef = useRef<Partial<Record<TextFieldKey, number>>>({});
  const pendingTextRef = useRef<Partial<Record<TextFieldKey, string>>>({});
  const saveFnRef = useRef(save);
  saveFnRef.current = save;
  const saveBulkRef = useRef(saveBulk);
  saveBulkRef.current = saveBulk;
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const providerRef = useRef(provider);
  providerRef.current = provider;
  const authModeRef = useRef(authMode);
  authModeRef.current = authMode;
  const modelRef = useRef(model);
  modelRef.current = model;
  const baseUrlRef = useRef(baseUrl);
  baseUrlRef.current = baseUrl;

  const loginAttemptRef = useRef(0);
  const ollamaProbeSeqRef = useRef(0);

  const persistSingleOrBaseline = useCallback(async (key: string, value: string) => {
    const s = settingsRef.current;
    const curProvider = providerRef.current;
    const curAuthMode = authModeRef.current;
    const curModel = key === "ai_model" ? value : modelRef.current;
    const curBaseUrl = key === "ai_base_url" ? value : baseUrlRef.current;
    const missingProvider = !s.ai_provider;
    const missingModel = !s.ai_model;
    const missingAuthMode = curProvider === "openai" && !s.ai_auth_mode;
    const missingOllamaUrl = curProvider === "ollama" && !s.ai_base_url;

    if (missingProvider || missingModel || missingAuthMode || missingOllamaUrl) {
      const payload: Record<string, string> = {
        ai_provider: curProvider,
        ai_model: curModel,
        ai_base_url: curBaseUrl,
      };
      if (curProvider === "openai") {
        payload.ai_auth_mode = curAuthMode;
      }
      payload[key] = value;
      await saveBulkRef.current(payload);
      return;
    }
    await saveFnRef.current(key, value);
  }, []);

  const clearPendingTextSaves = useCallback(() => {
    for (const key of Object.keys(textTimersRef.current) as TextFieldKey[]) {
      const timer = textTimersRef.current[key];
      if (timer !== undefined) {
        window.clearTimeout(timer);
        delete textTimersRef.current[key];
      }
      delete pendingTextRef.current[key];
      dirtyTextRef.current[key] = false;
    }
  }, []);

  const probeOllama = useCallback(async (rawUrl: string) => {
    const probeId = ++ollamaProbeSeqRef.current;
    const targetUrl = rawUrl.trim() || DEFAULT_OLLAMA_URL;
    try {
      const status = await invoke<OllamaStatus>("check_ollama_status", { baseUrl: targetUrl });
      if (ollamaProbeSeqRef.current !== probeId || providerRef.current !== "ollama") return;
      setOllamaRunning(Boolean(status?.running));
    } catch {
      if (ollamaProbeSeqRef.current !== probeId || providerRef.current !== "ollama") return;
      setOllamaRunning(false);
    }
  }, []);

  const commitTextField = useCallback(
    async (key: TextFieldKey, value: string) => {
      const timer = textTimersRef.current[key];
      if (timer !== undefined) {
        window.clearTimeout(timer);
        delete textTimersRef.current[key];
      }
      delete pendingTextRef.current[key];
      dirtyTextRef.current[key] = false;
      try {
        await persistSingleOrBaseline(key, value);
        if (key === "ai_api_key") {
          setPersistedApiKey(value);
        }
        if (key === "ai_base_url" && providerRef.current === "ollama") {
          void probeOllama(value);
        }
      } catch (err) {
        console.error(`Failed to save ${key}:`, err);
      }
    },
    [persistSingleOrBaseline, probeOllama],
  );

  const scheduleTextSave = useCallback(
    (key: TextFieldKey, value: string) => {
      dirtyTextRef.current[key] = true;
      pendingTextRef.current[key] = value;
      const existing = textTimersRef.current[key];
      if (existing !== undefined) {
        window.clearTimeout(existing);
      }
      textTimersRef.current[key] = window.setTimeout(() => {
        void commitTextField(key, value);
      }, TEXT_SAVE_DEBOUNCE_MS);
    },
    [commitTextField],
  );

  const textFieldHandlers = (
    key: TextFieldKey,
    value: string,
    setValue: (next: string) => void,
  ) => ({
    value,
    onChange: (e: ChangeEvent<HTMLInputElement>) => {
      const next = e.target.value;
      setValue(next);
      scheduleTextSave(key, next);
    },
    onBlur: () => {
      if (dirtyTextRef.current[key]) {
        void commitTextField(key, value);
      }
    },
    onKeyDown: (e: ReactKeyboardEvent<HTMLInputElement>) => {
      if (e.key !== "Enter") return;
      e.currentTarget.blur();
      if (dirtyTextRef.current[key]) {
        void commitTextField(key, value);
      }
    },
  });

  useEffect(() => {
    const timers = textTimersRef.current;
    const pending = pendingTextRef.current;
    return () => {
      const entries = Object.entries(pending) as [TextFieldKey, string][];
      for (const [key, value] of entries) {
        const timer = timers[key];
        if (timer !== undefined) {
          window.clearTimeout(timer);
          delete timers[key];
        }
        delete pending[key];
        void persistSingleOrBaseline(key, value).catch(() => {});
      }
    };
  }, [persistSingleOrBaseline]);

  useEffect(() => {
    if (loading) return;
    const nextProvider = normalizeProvider(settings.ai_provider);
    const nextAuthMode = normalizeAuthMode(settings.ai_auth_mode);
    setProvider(nextProvider);
    setAuthMode(nextAuthMode);
    if (!dirtyTextRef.current.ai_api_key) {
      const savedKey = settings.ai_api_key ?? "";
      setApiKey(savedKey);
      setPersistedApiKey(savedKey);
    }
    if (!dirtyTextRef.current.ai_model) {
      setModel(settings.ai_model ?? defaultModelFor(nextProvider, nextAuthMode));
    }
    if (!dirtyTextRef.current.ai_base_url) {
      setBaseUrl(
        settings.ai_base_url ??
          (nextProvider === "ollama"
            ? DEFAULT_OLLAMA_URL
            : nextProvider === "openai"
              ? DEFAULT_OPENAI_URL
              : ""),
      );
    }
    setTemperature(clampTemperature(settings.ai_temperature));
    if (settings.ai_keep_alive) setKeepAlive(settings.ai_keep_alive);
    if (settings.ai_effort_quick) setEffortQuick(settings.ai_effort_quick);
    if (settings.ai_effort_deep) setEffortDeep(settings.ai_effort_deep);
  }, [settings, loading]);

  const fetchOAuthStatus = useCallback(async (): Promise<OAuthStatus> => {
    try {
      const status = await invoke<OAuthStatus>("openai_oauth_status");
      return status ?? DISCONNECTED_OAUTH;
    } catch {
      return DISCONNECTED_OAUTH;
    }
  }, []);

  useEffect(() => {
    if (provider !== "openai") return;
    let disposed = false;
    let unlistenOAuth: (() => void) | null = null;
    const bump = () => {
      if (!disposed) setRefreshTick((tick) => tick + 1);
    };
    const onVisibilityChange = () => {
      if (!document.hidden) bump();
    };
    window.addEventListener("focus", bump);
    document.addEventListener("visibilitychange", onVisibilityChange);
    void listenCurrentWindow("openai-oauth-changed", bump)
      .then((fn) => {
        if (disposed) {
          fn();
        } else {
          unlistenOAuth = fn;
        }
      })
      .catch(() => {});
    return () => {
      disposed = true;
      window.removeEventListener("focus", bump);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      unlistenOAuth?.();
    };
  }, [provider]);

  useEffect(() => {
    if (provider !== "openai") return;
    let stale = false;
    void fetchOAuthStatus().then((status) => {
      if (stale) return;
      setOauthStatus(status);
      if (status.connected) {
        setOauthError(null);
      } else {
        setSignOutConfirmOpen(false);
      }
    });
    return () => {
      stale = true;
    };
  }, [provider, refreshNonce, refreshTick, fetchOAuthStatus]);

  useEffect(() => {
    if (!isCodexPath) return;
    let stale = false;
    invoke<CodexModelList>("list_codex_models")
      .then((list) => {
        if (stale) return;
        setModelsFromFallback(list.from_fallback);
        setCodexModels(list.models);
        // If tokens just expired during remote model fetch, sync UI to signed-out.
        if (list.from_fallback && oauthStatus.connected) {
          void fetchOAuthStatus().then((status) => {
            if (!stale) setOauthStatus(status);
          });
        }
      })
      .catch(() => {
        if (stale) return;
        setCodexModels(CURATED_CODEX_MODELS);
        setModelsFromFallback(true);
      });
    return () => {
      stale = true;
    };
  }, [isCodexPath, oauthStatus.connected, refreshNonce, fetchOAuthStatus]);

  useEffect(() => {
    if (loading || provider !== "ollama") {
      setOllamaRunning(null);
      return;
    }
    void probeOllama(baseUrlRef.current);
  }, [provider, loading, probeOllama]);

  const handleOAuthCancel = useCallback(() => {
    loginAttemptRef.current += 1;
    setOauthLoading(false);
    setOauthError(null);
    void invoke("openai_oauth_cancel").catch(() => {});
  }, []);

  const handleProviderChange = async (nextProvider: AiProvider) => {
    if (nextProvider === provider) return;
    if (oauthLoading) handleOAuthCancel();
    clearPendingTextSaves();

    const nextAuthMode: OpenAiAuthMode = nextProvider === "openai" ? "oauth" : authMode;
    const nextModel = defaultModelFor(nextProvider, nextAuthMode);
    const nextBaseUrl =
      nextProvider === "ollama"
        ? DEFAULT_OLLAMA_URL
        : nextProvider === "openai"
          ? DEFAULT_OPENAI_URL
          : "";

    providerRef.current = nextProvider;
    authModeRef.current = nextAuthMode;
    modelRef.current = nextModel;
    baseUrlRef.current = nextBaseUrl;
    setProvider(nextProvider);
    setApiKey("");
    setPersistedApiKey("");
    setShowApiKey(false);
    setCustomModel(false);
    setOauthError(null);
    setModel(nextModel);
    setBaseUrl(nextBaseUrl);
    if (nextProvider === "openai") setAuthMode("oauth");

    const updates: Record<string, string> = {
      ai_provider: nextProvider,
      ai_api_key: "",
      ai_model: nextModel,
      ai_base_url: nextBaseUrl,
    };
    if (nextProvider === "openai") updates.ai_auth_mode = "oauth";

    try {
      await saveBulk(updates);
    } catch (err) {
      console.error("Failed to save AI provider change:", err);
    }
  };

  const handleAuthModeChange = async (nextMode: OpenAiAuthMode) => {
    if (nextMode === authMode) return;
    if (oauthLoading && nextMode !== "oauth") handleOAuthCancel();
    clearPendingTextSaves();

    const nextModel = defaultModelFor("openai", nextMode);
    authModeRef.current = nextMode;
    modelRef.current = nextModel;
    setAuthMode(nextMode);
    setModel(nextModel);
    setCustomModel(false);
    setOauthError(null);

    try {
      await saveBulk({
        ai_provider: "openai",
        ai_auth_mode: nextMode,
        ai_model: nextModel,
        ...(settingsRef.current.ai_base_url === undefined
          ? { ai_base_url: baseUrlRef.current }
          : {}),
      });
    } catch (err) {
      console.error("Failed to save OpenAI auth mode:", err);
    }
  };

  const handleOAuthLogin = async () => {
    const attemptId = ++loginAttemptRef.current;
    setOauthLoading(true);
    setOauthError(null);
    try {
      const result = await invoke<OAuthStatus>("openai_oauth_login");
      if (loginAttemptRef.current !== attemptId) return;
      setOauthStatus(result ?? DISCONNECTED_OAUTH);
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
      setPersistedApiKey(apiKey);
      showSavedToast(t("settings.ai.oauthSuccess"));
    } catch (err) {
      if (loginAttemptRef.current !== attemptId) return;
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes("OAUTH_CANCELLED")) {
        setOauthError(msg);
      }
    } finally {
      if (loginAttemptRef.current === attemptId) {
        setOauthLoading(false);
      }
    }
  };

  const handleConfirmSignOut = async () => {
    setSigningOut(true);
    try {
      await invoke("openai_oauth_logout");
      setOauthStatus(DISCONNECTED_OAUTH);
      setSignOutConfirmOpen(false);
    } catch (err) {
      console.error("Failed to sign out:", err);
    } finally {
      setSigningOut(false);
    }
  };

  const handleClearApiKey = () => {
    setApiKey("");
    setShowApiKey(false);
    void commitTextField("ai_api_key", "");
  };

  const handleCodexModelSelect = (nextValue: string) => {
    if (nextValue === CUSTOM_MODEL) {
      setCustomModel(true);
      return;
    }
    setCustomModel(false);
    setModel(nextValue);
    void commitTextField("ai_model", nextValue);
  };

  const handleEffortChange = (which: "quick" | "deep", value: string) => {
    if (which === "quick") {
      setEffortQuick(value);
      void persistSingleOrBaseline("ai_effort_quick", value);
    } else {
      setEffortDeep(value);
      void persistSingleOrBaseline("ai_effort_deep", value);
    }
  };

  const handleTemperatureStep = (delta: number) => {
    const next = stepTemperatureValue(temperature, delta);
    if (next === temperature) return;
    setTemperature(next);
    void persistSingleOrBaseline("ai_temperature", String(next));
  };

  const handleKeepAliveChange = (next: string) => {
    setKeepAlive(next);
    void persistSingleOrBaseline("ai_keep_alive", next);
  };

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

  const keepAliveOptions = [
    ...KEEP_ALIVE_PRESETS.map((preset) => ({
      value: preset.value,
      label: t(preset.labelKey),
    })),
    ...(keepAlive && !KEEP_ALIVE_PRESETS.some((p) => p.value === keepAlive)
      ? [{ value: keepAlive, label: keepAlive }]
      : []),
  ];

  const email = oauthStatus.email?.trim() || null;
  const hasSavedApiKey = Boolean(persistedApiKey.trim());
  const textModelPlaceholder =
    provider === "ollama"
      ? "qwen3.5"
      : provider === "anthropic"
        ? "claude-sonnet-4-20250514"
        : "gpt-4o";

  return (
    <div className="flex flex-col gap-7 pb-6">
      {/* Section 1: Provider & Credentials / Auth */}
      <section className="flex flex-col gap-3">
        <SettingsOverline>
          {isApiKeyPath ? t("settings.ai.providerCredentialsOverline") : t("settings.ai.providerOverline")}
        </SettingsOverline>

        <SettingsGroup>
          <SettingsRow title={t("settings.ai.provider")}>
            <SegmentedControl
              surface="inset"
              variant="solid"
              value={provider}
              onChange={(next) => void handleProviderChange(next)}
              options={[
                { value: "openai", label: t("settings.ai.providers.openai") },
                { value: "anthropic", label: t("settings.ai.providers.anthropic") },
                { value: "ollama", label: t("settings.ai.providers.ollama") },
              ]}
            />
          </SettingsRow>

          {provider === "openai" && (
            <SettingsRow title={t("settings.ai.signInWith")}>
              <SegmentedControl
                surface="inset"
                variant="solid"
                value={authMode}
                onChange={(next) => void handleAuthModeChange(next)}
                options={[
                  { value: "oauth", label: t("settings.ai.chatgptAccount") },
                  { value: "api_key", label: t("settings.ai.apiKeyOption") },
                ]}
              />
            </SettingsRow>
          )}

          {isCodexPath && !oauthLoading && oauthStatus.connected && (
            <SettingsRow
              title={t("settings.ai.chatgptAccount")}
              hint={
                email
                  ? t("settings.ai.signedInViaBrowserWithEmail", { email })
                  : t("settings.ai.signedInViaBrowser")
              }
            >
              <StatusBadge tone="success" label={t("settings.ai.connectedBadge")} />
              <Button
                type="button"
                appearance="dawn"
                variant="secondary"
                size="sm"
                onClick={() => setSignOutConfirmOpen(true)}
              >
                <LogOut size={13.5} />
                <span>{t("settings.ai.signOut")}</span>
              </Button>
            </SettingsRow>
          )}

          {isCodexPath && !oauthLoading && !oauthStatus.connected && !oauthError && (
            <div
              data-testid="oauth-signed-out-row"
              className="px-5 py-[18px] flex items-center justify-between gap-5"
            >
              <div className="flex items-start gap-3.5 min-w-0">
                <div className="size-10 rounded-[12px] bg-accent-tint text-accent-on-tint flex items-center justify-center shrink-0">
                  <ShieldCheck size={18} />
                </div>
                <div className="min-w-0">
                  <p className="text-[14px] font-semibold text-text-primary leading-snug">
                    {t("settings.ai.notSignedIn")}
                  </p>
                  <p className="text-[12.5px] text-text-tertiary leading-[1.4] mt-0.5">
                    {t("settings.ai.notSignedInHint")}
                  </p>
                </div>
              </div>
              <Button
                type="button"
                appearance="dawn"
                variant="primary"
                size="sm"
                onClick={() => void handleOAuthLogin()}
              >
                <ExternalLink size={14} />
                <span>{t("settings.ai.signInWithChatGpt")}</span>
              </Button>
            </div>
          )}

          {isApiKeyPath && (
            <>
              <div className="px-5 py-4 flex flex-col gap-2.5">
                <div className="flex items-center justify-between gap-4">
                  <div className="min-w-0">
                    <p className="text-[14px] font-medium text-text-primary leading-snug">
                      {t("settings.ai.apiKey")}
                    </p>
                    <p className="text-[12.5px] text-text-tertiary mt-[3px] leading-snug">
                      {t("settings.ai.apiKeyHint")}
                    </p>
                  </div>
                  {hasSavedApiKey && (
                    <StatusBadge tone="success" label={t("settings.ai.savedBadge")} />
                  )}
                </div>

                <div className="flex items-center gap-2.5">
                  <div className="flex-1 h-[38px] px-3 rounded-[10px] bg-surface-solid border border-border-default focus-within:border-accent focus-within:ring-[3px] focus-within:ring-focus-ring flex items-center gap-2 transition-colors">
                    <KeyRound size={14} className="text-text-tertiary shrink-0" />
                    <input
                      type={showApiKey ? "text" : "password"}
                      {...textFieldHandlers("ai_api_key", apiKey, setApiKey)}
                      placeholder={provider === "anthropic" ? "sk-ant-..." : "sk-..."}
                      aria-label={t("settings.ai.apiKey")}
                      className="flex-1 min-w-0 bg-transparent border-0 outline-none font-mono text-[13px] text-text-primary placeholder:text-text-disabled"
                    />
                    <button
                      type="button"
                      onClick={() => setShowApiKey((v) => !v)}
                      aria-label={showApiKey ? t("settings.ai.hideApiKey") : t("settings.ai.showApiKey")}
                      className="p-1 rounded text-text-tertiary hover:text-text-primary cursor-pointer transition-colors"
                    >
                      {showApiKey ? <EyeOff size={15} /> : <Eye size={15} />}
                    </button>
                  </div>

                  <Button
                    type="button"
                    appearance="dawn"
                    variant="secondary"
                    size="sm"
                    disabled={!apiKey}
                    onClick={handleClearApiKey}
                  >
                    {t("settings.ai.clear")}
                  </Button>
                </div>
              </div>

              <SettingsRow title={t("settings.ai.baseUrl")} hint={t("settings.ai.baseUrlHint")}>
                <input
                  type="text"
                  {...textFieldHandlers("ai_base_url", baseUrl, setBaseUrl)}
                  placeholder={provider === "anthropic" ? DEFAULT_ANTHROPIC_URL : DEFAULT_OPENAI_URL}
                  aria-label={t("settings.ai.baseUrl")}
                  className={`w-[280px] ${monoInputClass}`}
                />
              </SettingsRow>
            </>
          )}

          {provider === "ollama" && (
            <>
              <SettingsRow
                title={t("settings.ai.ollamaServer")}
                hint={isMac ? t("settings.ai.ollamaServerHintMac") : t("settings.ai.ollamaServerHintOther")}
              >
                {ollamaRunning !== null && (
                  <StatusBadge
                    tone={ollamaRunning ? "success" : "neutral"}
                    label={ollamaRunning ? t("settings.ai.ollamaRunning") : t("settings.ai.ollamaNotRunning")}
                  />
                )}
                <input
                  type="text"
                  {...textFieldHandlers("ai_base_url", baseUrl, setBaseUrl)}
                  placeholder={DEFAULT_OLLAMA_URL}
                  aria-label={t("settings.ai.ollamaServer")}
                  className={`w-[190px] !h-[34px] ${monoInputClass}`}
                />
              </SettingsRow>

              <SettingsRow title={t("settings.ai.keepAlive")} hint={t("settings.ai.keepAliveHint")}>
                <Select
                  appearance="dawn"
                  className="w-[155px]"
                  icon={<Clock size={14} />}
                  value={keepAlive}
                  onChange={handleKeepAliveChange}
                  options={keepAliveOptions}
                />
              </SettingsRow>
            </>
          )}
        </SettingsGroup>

        {isCodexPath && oauthLoading && (
          <div
            data-testid="oauth-waiting-card"
            className="rounded-[14px] bg-surface-solid border border-accent/35 px-5 py-[18px] flex items-center justify-between gap-4"
          >
            <div className="flex items-start gap-3.5 min-w-0">
              <div className="size-10 rounded-[12px] bg-accent-tint text-accent-on-tint flex items-center justify-center shrink-0">
                <Loader2 size={18} className="animate-spin" />
              </div>
              <div className="min-w-0">
                <p className="text-[14px] font-semibold text-text-primary leading-snug">
                  {t("settings.ai.waitingAuth")}
                </p>
                <p className="text-[12.5px] text-text-secondary leading-[1.4] mt-0.5">
                  {t("settings.ai.waitingAuthHint")}
                </p>
              </div>
            </div>
            <Button
              type="button"
              appearance="dawn"
              variant="secondary"
              size="sm"
              onClick={handleOAuthCancel}
            >
              {t("common.cancel")}
            </Button>
          </div>
        )}

        {isCodexPath && !oauthLoading && !oauthStatus.connected && oauthError && (
          <div
            data-testid="oauth-error-card"
            className="rounded-[14px] bg-surface-solid border border-danger/25 px-5 py-[18px] flex items-center justify-between gap-4"
          >
            <div className="flex items-start gap-3.5 min-w-0">
              <div className="size-10 rounded-[12px] bg-danger-tint text-danger flex items-center justify-center shrink-0">
                <AlertCircle size={18} />
              </div>
              <div className="min-w-0">
                <p className="text-[14px] font-semibold text-text-primary leading-snug">
                  {t("settings.ai.authFailed")}
                </p>
                <p className="text-[12.5px] text-danger leading-[1.4] mt-0.5">
                  {t("settings.ai.authFailedHint")}
                </p>
              </div>
            </div>
            <Button
              type="button"
              appearance="dawn"
              variant="primary"
              size="sm"
              onClick={() => void handleOAuthLogin()}
            >
              <RefreshCw size={13.5} />
              <span>{t("settings.ai.tryAgain")}</span>
            </Button>
          </div>
        )}
      </section>

      {/* Section 2: Models & Generation */}
      <section className="flex flex-col gap-3">
        <SettingsOverline>
          {isCodexPath ? t("settings.ai.modelsOverline") : t("settings.ai.modelGenerationOverline")}
        </SettingsOverline>

        <SettingsGroup>
          {isCodexPath ? (
            <>
              <div className="flex flex-col">
                <SettingsRow
                  title={t("settings.ai.model")}
                  hint={
                    isCustomModel
                      ? t("settings.ai.modelHint")
                      : modelsFromFallback
                        ? t("settings.ai.modelListFallbackHint")
                        : !oauthStatus.connected
                          ? t("settings.ai.modelSignedOutHint")
                          : t("settings.ai.modelPickerHint")
                  }
                >
                  <Select
                    appearance="dawn"
                    className="w-[220px]"
                    icon={<Cpu size={14} />}
                    value={isCustomModel ? CUSTOM_MODEL : model}
                    onChange={handleCodexModelSelect}
                    options={modelOptions}
                  />
                </SettingsRow>
                {isCustomModel && (
                  <div className="px-5 pb-4 -mt-1">
                    <input
                      type="text"
                      {...textFieldHandlers("ai_model", model, setModel)}
                      placeholder="gpt-5.6-sol"
                      aria-label={t("settings.ai.model")}
                      className={`w-full text-[13px] ${monoInputClass}`}
                    />
                  </div>
                )}
              </div>

              <SettingsRow title={t("settings.ai.effortQuick")} hint={t("settings.ai.effortQuickHint")}>
                <Select
                  appearance="dawn"
                  className="w-[175px]"
                  value={effortQuick}
                  onChange={(value) => handleEffortChange("quick", value)}
                  options={effortOptions(effortQuick)}
                />
              </SettingsRow>

              <SettingsRow title={t("settings.ai.effortDeep")} hint={t("settings.ai.effortDeepHint")}>
                <Select
                  appearance="dawn"
                  className="w-[175px]"
                  value={effortDeep}
                  onChange={(value) => handleEffortChange("deep", value)}
                  options={effortOptions(effortDeep)}
                />
              </SettingsRow>
            </>
          ) : (
            <SettingsRow title={t("settings.ai.model")} hint={t("settings.ai.modelGenerationHint")}>
              <input
                type="text"
                {...textFieldHandlers("ai_model", model, setModel)}
                placeholder={textModelPlaceholder}
                aria-label={t("settings.ai.model")}
                className={`w-[240px] text-[13px] ${monoInputClass}`}
              />
            </SettingsRow>
          )}

          <SettingsRow title={t("settings.ai.temperature")} hint={t("settings.ai.temperatureHint")}>
            <Stepper
              valueLabel={temperature.toFixed(1)}
              onDecrement={() => handleTemperatureStep(-0.1)}
              onIncrement={() => handleTemperatureStep(0.1)}
              disableDecrement={temperature <= 0}
              disableIncrement={temperature >= 1}
              decrementLabel={t("settings.ai.temperatureDecrease")}
              incrementLabel={t("settings.ai.temperatureIncrease")}
            />
          </SettingsRow>
        </SettingsGroup>

        <p className="text-[12.5px] leading-[1.45] text-text-tertiary px-1 pt-0.5">
          {isMac ? t("settings.ai.footerNoteMac") : t("settings.ai.footerNoteOther")}
        </p>
      </section>

      <SignOutConfirmModal
        open={signOutConfirmOpen}
        email={email}
        isMac={isMac}
        signingOut={signingOut}
        onCancel={() => setSignOutConfirmOpen(false)}
        onConfirm={() => void handleConfirmSignOut()}
      />
    </div>
  );
}
