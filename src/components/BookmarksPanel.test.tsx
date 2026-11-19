/** @vitest-environment jsdom */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../i18n";
import BookmarksPanel from "./BookmarksPanel";

const mockInvoke = vi.fn();

vi.mock("../platform", () => ({
  invoke: (cmd: string, args?: unknown) => mockInvoke(cmd, args),
}));

const sampleHighlights = [
  {
    id: "hl-1",
    book_id: "book-1",
    cfi_range: "cfi-h",
    color: "purple",
    note: null,
    text_content: "We must imagine Sisyphus happy.",
    created_at: Math.floor(Date.now() / 1000) - 60,
    updated_at: Math.floor(Date.now() / 1000) - 60,
  },
];

const sampleBookmarks = [
  {
    id: "bm-1",
    book_id: "book-1",
    cfi: "cfi-b",
    label: "Chapter III",
    created_at: Math.floor(Date.now() / 1000) - 120,
    updated_at: Math.floor(Date.now() / 1000) - 120,
  },
];

describe("BookmarksPanel nested action keyboard isolation", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    document.documentElement.classList.add("dawn");
    await i18n.changeLanguage("en");
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "list_highlights") return sampleHighlights;
      if (cmd === "list_bookmarks") return sampleBookmarks;
      return null;
    });
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
    mockInvoke.mockReset();
  });

  async function renderPanel(overrides: {
    onNavigate?: (cfi: string) => void;
    onAsk?: (text: string, cfi?: string) => void;
    onRemoveHighlight?: (cfiRange: string) => void;
  } = {}) {
    await act(async () => {
      root.render(
        <BookmarksPanel
          bookId="book-1"
          bookTitle="The Myth of Sisyphus"
          onNavigate={overrides.onNavigate ?? vi.fn()}
          onAsk={overrides.onAsk ?? vi.fn()}
          onRemoveHighlight={overrides.onRemoveHighlight ?? vi.fn()}
        />,
      );
    });
    // Flush async list_highlights / list_bookmarks invocations
    await act(async () => {
      await Promise.resolve();
    });
  }

  function dispatchKey(el: Element, key: "Enter" | " "): KeyboardEvent {
    const ev = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
    el.dispatchEvent(ev);
    return ev;
  }

  it("does not intercept Enter or Space on Ask or Delete inside Highlights tab", async () => {
    const onNavigate = vi.fn();
    const onAsk = vi.fn();
    const onRemoveHighlight = vi.fn();
    await renderPanel({ onNavigate, onAsk, onRemoveHighlight });

    const askBtn = Array.from(container.querySelectorAll("button")).find((el) =>
      el.textContent?.includes("Ask"),
    );
    expect(askBtn).toBeDefined();

    for (const key of ["Enter", " "] as const) {
      const ev = dispatchKey(askBtn!, key);
      expect(ev.defaultPrevented).toBe(false);
    }
    expect(onNavigate).not.toHaveBeenCalled();

    await act(async () => {
      askBtn!.click();
    });
    expect(onAsk).toHaveBeenCalledWith("We must imagine Sisyphus happy.", "cfi-h");
    expect(onNavigate).not.toHaveBeenCalled();

    const deleteBtn = Array.from(container.querySelectorAll("button")).find((el) =>
      el.textContent?.includes("Delete"),
    );
    expect(deleteBtn).toBeDefined();
    for (const key of ["Enter", " "] as const) {
      const ev = dispatchKey(deleteBtn!, key);
      expect(ev.defaultPrevented).toBe(false);
    }
    expect(onNavigate).not.toHaveBeenCalled();

    await act(async () => {
      deleteBtn!.click();
    });
    expect(mockInvoke).toHaveBeenCalledWith("remove_highlight", { id: "hl-1" });
    expect(onRemoveHighlight).toHaveBeenCalledWith("cfi-h");
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it("still navigates when Enter or Space is pressed on the highlight card itself", async () => {
    const onNavigate = vi.fn();
    await renderPanel({ onNavigate });

    const card = container.querySelector('[role="button"]');
    expect(card).not.toBeNull();

    const enterEv = dispatchKey(card!, "Enter");
    expect(enterEv.defaultPrevented).toBe(true);
    expect(onNavigate).toHaveBeenLastCalledWith("cfi-h");

    const spaceEv = dispatchKey(card!, " ");
    expect(spaceEv.defaultPrevented).toBe(true);
    expect(onNavigate).toHaveBeenCalledTimes(2);
  });

  it("does not intercept Enter or Space on Delete inside Bookmarks tab while preserving card navigation", async () => {
    const onNavigate = vi.fn();
    await renderPanel({ onNavigate });

    const bookmarksTab = container.querySelectorAll<HTMLButtonElement>('[role="tab"]')[1];
    await act(async () => {
      bookmarksTab.click();
    });

    const card = container.querySelector('[role="button"]');
    expect(card).not.toBeNull();
    const enterEv = dispatchKey(card!, "Enter");
    expect(enterEv.defaultPrevented).toBe(true);
    expect(onNavigate).toHaveBeenLastCalledWith("cfi-b");
    onNavigate.mockClear();

    const deleteBtn = container.querySelector<HTMLButtonElement>('button[aria-label="Delete"]');
    expect(deleteBtn).not.toBeNull();

    for (const key of ["Enter", " "] as const) {
      const ev = dispatchKey(deleteBtn!, key);
      expect(ev.defaultPrevented).toBe(false);
    }
    expect(onNavigate).not.toHaveBeenCalled();

    await act(async () => {
      deleteBtn!.click();
    });
    expect(mockInvoke).toHaveBeenCalledWith("remove_bookmark", { id: "bm-1" });
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it("keeps highlight quote and note text selectable inside clickable cards and skips navigation while text is selected", async () => {
    const onNavigate = vi.fn();
    await renderPanel({ onNavigate });

    const card = container.querySelector<HTMLElement>('[role="button"]');
    expect(card).not.toBeNull();
    const quote = Array.from(card!.querySelectorAll("p")).find((p) =>
      p.textContent?.includes("We must imagine Sisyphus happy."),
    );
    expect(quote).toBeDefined();
    expect(quote!.className).toContain("select-text");

    const range = document.createRange();
    range.selectNodeContents(quote!);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);

    await act(async () => {
      card!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 }));
    });
    expect(onNavigate).not.toHaveBeenCalled();

    // Keyboard / AT-style click (detail === 0) still navigates even while a range is active.
    await act(async () => {
      card!.click();
    });
    expect(onNavigate).toHaveBeenCalledWith("cfi-h");
    onNavigate.mockClear();

    sel?.removeAllRanges();
    await act(async () => {
      card!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 }));
    });
    expect(onNavigate).toHaveBeenCalledWith("cfi-h");
  });

  it("keeps Highlights and Bookmarks scroll offsets inset 4px inside the panel's p-4 padding", async () => {
    await renderPanel();

    const panel = container.firstElementChild as HTMLElement;
    expect(panel.className).toContain("p-4");
    expect(panel.className).not.toContain("@[340px]/panel:p-5");

    const checkScrollBox = () => {
      const scrollBox = container.querySelector<HTMLElement>(".overflow-y-auto");
      expect(scrollBox).not.toBeNull();
      expect(scrollBox!.className).toContain("-mr-3");
      expect(scrollBox!.className).toContain("pr-3");
      expect(scrollBox!.className).not.toContain("-mr-4");
    };

    checkScrollBox();

    const bookmarksTab = container.querySelectorAll<HTMLButtonElement>('[role="tab"]')[1];
    await act(async () => {
      bookmarksTab.click();
    });
    checkScrollBox();
  });
});
