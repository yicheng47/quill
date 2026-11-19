import {
  useState,
  useEffect,
  useRef,
  useCallback,
  useMemo,
  type ChangeEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { useTranslation } from "react-i18next";
import {
  Check,
  Clock,
  Copy,
  Cpu,
  ExternalLink,
  Eye,
  EyeOff,
  FolderOpen,
  Loader2,
  LogIn,
  RefreshCw,
  Search,
  Terminal,
  X,
} from "lucide-react";
import { invoke, openFileDialog, openUrl } from "../../platform";
import {
  API_SERVICES,
  CODEX_INSTALL_COMMAND,
  CODEX_INSTALL_GUIDE_URL,
  formatCodexAccountLine,
  getApiServicePreset,
  normalizeApiProvider,
  resolveConnectionKind,
  type ApiModelList,
  type ApiProvider,
  type CodexStatus,
  type ConnectionKind,
  type LoginOutcome,
  type OllamaStatus,
} from "../../lib/aiConnections";
import {
  CODEX_FEATURES,
  applyCodexLegacyCarryOverLocal,
  buildCodexEffortSave,
  buildCodexModelSave,
  resolveCodexFeature,
  type CodexFeatureId,
} from "../../lib/codexFeatures";
import { invalidateCodexModelsCache, useCodexModels } from "../../hooks/useCodexModels";
import CodexFeaturePicker from "../CodexFeaturePicker";
import Button from "../ui/Button";
import Select from "../ui/Select";
import { StatusBadge } from "../ui/Badge";
import Stepper from "../ui/Stepper";
import { SettingsGroup, SettingsOverline, SettingsRow } from "../ui/SettingsRow";
import type { SettingsProps } from "./types";

type TextFieldKey = "ai_api_key" | "ai_base_url" | "ai_model";

function urlOrigin(raw: string): string | null {
  try {
    const parsed = new URL(raw.trim());
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed.origin && parsed.origin !== "null" ? parsed.origin : null;
  } catch {
    return null;
  }
}

function effectiveApiUrl(provider: ApiProvider, rawUrl: string): string {
  return rawUrl.trim() || getApiServicePreset(provider).defaultUrl;
}

function sameUrlOrigin(a: string, b: string): boolean {
  const oa = urlOrigin(a);
  const ob = urlOrigin(b);
  return oa !== null && oa === ob;
}

function didApiOriginChange(provider: ApiProvider, previousUrl: string, nextUrl: string): boolean {
  const previousEffective = effectiveApiUrl(provider, previousUrl);
  const nextEffective = effectiveApiUrl(provider, nextUrl);
  return Boolean(previousEffective) && (!nextEffective || !sameUrlOrigin(previousEffective, nextEffective));
}

const CUSTOM_MODEL = "__custom__";
const TEXT_SAVE_DEBOUNCE_MS = 450;

const KEEP_ALIVE_PRESETS = [
  { value: "5m", labelKey: "settings.ai.keepAlive5m" },
  { value: "15m", labelKey: "settings.ai.keepAlive15m" },
  { value: "30m", labelKey: "settings.ai.keepAlive30m" },
  { value: "1h", labelKey: "settings.ai.keepAlive1h" },
  { value: "-1", labelKey: "settings.ai.keepAliveForever" },
  { value: "0", labelKey: "settings.ai.keepAliveUnload" },
] as const;

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
  "h-9 px-3 rounded-[6px] bg-surface-solid border border-border-default font-mono text-[12.5px] text-text-primary placeholder:text-text-disabled focus:outline-none focus:border-accent focus:ring-[3px] focus:ring-focus-ring transition-colors";

interface AiSettingsProps extends SettingsProps {
  refreshNonce?: number;
  initialConnection?: ConnectionKind;
}

export default function AiSettings({
  settings,
  loading,
  save,
  saveBulk,
  showSavedToast,
  refreshNonce = 0,
  initialConnection,
}: AiSettingsProps) {
  const { t } = useTranslation();

  const [connectionKind, setConnectionKind] = useState<ConnectionKind>(() =>
    initialConnection ?? resolveConnectionKind(settings),
  );
  const [apiProvider, setApiProvider] = useState<ApiProvider>(() =>
    normalizeApiProvider(settings.ai_provider),
  );
  const [apiKey, setApiKey] = useState(() => settings.ai_api_key ?? "");
  const [committedApiKey, setCommittedApiKey] = useState(() => settings.ai_api_key ?? "");
  const [showApiKey, setShowApiKey] = useState(false);
  const [baseUrl, setBaseUrl] = useState(
    () => settings.ai_base_url ?? getApiServicePreset(normalizeApiProvider(settings.ai_provider)).defaultUrl,
  );
  const [committedBaseUrl, setCommittedBaseUrl] = useState(
    () => settings.ai_base_url ?? getApiServicePreset(normalizeApiProvider(settings.ai_provider)).defaultUrl,
  );
  const [model, setModel] = useState(() => settings.ai_model ?? "");
  const [temperature, setTemperature] = useState(() => clampTemperature(settings.ai_temperature));
  const [keepAlive, setKeepAlive] = useState(() => settings.ai_keep_alive ?? "30m");
  const [codexPath, setCodexPath] = useState(() => settings.ai_codex_path ?? "");
  const [codexSettings, setCodexSettings] = useState<Record<string, string>>(() => ({
    ...settings,
  }));
  const [customCodexFeatures, setCustomCodexFeatures] = useState<
    Partial<Record<CodexFeatureId, boolean>>
  >({});
  const [customFeatureDrafts, setCustomFeatureDrafts] = useState<
    Partial<Record<CodexFeatureId, string>>
  >({});

  const [codexStatus, setCodexStatus] = useState<CodexStatus | null>(null);
  const [codexChecking, setCodexChecking] = useState(true);
  const [signingIn, setSigningIn] = useState(false);
  const [loginError, setLoginError] = useState<string | null>(null);
  const [copiedCmd, setCopiedCmd] = useState(false);

  const [apiModels, setApiModels] = useState<string[]>([]);
  const [customApiModel, setCustomApiModel] = useState(false);
  const [apiModelFilter, setApiModelFilter] = useState("");
  const [ollamaStatus, setOllamaStatus] = useState<OllamaStatus | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);

  const codexAccountKey =
    codexStatus?.state === "ready"
      ? `${codexStatus.path ?? ""}|${codexStatus.email ?? ""}|${codexStatus.plan ?? ""}`
      : undefined;

  const { models: codexModels } = useCodexModels({
    enabled: !loading && connectionKind === "agent" && codexStatus?.state === "ready",
    codexPath,
    accountKey: codexAccountKey,
    refreshNonce,
  });
  const codexModelsRef = useRef(codexModels);
  codexModelsRef.current = codexModels;

  const codexSettingsRef = useRef(codexSettings);
  codexSettingsRef.current = codexSettings;
  const prevHydratedSettingsRef = useRef<Record<string, string> | null>(null);
  const customFeatureInputRefs = useRef<Partial<Record<CodexFeatureId, HTMLInputElement | null>>>(
    {},
  );
  const customFeatureDirtyRef = useRef<Partial<Record<CodexFeatureId, boolean>>>({});
  const customFeaturePendingRef = useRef<Partial<Record<CodexFeatureId, string>>>({});
  const customFeatureTimersRef = useRef<Partial<Record<CodexFeatureId, number>>>({});

  const dirtyTextRef = useRef<Record<TextFieldKey, boolean>>({
    ai_api_key: false,
    ai_base_url: false,
    ai_model: false,
  });
  const textTimersRef = useRef<Partial<Record<TextFieldKey, number>>>({});
  const pendingTextRef = useRef<Partial<Record<TextFieldKey, string>>>({});
  const pendingUnboundApiKeyRef = useRef<string | null>(null);
  const saveFnRef = useRef(save);
  saveFnRef.current = save;
  const saveBulkRef = useRef(saveBulk);
  saveBulkRef.current = saveBulk;
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const connectionKindRef = useRef(connectionKind);
  connectionKindRef.current = connectionKind;
  const apiProviderRef = useRef(apiProvider);
  apiProviderRef.current = apiProvider;
  const modelRef = useRef(model);
  modelRef.current = model;
  const baseUrlRef = useRef(baseUrl);
  baseUrlRef.current = baseUrl;
  const committedBaseUrlRef = useRef(committedBaseUrl);
  committedBaseUrlRef.current = committedBaseUrl;
  const signingInRef = useRef(signingIn);
  signingInRef.current = signingIn;

  const appliedInitialRef = useRef(false);
  const autoActivatedCodexRef = useRef(false);
  const codexProbeSeqRef = useRef(0);
  const loginAttemptRef = useRef(0);
  const ollamaProbeSeqRef = useRef(0);
  const apiModelsSeqRef = useRef(0);
  const copyTimerRef = useRef<number | null>(null);

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
    for (const id of Object.keys(customFeatureTimersRef.current) as CodexFeatureId[]) {
      const timer = customFeatureTimersRef.current[id];
      if (timer !== undefined) {
        window.clearTimeout(timer);
        delete customFeatureTimersRef.current[id];
      }
      delete customFeaturePendingRef.current[id];
      customFeatureDirtyRef.current[id] = false;
    }
    pendingUnboundApiKeyRef.current = null;
  }, []);

  const persistCodexUpdates = useCallback(async (updates: Record<string, string>) => {
    const s = settingsRef.current;
    const payload =
      s.ai_auth_mode !== "codex"
        ? { ai_auth_mode: "codex", ai_setup_seen: "true", ...updates }
        : updates;
    const entries = Object.entries(payload);
    if (entries.length === 1) {
      const [k, v] = entries[0];
      await saveFnRef.current(k, v);
    } else if (entries.length > 1) {
      await saveBulkRef.current(payload);
    }
  }, []);

  const persistSingleOrBaseline = useCallback(async (key: string, value: string) => {
    const s = settingsRef.current;
    const kind = connectionKindRef.current;
    if (kind === "agent") {
      if (s.ai_auth_mode !== "codex") {
        await saveBulkRef.current({
          ai_auth_mode: "codex",
          ai_setup_seen: "true",
          [key]: value,
        });
        return;
      }
      await saveFnRef.current(key, value);
      return;
    }

    const curProvider = apiProviderRef.current;
    const curModel = key === "ai_model" ? value : modelRef.current;
    const curBaseUrl = key === "ai_base_url" ? value : baseUrlRef.current;
    const needsBaseline =
      s.ai_auth_mode !== "api_key" ||
      !s.ai_provider ||
      (!s.ai_base_url && curBaseUrl.length > 0);

    if (needsBaseline) {
      await saveBulkRef.current({
        ai_auth_mode: "api_key",
        ai_provider: curProvider,
        ai_base_url: curBaseUrl,
        ai_model: curModel,
        ai_setup_seen: "true",
        [key]: value,
      });
      return;
    }
    await saveFnRef.current(key, value);
  }, []);

  const probeOllama = useCallback(async (rawUrl: string) => {
    const probeId = ++ollamaProbeSeqRef.current;
    const targetUrl = rawUrl.trim() || getApiServicePreset("ollama").defaultUrl;
    try {
      const status = await invoke<OllamaStatus>("check_ollama_status", { baseUrl: targetUrl });
      if (ollamaProbeSeqRef.current !== probeId) return;
      setOllamaStatus(
        status
          ? { running: Boolean(status.running), models: status.models ?? null }
          : { running: false, models: null },
      );
    } catch {
      if (ollamaProbeSeqRef.current !== probeId) return;
      setOllamaStatus({ running: false, models: null });
    }
  }, []);

  const probeCodex = useCallback(async () => {
    const seq = ++codexProbeSeqRef.current;
    setCodexChecking(true);
    try {
      const status = await invoke<CodexStatus>("codex_status");
      if (codexProbeSeqRef.current !== seq) return;
      if (status) {
        setCodexStatus(status);
        if (status.state === "ready") {
          setLoginError(null);
        }
      }
    } catch (err) {
      if (codexProbeSeqRef.current !== seq) return;
      setCodexStatus({
        state: "failed",
        version: null,
        min_version: "0.170.0",
        path: null,
        from_override: false,
        email: null,
        plan: null,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      if (codexProbeSeqRef.current === seq) {
        setCodexChecking(false);
      }
    }
  }, []);

  const commitTextField = useCallback(
    async (key: TextFieldKey, value: string, reason: "debounce" | "explicit" = "explicit") => {
      const timer = textTimersRef.current[key];
      if (timer !== undefined) {
        window.clearTimeout(timer);
        delete textTimersRef.current[key];
      }
      if (
        reason === "debounce" &&
        key === "ai_base_url" &&
        connectionKindRef.current === "api" &&
        pendingUnboundApiKeyRef.current?.trim()
      ) {
        // Keep the key-first draft unbound while the user is still typing the
        // Base URL so an intermediate valid host/port cannot capture the key.
        pendingTextRef.current[key] = value;
        dirtyTextRef.current[key] = true;
        return;
      }
      delete pendingTextRef.current[key];
      dirtyTextRef.current[key] = false;
      try {
        if (key === "ai_api_key" && connectionKindRef.current === "api") {
          if (!value.trim()) {
            pendingUnboundApiKeyRef.current = null;
          } else if (
            urlOrigin(effectiveApiUrl(apiProviderRef.current, committedBaseUrlRef.current)) === null
          ) {
            // Keep an API key entered before a valid HTTP(S) URL (e.g., Custom
            // setup) as a local draft so it commits atomically when the user
            // finishes entering a valid Base URL with blur or Enter.
            pendingUnboundApiKeyRef.current = value;
            dirtyTextRef.current.ai_api_key = true;
            return;
          }
          pendingUnboundApiKeyRef.current = null;
          await persistSingleOrBaseline(key, value);
          setCommittedApiKey(value);
          return;
        }
        if (key === "ai_base_url" && connectionKindRef.current === "api") {
          const prevValid =
            urlOrigin(effectiveApiUrl(apiProviderRef.current, committedBaseUrlRef.current)) !== null;
          const nextValid = urlOrigin(effectiveApiUrl(apiProviderRef.current, value)) !== null;
          const draftKey = pendingTextRef.current.ai_api_key ?? pendingUnboundApiKeyRef.current;
          if (reason === "explicit" && !prevValid && nextValid && draftKey && draftKey.trim()) {
            const keyTimer = textTimersRef.current.ai_api_key;
            if (keyTimer !== undefined) {
              window.clearTimeout(keyTimer);
              delete textTimersRef.current.ai_api_key;
            }
            delete pendingTextRef.current.ai_api_key;
            await saveBulkRef.current({
              ai_auth_mode: "api_key",
              ai_provider: apiProviderRef.current,
              ai_base_url: value,
              ai_api_key: draftKey,
              ai_model: modelRef.current,
              ai_setup_seen: "true",
            });
            dirtyTextRef.current.ai_api_key = false;
            pendingUnboundApiKeyRef.current = null;
            committedBaseUrlRef.current = value;
            setCommittedBaseUrl(value);
            setCommittedApiKey(draftKey);
            return;
          }
          const originChanged = didApiOriginChange(
            apiProviderRef.current,
            committedBaseUrlRef.current,
            value,
          );
          if (originChanged && !dirtyTextRef.current.ai_api_key) {
            const keyTimer = textTimersRef.current.ai_api_key;
            if (keyTimer !== undefined) {
              window.clearTimeout(keyTimer);
              delete textTimersRef.current.ai_api_key;
            }
            delete pendingTextRef.current.ai_api_key;
            dirtyTextRef.current.ai_api_key = false;
            pendingUnboundApiKeyRef.current = null;
            apiModelsSeqRef.current += 1;
            setApiKey("");
            setCommittedApiKey("");
            setShowApiKey(false);
            setApiModels([]);
            await saveBulkRef.current({
              ai_auth_mode: "api_key",
              ai_provider: apiProviderRef.current,
              ai_base_url: value,
              ai_api_key: "",
              ai_model: modelRef.current,
              ai_setup_seen: "true",
            });
          } else {
            await persistSingleOrBaseline(key, value);
          }
          committedBaseUrlRef.current = value;
          setCommittedBaseUrl(value);
          if (apiProviderRef.current === "ollama") {
            void probeOllama(value);
          }
          return;
        }
        await persistSingleOrBaseline(key, value);
        if (key === "ai_api_key") {
          setCommittedApiKey(value);
        }
        if (key === "ai_base_url") {
          committedBaseUrlRef.current = value;
          setCommittedBaseUrl(value);
          if (connectionKindRef.current === "api" && apiProviderRef.current === "ollama") {
            void probeOllama(value);
          }
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
        void commitTextField(key, value, "debounce");
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
      if (key === "ai_api_key" && !next.trim()) {
        pendingUnboundApiKeyRef.current = null;
      }
      setValue(next);
      scheduleTextSave(key, next);
    },
    onBlur: () => {
      if (dirtyTextRef.current[key]) {
        void commitTextField(key, value, "explicit");
      }
    },
    onKeyDown: (e: ReactKeyboardEvent<HTMLInputElement>) => {
      if (e.key !== "Enter") return;
      e.currentTarget.blur();
      if (dirtyTextRef.current[key]) {
        void commitTextField(key, value, "explicit");
      }
    },
  });

  // Flush pending debounced edits on unmount and clean timers.
  useEffect(() => {
    const timers = textTimersRef.current;
    const pending = pendingTextRef.current;
    const customTimers = customFeatureTimersRef.current;
    const customPending = customFeaturePendingRef.current;
    return () => {
      if (signingInRef.current) {
        void invoke("codex_login_cancel").catch(() => {});
      }
      if (copyTimerRef.current !== null) {
        window.clearTimeout(copyTimerRef.current);
      }
      const customEntries = Object.entries(customPending) as [CodexFeatureId, string][];
      for (const [id] of customEntries) {
        const timer = customTimers[id];
        if (timer !== undefined) {
          window.clearTimeout(timer);
          delete customTimers[id];
        }
        delete customPending[id];
      }
      if (customEntries.length > 0 && connectionKindRef.current === "agent") {
        const mergedUpdates: Record<string, string> = {};
        for (const [id, rawValue] of customEntries) {
          Object.assign(mergedUpdates, buildCodexModelSave(id, rawValue));
        }
        void persistCodexUpdates(mergedUpdates).catch(() => {});
      }
      const entries = Object.entries(pending) as [TextFieldKey, string][];
      for (const [key] of entries) {
        const timer = timers[key];
        if (timer !== undefined) {
          window.clearTimeout(timer);
          delete timers[key];
        }
        delete pending[key];
      }
      if (entries.length > 0) {
        const pendingMap = Object.fromEntries(entries) as Partial<Record<TextFieldKey, string>>;
        const hadUnboundKey = Boolean(pendingUnboundApiKeyRef.current?.trim());
        pendingUnboundApiKeyRef.current = null;

        if (connectionKindRef.current === "api") {
          const prevValid =
            urlOrigin(effectiveApiUrl(apiProviderRef.current, committedBaseUrlRef.current)) !== null;

          // Passive unmount must never bind a fresh key to an unfinished/uncommitted URL.
          if (pendingMap.ai_api_key?.trim() && (!prevValid || pendingMap.ai_base_url !== undefined)) {
            delete pendingMap.ai_api_key;
          }
          if (hadUnboundKey && pendingMap.ai_base_url !== undefined && !prevValid) {
            delete pendingMap.ai_base_url;
          }

          const baseUrlChangedOrigin =
            pendingMap.ai_base_url !== undefined &&
            pendingMap.ai_api_key === undefined &&
            didApiOriginChange(
              apiProviderRef.current,
              committedBaseUrlRef.current,
              pendingMap.ai_base_url,
            );
          if (baseUrlChangedOrigin) {
            void saveBulkRef
              .current({
                ai_auth_mode: "api_key",
                ai_provider: apiProviderRef.current,
                ai_base_url: pendingMap.ai_base_url!,
                ai_api_key: "",
                ai_model: pendingMap.ai_model ?? modelRef.current,
                ai_setup_seen: "true",
              })
              .catch(() => {});
            return;
          }
        }

        const remaining = Object.entries(pendingMap) as [TextFieldKey, string][];
        if (remaining.length === 1) {
          const [key, value] = remaining[0];
          void persistSingleOrBaseline(key, value).catch(() => {});
        } else if (remaining.length > 1) {
          const bulk: Record<string, string> = {};
          for (const [key, value] of remaining) {
            bulk[key] = value;
          }
          void saveBulkRef.current(bulk).catch(() => {});
        }
      }
    };
  }, [persistSingleOrBaseline, persistCodexUpdates]);

  // Hydrate local form state when saved settings load or update.
  useEffect(() => {
    if (loading) return;
    const resolvedKind =
      initialConnection && !appliedInitialRef.current
        ? initialConnection
        : resolveConnectionKind(settings);
    appliedInitialRef.current = true;
    const nextProvider = normalizeApiProvider(settings.ai_provider);
    const preset = getApiServicePreset(nextProvider);

    setConnectionKind(resolvedKind);
    setApiProvider(nextProvider);
    if (!dirtyTextRef.current.ai_api_key) {
      const savedKey = settings.ai_api_key ?? "";
      setApiKey(savedKey);
      setCommittedApiKey(savedKey);
    }
    if (!dirtyTextRef.current.ai_base_url) {
      const savedUrl =
        settings.ai_base_url !== undefined ? settings.ai_base_url : preset.defaultUrl;
      baseUrlRef.current = savedUrl;
      committedBaseUrlRef.current = savedUrl;
      setBaseUrl(savedUrl);
      setCommittedBaseUrl(savedUrl);
    }
    if (!dirtyTextRef.current.ai_model) {
      setModel(settings.ai_model ?? (resolvedKind === "api" ? preset.defaultModel : ""));
    }
    setTemperature(clampTemperature(settings.ai_temperature));
    if (settings.ai_keep_alive) setKeepAlive(settings.ai_keep_alive);
    setCodexPath(settings.ai_codex_path ?? "");
    const prevCodex = codexSettingsRef.current;
    const prevHydrated = prevHydratedSettingsRef.current;
    const changedModelFeatures: CodexFeatureId[] = [];
    const nextCodex: Record<string, string> = { ...settings };
    for (const feature of CODEX_FEATURES) {
      if (customFeatureDirtyRef.current[feature.id] && prevCodex[feature.modelKey] !== undefined) {
        nextCodex[feature.modelKey] = prevCodex[feature.modelKey];
      } else if (
        prevHydrated !== null &&
        ((settings[feature.modelKey] !== prevHydrated[feature.modelKey] &&
          settings[feature.modelKey] !== prevCodex[feature.modelKey]) ||
          (settings.ai_model !== prevHydrated.ai_model &&
            settings.ai_model !== prevCodex.ai_model))
      ) {
        changedModelFeatures.push(feature.id);
      }
    }
    prevHydratedSettingsRef.current = settings;
    codexSettingsRef.current = nextCodex;
    setCodexSettings(nextCodex);
    if (changedModelFeatures.length > 0) {
      setCustomCodexFeatures((prev) => {
        let mutated = false;
        const next = { ...prev };
        for (const id of changedModelFeatures) {
          if (next[id]) {
            next[id] = false;
            mutated = true;
          }
        }
        return mutated ? next : prev;
      });
      setCustomFeatureDrafts((prev) => {
        let mutated = false;
        const next = { ...prev };
        for (const id of changedModelFeatures) {
          if (id in next) {
            delete next[id];
            mutated = true;
          }
        }
        return mutated ? next : prev;
      });
    }
  }, [settings, loading, initialConnection]);

  // Re-check Codex when the window regains focus (e.g., user installed or signed in via CLI).
  useEffect(() => {
    let disposed = false;
    const bump = () => {
      if (!disposed && !signingInRef.current) {
        setRefreshTick((tick) => tick + 1);
      }
    };
    const onVisibilityChange = () => {
      if (!document.hidden) bump();
    };
    window.addEventListener("focus", bump);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      disposed = true;
      window.removeEventListener("focus", bump);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, []);

  // Probe Codex status (also shown as a badge on the collapsed Agent row when API is selected).
  useEffect(() => {
    if (loading) return;
    void probeCodex();
  }, [loading, codexPath, refreshNonce, refreshTick, probeCodex]);

  // If a fresh/skipped profile opens Settings -> AI (not specifically on API)
  // and Codex is already ready, commit ai_auth_mode = codex so the checked
  // Agent radio and Ready badge match active runtime behavior.
  useEffect(() => {
    if (
      loading ||
      initialConnection === "api" ||
      autoActivatedCodexRef.current ||
      connectionKind !== "agent" ||
      settings.ai_auth_mode ||
      settings.ai_provider ||
      codexStatus?.state !== "ready"
    ) {
      return;
    }
    autoActivatedCodexRef.current = true;
    void saveBulkRef.current({ ai_auth_mode: "codex", ai_setup_seen: "true" }).catch(() => {});
  }, [loading, initialConnection, connectionKind, settings.ai_auth_mode, settings.ai_provider, codexStatus]);

  // Probe Ollama server when API + Ollama is selected.
  useEffect(() => {
    if (loading || connectionKind !== "api" || apiProvider !== "ollama") {
      setOllamaStatus(null);
      return;
    }
    void probeOllama(committedBaseUrl);
  }, [loading, connectionKind, apiProvider, committedBaseUrl, refreshNonce, probeOllama]);

  // Fetch API service's /models list when API is selected and endpoint/credentials are present.
  useEffect(() => {
    const seq = ++apiModelsSeqRef.current;
    if (loading || connectionKind !== "api") {
      setApiModels([]);
      return () => {
        apiModelsSeqRef.current += 1;
      };
    }
    const preset = getApiServicePreset(apiProvider);
    const effectiveUrl = committedBaseUrl.trim() || preset.defaultUrl;
    if (!effectiveUrl || (preset.requiresKey && !committedApiKey.trim())) {
      setApiModels([]);
      return () => {
        apiModelsSeqRef.current += 1;
      };
    }
    // Automatic listing omits `apiKey` so the backend resolves only the committed,
    // origin-bound credential from secrets.db and a cached UI value cannot authorize
    // a cross-origin request.
    invoke<ApiModelList>("list_api_models", {
      provider: apiProvider,
      baseUrl: effectiveUrl,
    })
      .then((res) => {
        if (apiModelsSeqRef.current !== seq) return;
        setApiModels(Array.isArray(res?.models) ? res.models : []);
      })
      .catch(() => {
        if (apiModelsSeqRef.current !== seq) return;
        setApiModels([]);
      });
    return () => {
      apiModelsSeqRef.current += 1;
    };
  }, [loading, connectionKind, apiProvider, committedBaseUrl, committedApiKey, refreshNonce]);

  const handleCancelLogin = useCallback(() => {
    loginAttemptRef.current += 1;
    setSigningIn(false);
    setLoginError(null);
    void invoke("codex_login_cancel").catch(() => {});
  }, []);

  const handleCodexLogin = async () => {
    const attemptId = ++loginAttemptRef.current;
    setSigningIn(true);
    setLoginError(null);
    try {
      const outcome = await invoke<LoginOutcome>("codex_login");
      if (loginAttemptRef.current !== attemptId) return;
      if (outcome?.success) {
        await saveBulk({
          ai_auth_mode: "codex",
          ai_setup_seen: "true",
          ai_codex_migration_pending: "false",
        });
        showSavedToast(t("settings.ai.codex.signedInToast"));
        invalidateCodexModelsCache();
        await probeCodex();
      } else if (outcome?.error) {
        setLoginError(outcome.error);
      }
    } catch (err) {
      if (loginAttemptRef.current !== attemptId) return;
      setLoginError(err instanceof Error ? err.message : String(err));
    } finally {
      if (loginAttemptRef.current === attemptId) {
        setSigningIn(false);
      }
    }
  };

  const handleSelectConnection = async (next: ConnectionKind) => {
    if (next === connectionKind) {
      if (next === "agent" && settingsRef.current.ai_auth_mode !== "codex") {
        await saveBulk({ ai_auth_mode: "codex", ai_setup_seen: "true" });
      }
      return;
    }
    if (signingIn && next !== "agent") {
      handleCancelLogin();
    }
    clearPendingTextSaves();

    connectionKindRef.current = next;
    setConnectionKind(next);
    setCustomCodexFeatures({});
    setCustomFeatureDrafts({});
    setCustomApiModel(false);
    setApiModelFilter("");

    if (next === "agent") {
      modelRef.current = "";
      setModel("");
      const updates = {
        ai_auth_mode: "codex",
        ai_model: "",
        ai_setup_seen: "true",
      };
      const nextCodex = applyCodexLegacyCarryOverLocal(codexSettingsRef.current, updates);
      codexSettingsRef.current = nextCodex;
      setCodexSettings(nextCodex);
      try {
        await saveBulk(updates);
      } catch (err) {
        console.error("Failed to switch to Agent connection:", err);
      }
    } else {
      const preset = getApiServicePreset(apiProviderRef.current);
      const nextBaseUrl = baseUrlRef.current || preset.defaultUrl;
      const isCodexSlug = codexModels.some((m) => m.slug === modelRef.current);
      const nextModel =
        !modelRef.current || isCodexSlug ? preset.defaultModel : modelRef.current;
      baseUrlRef.current = nextBaseUrl;
      committedBaseUrlRef.current = nextBaseUrl;
      modelRef.current = nextModel;
      setBaseUrl(nextBaseUrl);
      setCommittedBaseUrl(nextBaseUrl);
      setModel(nextModel);
      const updates = {
        ai_auth_mode: "api_key",
        ai_provider: apiProviderRef.current,
        ai_base_url: nextBaseUrl,
        ai_model: nextModel,
        ai_setup_seen: "true",
      };
      const nextCodex = applyCodexLegacyCarryOverLocal(codexSettingsRef.current, updates);
      codexSettingsRef.current = nextCodex;
      setCodexSettings(nextCodex);
      try {
        await saveBulk(updates);
      } catch (err) {
        console.error("Failed to switch to API connection:", err);
      }
    }
  };

  const handleApiServiceChange = async (nextRaw: string) => {
    const nextProvider = normalizeApiProvider(nextRaw);
    if (nextProvider === apiProvider) return;
    clearPendingTextSaves();

    const preset = getApiServicePreset(nextProvider);
    apiProviderRef.current = nextProvider;
    baseUrlRef.current = preset.defaultUrl;
    committedBaseUrlRef.current = preset.defaultUrl;
    modelRef.current = preset.defaultModel;

    setApiProvider(nextProvider);
    setBaseUrl(preset.defaultUrl);
    setCommittedBaseUrl(preset.defaultUrl);
    setApiKey("");
    setCommittedApiKey("");
    setShowApiKey(false);
    setModel(preset.defaultModel);
    setApiModels([]);
    setCustomApiModel(false);
    setApiModelFilter("");

    try {
      await saveBulk({
        ai_auth_mode: "api_key",
        ai_provider: nextProvider,
        ai_base_url: preset.defaultUrl,
        ai_api_key: "",
        ai_model: preset.defaultModel,
        ai_setup_seen: "true",
      });
    } catch (err) {
      console.error("Failed to save API service:", err);
    }
  };

  const handleClearApiKey = () => {
    pendingUnboundApiKeyRef.current = null;
    setApiKey("");
    setShowApiKey(false);
    void commitTextField("ai_api_key", "");
  };

  const handleChooseCodexPath = async () => {
    try {
      const selected = await openFileDialog({ multiple: false });
      if (!selected) return;
      await persistSingleOrBaseline("ai_codex_path", selected);
      setCodexPath(selected);
    } catch (err) {
      console.error("Failed to pick Codex location:", err);
    }
  };

  const handleResetCodexPath = async () => {
    try {
      await persistSingleOrBaseline("ai_codex_path", "");
      setCodexPath("");
    } catch (err) {
      console.error("Failed to reset Codex location:", err);
    }
  };

  const handleCopyInstallCommand = () => {
    void navigator.clipboard?.writeText(CODEX_INSTALL_COMMAND);
    setCopiedCmd(true);
    if (copyTimerRef.current !== null) {
      window.clearTimeout(copyTimerRef.current);
    }
    copyTimerRef.current = window.setTimeout(() => {
      setCopiedCmd(false);
      copyTimerRef.current = null;
    }, 2000);
  };

  const applyCodexFeatureUpdates = useCallback(
    (updates: Record<string, string>) => {
      const nextCodex = applyCodexLegacyCarryOverLocal(codexSettingsRef.current, updates);
      codexSettingsRef.current = nextCodex;
      setCodexSettings(nextCodex);
      void persistCodexUpdates(updates).catch((err) => {
        console.error("Failed to save Codex feature setting:", err);
      });
    },
    [persistCodexUpdates],
  );

  const clearCustomFeatureTimer = useCallback((featureId: CodexFeatureId) => {
    const timer = customFeatureTimersRef.current[featureId];
    if (timer !== undefined) {
      window.clearTimeout(timer);
      delete customFeatureTimersRef.current[featureId];
    }
    delete customFeaturePendingRef.current[featureId];
    customFeatureDirtyRef.current[featureId] = false;
  }, []);

  const settleCustomFeatureEditor = useCallback((featureId: CodexFeatureId) => {
    setCustomCodexFeatures((prev) => (prev[featureId] ? { ...prev, [featureId]: false } : prev));
    setCustomFeatureDrafts((prev) => {
      if (!(featureId in prev)) return prev;
      const next = { ...prev };
      delete next[featureId];
      return next;
    });
  }, []);

  const commitCustomFeatureModel = useCallback(
    (
      featureId: CodexFeatureId,
      rawValue: string,
      trigger: "debounce" | "explicit" = "explicit",
    ) => {
      clearCustomFeatureTimer(featureId);
      const trimmed = rawValue.trim();
      const updates = buildCodexModelSave(featureId, trimmed);
      // Keep the focused editor and draft open across debounced autosaves (even
      // while the catalog is empty), and settle transient editing state on blur/Enter
      // so settled UI derives directly from current settings.
      if (trigger === "explicit") {
        settleCustomFeatureEditor(featureId);
      }
      applyCodexFeatureUpdates(updates);
    },
    [applyCodexFeatureUpdates, clearCustomFeatureTimer, settleCustomFeatureEditor],
  );

  const handleCodexFeatureModelSelect = useCallback(
    (featureId: CodexFeatureId, nextSlug: string) => {
      clearCustomFeatureTimer(featureId);
      settleCustomFeatureEditor(featureId);
      const updates = buildCodexModelSave(featureId, nextSlug);
      applyCodexFeatureUpdates(updates);
    },
    [applyCodexFeatureUpdates, clearCustomFeatureTimer, settleCustomFeatureEditor],
  );

  const handleCodexFeatureEffortSelect = useCallback(
    (featureId: CodexFeatureId, nextEffort: string) => {
      const updates = buildCodexEffortSave(featureId, nextEffort);
      applyCodexFeatureUpdates(updates);
    },
    [applyCodexFeatureUpdates],
  );

  const handleRequestCustomCodexModel = useCallback((featureId: CodexFeatureId) => {
    const resolved = resolveCodexFeature(
      featureId,
      codexSettingsRef.current,
      codexModelsRef.current,
    );
    const seedDraft =
      resolved.isCustomModel || (codexModelsRef.current.length === 0 && resolved.explicitModel)
        ? resolved.effectiveModel
        : "";
    setCustomCodexFeatures((prev) => ({ ...prev, [featureId]: true }));
    setCustomFeatureDrafts((prev) => ({
      ...prev,
      [featureId]: prev[featureId] ?? seedDraft,
    }));
    requestAnimationFrame(() => {
      customFeatureInputRefs.current[featureId]?.focus();
    });
  }, []);

  const handleCustomFeatureChange = useCallback(
    (featureId: CodexFeatureId, nextValue: string) => {
      setCustomFeatureDrafts((prev) => ({ ...prev, [featureId]: nextValue }));
      customFeatureDirtyRef.current[featureId] = true;
      customFeaturePendingRef.current[featureId] = nextValue;
      const existing = customFeatureTimersRef.current[featureId];
      if (existing !== undefined) {
        window.clearTimeout(existing);
      }
      customFeatureTimersRef.current[featureId] = window.setTimeout(() => {
        commitCustomFeatureModel(featureId, nextValue, "debounce");
      }, TEXT_SAVE_DEBOUNCE_MS);
    },
    [commitCustomFeatureModel],
  );

  const handleCustomFeatureBlur = useCallback(
    (featureId: CodexFeatureId) => {
      if (customFeatureDirtyRef.current[featureId]) {
        const val = customFeaturePendingRef.current[featureId] ?? customFeatureDrafts[featureId] ?? "";
        commitCustomFeatureModel(featureId, val, "explicit");
      } else {
        settleCustomFeatureEditor(featureId);
      }
    },
    [commitCustomFeatureModel, customFeatureDrafts, settleCustomFeatureEditor],
  );

  const handleCustomFeatureKeyDown = useCallback(
    (featureId: CodexFeatureId, e: ReactKeyboardEvent<HTMLInputElement>) => {
      if (e.key !== "Enter") return;
      if (customFeatureDirtyRef.current[featureId]) {
        commitCustomFeatureModel(featureId, e.currentTarget.value, "explicit");
      } else {
        settleCustomFeatureEditor(featureId);
      }
      e.currentTarget.blur();
    },
    [commitCustomFeatureModel, settleCustomFeatureEditor],
  );

  const handleApiModelSelect = (nextValue: string) => {
    if (nextValue === CUSTOM_MODEL) {
      setCustomApiModel(true);
      setApiModelFilter("");
      return;
    }
    setCustomApiModel(false);
    setApiModelFilter("");
    setModel(nextValue);
    modelRef.current = nextValue;
    void commitTextField("ai_model", nextValue);
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

  // API service & model options
  const activePreset = getApiServicePreset(apiProvider);
  const serviceOptions = API_SERVICES.map((svc) => ({
    value: svc.id,
    label: t(svc.labelKey),
    description: svc.menuDescriptionKey ? t(svc.menuDescriptionKey) : svc.menuUrl,
  }));

  const filteredApiModels = useMemo(() => {
    const q = apiModelFilter.trim().toLowerCase();
    if (!q) return apiModels;
    return apiModels.filter((id) => id.toLowerCase().includes(q));
  }, [apiModels, apiModelFilter]);

  const apiModelInList = model.trim() !== "" && apiModels.includes(model.trim());
  const showApiModelPicker = apiModels.length > 0 && !customApiModel;
  const apiModelOptions = [
    ...(model.trim() && !apiModelInList ? [{ value: model.trim(), label: model.trim() }] : []),
    ...filteredApiModels.map((id) => ({ value: id, label: id })),
    { value: CUSTOM_MODEL, label: t("settings.ai.modelCustom") },
  ];

  const keepAliveOptions = [
    ...KEEP_ALIVE_PRESETS.map((preset) => ({
      value: preset.value,
      label: t(preset.labelKey),
    })),
    ...(keepAlive && !KEEP_ALIVE_PRESETS.some((p) => p.value === keepAlive)
      ? [{ value: keepAlive, label: keepAlive }]
      : []),
  ];

  // Collapsed Agent badge when API is selected
  const renderCollapsedAgentBadge = () => {
    if (codexChecking && !codexStatus) return null;
    if (!codexStatus) return null;
    switch (codexStatus.state) {
      case "ready":
        return <StatusBadge tone="success" label={t("settings.ai.codex.ready")} />;
      case "not_signed_in":
        return <StatusBadge tone="warning" label={t("settings.ai.codex.signInNeeded")} />;
      case "too_old":
        return <StatusBadge tone="warning" label={t("settings.ai.codex.updateNeeded")} />;
      case "failed":
        return <StatusBadge tone="danger" label={t("settings.ai.codex.errorBadge")} />;
      default:
        return null;
    }
  };

  // Expanded Codex status row (matches Pencil frame xUV03)
  const renderCodexStatusRow = () => {
    if (signingIn) {
      return (
        <SettingsRow
          className="pl-[46px]"
          title={t("settings.ai.codex.title")}
          hint={t("settings.ai.codex.signingInHint")}
        >
          <span className="inline-flex items-center gap-1.5 text-[12.5px] text-text-secondary">
            <Loader2 size={14} className="animate-spin text-accent-fg" />
            <span>{t("settings.ai.codex.waitingForBrowser")}</span>
          </span>
          <Button
            type="button"
            appearance="dawn"
            variant="ghost"
            size="sm"
            onClick={handleCancelLogin}
          >
            <X size={13.5} />
            <span>{t("common.cancel")}</span>
          </Button>
        </SettingsRow>
      );
    }

    if (codexChecking || !codexStatus) {
      return (
        <SettingsRow
          className="pl-[46px]"
          title={t("settings.ai.codex.title")}
          hint={t("settings.ai.codex.checkingHint")}
        >
          <span className="inline-flex items-center gap-1.5 text-[12.5px] text-text-tertiary">
            <Loader2 size={14} className="animate-spin" />
            <span>{t("settings.ai.codex.checking")}</span>
          </span>
        </SettingsRow>
      );
    }

    switch (codexStatus.state) {
      case "ready": {
        const accountLine = formatCodexAccountLine(codexStatus, true);
        return (
          <SettingsRow
            className="pl-[46px]"
            title={t("settings.ai.codex.title")}
            hint={
              accountLine ||
              t("settings.ai.codex.readyFallback", { version: codexStatus.version ?? "" })
            }
          >
            <StatusBadge tone="success" label={t("settings.ai.codex.ready")} />
          </SettingsRow>
        );
      }

      case "not_signed_in":
        return (
          <SettingsRow
            className="pl-[46px]"
            title={t("settings.ai.codex.title")}
            hint={
              loginError ? (
                <span className="text-danger">{loginError}</span>
              ) : (
                t("settings.ai.codex.notSignedInHint", {
                  version: codexStatus.version ?? "",
                })
              )
            }
          >
            <Button
              type="button"
              appearance="dawn"
              variant="primary"
              size="sm"
              onClick={() => void handleCodexLogin()}
            >
              <LogIn size={13.5} />
              <span>{t("settings.ai.signInWithChatGpt")}</span>
            </Button>
          </SettingsRow>
        );

      case "not_installed":
        return (
          <SettingsRow
            className="pl-[46px]"
            title={t("settings.ai.codex.title")}
            hint={t("settings.ai.codex.notInstalledHint")}
          >
            <Button
              type="button"
              appearance="dawn"
              variant="secondary"
              size="sm"
              onClick={handleCopyInstallCommand}
            >
              {copiedCmd ? <Check size={13.5} /> : <Copy size={13.5} />}
              <span>
                {copiedCmd ? t("common.copied") : t("settings.ai.codex.copyCommand")}
              </span>
            </Button>
            <Button
              type="button"
              appearance="dawn"
              variant="secondary"
              size="sm"
              onClick={() => void openUrl(CODEX_INSTALL_GUIDE_URL)}
            >
              <ExternalLink size={13.5} />
              <span>{t("settings.ai.codex.installGuide")}</span>
            </Button>
            <Button
              type="button"
              appearance="dawn"
              variant="ghost"
              size="sm"
              onClick={() => void probeCodex()}
            >
              <RefreshCw size={13.5} />
              <span>{t("settings.ai.codex.checkAgain")}</span>
            </Button>
          </SettingsRow>
        );

      case "too_old":
        return (
          <SettingsRow
            className="pl-[46px]"
            title={t("settings.ai.codex.title")}
            hint={t("settings.ai.codex.tooOldHint", {
              version: codexStatus.version ?? "",
              minVersion: codexStatus.min_version,
            })}
          >
            <StatusBadge tone="warning" label={t("settings.ai.codex.updateNeeded")} />
            <Button
              type="button"
              appearance="dawn"
              variant="secondary"
              size="sm"
              onClick={() => void probeCodex()}
            >
              <RefreshCw size={13.5} />
              <span>{t("settings.ai.codex.checkAgain")}</span>
            </Button>
          </SettingsRow>
        );

      case "failed":
        return (
          <SettingsRow
            className="pl-[46px]"
            title={t("settings.ai.codex.title")}
            hint={codexStatus.error || t("settings.ai.codex.failedFallback")}
          >
            <StatusBadge tone="danger" label={t("settings.ai.codex.errorBadge")} />
            <Button
              type="button"
              appearance="dawn"
              variant="secondary"
              size="sm"
              onClick={() => void probeCodex()}
            >
              <RefreshCw size={13.5} />
              <span>{t("settings.ai.retry")}</span>
            </Button>
          </SettingsRow>
        );
    }
  };

  const renderCodexLocationHint = () => {
    if (codexPath.trim()) {
      return (
        <>
          <span className="font-mono">{codexPath.trim()}</span>
          {" · "}
          {t("settings.ai.codex.customPath")}
        </>
      );
    }
    if (codexStatus?.path) {
      return (
        <>
          <span className="font-mono">{codexStatus.path}</span>
          {" · "}
          {t("settings.ai.codex.foundAutomatically")}
        </>
      );
    }
    return t("settings.ai.codex.locationAutoHint");
  };

  const renderOllamaHint = () => {
    if (ollamaStatus === null) return t("settings.ai.codex.checking");
    if (!ollamaStatus.running) return t("settings.ai.ollamaNotReachable");
    if (ollamaStatus.models != null) {
      return t("settings.ai.ollamaReachableWithCount", { count: ollamaStatus.models });
    }
    return t("settings.ai.ollamaReachable");
  };

  return (
    <div className="flex flex-col gap-7 pb-6">
      {/* Section 1: Connection */}
      <section className="flex flex-col gap-3">
        <SettingsOverline>{t("settings.ai.connectionOverline")}</SettingsOverline>

        <SettingsGroup>
          {/* Option 1: Agent */}
          <button
            type="button"
            role="radio"
            aria-checked={connectionKind === "agent"}
            data-testid="connection-option-agent"
            onClick={() => void handleSelectConnection("agent")}
            className="w-full min-h-[70px] px-5 py-3.5 flex items-center justify-between gap-4 text-left cursor-pointer hover:bg-surface-tint/40 transition-colors"
          >
            <div className="flex items-start gap-3 min-w-0 flex-1">
              <span
                aria-hidden="true"
                className={`mt-0.5 size-[18px] rounded-full shrink-0 transition-colors ${
                  connectionKind === "agent"
                    ? "border-[5px] border-accent bg-surface-solid"
                    : "border-[1.5px] border-border-strong bg-transparent"
                }`}
              />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-[14px] font-medium text-text-primary leading-snug">
                    {t("settings.ai.agentOption")}
                  </span>
                  <span className="px-2 py-[2px] rounded-full bg-accent-tint text-accent-on-tint text-[11px] font-semibold leading-tight">
                    {t("settings.ai.recommendedBadge")}
                  </span>
                </div>
                <p className="text-[12.5px] text-text-tertiary mt-[3px] leading-snug">
                  {connectionKind === "agent"
                    ? t("settings.ai.agentHintExpanded")
                    : t("settings.ai.agentHintCollapsed")}
                </p>
              </div>
            </div>
            {connectionKind !== "agent" && (
              <div className="shrink-0 flex items-center gap-2">{renderCollapsedAgentBadge()}</div>
            )}
          </button>

          {/* Expanded Agent rows */}
          {connectionKind === "agent" && (
            <>
              <SettingsRow
                className="pl-[46px]"
                title={t("settings.ai.agentOption")}
                hint={t("settings.ai.agentPickerHint")}
              >
                <Select
                  appearance="dawn"
                  ariaLabel={t("settings.ai.agentOption")}
                  className="w-[155px]"
                  icon={<Terminal size={14} />}
                  value="codex"
                  onChange={() => {}}
                  options={[{ value: "codex", label: t("settings.ai.codex.title") }]}
                />
              </SettingsRow>

              <div data-testid="codex-status-row">{renderCodexStatusRow()}</div>

              <div data-testid="codex-location-row">
                <SettingsRow
                  className="pl-[46px]"
                  title={t("settings.ai.codex.locationTitle")}
                  hint={renderCodexLocationHint()}
                >
                  {codexPath.trim() && (
                    <Button
                      type="button"
                      appearance="dawn"
                      variant="ghost"
                      size="sm"
                      onClick={() => void handleResetCodexPath()}
                    >
                      {t("settings.ai.codex.resetPath")}
                    </Button>
                  )}
                  <Button
                    type="button"
                    appearance="dawn"
                    variant="secondary"
                    size="sm"
                    onClick={() => void handleChooseCodexPath()}
                  >
                    <FolderOpen size={13.5} />
                    <span>{t("settings.ai.codex.changeLocation")}</span>
                  </Button>
                </SettingsRow>
              </div>
            </>
          )}

          {/* Option 2: API */}
          <button
            type="button"
            role="radio"
            aria-checked={connectionKind === "api"}
            data-testid="connection-option-api"
            onClick={() => void handleSelectConnection("api")}
            className="w-full min-h-[70px] px-5 py-3.5 flex items-center justify-between gap-4 text-left cursor-pointer hover:bg-surface-tint/40 transition-colors"
          >
            <div className="flex items-start gap-3 min-w-0 flex-1">
              <span
                aria-hidden="true"
                className={`mt-0.5 size-[18px] rounded-full shrink-0 transition-colors ${
                  connectionKind === "api"
                    ? "border-[5px] border-accent bg-surface-solid"
                    : "border-[1.5px] border-border-strong bg-transparent"
                }`}
              />
              <div className="min-w-0 flex-1">
                <p className="text-[14px] font-medium text-text-primary leading-snug">
                  {t("settings.ai.apiOption")}
                </p>
                <p className="text-[12.5px] text-text-tertiary mt-[3px] leading-snug">
                  {connectionKind === "api"
                    ? t("settings.ai.apiHintExpanded")
                    : t("settings.ai.apiHintCollapsed")}
                </p>
              </div>
            </div>
          </button>

          {/* Expanded API rows */}
          {connectionKind === "api" && (
            <>
              <SettingsRow
                className="pl-[46px]"
                title={t("settings.ai.service")}
                hint={
                  apiProvider === "ollama"
                    ? t("settings.ai.serviceOllamaHint")
                    : t("settings.ai.serviceHint")
                }
              >
                <Select
                  appearance="dawn"
                  ariaLabel={t("settings.ai.service")}
                  className="w-[180px]"
                  menuMinWidth={336}
                  value={apiProvider}
                  onChange={(next) => void handleApiServiceChange(next)}
                  options={serviceOptions}
                />
              </SettingsRow>

              <SettingsRow
                className="pl-[46px]"
                title={t("settings.ai.baseUrl")}
                hint={
                  apiProvider === "custom"
                    ? t("settings.ai.baseUrlCustomHint")
                    : t("settings.ai.baseUrlHint")
                }
              >
                <input
                  type="text"
                  {...textFieldHandlers("ai_base_url", baseUrl, setBaseUrl)}
                  placeholder={activePreset.defaultUrl || "https://example.com/v1"}
                  aria-label={t("settings.ai.baseUrl")}
                  className={`w-[290px] ${monoInputClass}`}
                />
              </SettingsRow>

              {apiProvider === "ollama" ? (
                <>
                  <SettingsRow
                    className="pl-[46px]"
                    title={t("settings.ai.ollamaServer")}
                    hint={renderOllamaHint()}
                  >
                    {ollamaStatus !== null && (
                      <StatusBadge
                        tone={ollamaStatus.running ? "success" : "neutral"}
                        label={
                          ollamaStatus.running
                            ? t("settings.ai.connectedBadge")
                            : t("settings.ai.ollamaNotRunning")
                        }
                      />
                    )}
                  </SettingsRow>

                  <SettingsRow
                    className="pl-[46px]"
                    title={t("settings.ai.keepAlive")}
                    hint={t("settings.ai.keepAliveHint")}
                  >
                    <Select
                      appearance="dawn"
                      ariaLabel={t("settings.ai.keepAlive")}
                      className="w-[165px]"
                      icon={<Clock size={14} />}
                      value={keepAlive}
                      onChange={handleKeepAliveChange}
                      options={keepAliveOptions}
                    />
                  </SettingsRow>
                </>
              ) : (
                <SettingsRow
                  className="pl-[46px]"
                  title={t("settings.ai.apiKey")}
                  hint={
                    apiProvider === "custom"
                      ? t("settings.ai.apiKeyOptionalHint")
                      : t("settings.ai.apiKeyHint")
                  }
                >
                  <div className="w-[290px] h-9 px-3 rounded-[6px] bg-surface-solid border border-border-default focus-within:border-accent focus-within:ring-[3px] focus-within:ring-focus-ring flex items-center gap-1.5 transition-colors">
                    <input
                      type={showApiKey ? "text" : "password"}
                      {...textFieldHandlers("ai_api_key", apiKey, setApiKey)}
                      placeholder={activePreset.keyPlaceholder}
                      aria-label={t("settings.ai.apiKey")}
                      className="flex-1 min-w-0 bg-transparent border-0 outline-none font-mono text-[12.5px] text-text-primary placeholder:text-text-disabled"
                    />
                    {apiKey && (
                      <button
                        type="button"
                        onClick={handleClearApiKey}
                        aria-label={t("settings.ai.clear")}
                        className="p-1 rounded text-text-tertiary hover:text-text-primary cursor-pointer transition-colors"
                      >
                        <X size={13.5} />
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => setShowApiKey((v) => !v)}
                      aria-label={
                        showApiKey ? t("settings.ai.hideApiKey") : t("settings.ai.showApiKey")
                      }
                      className="p-1 rounded text-text-tertiary hover:text-text-primary cursor-pointer transition-colors"
                    >
                      {showApiKey ? <EyeOff size={14.5} /> : <Eye size={14.5} />}
                    </button>
                  </div>
                </SettingsRow>
              )}
            </>
          )}
        </SettingsGroup>
      </section>

      {/* Section 2: Models */}
      <section className="flex flex-col gap-3">
        <SettingsOverline>{t("settings.ai.modelsOverline")}</SettingsOverline>

        <SettingsGroup>
          {connectionKind === "agent" ? (
            <>
              {CODEX_FEATURES.map((feature) => {
                const resolved = resolveCodexFeature(feature.id, codexSettings, codexModels);
                const showCustomInput =
                  Boolean(customCodexFeatures[feature.id]) || resolved.isCustomModel;
                const draftValue =
                  customFeatureDrafts[feature.id] ??
                  (resolved.isCustomModel ? resolved.effectiveModel : "");
                return (
                  <div key={feature.id} className="flex flex-col">
                    <SettingsRow title={t(feature.titleKey)} hint={t(feature.hintKey)}>
                      <CodexFeaturePicker
                        feature={feature.id}
                        settings={codexSettings}
                        models={codexModels}
                        variant="settings"
                        customMode={Boolean(customCodexFeatures[feature.id])}
                        onSelectModel={(slug) => handleCodexFeatureModelSelect(feature.id, slug)}
                        onSelectEffort={(level) =>
                          handleCodexFeatureEffortSelect(feature.id, level)
                        }
                        onRequestCustomModel={() => handleRequestCustomCodexModel(feature.id)}
                      />
                    </SettingsRow>
                    {showCustomInput && (
                      <div className="px-5 pb-4 -mt-1">
                        <input
                          ref={(el) => {
                            customFeatureInputRefs.current[feature.id] = el;
                          }}
                          type="text"
                          value={draftValue}
                          onChange={(e) => handleCustomFeatureChange(feature.id, e.target.value)}
                          onBlur={() => handleCustomFeatureBlur(feature.id)}
                          onKeyDown={(e) => handleCustomFeatureKeyDown(feature.id, e)}
                          placeholder={resolved.defaultModel?.slug || "gpt-6.2-sol"}
                          aria-label={`${t(feature.titleKey)} — ${t("settings.ai.modelCustomInput")}`}
                          data-testid={`codex-custom-model-input-${feature.id}`}
                          className={`w-full text-[13px] ${monoInputClass}`}
                        />
                      </div>
                    )}
                  </div>
                );
              })}
            </>
          ) : (
            <>
              <div className="flex flex-col">
                <SettingsRow
                  title={t("settings.ai.model")}
                  hint={
                    apiModels.length > 0
                      ? t("settings.ai.apiModelPickerHint")
                      : t("settings.ai.modelGenerationHint")
                  }
                >
                  {showApiModelPicker ? (
                    <Select
                      appearance="dawn"
                      ariaLabel={t("settings.ai.model")}
                      className="w-[240px]"
                      menuMinWidth={300}
                      icon={<Cpu size={14} />}
                      value={model.trim()}
                      placeholder={activePreset.defaultModel || t("settings.ai.modelPlaceholder")}
                      onChange={handleApiModelSelect}
                      options={apiModelOptions}
                      menuHeader={
                        apiModels.length > 15 ? (
                          <div className="p-1.5 border-b border-border-subtle mb-1">
                            <div className="h-8 px-2.5 rounded-[6px] bg-surface-inset flex items-center gap-2">
                              <Search size={13} className="text-text-tertiary shrink-0" />
                              <input
                                type="text"
                                value={apiModelFilter}
                                onChange={(e) => setApiModelFilter(e.target.value)}
                                placeholder={t("settings.ai.filterModels")}
                                className="flex-1 min-w-0 bg-transparent border-0 outline-none text-[12.5px] text-text-primary placeholder:text-text-disabled"
                              />
                            </div>
                          </div>
                        ) : undefined
                      }
                    />
                  ) : (
                    <div className="flex items-center gap-2">
                      <input
                        type="text"
                        {...textFieldHandlers("ai_model", model, setModel)}
                        placeholder={activePreset.defaultModel || t("settings.ai.modelPlaceholder")}
                        aria-label={t("settings.ai.model")}
                        className={`w-[240px] text-[13px] ${monoInputClass}`}
                      />
                      {apiModels.length > 0 && customApiModel && (
                        <Button
                          type="button"
                          appearance="dawn"
                          variant="ghost"
                          size="sm"
                          onClick={() => setCustomApiModel(false)}
                        >
                          {t("settings.ai.backToList")}
                        </Button>
                      )}
                    </div>
                  )}
                </SettingsRow>
              </div>

              <SettingsRow
                title={t("settings.ai.temperature")}
                hint={t("settings.ai.temperatureHint")}
              >
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
            </>
          )}
        </SettingsGroup>

        <p className="text-[12.5px] leading-[1.45] text-text-tertiary px-1 pt-0.5">
          {connectionKind === "agent"
            ? t("settings.ai.codex.footerNote")
            : t("settings.ai.footerNote")}
        </p>
      </section>
    </div>
  );
}
