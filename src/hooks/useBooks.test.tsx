/** @vitest-environment jsdom */

import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn<(command: string, args?: object) => Promise<unknown>>(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mocks.invoke,
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(),
}));

import { type Book, useBooks } from "./useBooks";

interface BookPageResult {
  books: Book[];
  next_cursor: string | null;
  total: number;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function book(title: string): Book {
  return {
    id: title.toLowerCase(),
    title,
    author: "Author",
    description: null,
    cover_path: null,
    file_path: `/books/${title}.epub`,
    format: "epub",
    genre: null,
    pages: null,
    status: "unread",
    progress: 0,
    current_cfi: null,
    created_at: 1,
    updated_at: 1,
    available: true,
    cover_data: null,
  };
}

function booksPage(titles: string[], nextCursor: string | null = null, total = titles.length): BookPageResult {
  return {
    books: titles.map(book),
    next_cursor: nextCursor,
    total,
  };
}

function page(title: string): BookPageResult {
  return booksPage([title]);
}

let current: ReturnType<typeof useBooks>;

function HookHarness({ filter }: { filter?: string }) {
  const books = useBooks(filter);
  useEffect(() => {
    current = books;
  }, [books]);
  return <p>{books.loading ? "loading" : books.books[0]?.title}</p>;
}

describe("useBooks refresh modes", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    mocks.invoke.mockReset();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it("shows loading until the initial page and each changed query arrive", async () => {
    const initialPage = deferred<BookPageResult>();
    const filteredPage = deferred<BookPageResult>();
    mocks.invoke
      .mockReturnValueOnce(initialPage.promise)
      .mockReturnValueOnce(filteredPage.promise);

    act(() => root.render(<HookHarness />));
    expect(container.textContent).toBe("loading");

    await act(async () => {
      initialPage.resolve(page("First"));
      await initialPage.promise;
    });
    expect(container.textContent).toBe("First");

    act(() => root.render(<HookHarness filter="finished" />));
    expect(container.textContent).toBe("loading");

    await act(async () => {
      filteredPage.resolve(page("Finished"));
      await filteredPage.promise;
    });
    expect(container.textContent).toBe("Finished");
  });

  it("keeps the current page visible during a silent refresh", async () => {
    mocks.invoke.mockResolvedValueOnce(page("First"));
    await act(async () => root.render(<HookHarness />));

    const updatedPage = deferred<BookPageResult>();
    mocks.invoke.mockReturnValueOnce(updatedPage.promise);
    let refreshPromise!: Promise<void>;

    act(() => {
      refreshPromise = current.refreshSilently();
    });
    expect(current.loading).toBe(false);
    expect(container.textContent).toBe("First");

    await act(async () => {
      updatedPage.resolve(page("Updated"));
      await refreshPromise;
    });
    expect(container.textContent).toBe("Updated");
  });

  it("keeps every loaded page during a silent refresh", async () => {
    const firstTitles = Array.from({ length: 20 }, (_, index) => `Book ${index + 1}`);
    const secondTitles = Array.from({ length: 20 }, (_, index) => `Book ${index + 21}`);
    const allTitles = [...firstTitles, ...secondTitles];
    mocks.invoke.mockResolvedValueOnce(booksPage(firstTitles, "cursor-20", 40));

    await act(async () => root.render(<HookHarness />));
    expect(current.books).toHaveLength(20);

    mocks.invoke.mockResolvedValueOnce(booksPage(secondTitles, null, 40));
    await act(async () => {
      await current.loadMore();
    });
    expect(current.books.map((loadedBook) => loadedBook.title)).toEqual(allTitles);

    mocks.invoke.mockResolvedValueOnce(booksPage(allTitles, null, 40));
    await act(async () => {
      await current.refreshSilently();
    });

    expect(mocks.invoke).toHaveBeenLastCalledWith("list_books", {
      filter: null,
      search: null,
      collectionId: null,
      cursor: null,
      limit: 40,
    });
    expect(current.books.map((loadedBook) => loadedBook.title)).toEqual(allTitles);
  });
});
