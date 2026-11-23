import { describe, expect, it } from "vitest";
import { classifySelection } from "./selectionRouting";

describe("classifySelection", () => {
  it("routes single English words and strips outer quotes/trailing punctuation", () => {
    expect(classifySelection("mortified")).toEqual({
      mode: "word",
      grayZone: false,
      normalizedTerm: "mortified",
    });
    expect(classifySelection("  “mortifying.”  ")).toEqual({
      mode: "word",
      grayZone: false,
      normalizedTerm: "mortifying",
    });
    expect(classifySelection("(ephemeral),")).toEqual({
      mode: "word",
      grayZone: false,
      normalizedTerm: "ephemeral",
    });
  });

  it("marks 2-3 English words as gray-zone word and 4-5 words as gray-zone passage", () => {
    expect(classifySelection("Crystal Palace")).toEqual({
      mode: "word",
      grayZone: true,
      normalizedTerm: "Crystal Palace",
    });
    expect(classifySelection("by and large")).toEqual({
      mode: "word",
      grayZone: true,
      normalizedTerm: "by and large",
    });
    expect(classifySelection("to be or not")).toEqual({
      mode: "passage",
      grayZone: true,
      normalizedTerm: "to be or not",
    });
    expect(classifySelection("a stitch in time saves")).toEqual({
      mode: "passage",
      grayZone: true,
      normalizedTerm: "a stitch in time saves",
    });
    expect(
      classifySelection("The quick brown fox jumps over the lazy dog in winter."),
    ).toEqual({
      mode: "passage",
      grayZone: false,
      normalizedTerm: "The quick brown fox jumps over the lazy dog in winter",
    });
  });

  it("handles CJK words, 4-char idioms, short phrases, and longer passages", () => {
    expect(classifySelection("悖论")).toEqual({
      mode: "word",
      grayZone: false,
      normalizedTerm: "悖论",
    });
    expect(classifySelection("「潜移默化。」")).toEqual({
      mode: "word",
      grayZone: true,
      normalizedTerm: "潜移默化",
    });
    expect(classifySelection("潜移默化之中")).toEqual({
      mode: "word",
      grayZone: true,
      normalizedTerm: "潜移默化之中",
    });
    expect(classifySelection("不知不觉受到影响")).toEqual({
      mode: "passage",
      grayZone: true,
      normalizedTerm: "不知不觉受到影响",
    });
    expect(classifySelection("思想或性格不知不觉受到感染和影响")).toEqual({
      mode: "passage",
      grayZone: false,
      normalizedTerm: "思想或性格不知不觉受到感染和影响",
    });
  });

  it("routes internal clause/sentence punctuation to passage with gray-zone for short idioms", () => {
    expect(classifySelection("一言既出，驷马难追。")).toEqual({
      mode: "passage",
      grayZone: true,
      normalizedTerm: "一言既出，驷马难追",
    });
    expect(classifySelection("Veni, vidi, vici.")).toEqual({
      mode: "passage",
      grayZone: true,
      normalizedTerm: "Veni, vidi, vici",
    });
    expect(classifySelection("She paused, looked back, and walked out the door.")).toEqual({
      mode: "passage",
      grayZone: false,
      normalizedTerm: "She paused, looked back, and walked out the door",
    });
  });

  it("always routes multi-line selections to passage with grayZone false", () => {
    expect(classifySelection("First line\nSecond line")).toEqual({
      mode: "passage",
      grayZone: false,
      normalizedTerm: "First line\nSecond line",
    });
    expect(classifySelection("潜移\n默化")).toEqual({
      mode: "passage",
      grayZone: false,
      normalizedTerm: "潜移\n默化",
    });
  });

  it("does not strip mismatched outer quotes across separate quoted spans", () => {
    const result = classifySelection('"alpha" and "beta"');
    expect(result.normalizedTerm).toBe('"alpha" and "beta"');
    expect(result.mode).toBe("word");
    expect(result.grayZone).toBe(true);
  });
});
