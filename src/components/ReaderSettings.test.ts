import { describe, expect, it } from "vitest";
import {
  getStoredReaderSettings,
  nudgeFontSize,
  type ReaderSettingsState,
} from "./ReaderSettings";

const settings: ReaderSettingsState = {
  theme: "original",
  font: "georgia",
  fontSize: 26,
  brightness: 100,
  readingMode: "scrolling",
  pageColumns: 2,
  lineSpacing: 1.8,
  charSpacing: 0,
  wordSpacing: 0,
  margins: 0,
};

describe("reader font size", () => {
  it("steps by two and clamps to the reader bounds", () => {
    expect(nudgeFontSize(26, 1)).toBe(28);
    expect(nudgeFontSize(26, -1)).toBe(24);
    expect(nudgeFontSize(48, 1)).toBe(48);
    expect(nudgeFontSize(12, -1)).toBe(12);
  });

  it("omits the per-book font size when the override is cleared", () => {
    const withoutOverride = getStoredReaderSettings(settings, false);

    expect(withoutOverride).not.toHaveProperty("fontSize");
    expect(withoutOverride.brightness).toBe(100);
    expect(getStoredReaderSettings(settings, true)).toEqual(settings);
    expect(settings.fontSize).toBe(26);
  });
});
