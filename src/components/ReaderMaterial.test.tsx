// @vitest-environment jsdom
import fs from "node:fs";
import path from "node:path";
import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReaderSettingsState } from "./ReaderSettings";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: "en", changeLanguage: vi.fn() },
  }),
  initReactI18next: { type: "3rdParty", init: vi.fn() },
}));

vi.mock("../platform", () => ({
  invoke: vi.fn(async (cmd: string) => {
    if (cmd === "get_all_settings") return { translation_target_language: "zh" };
    if (cmd === "list_chats" || cmd === "list_vocabulary") return [];
    return null;
  }),
  listen: vi.fn(async () => () => {}),
  listenCurrentWindow: vi.fn(async () => () => {}),
  emit: vi.fn(async () => {}),
  emitTo: vi.fn(async () => {}),
  focusWindow: vi.fn(async () => {}),
  closeCurrentWindow: vi.fn(async () => {}),
  convertFileSrc: (p: string) => p,
}));

import ReaderBottomPills from "./ReaderBottomPills";
import ReaderSettings from "./ReaderSettings";
import HighlightToolbar from "./HighlightToolbar";
import ReaderCloudState from "./ReaderCloudState";
import ReaderContextMenu from "./ReaderContextMenu";
import LookupPopover from "./LookupPopover";
import ExplainPopover from "./ExplainPopover";
import TranslationPopover from "./TranslationPopover";

function extractCssRuleBlock(css: string, selector: string): string {
  const start = css.indexOf(`${selector} {`);
  if (start === -1) return "";
  let depth = 0;
  for (let i = start; i < css.length; i += 1) {
    if (css[i] === "{") depth += 1;
    if (css[i] === "}") {
      depth -= 1;
      if (depth === 0) return css.slice(start, i + 1);
    }
  }
  return "";
}

function installReaderMaterialStyles(): () => void {
  const raw = fs.readFileSync(path.resolve(__dirname, "../index.css"), "utf8");
  const blocks = [
    extractCssRuleBlock(raw, "@theme").replace(/^@theme\s*\{/, ":root {"),
    extractCssRuleBlock(raw, ".dawn"),
    extractCssRuleBlock(raw, ".dawn.dark"),
    extractCssRuleBlock(raw, ".dark"),
    extractCssRuleBlock(raw, '[data-reader-theme="paper"]'),
    extractCssRuleBlock(raw, '[data-reader-theme="quiet"]'),
    extractCssRuleBlock(raw, ".reader-island"),
    extractCssRuleBlock(raw, ".reader-popover"),
    extractCssRuleBlock(raw, ".reader-pill"),
    extractCssRuleBlock(raw, ".reader-pill-accent"),
  ].filter(Boolean);

  const styleEl = document.createElement("style");
  styleEl.textContent = blocks.join("\n");
  document.head.appendChild(styleEl);
  return () => styleEl.remove();
}

function applyReaderTheme(theme: "original" | "paper" | "quiet" | "dark"): void {
  document.documentElement.classList.add("dawn");
  document.documentElement.dataset.readerTheme = theme;
  document.documentElement.classList.toggle("dark", theme === "dark");
}

const DEFAULT_SETTINGS: ReaderSettingsState = {
  theme: "original",
  font: "literata",
  fontSize: 18,
  brightness: 100,
  readingMode: "paginated",
  pageColumns: 1,
  lineSpacing: 1.6,
  charSpacing: 0,
  wordSpacing: 0,
  margins: 64,
};

describe("Reader page-theme materials", () => {
  let container: HTMLDivElement;
  let root: Root;
  let cleanupStyles: (() => void) | null = null;

  beforeEach(() => {
    (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
    Element.prototype.scrollIntoView = vi.fn();
    cleanupStyles = installReaderMaterialStyles();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    cleanupStyles?.();
    cleanupStyles = null;
    document.documentElement.classList.remove("dawn", "dark");
    delete document.documentElement.dataset.readerTheme;
  });

  it("resolves Dawn glass, Sepia (#F7F0E1/#E4D8BE), Gray (#EDEDF0/#D4D4DA), and Nocturne (Ember) dark CSS tokens per theme", () => {
    applyReaderTheme("original");
    const originalStyle = getComputedStyle(document.documentElement);
    expect(originalStyle.getPropertyValue("--color-reader-island").trim()).toBe("var(--color-surface-glass)");
    expect(originalStyle.getPropertyValue("--color-surface-glass").trim()).toBe("rgba(255, 255, 255, 0.72)");
    expect(originalStyle.getPropertyValue("--color-reader-pill-accent").trim()).toContain("--color-reader-pill");
    expect(originalStyle.getPropertyValue("--color-surface-tint").trim()).toBe("#f3f0ff");
    expect(originalStyle.getPropertyValue("--color-accent").trim()).toBe("#6f63d2");
    expect(originalStyle.getPropertyValue("--color-accent-fg").trim()).toBe("#6f63d2");

    applyReaderTheme("paper");
    const paperStyle = getComputedStyle(document.documentElement);
    expect(paperStyle.getPropertyValue("--color-reader-island-sepia").trim()).toBe("#f7f0e1");
    expect(paperStyle.getPropertyValue("--color-reader-island-sepia-border").trim()).toBe("#e4d8be");
    expect(paperStyle.getPropertyValue("--color-reader-island").trim()).toBe("var(--color-reader-island-sepia)");
    expect(paperStyle.getPropertyValue("--color-reader-popover").trim()).toBe("var(--color-reader-island-sepia)");
    expect(paperStyle.getPropertyValue("--color-reader-pill").trim()).toBe("var(--color-reader-island-sepia)");
    expect(paperStyle.getPropertyValue("--color-reader-pill-accent").trim()).toContain("--color-reader-pill");
    expect(paperStyle.getPropertyValue("--color-surface-tint").trim()).toBe("rgba(111, 99, 210, 0.08)");

    applyReaderTheme("quiet");
    const quietStyle = getComputedStyle(document.documentElement);
    expect(quietStyle.getPropertyValue("--color-reader-island-gray").trim()).toBe("#ededf0");
    expect(quietStyle.getPropertyValue("--color-reader-island-gray-border").trim()).toBe("#d4d4da");
    expect(quietStyle.getPropertyValue("--color-reader-island").trim()).toBe("var(--color-reader-island-gray)");
    expect(quietStyle.getPropertyValue("--color-reader-popover").trim()).toBe("var(--color-reader-island-gray)");
    expect(quietStyle.getPropertyValue("--color-reader-pill").trim()).toBe("var(--color-reader-island-gray)");
    expect(quietStyle.getPropertyValue("--color-reader-pill-accent").trim()).toContain("--color-reader-pill");

    applyReaderTheme("dark");
    const darkStyle = getComputedStyle(document.documentElement);
    expect(darkStyle.getPropertyValue("--color-surface-glass").trim()).toBe("rgba(27, 25, 23, 0.97)");
    expect(darkStyle.getPropertyValue("--color-surface-solid").trim()).toBe("#27241f");
    expect(darkStyle.getPropertyValue("--color-reader-pill").trim()).toBe("rgba(46, 42, 38, 0.88)");
    expect(darkStyle.getPropertyValue("--color-reader-pill-border").trim()).toBe("rgba(255, 243, 227, 0.12)");
    expect(darkStyle.getPropertyValue("--color-surface-tint").trim()).toBe("rgba(161, 147, 245, 0.15)");
    expect(darkStyle.getPropertyValue("--color-accent").trim()).toBe("#6f62da");
    expect(darkStyle.getPropertyValue("--color-accent-fg").trim()).toBe("#a193f5");
  });

  it("applies shared reader-island, reader-pill, and reader-popover material classes across M6+M7 surfaces", async () => {
    const anchorRef = createRef<HTMLButtonElement>();
    applyReaderTheme("paper");

    await act(async () => {
      root.render(
        <div>
          <button ref={anchorRef} type="button">
            Aa
          </button>
          <ReaderBottomPills
            bookFormat="epub"
            isDarkPaper={false}
            canGoBack
            jumpBackPage={12}
            onGoBack={vi.fn()}
            progress={42}
            progressPillLabel="42%"
            timeLeftLabel="10m left"
            zoom={1}
            fitPercent={100}
            onZoom={vi.fn()}
            onResetPdfZoom={vi.fn()}
            onPrev={vi.fn()}
            onNext={vi.fn()}
          />
          <ReaderSettings
            open
            onClose={vi.fn()}
            anchorRef={anchorRef}
            settings={{ ...DEFAULT_SETTINGS, theme: "paper" }}
            onSettingsChange={vi.fn()}
          />
          <HighlightToolbar
            x={10}
            y={10}
            currentColor="yellow"
            onChangeColor={vi.fn()}
            onDelete={vi.fn()}
            onClose={vi.fn()}
          />
          <ReaderCloudState
            book={{
              title: "Dune",
              author: "Frank Herbert",
              cover_data: null,
              cover_path: null,
              progress: 12,
            }}
            state="downloading"
            onDownloadRetry={vi.fn()}
            onBackToLibrary={vi.fn()}
          />
          <ReaderContextMenu
            x={20}
            y={20}
            text="word"
            onClose={vi.fn()}
            onCopy={vi.fn()}
            onExplain={vi.fn()}
            onQuote={vi.fn()}
            onLookup={vi.fn()}
            onTranslate={vi.fn()}
          />
          <LookupPopover x={40} y={40} word="word" sentence="A word." bookId="b-1" onClose={vi.fn()} />
          <ExplainPopover
            x={60}
            y={60}
            text="passage"
            sentence="A passage."
            bookId="b-1"
            onClose={vi.fn()}
          />
          <TranslationPopover x={80} y={80} text="passage" bookId="b-1" onClose={vi.fn()} />
        </div>,
      );
    });

    expect(container.querySelectorAll(".reader-pill").length).toBeGreaterThanOrEqual(2);
    expect(container.querySelectorAll(".reader-pill.reader-pill-accent").length).toBe(1);
    expect(container.querySelectorAll(".reader-island").length).toBeGreaterThanOrEqual(1);
    // Aa popover + HighlightToolbar + ReaderContextMenu + Lookup + Explain + Translate
    expect(container.querySelectorAll(".reader-popover").length).toBeGreaterThanOrEqual(6);

    const pillsTsx = fs.readFileSync(path.resolve(__dirname, "./ReaderBottomPills.tsx"), "utf8");
    expect(pillsTsx).toContain("reader-pill-accent");
    expect(pillsTsx).not.toContain("#8477EE");
    expect(pillsTsx).not.toContain("#C8C0FF");
    expect(pillsTsx).not.toContain("#9B99AB");

    const indexCss = fs.readFileSync(path.resolve(__dirname, "../index.css"), "utf8");
    expect(indexCss).toMatch(/\.markdown-body a\s*\{[^}]*color:\s*var\(--color-accent-fg\)/);

    const readerTsx = fs.readFileSync(path.resolve(__dirname, "../pages/Reader.tsx"), "utf8");
    const tocTsx = fs.readFileSync(path.resolve(__dirname, "./TableOfContents.tsx"), "utf8");
    const bmTsx = fs.readFileSync(path.resolve(__dirname, "./BookmarksPanel.tsx"), "utf8");
    expect(readerTsx).toContain("reader-island");
    expect(readerTsx).not.toContain("dawn-glass");
    expect(tocTsx).toContain("reader-island");
    expect(tocTsx).not.toContain("dawn-glass");
    expect(bmTsx).toContain("reader-island");
    expect(bmTsx).not.toContain("dawn-glass");
  });
});
