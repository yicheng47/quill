/** @vitest-environment jsdom */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../i18n";
import ReaderCloudState from "./ReaderCloudState";

vi.mock("../platform", () => ({
  convertFileSrc: (p: string) => `quill-file://local/${p}`,
  invoke: () => Promise.resolve(null),
}));

const baseBook = {
  title: "The Martian",
  author: "Andy Weir",
  cover_data: null,
  cover_path: null,
  progress: 0,
};

describe("ReaderCloudState", () => {
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

  function findButton(label: string): HTMLButtonElement {
    const btn = Array.from(container.querySelectorAll("button")).find((el) =>
      el.textContent?.includes(label),
    );
    if (!btn) {
      throw new Error(`Button containing "${label}" not found`);
    }
    return btn;
  }

  it("renders downloading state with disabled primary CTA and library back button", async () => {
    const onDownloadRetry = vi.fn();
    const onBackToLibrary = vi.fn();

    await act(async () => {
      root.render(
        <ReaderCloudState
          book={baseBook}
          state="downloading"
          onDownloadRetry={onDownloadRetry}
          onBackToLibrary={onBackToLibrary}
        />,
      );
    });

    expect(container.textContent).toContain("In iCloud");
    expect(container.textContent).toContain("Book in iCloud");
    expect(container.textContent).toContain(
      "This book's file lives in iCloud and needs to be downloaded before reading.",
    );
    expect(container.textContent).not.toMatch(/\b\d+\s*(KB|MB|GB)\b/);

    const downloadBtn = findButton("Downloading…");
    expect(downloadBtn.disabled).toBe(true);
    await act(async () => {
      downloadBtn.click();
    });
    expect(onDownloadRetry).not.toHaveBeenCalled();

    const backBtn = findButton("Back to Library");
    await act(async () => {
      backBtn.click();
    });
    expect(onBackToLibrary).toHaveBeenCalledTimes(1);
  });

  it("shows reading progress in the iCloud status pill when progress > 0", async () => {
    await act(async () => {
      root.render(
        <ReaderCloudState
          book={{ ...baseBook, progress: 42 }}
          state="downloading"
          onDownloadRetry={vi.fn()}
          onBackToLibrary={vi.fn()}
        />,
      );
    });

    expect(container.textContent).toContain("In iCloud · 42% read");
  });

  it("renders timedOut state with enabled Download Book action", async () => {
    const onDownloadRetry = vi.fn();
    const onBackToLibrary = vi.fn();

    await act(async () => {
      root.render(
        <ReaderCloudState
          book={baseBook}
          state="timedOut"
          onDownloadRetry={onDownloadRetry}
          onBackToLibrary={onBackToLibrary}
        />,
      );
    });

    expect(container.textContent).toContain("Download timed out");
    expect(container.textContent).toContain(
      "Download is taking too long. Please check your internet connection.",
    );

    const retryBtn = findButton("Download Book");
    expect(retryBtn.disabled).toBe(false);
    await act(async () => {
      retryBtn.click();
    });
    expect(onDownloadRetry).toHaveBeenCalledTimes(1);

    await act(async () => {
      findButton("Back to Library").click();
    });
    expect(onBackToLibrary).toHaveBeenCalledTimes(1);
  });

  it("renders failed state with Try Again action", async () => {
    const onDownloadRetry = vi.fn();
    const onBackToLibrary = vi.fn();

    await act(async () => {
      root.render(
        <ReaderCloudState
          book={baseBook}
          state="failed"
          onDownloadRetry={onDownloadRetry}
          onBackToLibrary={onBackToLibrary}
        />,
      );
    });

    expect(container.textContent).toContain("Couldn't open this book");
    expect(container.textContent).toContain(
      "The book file can't be read from iCloud. Check that iCloud Drive is syncing, then try again.",
    );

    const retryBtn = findButton("Try Again");
    expect(retryBtn.disabled).toBe(false);
    await act(async () => {
      retryBtn.click();
    });
    expect(onDownloadRetry).toHaveBeenCalledTimes(1);

    await act(async () => {
      findButton("Back to Library").click();
    });
    expect(onBackToLibrary).toHaveBeenCalledTimes(1);
  });
});
