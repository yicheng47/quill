import { CODEX_FALLBACK_EFFORT_LEVELS, type CodexModel } from "./aiConnections";

export type CodexFeatureId = "lookup" | "explain" | "chat" | "translate";

export interface CodexFeatureSpec {
  id: CodexFeatureId;
  modelKey: `ai_codex_model_${CodexFeatureId}`;
  effortKey: `ai_codex_effort_${CodexFeatureId}`;
  legacyEffortKey: "ai_effort_quick" | "ai_effort_deep";
  legacyEffortFallbackKey?: `ai_codex_effort_fallback_${Exclude<CodexFeatureId, "lookup">}`;
  defaultFamily: "luna" | "terra" | "sol";
  defaultFamilyLabel: "Luna" | "Terra" | "Sol";
  defaultEffort: "low" | "medium" | "high";
  titleKey: string;
  hintKey: string;
}

export const CODEX_FEATURES: readonly CodexFeatureSpec[] = [
  {
    id: "lookup",
    modelKey: "ai_codex_model_lookup",
    effortKey: "ai_codex_effort_lookup",
    legacyEffortKey: "ai_effort_quick",
    defaultFamily: "luna",
    defaultFamilyLabel: "Luna",
    defaultEffort: "low",
    titleKey: "settings.ai.features.lookup.title",
    hintKey: "settings.ai.features.lookup.hint",
  },
  {
    id: "explain",
    modelKey: "ai_codex_model_explain",
    effortKey: "ai_codex_effort_explain",
    legacyEffortKey: "ai_effort_deep",
    legacyEffortFallbackKey: "ai_codex_effort_fallback_explain",
    defaultFamily: "terra",
    defaultFamilyLabel: "Terra",
    defaultEffort: "high",
    titleKey: "settings.ai.features.explain.title",
    hintKey: "settings.ai.features.explain.hint",
  },
  {
    id: "chat",
    modelKey: "ai_codex_model_chat",
    effortKey: "ai_codex_effort_chat",
    legacyEffortKey: "ai_effort_deep",
    legacyEffortFallbackKey: "ai_codex_effort_fallback_chat",
    defaultFamily: "sol",
    defaultFamilyLabel: "Sol",
    defaultEffort: "high",
    titleKey: "settings.ai.features.chat.title",
    hintKey: "settings.ai.features.chat.hint",
  },
  {
    id: "translate",
    modelKey: "ai_codex_model_translate",
    effortKey: "ai_codex_effort_translate",
    legacyEffortKey: "ai_effort_deep",
    legacyEffortFallbackKey: "ai_codex_effort_fallback_translate",
    defaultFamily: "terra",
    defaultFamilyLabel: "Terra",
    defaultEffort: "medium",
    titleKey: "settings.ai.features.translate.title",
    hintKey: "settings.ai.features.translate.hint",
  },
] as const;

export function getCodexFeature(id: CodexFeatureId): CodexFeatureSpec {
  return CODEX_FEATURES.find((f) => f.id === id) ?? CODEX_FEATURES[2];
}

export function chosenCodexSetting(raw?: string | null): string | null {
  const trimmed = raw?.trim() ?? "";
  if (!trimmed || trimmed === "default") return null;
  return trimmed;
}

export function findCatalogDefaultModel(models: readonly CodexModel[]): CodexModel | null {
  return models.find((m) => m.is_default) ?? models[0] ?? null;
}

export function findFamilyDefaultModel(
  models: readonly CodexModel[],
  family: string,
): CodexModel | null {
  const suffix = `-${family.toLowerCase()}`;
  return models.find((m) => m.slug.toLowerCase().endsWith(suffix)) ?? null;
}

export interface ResolvedCodexFeature {
  feature: CodexFeatureSpec;
  effectiveModel: string;
  modelDisplayName: string;
  knownModel: CodexModel | null;
  defaultModel: CodexModel | null;
  defaultModelFromFamily: boolean;
  explicitModel: string | null;
  isModelDefault: boolean;
  isCustomModel: boolean;
  resolvedEffort: string;
  defaultResolvedEffort: string;
  supportedEffortLevels: string[];
  hasKnownSupportedEfforts: boolean;
  isEffortDefault: boolean;
}

/**
 * Mirrors `crates/quill-core/src/ai/codex/mod.rs::resolve_model_and_effort`
 * so Settings and both composers always agree with the backend.
 */
export function resolveCodexFeature(
  featureId: CodexFeatureId,
  settings: Record<string, string>,
  models: readonly CodexModel[],
): ResolvedCodexFeature {
  const feature = getCodexFeature(featureId);
  const catalogDefault = findCatalogDefaultModel(models);
  const familyModel = findFamilyDefaultModel(models, feature.defaultFamily);
  const defaultModel = familyModel ?? catalogDefault;
  const defaultModelFromFamily = familyModel !== null;

  const featureModel = chosenCodexSetting(settings[feature.modelKey]);
  const legacyModel = chosenCodexSetting(settings.ai_model);
  const explicitModel = featureModel ?? legacyModel;
  const isModelDefault = explicitModel === null;

  const effectiveModel = explicitModel ?? defaultModel?.slug ?? "";
  const knownModel = effectiveModel
    ? (models.find((m) => m.slug === effectiveModel) ?? null)
    : null;
  const isCustomModel = explicitModel !== null && models.length > 0 && knownModel === null;
  const modelDisplayName = knownModel ? knownModel.display_name || knownModel.slug : effectiveModel;

  const hasKnownSupportedEfforts = Boolean(
    knownModel && knownModel.supported_reasoning_levels.length > 0,
  );
  const supportedEffortLevels = hasKnownSupportedEfforts
    ? [...knownModel!.supported_reasoning_levels]
    : [...CODEX_FALLBACK_EFFORT_LEVELS];
  const supportsEffort = (candidate: string): boolean =>
    hasKnownSupportedEfforts ? supportedEffortLevels.includes(candidate) : true;

  const defaultResolvedEffort = supportsEffort(feature.defaultEffort)
    ? feature.defaultEffort
    : knownModel?.default_reasoning_level || catalogDefault?.default_reasoning_level || "low";

  const featureEffort = chosenCodexSetting(settings[feature.effortKey]);
  const legacyEffort =
    chosenCodexSetting(settings[feature.legacyEffortKey]) ??
    (feature.legacyEffortFallbackKey
      ? chosenCodexSetting(settings[feature.legacyEffortFallbackKey])
      : null);
  const effectiveExplicitEffort =
    (featureEffort && supportsEffort(featureEffort) ? featureEffort : null) ??
    (legacyEffort && supportsEffort(legacyEffort) ? legacyEffort : null);

  const isEffortDefault = effectiveExplicitEffort === null;
  const resolvedEffort = effectiveExplicitEffort ?? defaultResolvedEffort;

  return {
    feature,
    effectiveModel,
    modelDisplayName,
    knownModel,
    defaultModel,
    defaultModelFromFamily,
    explicitModel,
    isModelDefault,
    isCustomModel,
    resolvedEffort,
    defaultResolvedEffort,
    supportedEffortLevels,
    hasKnownSupportedEfforts,
    isEffortDefault,
  };
}

/**
 * Build the minimal per-feature settings diff for choosing a model (or
 * clearing to Default). Never writes the reasoning key; resolvers already skip
 * unsupported saved tiers and fall through to the supported fallback, while
 * legacy 2.0 `ai_model` carry-over is resolved atomically inside SQLite
 * (`commands/settings.rs`).
 */
export function buildCodexModelSave(
  featureId: CodexFeatureId,
  nextModel: string,
): Record<string, string> {
  const feature = getCodexFeature(featureId);
  const trimmed = nextModel.trim();
  return {
    [feature.modelKey]: !trimmed || trimmed === "default" ? "" : trimmed,
  };
}

/**
 * Build the minimal per-feature settings diff for choosing a reasoning level
 * (or clearing to Default). Legacy tier carry-over onto untouched sibling
 * features is resolved atomically inside SQLite (`commands/settings.rs`).
 */
export function buildCodexEffortSave(
  featureId: CodexFeatureId,
  nextEffort: string,
): Record<string, string> {
  const feature = getCodexFeature(featureId);
  const trimmed = nextEffort.trim();
  return {
    [feature.effortKey]: !trimmed || trimmed === "default" ? "" : trimmed,
  };
}

/**
 * Mirror `commands/settings.rs::preserve_codex_legacy_in_tx` for local
 * optimistic state before the authoritative `get_all_settings` refresh returns.
 * Never sent over IPC.
 */
export function applyCodexLegacyCarryOverLocal(
  current: Record<string, string>,
  updates: Record<string, string>,
): Record<string, string> {
  const next: Record<string, string> = { ...current };
  const oldAuthMode = current.ai_auth_mode;
  const newAuthMode = updates.ai_auth_mode ?? oldAuthMode;

  const switchingFromCodex = oldAuthMode === "codex" && newAuthMode !== "codex";
  const clearingCodexModel =
    newAuthMode === "codex" &&
    CODEX_FEATURES.some(
      (f) => f.modelKey in updates && chosenCodexSetting(updates[f.modelKey]) === null,
    ) &&
    chosenCodexSetting(updates.ai_model) === null;

  if (switchingFromCodex || clearingCodexModel) {
    const legacyModel = chosenCodexSetting(current.ai_model);
    if (legacyModel) {
      for (const f of CODEX_FEATURES) {
        if (f.modelKey in updates) continue;
        if (chosenCodexSetting(current[f.modelKey]) === null) {
          next[f.modelKey] = legacyModel;
        }
      }
      if (clearingCodexModel && !("ai_model" in updates)) {
        next.ai_model = "";
      }
    }
  }

  if (
    "ai_codex_effort_lookup" in updates &&
    chosenCodexSetting(updates.ai_codex_effort_lookup) === null &&
    chosenCodexSetting(updates.ai_effort_quick) === null &&
    chosenCodexSetting(current.ai_effort_quick) !== null &&
    !("ai_effort_quick" in updates)
  ) {
    next.ai_effort_quick = "";
  }

  const clearingDeepEffort =
    CODEX_FEATURES.some(
      (f) =>
        f.legacyEffortKey === "ai_effort_deep" &&
        f.effortKey in updates &&
        chosenCodexSetting(updates[f.effortKey]) === null,
    ) && chosenCodexSetting(updates.ai_effort_deep) === null;
  if (clearingDeepEffort) {
    const legacyDeep = chosenCodexSetting(current.ai_effort_deep);
    if (legacyDeep) {
      for (const f of CODEX_FEATURES) {
        if (f.legacyEffortKey !== "ai_effort_deep" || f.effortKey in updates) continue;
        if (chosenCodexSetting(current[f.effortKey]) === null) {
          next[f.effortKey] = legacyDeep;
        } else if (
          f.legacyEffortFallbackKey &&
          !(f.legacyEffortFallbackKey in updates) &&
          chosenCodexSetting(current[f.legacyEffortFallbackKey]) === null
        ) {
          next[f.legacyEffortFallbackKey] = legacyDeep;
        }
      }
      if (!("ai_effort_deep" in updates)) {
        next.ai_effort_deep = "";
      }
    }
    for (const f of CODEX_FEATURES) {
      if (
        f.legacyEffortFallbackKey &&
        f.effortKey in updates &&
        chosenCodexSetting(updates[f.effortKey]) === null &&
        !(f.legacyEffortFallbackKey in updates) &&
        chosenCodexSetting(current[f.legacyEffortFallbackKey]) !== null
      ) {
        next[f.legacyEffortFallbackKey] = "";
      }
    }
  }

  return { ...next, ...updates };
}
