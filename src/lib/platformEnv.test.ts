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

  it("omits custom scrollbars in foliate-js shadow renderers on macOS and emits inset 4px thumbs on Windows", async () => {
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

    setUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36");
    for (const tag of ["foliate-paginator", "foliate-pdf-scroll", "foliate-fxl"]) {
      const css = readShadowCss(tag);
      expect(css).not.toContain("::-webkit-scrollbar");
    }

    setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36");
    for (const tag of ["foliate-paginator", "foliate-pdf-scroll", "foliate-fxl"]) {
      const css = readShadowCss(tag);
      expect(css).toContain("::-webkit-scrollbar");
      expect(css).toContain("width: 8px");
      expect(css).toContain("border: 2px solid transparent");
      expect(css).toContain("background-clip: content-box");
      expect(css).toContain("var(--scrollbar-thumb");
    }
  });
});
