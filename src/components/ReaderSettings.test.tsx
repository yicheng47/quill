/** @vitest-environment jsdom */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../i18n";
import ReaderSettings, {
  getStoredReaderSettings,
  nearestMarginPreset,
  nudgeFontSize,
  type ReaderSettingsState,
} from "./ReaderSettings";

vi.mock("../platform", () => ({
  convertFileSrc: (p: string) => `quill-file://local/${p}`,
  invoke: () => Promise.resolve(null),
}));

const baseSettings: ReaderSettingsState = {
  theme: "original",
  font: "literata",
  fontSize: 20,
  brightness: 100,
  readingMode: "scrolling",
  pageColumns: 1,
  lineSpacing: 1.8,
  charSpacing: 0,
  wordSpacing: 0,
  margins: 60,
};

describe("reader settings helpers", () => {
  it("steps font size by two and clamps to the reader bounds", () => {
    expect(nudgeFontSize(26, 1)).toBe(28);
    expect(nudgeFontSize(26, -1)).toBe(24);
    expect(nudgeFontSize(48, 1)).toBe(48);
    expect(nudgeFontSize(12, -1)).toBe(12);
  });

  it("omits the per-book font size when the override is cleared", () => {
    const customSettings: ReaderSettingsState = {
      ...baseSettings,
      font: "georgia",
      fontSize: 26,
      pageColumns: 2,
      margins: 0,
    };
    const withoutOverride = getStoredReaderSettings(customSettings, false);

    expect(withoutOverride).not.toHaveProperty("fontSize");
    expect(withoutOverride.brightness).toBe(100);
    expect(getStoredReaderSettings(customSettings, true)).toEqual(customSettings);
    expect(customSettings.fontSize).toBe(26);
  });

  it("maps exact and custom stored margins to the nearest preset without mutating values", () => {
    expect(nearestMarginPreset(0)).toBe("narrow");
    expect(nearestMarginPreset(25)).toBe("narrow");
    expect(nearestMarginPreset(40)).toBe("normal");
    expect(nearestMarginPreset(60)).toBe("normal");
    expect(nearestMarginPreset(95)).toBe("wide");
    expect(nearestMarginPreset(120)).toBe("wide");
  });
});

describe("ReaderSettings popover variants", () => {
  let container: HTMLDivElement;
  let anchorEl: HTMLButtonElement;
  let root: Root;

  beforeEach(async () => {
    document.documentElement.classList.add("dawn");
    await i18n.changeLanguage("en");
    anchorEl = document.createElement("button");
    anchorEl.getBoundingClientRect = () =>
      ({ bottom: 48, right: 600, top: 16, left: 560, width: 40, height: 32 }) as DOMRect;
    document.body.appendChild(anchorEl);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    anchorEl.remove();
    document.documentElement.classList.remove("dawn");
  });

  function renderPopover(
    overrides: Partial<{
      open: boolean;
      bookFormat: "epub" | "pdf";
      settings: ReaderSettingsState;
      onSettingsChange: (next: ReaderSettingsState) => void;
    }> = {},
  ) {
    const onSettingsChange = overrides.onSettingsChange ?? vi.fn();
    return {
      onSettingsChange,
      render: async () => {
        await act(async () => {
          root.render(
            <ReaderSettings
              open={overrides.open ?? true}
              onClose={vi.fn()}
              anchorRef={{ current: anchorEl }}
              settings={overrides.settings ?? baseSettings}
              onSettingsChange={onSettingsChange}
              bookFormat={overrides.bookFormat}
            />,
          );
        });
      },
    };
  }

  function findButton(label: string): HTMLButtonElement {
    const btn = Array.from(container.querySelectorAll("button")).find((el) =>
      el.textContent?.includes(label),
    );
    if (!btn) {
      throw new Error(`Button containing "${label}" not found`);
    }
    return btn;
  }

  it("renders nothing when closed", async () => {
    const { render } = renderPopover({ open: false, bookFormat: "epub" });
    await render();
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  it("renders EPUB controls, updates steppers/modes/themes/fonts, and keeps custom margins untouched until clicked", async () => {
    const onSettingsChange = vi.fn();
    const { render } = renderPopover({
      bookFormat: "epub",
      settings: { ...baseSettings, margins: 25 },
      onSettingsChange,
    });
    await render();

    const dialog = container.querySelector('[role="dialog"][aria-label="Typography"]');
    expect(dialog).not.toBeNull();
    expect(container.textContent).toContain("20 px");
    expect(container.textContent).toContain("Literata");
    expect(container.textContent).toContain("Spacing & Margins");
    expect(container.textContent).toContain("Word Spacing");
    expect(container.textContent).not.toContain("Page Layout");
    expect(container.querySelector('input[aria-label="Brightness"]')).not.toBeNull();

    // Custom stored margin (25) maps visually to Narrow without firing onSettingsChange
    expect(onSettingsChange).not.toHaveBeenCalled();
    expect(findButton("Narrow").getAttribute("aria-pressed")).toBe("true");
    expect(findButton("Normal").getAttribute("aria-pressed")).toBe("false");

    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[aria-label="Increase font size"]')?.click();
    });
    expect(onSettingsChange).toHaveBeenLastCalledWith({
      ...baseSettings,
      margins: 25,
      fontSize: 22,
    });

    await act(async () => {
      findButton("Sepia").click();
    });
    expect(onSettingsChange).toHaveBeenLastCalledWith({
      ...baseSettings,
      margins: 25,
      theme: "paper",
    });

    await act(async () => {
      findButton("Paginated").click();
    });
    expect(onSettingsChange).toHaveBeenLastCalledWith({
      ...baseSettings,
      margins: 25,
      readingMode: "paginated",
    });

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('button[aria-label="Increase Word Spacing"]')
        ?.click();
    });
    expect(onSettingsChange).toHaveBeenLastCalledWith({
      ...baseSettings,
      margins: 25,
      wordSpacing: 1,
    });

    await act(async () => {
      findButton("Wide").click();
    });
    expect(onSettingsChange).toHaveBeenLastCalledWith({
      ...baseSettings,
      margins: 120,
    });

    // Open Select menu and pick Georgia
    await act(async () => {
      findButton("Literata").click();
    });
    const georgiaBtn = Array.from(document.body.querySelectorAll("button")).find((el) =>
      el.textContent?.includes("Georgia"),
    );
    expect(georgiaBtn).toBeDefined();
    await act(async () => {
      georgiaBtn?.click();
    });
    expect(onSettingsChange).toHaveBeenLastCalledWith({
      ...baseSettings,
      margins: 25,
      font: "georgia",
    });
  });

  it("renders PDF controls with Page Layout and Brightness while hiding EPUB typography", async () => {
    const onSettingsChange = vi.fn();
    const { render } = renderPopover({
      bookFormat: "pdf",
      settings: baseSettings,
      onSettingsChange,
    });
    await render();

    expect(container.querySelector('[role="dialog"][aria-label="Typography"]')).not.toBeNull();
    expect(container.querySelector('input[aria-label="Brightness"]')).not.toBeNull();
    expect(container.textContent).toContain("Reading Mode");
    expect(container.textContent).toContain("Page Layout");
    expect(container.textContent).toContain("Single Page");
    expect(container.textContent).toContain("Two Pages");

    // EPUB-only sections must be omitted in PDF mode
    expect(container.querySelector('button[aria-label="Increase font size"]')).toBeNull();
    expect(container.textContent).not.toContain("Spacing & Margins");
    expect(container.textContent).not.toContain("Line Spacing");

    await act(async () => {
      findButton("Two Pages").click();
    });
    expect(onSettingsChange).toHaveBeenLastCalledWith({
      ...baseSettings,
      pageColumns: 2,
    });

    await act(async () => {
      findButton("Dark").click();
    });
    expect(onSettingsChange).toHaveBeenLastCalledWith({
      ...baseSettings,
      theme: "dark",
    });
  });

  it("clamps EPUB and PDF popover horizontally inside narrow viewports while preserving anchor alignment when wide", async () => {
    const origWidth = window.innerWidth;
    const setViewport = (width: number, anchorRight: number) => {
      Object.defineProperty(window, "innerWidth", { value: width, configurable: true, writable: true });
      anchorEl.getBoundingClientRect = () =>
        ({ bottom: 48, right: anchorRight, top: 16, left: anchorRight - 32, width: 32, height: 32 }) as DOMRect;
    };

    try {
      // Wide viewport: aligns right edge to Typography button (1200 - 950 = 250px).
      setViewport(1200, 950);
      await renderPopover({ bookFormat: "epub" }).render();
      const wideDialog = container.querySelector<HTMLElement>('[role="dialog"][aria-label="Typography"]')!;
      expect(wideDialog.style.right).toBe("250px");
      expect(wideDialog.className).toContain("max-w-[calc(100vw-24px)]");

      // Narrow 500px viewport (700 DIP @ 140% zoom) with Windows caption group shifting anchor right to 257px:
      // EPUB (316px wide) clamps to right = 500 - 316 - 12 = 172px so left edge stays at 12px instead of -59px.
      setViewport(500, 257);
      await act(async () => {
        window.dispatchEvent(new Event("resize"));
      });
      expect(wideDialog.style.right).toBe("172px");

      // PDF (296px wide) clamps to right = 500 - 296 - 12 = 192px so left edge stays at 12px.
      await renderPopover({ bookFormat: "pdf" }).render();
      const pdfDialog = container.querySelector<HTMLElement>('[role="dialog"][aria-label="Typography"]')!;
      expect(pdfDialog.style.right).toBe("192px");
    } finally {
      Object.defineProperty(window, "innerWidth", { value: origWidth, configurable: true, writable: true });
    }
  });
});
