export type ConnectionKind = "agent" | "api";

export type ApiProvider =
  | "openai"
  | "anthropic"
  | "gemini"
  | "deepseek"
  | "openrouter"
  | "ollama"
  | "custom";

export type CodexStatusState =
  | "ready"
  | "not_installed"
  | "not_signed_in"
  | "too_old"
  | "failed";

export interface CodexStatus {
  state: CodexStatusState;
  version: string | null;
  min_version: string;
  path: string | null;
  from_override: boolean;
  email: string | null;
  plan: string | null;
  error: string | null;
}

export interface CodexModel {
  slug: string;
  display_name: string;
  description: string;
  supported_reasoning_levels: string[];
  default_reasoning_level: string;
  is_default: boolean;
}

export interface CodexModelList {
  models: CodexModel[];
}

export interface LoginOutcome {
  success: boolean;
  error: string | null;
}

export interface ApiModelList {
  models: string[];
}

export interface OllamaStatus {
  running: boolean;
  models: number | null;
}

export interface ApiServicePreset {
  id: ApiProvider;
  labelKey: string;
  defaultUrl: string;
  menuDescriptionKey?: string;
  menuUrl?: string;
  requiresKey: boolean;
  defaultModel: string;
  keyPlaceholder: string;
}

export const CODEX_INSTALL_COMMAND = "npm install -g @openai/codex";
export const CODEX_UPDATE_COMMAND = "npm install -g @openai/codex@latest";
export const CODEX_INSTALL_GUIDE_URL = "https://developers.openai.com/codex/cli";
export const CODEX_FALLBACK_EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;

export const API_SERVICES: readonly ApiServicePreset[] = [
  {
    id: "openai",
    labelKey: "settings.ai.providers.openai",
    defaultUrl: "https://api.openai.com/v1",
    menuUrl: "api.openai.com/v1",
    requiresKey: true,
    defaultModel: "gpt-4o",
    keyPlaceholder: "sk-...",
  },
  {
    id: "anthropic",
    labelKey: "settings.ai.providers.anthropic",
    defaultUrl: "https://api.anthropic.com",
    menuUrl: "api.anthropic.com",
    requiresKey: true,
    defaultModel: "claude-sonnet-4-20250514",
    keyPlaceholder: "sk-ant-...",
  },
  {
    id: "gemini",
    labelKey: "settings.ai.providers.gemini",
    defaultUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    menuUrl: "generativelanguage.googleapis.com/v1beta/openai",
    requiresKey: true,
    defaultModel: "gemini-2.5-flash",
    keyPlaceholder: "AIza...",
  },
  {
    id: "deepseek",
    labelKey: "settings.ai.providers.deepseek",
    defaultUrl: "https://api.deepseek.com/v1",
    menuUrl: "api.deepseek.com/v1",
    requiresKey: true,
    defaultModel: "deepseek-chat",
    keyPlaceholder: "sk-...",
  },
  {
    id: "openrouter",
    labelKey: "settings.ai.providers.openrouter",
    defaultUrl: "https://openrouter.ai/api/v1",
    menuUrl: "openrouter.ai/api/v1",
    requiresKey: true,
    defaultModel: "",
    keyPlaceholder: "sk-or-...",
  },
  {
    id: "ollama",
    labelKey: "settings.ai.providers.ollama",
    defaultUrl: "http://localhost:11434/v1",
    menuDescriptionKey: "settings.ai.providers.ollamaMenuDesc",
    requiresKey: false,
    defaultModel: "qwen3.5",
    keyPlaceholder: "",
  },
  {
    id: "custom",
    labelKey: "settings.ai.providers.custom",
    defaultUrl: "",
    menuDescriptionKey: "settings.ai.providers.customMenuDesc",
    requiresKey: false,
    defaultModel: "",
    keyPlaceholder: "sk-...",
  },
];

export const AI_SENTINELS = [
  "AI_NOT_CONFIGURED",
  "CODEX_NOT_INSTALLED",
  "CODEX_NOT_SIGNED_IN",
  "CODEX_TOO_OLD",
  "CODEX_FAILED",
] as const;

export type AiSentinel = (typeof AI_SENTINELS)[number];

export function matchAiSentinel(raw: string | null | undefined): AiSentinel | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  for (const sentinel of AI_SENTINELS) {
    if (trimmed === sentinel || trimmed.includes(sentinel)) {
      return sentinel;
    }
  }
  return null;
}

export function isExactAiSentinel(raw: string | null | undefined): raw is AiSentinel {
  if (!raw) return false;
  const trimmed = raw.trim();
  return (AI_SENTINELS as readonly string[]).includes(trimmed);
}

export function normalizeApiProvider(raw?: string | null): ApiProvider {
  const trimmed = raw?.trim();
  if (
    trimmed === "openai" ||
    trimmed === "anthropic" ||
    trimmed === "gemini" ||
    trimmed === "deepseek" ||
    trimmed === "openrouter" ||
    trimmed === "ollama" ||
    trimmed === "custom"
  ) {
    return trimmed;
  }
  return "openai";
}

export function getApiServicePreset(provider: ApiProvider): ApiServicePreset {
  return API_SERVICES.find((s) => s.id === provider) ?? API_SERVICES[0];
}

/**
 * Determine which connection is selected in Settings → AI.
 * Fresh installs default to Agent; saved API-key or Ollama settings open on API.
 */
export function resolveConnectionKind(settings: Record<string, string>): ConnectionKind {
  if (settings.ai_auth_mode === "codex") return "agent";
  if (settings.ai_auth_mode === "api_key") return "api";
  if (settings.ai_provider?.trim()) return "api";
  return "agent";
}

/** Whether AI has been configured (Codex selected or a usable API connection saved). */
export function isAiConfigured(settings: Record<string, string>): boolean {
  if (settings.ai_auth_mode === "codex") return true;
  const provider = settings.ai_provider?.trim();
  if (!provider) return false;
  if (provider === "ollama") return true;
  if (provider === "custom") return Boolean(settings.ai_base_url?.trim());
  return Boolean(settings.ai_api_key?.trim());
}

/** Whether the first-launch AI setup dialog should appear over Home. */
export function shouldShowAiSetup(settings: Record<string, string>): {
  show: boolean;
  isMigration: boolean;
} {
  if (settings.ai_codex_migration_pending === "true") {
    return { show: true, isMigration: true };
  }
  if (settings.ai_setup_seen === "true") {
    return { show: false, isMigration: false };
  }
  if (isAiConfigured(settings)) {
    return { show: false, isMigration: false };
  }
  return { show: true, isMigration: false };
}

export function formatCodexPlan(plan?: string | null): string | null {
  const trimmed = plan?.trim();
  if (!trimmed) return null;
  const lower = trimmed.toLowerCase();
  const known: Record<string, string> = {
    pro: "ChatGPT Pro",
    plus: "ChatGPT Plus",
    team: "ChatGPT Team",
    enterprise: "ChatGPT Enterprise",
    edu: "ChatGPT Edu",
    free: "ChatGPT Free",
    go: "ChatGPT Go",
  };
  if (known[lower]) return known[lower];
  return `ChatGPT ${trimmed.charAt(0).toUpperCase()}${trimmed.slice(1)}`;
}

export function formatCodexAccountLine(
  status: Pick<CodexStatus, "email" | "plan" | "version">,
  includeVersion: boolean,
): string {
  const parts: string[] = [];
  if (status.email?.trim()) parts.push(status.email.trim());
  const plan = formatCodexPlan(status.plan);
  if (plan) parts.push(plan);
  if (includeVersion && status.version?.trim()) {
    parts.push(`Codex ${status.version.trim()}`);
  }
  return parts.join(" · ");
}
