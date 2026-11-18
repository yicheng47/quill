/** @vitest-environment jsdom */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../i18n";
import ImportOverlays from "./ImportOverlays";

describe("ImportOverlays separated states", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
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
  });

  it("renders nothing when all import states are inactive", async () => {
    await act(async () => {
      root.render(
        <ImportOverlays
          isDragging={false}
          importing={false}
          importSlow={false}
          importError={null}
          onDismissError={vi.fn()}
        />,
      );
    });
    expect(container.textContent).toBe("");
  });

  it("renders drop overlay while dragging and suppresses progress card", async () => {
    await act(async () => {
      root.render(
        <ImportOverlays
          isDragging={true}
          importing={true}
          importingFileName="Stoner.epub"
          importSlow={true}
          importError={null}
          onDismissError={vi.fn()}
        />,
      );
    });
    const dropOverlay = container.querySelector('[data-testid="import-drop-overlay"]');
    expect(dropOverlay).not.toBeNull();
    expect(dropOverlay?.textContent).toContain("Drop books to add to Quill");
    expect(dropOverlay?.textContent).toContain("Supports EPUB and PDF files.");
    expect(dropOverlay?.textContent).toContain(".EPUB");
    expect(dropOverlay?.textContent).toContain(".PDF");
    expect(dropOverlay?.querySelector(".border-2")).not.toBeNull();
    expect(container.querySelector('[data-testid="import-progress-overlay"]')).toBeNull();
  });

  it("renders importing progress card with file name and slow PDF hint", async () => {
    await act(async () => {
      root.render(
        <ImportOverlays
          isDragging={false}
          importing={true}
          importingCount={3}
          importingFileName="Architecture.pdf"
          importSlow={true}
          importError={null}
          onDismissError={vi.fn()}
        />,
      );
    });
    const progress = container.querySelector('[data-testid="import-progress-overlay"]');
    expect(progress).not.toBeNull();
    expect(progress?.textContent).toContain("Importing 3 books");
    expect(progress?.textContent).toContain("Architecture.pdf");
    expect(progress?.textContent).toContain("large PDFs");
  });

  it("renders top-center non-blocking error toast and dismisses cleanly", async () => {
    const onDismissError = vi.fn();
    await act(async () => {
      root.render(
        <ImportOverlays
          isDragging={false}
          importing={false}
          importSlow={false}
          importError="Corrupted EPUB container"
          onDismissError={onDismissError}
        />,
      );
    });
    const toast = container.querySelector('[data-testid="import-error-toast"]');
    expect(toast).not.toBeNull();
    expect(toast?.classList.contains("no-drag")).toBe(true);
    expect(toast?.textContent).toContain("Couldn't import book");
    expect(toast?.textContent).toContain("Corrupted EPUB container");

    const dismissBtn = toast?.querySelector<HTMLButtonElement>('button[aria-label="Dismiss"]');
    await act(async () => {
      dismissBtn?.click();
    });
    expect(onDismissError).toHaveBeenCalledTimes(1);
  });
});
