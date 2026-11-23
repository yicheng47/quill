import { describe, expect, it } from "vitest";
import { getVocabGroupKey, getVocabSortKey, matchesVocabSearch } from "./pinyin";

describe("pinyin vocab grouping, sorting, and search", () => {
  it("maps English, Simplified/Traditional Chinese, accented Latin, and symbols to A-Z/# groups", () => {
    expect(getVocabGroupKey("mortify")).toBe("M");
    expect(getVocabGroupKey("Élan")).toBe("E");
    expect(getVocabGroupKey("潜移默化")).toBe("Q");
    expect(getVocabGroupKey("潛移默化")).toBe("Q");
    expect(getVocabGroupKey("执拗")).toBe("Z");
    expect(getVocabGroupKey("悖论")).toBe("B");
    expect(getVocabGroupKey("缄默")).toBe("J");
    // Polyphones must group by their full-phrase reading, matching sort/search
    expect(getVocabGroupKey("重庆")).toBe("C");
    expect(getVocabGroupKey("长大")).toBe("Z");
    expect(getVocabGroupKey("42")).toBe("#");
    expect(getVocabGroupKey("…")).toBe("#");
  });

  it("interleaves English and Chinese entries alphabetically by pinyin with symbols last", () => {
    const entries = ["42", "zephyr", "潜移默化", "悖论", "benign", "缄默", "alpha", "重庆", "长大"];
    const sorted = [...entries].sort((a, b) =>
      getVocabSortKey(a).localeCompare(getVocabSortKey(b)),
    );
    expect(sorted).toEqual([
      "alpha",
      "悖论",
      "benign",
      "重庆",
      "缄默",
      "潜移默化",
      "zephyr",
      "长大",
      "42",
    ]);
  });

  it("matches Chinese entries by substring, full pinyin, pinyin initials, and gloss", () => {
    expect(matchesVocabSearch("潜移默化", "默化")).toBe(true);
    expect(matchesVocabSearch("潜移默化", "qianyi")).toBe(true);
    expect(matchesVocabSearch("潜移默化", "qiányí")).toBe(true);
    expect(matchesVocabSearch("潜移默化", "qymh")).toBe(true);
    expect(matchesVocabSearch("潜移默化", "subtly", "subtly influence")).toBe(true);
    expect(
      matchesVocabSearch(
        "不分胜负",
        "evenly matched",
        null,
        "unable to determine victory or defeat (idiom); evenly matched",
      ),
    ).toBe(true);
    expect(matchesVocabSearch("潜移默化", "xyz")).toBe(false);
  });

  it("matches English entries by substring and optional gloss", () => {
    expect(matchesVocabSearch("mortify", "mort")).toBe(true);
    expect(matchesVocabSearch("mortify", "tify")).toBe(true);
    expect(matchesVocabSearch("mortify", "羞愧", "使羞愧")).toBe(true);
    expect(matchesVocabSearch("mortify", "zephyr")).toBe(false);
  });
});
