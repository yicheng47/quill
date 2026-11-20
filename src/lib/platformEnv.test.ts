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

  it("scopes custom ::-webkit-scrollbar rules in index.css to non-macOS with an inset thumb", () => {
    const css = fs.readFileSync(path.resolve(process.cwd(), "src/index.css"), "utf8");
    const scrollbarLines = css
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.includes("::-webkit-scrollbar") && !line.startsWith("/*"));

    expect(scrollbarLines.length).toBeGreaterThan(0);
    for (const line of scrollbarLines) {
      if (line.startsWith(".scrollbar-none::-webkit-scrollbar")) continue;
      expect(line).toContain(":not(.platform-mac)");
    }
    expect(css).toContain("background-clip: content-box;");
    expect(css).toContain("--scrollbar-thumb:");
    expect(css).toContain("--scrollbar-thumb-hover:");
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
