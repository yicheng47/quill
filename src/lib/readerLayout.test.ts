import { describe, expect, it } from "vitest";
import {
  canShowDualIslands,
  READER_SHELL_BG_BY_THEME,
  readerShellClassForTheme,
} from "./readerLayout";

describe("readerLayout helpers", () => {
  it("disallows simultaneous Contents + right island at 700px (100% and 120% zoom) while allowing them at 1440px", () => {
    // 700px window @ 100% zoom -> 660px workspace inner width
    expect(canShowDualIslands(660, 420)).toBe(false);
    // 700px physical @ 120% zoom -> ~543px workspace inner width
    expect(canShowDualIslands(543, 420)).toBe(false);
    // Boundary: 300 (TOC) + 420 (panel) + 32 (2 gaps) + 280 (Paper) = 1032px inner
    expect(canShowDualIslands(1031, 420)).toBe(false);
    expect(canShowDualIslands(1032, 420)).toBe(true);
    // 1440px default window -> 1400px workspace inner width
    expect(canShowDualIslands(1400, 420)).toBe(true);
  });

  it("maps each page theme to its shell atmosphere class and BrowserWindow background", () => {
    expect(readerShellClassForTheme("original")).toBe("dawn-atmosphere");
    expect(readerShellClassForTheme("paper")).toBe("reader-shell-sepia");
    expect(readerShellClassForTheme("quiet")).toBe("reader-shell-quiet");
    expect(readerShellClassForTheme("dark")).toBe("dawn-atmosphere");

    expect(READER_SHELL_BG_BY_THEME).toEqual({
      original: "#EEEBF8",
      paper: "#F0E7D4",
      quiet: "#D2D2D8",
      dark: "#0D0C0B",
    });
  });
});
