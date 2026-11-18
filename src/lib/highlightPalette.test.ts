/** @vitest-environment jsdom */

import { describe, expect, it } from "vitest";
// @ts-expect-error -- foliate-js has no TS declarations
import { Overlayer } from "../../public/foliate-js/overlayer.js";
import type { ReaderTheme } from "../components/ReaderSettings";
import {
  createAnnotationDrawCallback,
  DARK_HIGHLIGHT_COLOR_MAP,
  LIGHT_HIGHLIGHT_COLOR_MAP,
} from "./highlightPalette";

describe("highlight palette annotation drawing", () => {
  const sampleRange = {
    getClientRects: () => [{ left: 10, top: 20, width: 80, height: 18 }],
  } as unknown as Range;

  it("updates an existing annotation when switching Original -> Dark -> Original via Overlayer.redraw()", () => {
    let activeTheme: ReaderTheme = "original";
    const overlayer = new Overlayer();
    overlayer.add("cfi-1", sampleRange, createAnnotationDrawCallback("purple", () => activeTheme, false));

    const getGroup = () => overlayer.element.querySelector("g")!;
    expect(getGroup().getAttribute("fill")).toBe(LIGHT_HIGHLIGHT_COLOR_MAP.purple);
    expect(getGroup().getAttribute("opacity")).toBe("0.9");
    expect(getGroup().style.mixBlendMode).toBe("multiply");

    activeTheme = "dark";
    overlayer.redraw();
    expect(getGroup().getAttribute("fill")).toBe(DARK_HIGHLIGHT_COLOR_MAP.purple);
    expect(getGroup().getAttribute("opacity")).toBe("0.38");
    expect(getGroup().style.mixBlendMode).toBe("normal");

    activeTheme = "original";
    overlayer.redraw();
    expect(getGroup().getAttribute("fill")).toBe(LIGHT_HIGHLIGHT_COLOR_MAP.purple);
    expect(getGroup().getAttribute("opacity")).toBe("0.9");
    expect(getGroup().style.mixBlendMode).toBe("multiply");
  });

  it("keeps PDF highlights on the light multiply palette across theme switches", () => {
    let activeTheme: ReaderTheme = "original";
    const overlayer = new Overlayer();
    overlayer.add("cfi-pdf", sampleRange, createAnnotationDrawCallback("yellow", () => activeTheme, true));

    activeTheme = "dark";
    overlayer.redraw();
    const g = overlayer.element.querySelector("g")!;
    expect(g.getAttribute("fill")).toBe(LIGHT_HIGHLIGHT_COLOR_MAP.yellow);
    expect(g.getAttribute("opacity")).toBe("0.7");
    expect(g.style.mixBlendMode).toBe("multiply");
  });
});
