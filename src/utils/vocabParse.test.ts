import { describe, expect, it } from "vitest";
import { parseDefinition } from "./vocabParse";

describe("vocabParse", () => {
  it("extracts IPA and part of speech from definition header", () => {
    const parsed = parseDefinition(
      "/ˈpɑːndərəs/ adjective. Slow, heavy, and laborious in movement or manner.",
    );
    expect(parsed.pronunciation).toBe("/ˈpɑːndərəs/");
    expect(parsed.partOfSpeech).toBe("adjective");
    expect(parsed.definition).toBe("Slow, heavy, and laborious in movement or manner.");
  });

  it("handles definitions without IPA or part of speech and preserves trailing paragraphs", () => {
    const parsed = parseDefinition("First sense.\n\nSecond note.");
    expect(parsed.pronunciation).toBeNull();
    expect(parsed.partOfSpeech).toBeNull();
    expect(parsed.definition).toBe("First sense.\n\nSecond note.");
  });
});
