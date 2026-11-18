/** @vitest-environment jsdom */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../i18n";
import ReaderBottomPills from "./ReaderBottomPills";

describe("ReaderBottomPills", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    document.documentElement.classList.add("dawn");
    await i18n.changeLanguage("en");
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    document.documentElement.classList.remove("dawn");
  });

  it("renders adaptive EPUB pill without non-shrinking overflow traps and fires prev/next/jump-back", async () => {
    const onGoBack = vi.fn();
    const onPrev = vi.fn();
    const onNext = vi.fn();

    await act(async () => {
      root.render(
        <div className="@container/paper w-[344px]">
          <ReaderBottomPills
            bookFormat="epub"
            isDarkPaper={false}
            canGoBack={true}
            jumpBackPage={14}
            onGoBack={onGoBack}
            progress={45}
            progressPillLabel="Chapter 12 of 24"
            timeLeftLabel="~12 min left"
            zoom="fit"
            fitPercent={100}
            onZoom={vi.fn()}
            onResetPdfZoom={vi.fn()}
            onPrev={onPrev}
            onNext={onNext}
          />
        </div>,
      );
    });

    const prevBtn = container.querySelector<HTMLButtonElement>('button[aria-label="Previous page"]');
    const nextBtn = container.querySelector<HTMLButtonElement>('button[aria-label="Next page"]');
    const backBtn = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Back to p. 14"),
    );

    expect(prevBtn).not.toBeNull();
    expect(nextBtn).not.toBeNull();
    expect(backBtn).toBeDefined();

    // Label can truncate inside narrow Paper rather than pushing Next off-screen
    const labelEl = Array.from(container.querySelectorAll("span")).find(
      (el) => el.textContent === "Chapter 12 of 24",
    );
    expect(labelEl?.className).toContain("min-w-0");
    expect(labelEl?.className).toContain("truncate");

    // Pill allows shrinking cleanly to Paper width and stacks jump-back above below 700px
    const pillContainer = nextBtn!.parentElement!;
    expect(pillContainer.className).toContain("max-w-full");
    expect(pillContainer.className).not.toContain("shrink-0");
    expect(pillContainer.parentElement!.className).toContain("flex-col");
    expect(pillContainer.parentElement!.className).toContain("@[700px]/paper:flex-row");

    await act(async () => {
      prevBtn!.click();
      nextBtn!.click();
      backBtn!.click();
    });
    expect(onPrev).toHaveBeenCalledTimes(1);
    expect(onNext).toHaveBeenCalledTimes(1);
    expect(onGoBack).toHaveBeenCalledTimes(1);
  });

  it("renders PDF progress and Fit zoom controls compactly for a 224px narrow Paper pane", async () => {
    const onZoom = vi.fn();
    const onResetPdfZoom = vi.fn();

    await act(async () => {
      root.render(
        <div className="@container/paper w-[224px]">
          <ReaderBottomPills
            bookFormat="pdf"
            isDarkPaper={true}
            canGoBack={true}
            jumpBackPage={12}
            onGoBack={vi.fn()}
            progress={25}
            progressPillLabel="Pages 10–11 of 1298"
            timeLeftLabel={null}
            zoom="fit"
            fitPercent={147}
            onZoom={onZoom}
            onResetPdfZoom={onResetPdfZoom}
            onPrev={vi.fn()}
            onNext={vi.fn()}
          />
        </div>,
      );
    });

    const prevBtn = container.querySelector<HTMLButtonElement>('button[aria-label="Previous page"]');
    const nextBtn = container.querySelector<HTMLButtonElement>('button[aria-label="Next page"]');
    const zoomOut = container.querySelector<HTMLButtonElement>('button[aria-label="Decrease"]');
    const zoomIn = container.querySelector<HTMLButtonElement>('button[aria-label="Increase"]');
    const fitBtn = container.querySelector<HTMLButtonElement>('button[title="Fit to width"]');
    expect(prevBtn).not.toBeNull();
    expect(nextBtn).not.toBeNull();
    expect(zoomOut).not.toBeNull();
    expect(zoomIn).not.toBeNull();
    expect(fitBtn?.getAttribute("aria-label")).toBe("147% · Fit");
    expect(fitBtn?.textContent).toBe("147% · Fit");

    // Compact controls keep buttons reachable at 224px while hiding secondary "· Fit" suffix,
    // divider, and track via container queries below narrow thresholds
    expect(prevBtn!.className).toContain("size-[26px]");
    expect(zoomOut!.className).toContain("size-[22px]");
    const fitSuffix = fitBtn?.querySelector("span");
    expect(fitSuffix?.className).toContain("hidden");
    expect(fitSuffix?.className).toContain("@[280px]/paper:inline");

    const trackEl = Array.from(container.querySelectorAll("div")).find((el) =>
      el.className.includes("w-[110px]"),
    );
    expect(trackEl?.className).toContain("hidden");
    expect(trackEl?.className).toContain("@[600px]/paper:block");

    await act(async () => {
      zoomOut!.click();
      zoomIn!.click();
      fitBtn!.click();
    });
    expect(onZoom).toHaveBeenNthCalledWith(1, -10);
    expect(onZoom).toHaveBeenNthCalledWith(2, 10);
    expect(onResetPdfZoom).toHaveBeenCalledTimes(1);
  });
});
