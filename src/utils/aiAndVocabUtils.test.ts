// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  extractRangeSelectionContext,
  extractSelectionSentence,
  extractSelectionSentenceWithOffset,
  formatAiModelFooter,
  parseAiErrorMessage,
} from "./aiStream";
import {
  formatCodexAccountLine,
  isAiConfigured,
  matchAiSentinel,
  resolveConnectionKind,
  shouldShowAiSetup,
  type CodexModel,
} from "../lib/aiConnections";
import {
  applyCodexLegacyCarryOverLocal,
  buildCodexEffortSave,
  buildCodexModelSave,
  resolveCodexFeature,
} from "../lib/codexFeatures";
import { parseDefinition, parseSavedVocabDefinition } from "./vocabParse";

describe("parseAiErrorMessage", () => {
  it("extracts error detail when prefixed with Error:", () => {
    expect(parseAiErrorMessage("Error: Rate limit exceeded")).toBe("Rate limit exceeded");
    expect(parseAiErrorMessage("  Error:   Connection reset  ")).toBe("Connection reset");
  });

  it("handles bare Error: string safely", () => {
    expect(parseAiErrorMessage("Error:")).toBe("Error:");
  });

  it("returns null for normal content or sentinel tokens", () => {
    expect(parseAiErrorMessage("Hello world")).toBeNull();
    expect(parseAiErrorMessage("AI_NOT_CONFIGURED")).toBeNull();
    expect(parseAiErrorMessage("CODEX_NOT_SIGNED_IN")).toBeNull();
  });
});

describe("formatAiModelFooter", () => {
  it("returns null when no AI connection or empty API model is configured", () => {
    expect(formatAiModelFooter({})).toBeNull();
    expect(formatAiModelFooter({ ai_provider: "  " })).toBeNull();
    expect(formatAiModelFooter({ ai_provider: "openai", ai_model: "  " })).toBeNull();
  });

  it("matches commands/ai.rs defaults when model or auth_mode rows are absent", () => {
    expect(
      formatAiModelFooter({
        ai_provider: "openai",
        ai_effort_deep: "high",
      }),
    ).toBe("llama3.2");

    expect(
      formatAiModelFooter({
        ai_provider: "anthropic",
        ai_model: "claude-sonnet-4-20250514",
        ai_effort_deep: "high",
      }),
    ).toBe("claude-sonnet-4-20250514");
  });

  it("formats Codex model and deep reasoning effort", () => {
    expect(
      formatAiModelFooter(
        {
          ai_auth_mode: "codex",
          ai_model: "gpt-6.2-sol",
          ai_effort_deep: "high",
        },
        (effort) => `Effort ${effort}`,
      ),
    ).toBe("gpt-6.2-sol · Effort high");

    expect(
      formatAiModelFooter({
        ai_auth_mode: "codex",
        ai_model: "gpt-6.2-sol",
        ai_effort_deep: "default",
      }),
    ).toBe("gpt-6.2-sol");

    expect(formatAiModelFooter({ ai_auth_mode: "codex" })).toBe("Codex");

    expect(
      formatAiModelFooter({
        ai_provider: "openai",
        ai_auth_mode: "api_key",
        ai_model: "gpt-4o",
        ai_effort_deep: "high",
      }),
    ).toBe("gpt-4o");

    expect(
      formatAiModelFooter(
        {
          ai_auth_mode: "codex",
          ai_model: "gpt-5.6-sol",
          ai_effort_deep: "low",
          ai_codex_model_chat: "gpt-6.1-terra",
          ai_codex_effort_chat: "medium",
        },
        (effort) => effort,
      ),
    ).toBe("gpt-6.1-terra · medium");
  });
});

describe("codexFeatures resolution and updates (#358)", () => {
  const catalog: CodexModel[] = [
    {
      slug: "gpt-6.3-sol",
      display_name: "GPT-6.3 Sol",
      description: "",
      supported_reasoning_levels: ["low", "medium", "high"],
      default_reasoning_level: "low",
      is_default: true,
    },
    {
      slug: "gpt-6.2-sol",
      display_name: "GPT-6.2 Sol",
      description: "",
      supported_reasoning_levels: ["low", "medium", "high"],
      default_reasoning_level: "low",
      is_default: false,
    },
    {
      slug: "gpt-6.1-terra",
      display_name: "GPT-6.1 Terra",
      description: "",
      supported_reasoning_levels: ["low", "medium", "high", "xhigh"],
      default_reasoning_level: "medium",
      is_default: false,
    },
    {
      slug: "gpt-6-luna",
      display_name: "GPT-6 Luna",
      description: "",
      supported_reasoning_levels: ["low", "medium"],
      default_reasoning_level: "low",
      is_default: false,
    },
  ];

  it("resolves family defaults newest-first and falls back to catalog default when family is absent", () => {
    expect(resolveCodexFeature("lookup", {}, catalog)).toMatchObject({
      effectiveModel: "gpt-6-luna",
      modelDisplayName: "GPT-6 Luna",
      resolvedEffort: "low",
      isModelDefault: true,
      isEffortDefault: true,
      defaultModelFromFamily: true,
    });
    expect(resolveCodexFeature("chat", {}, catalog)).toMatchObject({
      effectiveModel: "gpt-6.3-sol",
      resolvedEffort: "high",
      defaultResolvedEffort: "high",
      defaultModelFromFamily: true,
    });
    expect(resolveCodexFeature("translate", {}, catalog)).toMatchObject({
      effectiveModel: "gpt-6.1-terra",
      resolvedEffort: "medium",
    });

    const noTerra = catalog.filter((m) => !m.slug.endsWith("-terra"));
    expect(resolveCodexFeature("explain", {}, noTerra)).toMatchObject({
      effectiveModel: "gpt-6.3-sol",
      defaultModelFromFamily: false,
      resolvedEffort: "high",
    });
  });

  it("applies feature > legacy > family/default precedence and falls through on unsupported effort", () => {
    expect(
      resolveCodexFeature(
        "explain",
        {
          ai_model: "gpt-6-luna",
          ai_effort_deep: "xhigh", // unsupported by gpt-6-luna (supports low, medium; default low)
        },
        catalog,
      ),
    ).toMatchObject({
      effectiveModel: "gpt-6-luna",
      isModelDefault: false,
      // Explain default effort (high) is also unsupported by gpt-6-luna -> model default low.
      resolvedEffort: "low",
      defaultResolvedEffort: "low",
      isEffortDefault: true,
    });

    expect(
      resolveCodexFeature(
        "chat",
        {
          ai_codex_model_chat: "my-custom",
          ai_codex_effort_chat: "ultra",
        },
        catalog,
      ),
    ).toMatchObject({
      effectiveModel: "my-custom",
      isCustomModel: true,
      resolvedEffort: "ultra",
      isEffortDefault: false,
    });
  });

  it("builds minimal per-feature saves without sibling or implicit effort writes and mirrors legacy carry-over locally", () => {
    expect(buildCodexModelSave("chat", "gpt-6.1-terra")).toEqual({
      ai_codex_model_chat: "gpt-6.1-terra",
    });
    expect(buildCodexModelSave("explain", "")).toEqual({
      ai_codex_model_explain: "",
    });
    expect(buildCodexModelSave("explain", "default")).toEqual({
      ai_codex_model_explain: "",
    });
    expect(buildCodexEffortSave("explain", "")).toEqual({
      ai_codex_effort_explain: "",
    });
    expect(buildCodexEffortSave("lookup", "default")).toEqual({
      ai_codex_effort_lookup: "",
    });

    // Local optimistic mirror matches Rust's preserve_codex_legacy_in_tx.
    expect(
      applyCodexLegacyCarryOverLocal(
        { ai_auth_mode: "codex", ai_model: "gpt-6-luna", ai_codex_model_chat: "gpt-6.3-sol" },
        { ai_auth_mode: "api_key", ai_model: "gpt-4o" },
      ),
    ).toEqual({
      ai_auth_mode: "api_key",
      ai_model: "gpt-4o",
      ai_codex_model_lookup: "gpt-6-luna",
      ai_codex_model_explain: "gpt-6-luna",
      ai_codex_model_chat: "gpt-6.3-sol",
      ai_codex_model_translate: "gpt-6-luna",
    });
  });

  it("preserves supported legacy reasoning fallback on model-only edits and sibling Default resets", () => {
    const lunaMediumHighCatalog: CodexModel[] = [
      {
        slug: "gpt-6-luna",
        display_name: "GPT-6 Luna",
        description: "",
        supported_reasoning_levels: ["medium", "high"],
        default_reasoning_level: "medium",
        is_default: false,
      },
      {
        slug: "gpt-6.1-terra",
        display_name: "GPT-6.1 Terra",
        description: "",
        supported_reasoning_levels: ["low", "medium", "high", "xhigh"],
        default_reasoning_level: "medium",
        is_default: false,
      },
      {
        slug: "gpt-6.2-sol",
        display_name: "GPT-6.2 Sol",
        description: "",
        supported_reasoning_levels: ["low", "medium", "high"],
        default_reasoning_level: "high",
        is_default: true,
      },
    ];

    // (a) Chat on Terra/xhigh with legacy deep=medium; model-only switch to Luna (medium/high)
    // writes only the model key so Terra -> Luna -> Terra keeps xhigh and Luna resolves medium.
    const startSettings = {
      ai_auth_mode: "codex",
      ai_codex_model_chat: "gpt-6.1-terra",
      ai_codex_effort_chat: "xhigh",
      ai_effort_deep: "medium",
    };
    const toLuna = buildCodexModelSave("chat", "gpt-6-luna");
    expect(toLuna).toEqual({ ai_codex_model_chat: "gpt-6-luna" });
    const onLuna = applyCodexLegacyCarryOverLocal(startSettings, toLuna);
    expect(resolveCodexFeature("chat", onLuna, lunaMediumHighCatalog)).toMatchObject({
      effectiveModel: "gpt-6-luna",
      resolvedEffort: "medium",
      isEffortDefault: false,
    });
    const backToTerra = applyCodexLegacyCarryOverLocal(
      onLuna,
      buildCodexModelSave("chat", "gpt-6.1-terra"),
    );
    expect(resolveCodexFeature("chat", backToTerra, lunaMediumHighCatalog)).toMatchObject({
      effectiveModel: "gpt-6.1-terra",
      resolvedEffort: "xhigh",
      isEffortDefault: false,
    });

    // Clearing Model -> Default also writes only the model key, never the reasoning key.
    expect(buildCodexModelSave("chat", "")).toEqual({ ai_codex_model_chat: "" });

    // (b) Untouched Chat with saved unsupported xhigh preserves legacy medium fallback
    // when Explain resets to Default, and explicit Chat Default clears that fallback.
    const afterExplainReset = applyCodexLegacyCarryOverLocal(
      {
        ai_auth_mode: "codex",
        ai_codex_model_chat: "gpt-6-luna",
        ai_codex_effort_chat: "xhigh",
        ai_effort_deep: "medium",
      },
      { ai_codex_effort_explain: "" },
    );
    expect(afterExplainReset).toMatchObject({
      ai_codex_effort_explain: "",
      ai_codex_effort_translate: "medium",
      ai_codex_effort_chat: "xhigh",
      ai_codex_effort_fallback_chat: "medium",
      ai_effort_deep: "",
    });
    expect(resolveCodexFeature("chat", afterExplainReset, lunaMediumHighCatalog)).toMatchObject({
      resolvedEffort: "medium",
      isEffortDefault: false,
    });
    expect(resolveCodexFeature("explain", afterExplainReset, lunaMediumHighCatalog)).toMatchObject({
      resolvedEffort: "high",
      isEffortDefault: true,
    });
    expect(
      resolveCodexFeature("translate", afterExplainReset, lunaMediumHighCatalog),
    ).toMatchObject({
      resolvedEffort: "medium",
      isEffortDefault: false,
    });

    const afterChatReset = applyCodexLegacyCarryOverLocal(afterExplainReset, {
      ai_codex_effort_chat: "",
    });
    expect(afterChatReset.ai_codex_effort_fallback_chat).toBe("");
    expect(resolveCodexFeature("chat", afterChatReset, lunaMediumHighCatalog)).toMatchObject({
      resolvedEffort: "high",
      isEffortDefault: true,
    });
  });
});

describe("aiConnections helpers", () => {
  it("resolves connection kind, setup eligibility, sentinels, and Codex account lines", () => {
    expect(resolveConnectionKind({})).toBe("agent");
    expect(resolveConnectionKind({ ai_auth_mode: "codex" })).toBe("agent");
    expect(resolveConnectionKind({ ai_provider: "ollama" })).toBe("api");
    expect(resolveConnectionKind({ ai_provider: "anthropic" })).toBe("api");

    expect(isAiConfigured({})).toBe(false);
    expect(isAiConfigured({ ai_auth_mode: "codex" })).toBe(true);
    expect(isAiConfigured({ ai_provider: "ollama" })).toBe(true);
    expect(isAiConfigured({ ai_provider: "openai" })).toBe(false);
    expect(isAiConfigured({ ai_provider: "openai", ai_api_key: "sk-1" })).toBe(true);
    expect(isAiConfigured({ ai_provider: "custom", ai_base_url: "http://localhost:8000/v1" })).toBe(
      true,
    );

    expect(shouldShowAiSetup({})).toEqual({ show: true, isMigration: false });
    expect(shouldShowAiSetup({ ai_setup_seen: "true" })).toEqual({ show: false, isMigration: false });
    expect(shouldShowAiSetup({ ai_setup_seen: "true", ai_codex_migration_pending: "true" })).toEqual({
      show: true,
      isMigration: true,
    });
    expect(shouldShowAiSetup({ ai_auth_mode: "codex" })).toEqual({ show: false, isMigration: false });

    expect(matchAiSentinel("Error: CODEX_TOO_OLD")).toBe("CODEX_TOO_OLD");
    expect(matchAiSentinel("unrelated")).toBeNull();
    expect(
      formatCodexAccountLine({ email: "a@b.com", plan: "pro", version: "0.170.0" }, true),
    ).toBe("a@b.com · ChatGPT Pro · Codex 0.170.0");
  });
});

describe("extractSelectionSentence & DOM Range extraction", () => {
  it("uses Range offset rather than indexOf so repeated words select the right window", () => {
    const filler = "x ".repeat(480); // 960 chars
    const paragraph = `deposit bank ${filler}river bank ahead`;
    const riverBankOffset = paragraph.lastIndexOf("bank");
    expect(riverBankOffset).toBeGreaterThan(950);

    const { sentence, matchStart } = extractSelectionSentenceWithOffset(
      paragraph,
      "bank",
      riverBankOffset,
      500,
    );
    expect(sentence.length).toBeLessThanOrEqual(500);
    expect(sentence).toContain("river bank");
    expect(sentence).not.toContain("deposit");
    expect(sentence.slice(matchStart, matchStart + 4)).toBe("bank");
    expect(sentence.slice(matchStart - 6, matchStart + 4)).toBe("river bank");
  });

  it("tracks exact occurrence offset when both occurrences appear in the same window", () => {
    const paragraph = "She left the deposit bank and walked down to the river bank.";
    const secondIdx = paragraph.lastIndexOf("bank");

    const result = extractSelectionSentenceWithOffset(paragraph, "bank", secondIdx, 500);
    expect(result.sentence).toBe(paragraph);
    expect(result.matchStart).toBe(secondIdx);
    expect(result.sentence.slice(result.matchStart - 6, result.matchStart + 4)).toBe("river bank");
  });

  it("extracts exact DOM Range context from nested inline nodes and handles cross-block selections", () => {
    const wrapper = document.createElement("div");
    const p1 = document.createElement("p");
    p1.append("The deposit bank closed before dusk, while the old ");
    const em = document.createElement("em");
    em.textContent = "river bank";
    p1.append(em, " flooded overnight.");
    const p2 = document.createElement("p");
    p2.textContent = "Second paragraph after break.";
    wrapper.append(p1, p2);

    const range = document.createRange();
    range.setStart(em.firstChild!, 6); // "bank" inside "river bank"
    range.setEnd(em.firstChild!, 10);
    const extracted = extractRangeSelectionContext(p1, range, "bank", 500);
    expect(extracted.sentence).toBe(p1.textContent);
    expect(extracted.matchStart).toBe(p1.textContent!.lastIndexOf("bank"));

    const crossRange = document.createRange();
    crossRange.setStart(em.firstChild!, 0);
    crossRange.setEnd(p2.firstChild!, 6);
    expect(extractRangeSelectionContext(p1, crossRange, "river bank\nSecond", 500)).toEqual({
      sentence: "river bank\nSecond",
      matchStart: 0,
    });

    expect(extractSelectionSentence("Short plain sentence.", "plain")).toBe("Short plain sentence.");
  });
});

describe("vocab definition parsing for M7 surfaces", () => {
  it("parses IPA and POS with optional markdown emphasis or parentheses", () => {
    expect(parseDefinition("**/ˈkɒm.ən/** *(adj.)* Shared by many people.")).toEqual({
      pronunciation: "/ˈkɒm.ən/",
      partOfSpeech: "adj",
      definition: "Shared by many people.",
    });

    expect(parseDefinition("/rʌn/ verb. Move rapidly.\n\nAlso: manage.")).toEqual({
      pronunciation: "/rʌn/",
      partOfSpeech: "verb",
      definition: "Move rapidly.\n\nAlso: manage.",
    });
  });

  it("splits leading translation gloss above plain or emphasized IPA entry in saved words", () => {
    expect(
      parseSavedVocabDefinition("瞬息万变的\n**/iˈfɛmərəl/** *(adj.)* Lasting for a very short time."),
    ).toEqual({
      gloss: "瞬息万变的",
      pronunciation: "/iˈfɛmərəl/",
      partOfSpeech: "adj",
      definition: "Lasting for a very short time.",
    });
  });

  it("falls back to null gloss when first line starts with IPA", () => {
    expect(parseSavedVocabDefinition("/iˈfɛmərəl/ adj. Short-lived.")).toEqual({
      gloss: null,
      pronunciation: "/iˈfɛmərəl/",
      partOfSpeech: "adj",
      definition: "Short-lived.",
    });
  });
});
