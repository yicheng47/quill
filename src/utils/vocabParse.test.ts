// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import {
  detectSpeechLang,
  formatPronunciation,
  parseDefinition,
  parseSavedVocabDefinition,
  speakWord,
  splitHighlightedForms,
} from "./vocabParse";

describe("vocabParse", () => {
  it("extracts IPA and part of speech from English definition header", () => {
    const parsed = parseDefinition(
      "/ˈpɑːndərəs/ adjective. Slow, heavy, and laborious in movement or manner.",
    );
    expect(parsed.pronunciation).toBe("/ˈpɑːndərəs/");
    expect(parsed.partOfSpeech).toBe("adjective");
    expect(parsed.definition).toBe("Slow, heavy, and laborious in movement or manner.");
  });

  it("extracts pinyin and Chinese part of speech from Chinese definition header", () => {
    const parsed = parseDefinition(
      "/qián yí mò huà/ 成语. 指人的思想或性格不知不觉受到感染、影响而发生了变化。",
    );
    expect(parsed.pronunciation).toBe("/qián yí mò huà/");
    expect(parsed.partOfSpeech).toBe("成语");
    expect(parsed.definition).toBe(
      "指人的思想或性格不知不觉受到感染、影响而发生了变化。",
    );
  });

  it("splits leading gloss on Chinese saved entries", () => {
    const parsed = parseSavedVocabDefinition(
      "subtly influence over time\n/qián yí mò huà/ 成语. 指人的思想或性格不知不觉受到感染、影响而发生了变化。",
    );
    expect(parsed.gloss).toBe("subtly influence over time");
    expect(parsed.pronunciation).toBe("/qián yí mò huà/");
    expect(parsed.partOfSpeech).toBe("成语");
    expect(parsed.definition).toBe(
      "指人的思想或性格不知不觉受到感染、影响而发生了变化。",
    );
  });

  it("handles definitions without IPA or part of speech and preserves trailing paragraphs", () => {
    const parsed = parseDefinition("First sense.\n\nSecond note.");
    expect(parsed.pronunciation).toBeNull();
    expect(parsed.partOfSpeech).toBeNull();
    expect(parsed.definition).toBe("First sense.\n\nSecond note.");
  });

  it("formats pronunciation as slash-free pinyin for Chinese and /IPA/ for English", () => {
    expect(formatPronunciation("/qián yí mò huà/", "zh")).toBe("qián yí mò huà");
    expect(formatPronunciation("/qián yí mò huà/", "潜移默化")).toBe("qián yí mò huà");
    expect(formatPronunciation("qián yí mò huà")).toBe("qián yí mò huà");
    expect(formatPronunciation("ˈmɔːrtɪfaɪ", "en")).toBe("/ˈmɔːrtɪfaɪ/");
    expect(formatPronunciation("/ˈmɔːrtɪfaɪ/", "mortify")).toBe("/ˈmɔːrtɪfaɪ/");
    expect(formatPronunciation("")).toBeNull();
  });

  it("highlights lemma and all inflected forms with word boundaries for Latin and substring for CJK", () => {
    const segments = splitHighlightedForms(
      "It was a mortifying scene, and he felt mortified — never wishing to mortify anyone.",
      ["mortify", "mortified", "mortifying"],
    );
    expect(segments.filter((s) => s.highlight).map((s) => s.text)).toEqual([
      "mortifying",
      "mortified",
      "mortify",
    ]);

    const boundarySegments = splitHighlightedForms("She was going to go home.", ["go"]);
    expect(boundarySegments.filter((s) => s.highlight).map((s) => s.text)).toEqual(["go"]);

    const zhSegments = splitHighlightedForms("这种影响往往是潜移默化的。", ["潜移默化"]);
    expect(zhSegments).toEqual([
      { text: "这种影响往往是", highlight: false },
      { text: "潜移默化", highlight: true },
      { text: "的。", highlight: false },
    ]);
  });

  it("detects CJK speech languages and sets utterance.lang when speaking", () => {
    expect(detectSpeechLang("潜移默化")).toBe("zh-CN");
    expect(detectSpeechLang("食べる")).toBe("ja-JP");
    expect(detectSpeechLang("한국어")).toBe("ko-KR");
    expect(detectSpeechLang("mortify")).toBeNull();

    const spoken: Array<{ text: string; lang: string }> = [];
    class FakeUtterance {
      text: string;
      lang = "";
      voice: unknown = null;
      constructor(text: string) {
        this.text = text;
      }
    }
    vi.stubGlobal("SpeechSynthesisUtterance", FakeUtterance);
    Object.defineProperty(window, "speechSynthesis", {
      configurable: true,
      value: {
        cancel: vi.fn(),
        getVoices: () => [],
        speak: (u: FakeUtterance) => spoken.push({ text: u.text, lang: u.lang }),
      },
    });

    speakWord("潜移默化");
    speakWord("mortify");
    expect(spoken).toEqual([
      { text: "潜移默化", lang: "zh-CN" },
      { text: "mortify", lang: "" },
    ]);
    vi.unstubAllGlobals();
  });
});
