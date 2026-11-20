// @vitest-environment jsdom
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyPlatformClass, isMacOS, isWindows } from "./platformEnv";

const originalUserAgent = navigator.userAgent;

function setUserAgent(ua: string) {
  Object.defineProperty(window.navigator, "userAgent", {
    configurable: true,
    value: ua,
  });
}

describe("platformEnv", () => {
  afterEach(() => {
    setUserAgent(originalUserAgent);
    document.documentElement.classList.remove("platform-mac");
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("toggles platform-mac on documentElement based on userAgent", () => {
    setUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36");
    expect(isMacOS()).toBe(true);
    expect(isWindows()).toBe(false);
    applyPlatformClass();
    expect(document.documentElement.classList.contains("platform-mac")).toBe(true);

    setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36");
    expect(isMacOS()).toBe(false);
    expect(isWindows()).toBe(true);
    applyPlatformClass();
    expect(document.documentElement.classList.contains("platform-mac")).toBe(false);
  });

  it("applies all-platform transparent-track fading ::-webkit-scrollbar rules in index.css with readable Dawn contrast", () => {
    const css = fs.readFileSync(path.resolve(process.cwd(), "src/index.css"), "utf8");
    const scrollbarLines = css
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.includes("::-webkit-scrollbar") && !line.startsWith("/*"));

    expect(scrollbarLines.length).toBeGreaterThan(0);
    for (const line of scrollbarLines) {
      expect(line).not.toContain(":not(.platform-mac)");
      expect(line).not.toContain(".platform-mac");
    }
    expect(css).toMatch(/::-webkit-scrollbar\s*\{\s*width:\s*8px;\s*height:\s*8px;\s*\}/);
    expect(css).toContain("::-webkit-scrollbar-track");
    expect(css).toContain("::-webkit-scrollbar-corner");
    expect(css).toMatch(/::-webkit-scrollbar-thumb\s*\{\s*background-color:\s*transparent;/);
    expect(css).toContain("border: 2px solid transparent;");
    expect(css).toContain("background-clip: content-box;");
    expect(css).toContain("border-radius: 9999px;");
    expect(css).toMatch(/\[data-scrollbar-active\]::-webkit-scrollbar-thumb\s*\{\s*background-color:\s*var\(--scrollbar-thumb/);
    expect(css).toContain("[data-scrollbar-active]::-webkit-scrollbar-thumb:hover");
    expect(css).toContain("[data-scrollbar-active]::-webkit-scrollbar-thumb:active");
    for (const line of scrollbarLines) {
      if (line.includes("::-webkit-scrollbar-thumb:hover") || line.includes("::-webkit-scrollbar-thumb:active")) {
        expect(line).toMatch(/^\[data-scrollbar-active\]::-webkit-scrollbar-thumb:(?:hover|active)/);
      }
    }
    expect(css).toContain(".scrollbar-none::-webkit-scrollbar");

    const parseRgba = (token: string): [number, number, number, number] => {
      const m = token.match(/rgba\(\s*(\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\s*\)/);
      expect(m).not.toBeNull();
      return [Number(m![1]), Number(m![2]), Number(m![3]), Number(m![4])];
    };
    const over = (
      [r, g, b, a]: [number, number, number, number],
      [br, bg, bb]: [number, number, number],
    ): [number, number, number] => [
      Math.round(r * a + br * (1 - a)),
      Math.round(g * a + bg * (1 - a)),
      Math.round(b * a + bb * (1 - a)),
    ];
    const luminance = ([r, g, b]: [number, number, number]) => {
      const lin = (c: number) => {
        const v = c / 255;
        return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
    };
    const contrast = (a: [number, number, number], b: [number, number, number]) => {
      const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
      return (hi + 0.05) / (lo + 0.05);
    };

    const lightBlock = css.match(/\.dawn\s*\{[\s\S]*?\n\}/)?.[0] ?? "";
    const darkBlock = css.match(/\.dawn\.dark\s*\{[\s\S]*?\n\}/)?.[0] ?? "";
    const lightThumb = parseRgba(lightBlock.match(/--scrollbar-thumb:\s*([^;]+);/)?.[1] ?? "");
    const lightHover = parseRgba(lightBlock.match(/--scrollbar-thumb-hover:\s*([^;]+);/)?.[1] ?? "");
    const darkThumb = parseRgba(darkBlock.match(/--scrollbar-thumb:\s*([^;]+);/)?.[1] ?? "");
    const darkHover = parseRgba(darkBlock.match(/--scrollbar-thumb-hover:\s*([^;]+);/)?.[1] ?? "");

    for (const bg of [
      [238, 235, 248] as [number, number, number], // light canvas start
      [250, 249, 253] as [number, number, number], // dawn-glass over canvas
      [255, 255, 255] as [number, number, number], // surface-solid
    ]) {
      expect(contrast(over(lightThumb, bg), bg)).toBeGreaterThan(1.5);
      expect(contrast(over(lightHover, bg), bg)).toBeGreaterThan(2.2);
    }
    for (const bg of [
      [13, 12, 11] as [number, number, number], // dark canvas start
      [18, 17, 15] as [number, number, number], // surface-inset
      [27, 25, 23] as [number, number, number], // dawn-glass
      [39, 36, 31] as [number, number, number], // surface-solid
    ]) {
      expect(contrast(over(darkThumb, bg), bg)).toBeGreaterThan(1.5);
      expect(contrast(over(darkHover, bg), bg)).toBeGreaterThan(2.2);
    }
  });

  it("gives foliate-js shadow renderers a fading inset thumb on a transparent track on every platform", async () => {
    const capturedRoots = new WeakMap<Element, ShadowRoot>();
    const originalAttachShadow = HTMLElement.prototype.attachShadow;
    vi.spyOn(HTMLElement.prototype, "attachShadow").mockImplementation(function (
      this: HTMLElement,
      init: ShadowRootInit,
    ) {
      const shadow = originalAttachShadow.call(this, init);
      capturedRoots.set(this, shadow);
      return shadow;
    });

    const sheetText = new WeakMap<object, string>();
    class FakeCSSStyleSheet {
      replaceSync(text: string) {
        sheetText.set(this, text);
      }
    }
    vi.stubGlobal("CSSStyleSheet", FakeCSSStyleSheet);
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({
        matches: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    );

    // @ts-expect-error untyped vendored JS submodule modules
    await import("../../public/foliate-js/paginator.js");
    // @ts-expect-error untyped vendored JS submodule modules
    await import("../../public/foliate-js/pdf-scroll.js");
    // @ts-expect-error untyped vendored JS submodule modules
    await import("../../public/foliate-js/fixed-layout.js");

    const readShadowCss = (tag: string): string => {
      const el = document.createElement(tag);
      const shadow = capturedRoots.get(el);
      expect(shadow).toBeDefined();
      const inlineCss = shadow!.querySelector("style")?.textContent ?? "";
      const adoptedCss = ((shadow as unknown as { adoptedStyleSheets?: object[] }).adoptedStyleSheets ?? [])
        .map((sheet) => sheetText.get(sheet) ?? "")
        .join("\n");
      return `${inlineCss}\n${adoptedCss}`;
    };

    for (const ua of [
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    ]) {
      setUserAgent(ua);
      for (const tag of ["foliate-paginator", "foliate-pdf-scroll", "foliate-fxl"]) {
        const css = readShadowCss(tag);
        expect(css).toContain("::-webkit-scrollbar { width: 8px; height: 8px; }");
        expect(css).toContain("::-webkit-scrollbar-track");
        expect(css).toMatch(/::-webkit-scrollbar-thumb \{\s*background-color: transparent;/);
        expect(css).toContain("border: 2px solid transparent");
        expect(css).toContain("background-clip: content-box");
        expect(css).toMatch(/\[scrolling\]\)?::-webkit-scrollbar-thumb \{\s*background-color: var\(--scrollbar-thumb/);
      }
    }

    vi.useFakeTimers();
    try {
      const pdf = document.createElement("foliate-pdf-scroll");
      pdf.dispatchEvent(new Event("scroll"));
      expect(pdf.hasAttribute("scrolling")).toBe(true);
      vi.advanceTimersByTime(999);
      pdf.dispatchEvent(new Event("scroll"));
      vi.advanceTimersByTime(999);
      expect(pdf.hasAttribute("scrolling")).toBe(true);
      vi.advanceTimersByTime(1);
      expect(pdf.hasAttribute("scrolling")).toBe(false);

      const fxl = document.createElement("foliate-fxl");
      Object.defineProperty(fxl, "clientWidth", { value: 100 });
      Object.defineProperty(fxl, "clientHeight", { value: 100 });
      const move = (clientX: number) => fxl.dispatchEvent(new MouseEvent("pointermove", { clientX, clientY: 10 }));
      move(50);
      expect(fxl.hasAttribute("scrolling")).toBe(false);
      move(104);
      vi.advanceTimersByTime(5000);
      expect(fxl.hasAttribute("scrolling")).toBe(true);
      move(50);
      vi.advanceTimersByTime(999);
      expect(fxl.hasAttribute("scrolling")).toBe(true);
      vi.advanceTimersByTime(1);
      expect(fxl.hasAttribute("scrolling")).toBe(false);

      move(104);
      expect(fxl.hasAttribute("scrolling")).toBe(true);
      const content = document.createElement("div");
      capturedRoots.get(fxl)!.append(content);
      content.dispatchEvent(new MouseEvent("pointerover", { bubbles: true }));
      vi.advanceTimersByTime(1000);
      expect(fxl.hasAttribute("scrolling")).toBe(false);

      const paginator = document.createElement("foliate-paginator");
      const container = capturedRoots.get(paginator)!.getElementById("container")!;
      container.dispatchEvent(new Event("scroll"));
      expect(container.hasAttribute("scrolling")).toBe(true);
      vi.advanceTimersByTime(1000);
      expect(container.hasAttribute("scrolling")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
