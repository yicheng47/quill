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

import { type ChatCounts, type ChatSummary, useAllChats, useChatCounts } from "./useChats";

interface ChatPageResult {
  chats: ChatSummary[];
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

function chat(id: string, updatedAt: number, pinned = false): ChatSummary {
  return {
    id,
    book_id: "book1",
    title: id,
    model: null,
    pinned,
    metadata: null,
    created_at: updatedAt,
    updated_at: updatedAt,
    book_title: "Book",
    message_count: 0,
    last_message: null,
  };
}

function page(chats: ChatSummary[], nextCursor: string | null = null, total = chats.length): ChatPageResult {
  return { chats, next_cursor: nextCursor, total };
}

let current: ReturnType<typeof useAllChats>;
let currentCounts: ReturnType<typeof useChatCounts>;

function ChatsHarness({ search, bookId }: { search?: string; bookId?: string }) {
  const result = useAllChats(search, bookId);
  useEffect(() => {
    current = result;
  }, [result]);
  return <p>{result.loading ? "loading" : result.chats.map((item) => item.id).join(",")}</p>;
}

function CountsHarness() {
  const result = useChatCounts();
  useEffect(() => {
    currentCounts = result;
  }, [result]);
  return <p>{result.counts?.total ?? "loading"}</p>;
}

describe("useAllChats", () => {
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

  it("passes search and book filters to the first page", async () => {
    mocks.invoke.mockResolvedValueOnce(page([chat("matching", 1)]));

    await act(async () => root.render(<ChatsHarness search="needle" bookId="book1" />));

    expect(mocks.invoke).toHaveBeenCalledWith("list_all_chats", {
      search: "needle",
      bookId: "book1",
      cursor: null,
      limit: null,
    });
    expect(container.textContent).toBe("matching");
  });

  it("appends the next cursor page", async () => {
    mocks.invoke.mockResolvedValueOnce(page([chat("first", 2)], "cursor-1", 2));
    await act(async () => root.render(<ChatsHarness />));

    mocks.invoke.mockResolvedValueOnce(page([chat("second", 1)], null, 2));
    await act(async () => {
      await current.loadMore();
    });

    expect(current.chats.map((item) => item.id)).toEqual(["first", "second"]);
    expect(current.hasMore).toBe(false);
    expect(mocks.invoke).toHaveBeenLastCalledWith("list_all_chats", {
      search: null,
      bookId: null,
      cursor: "cursor-1",
      limit: null,
    });
  });

  it("ignores an old load-more response after the filter changes", async () => {
    mocks.invoke.mockResolvedValueOnce(page([chat("unfiltered", 2)], "old-cursor", 2));
    await act(async () => root.render(<ChatsHarness />));

    const stalePage = deferred<ChatPageResult>();
    const filteredPage = deferred<ChatPageResult>();
    mocks.invoke
      .mockReturnValueOnce(stalePage.promise)
      .mockReturnValueOnce(filteredPage.promise);

    let loadMorePromise!: Promise<void>;
    act(() => {
      loadMorePromise = current.loadMore();
    });
    act(() => root.render(<ChatsHarness bookId="book2" />));

    await act(async () => {
      filteredPage.resolve(page([chat("filtered", 1)], null, 1));
      await filteredPage.promise;
    });
    await act(async () => {
      stalePage.resolve(page([chat("stale", 0)], null, 2));
      await loadMorePromise;
    });

    expect(current.chats.map((item) => item.id)).toEqual(["filtered"]);
    expect(current.total).toBe(1);
    expect(current.hasMore).toBe(false);
  });

  it("patches ordering and removes a loaded chat without refetching", async () => {
    mocks.invoke.mockResolvedValueOnce(page([chat("first", 2), chat("second", 1)], null, 2));
    await act(async () => root.render(<ChatsHarness />));

    act(() => current.patchChat("second", { pinned: true, title: "Renamed" }));
    expect(current.chats.map((item) => item.id)).toEqual(["second", "first"]);
    expect(current.chats[0].title).toBe("Renamed");

    act(() => current.removeLocal("second"));
    expect(current.chats.map((item) => item.id)).toEqual(["first"]);
    expect(current.total).toBe(1);
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
  });

  it("loads backend chat counts independently", async () => {
    const counts: ChatCounts = {
      total: 3,
      by_book: [{ book_id: "book1", book_title: "Book", count: 3 }],
    };
    mocks.invoke.mockResolvedValueOnce(counts);

    await act(async () => root.render(<CountsHarness />));

    expect(currentCounts.counts).toEqual(counts);
    expect(mocks.invoke).toHaveBeenCalledWith("get_chat_counts");
  });
});
