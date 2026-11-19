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
} from "../lib/aiConnections";
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
