/** @vitest-environment jsdom */

import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn<(command: string, args?: Record<string, unknown>) => Promise<unknown>>(),
  listen: vi.fn<(event: string, handler: (event: { payload: unknown }) => void) => Promise<() => void>>(),
}));

vi.mock("../platform", () => ({
  invoke: mocks.invoke,
  listen: mocks.listen,
}));

import { useAiChat } from "./useAiChat";

let current: ReturnType<typeof useAiChat>;

function AiChatHarness() {
  const result = useAiChat("book-1", {
    title: "Frankenstein",
    author: "Mary Shelley",
    chapter: "Chapter III",
  });
  useEffect(() => {
    current = result;
  }, [result]);
  return <p>{result.messages.length}</p>;
}

describe("useAiChat", () => {
  let container: HTMLDivElement;
  let root: Root;
  let listeners: Map<string, (event: { payload: unknown }) => void>;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    mocks.invoke.mockReset();
    mocks.listen.mockReset();
    listeners = new Map();
    mocks.listen.mockImplementation(async (event, handler) => {
      listeners.set(event, handler);
      return () => {
        if (listeners.get(event) === handler) listeners.delete(event);
      };
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  function mockCommands(existingChats: Array<{ id: string; messages?: Array<{ id: string; role: string; content: string; context?: string | null }> }> = []) {
    mocks.invoke.mockImplementation(async (command, args) => {
      switch (command) {
        case "list_chats":
          return existingChats.map((c) => ({
            id: c.id,
            book_id: "book-1",
            title: "Chat",
            model: null,
            pinned: false,
            metadata: null,
            created_at: 1,
            updated_at: 1,
          }));
        case "list_chat_messages": {
          const found = existingChats.find((c) => c.id === args?.chatId);
          return (found?.messages ?? []).map((m) => ({
            id: m.id,
            chat_id: String(args?.chatId),
            role: m.role,
            content: m.content,
            context: m.context ?? null,
            metadata: null,
            created_at: 1,
            updated_at: 1,
          }));
        }
        case "create_chat":
          return {
            id: "chat-new",
            book_id: "book-1",
            title: "New chat",
            model: null,
            pinned: false,
            metadata: null,
            created_at: 2,
            updated_at: 2,
          };
        case "save_chat_message":
          return {
            id: "msg-saved",
            chat_id: String(args?.chatId),
            role: String(args?.role),
            content: String(args?.content),
            context: args?.context ?? null,
            metadata: args?.metadata ?? null,
            created_at: 2,
            updated_at: 2,
          };
        case "get_chat":
          return {
            id: String(args?.chatId),
            book_id: "book-1",
            title: "New chat",
            model: null,
            pinned: false,
            metadata: null,
            created_at: 2,
            updated_at: 2,
          };
        default:
          return undefined;
      }
    });
  }

  async function withoutActFlush(fn: () => Promise<void>) {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", false);
    try {
      await fn();
    } finally {
      vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    }
  }

  it("includes the newly sent quoted message in ai_chat before React flushes render", async () => {
    mockCommands();
    await act(async () => {
      root.render(<AiChatHarness />);
    });
    await act(async () => {
      await current.initialize();
    });

    // Simulate a real Electron UI submit: invoke/listen resolve in microtasks
    // before React flushes the scheduled state update from updateMessages.
    await withoutActFlush(() =>
      current.send(
        "Explain in five words.",
        "When I had attained the age of seventeen,",
        "epubcfi(/6/14)"
      )
    );

    const aiChatCall = mocks.invoke.mock.calls.find(([cmd]) => cmd === "ai_chat");
    expect(aiChatCall).toBeDefined();
    expect(aiChatCall?.[1]).toEqual({
      messages: [
        {
          role: "user",
          content: '[Selected passage: "When I had attained the age of seventeen,"]\n\nExplain in five words.',
        },
      ],
      bookTitle: "Frankenstein",
      bookAuthor: "Mary Shelley",
      currentChapter: "Chapter III",
    });

    await act(async () => {
      listeners.get("ai-stream-chunk")?.({ payload: { delta: "", done: true } });
    });
  });

  it("sends only the new message after reset() starts a fresh chat", async () => {
    mockCommands([
      {
        id: "chat-1",
        messages: [
          { id: "m1", role: "user", content: "Old question" },
          { id: "m2", role: "assistant", content: "Old answer" },
        ],
      },
    ]);
    await act(async () => {
      root.render(<AiChatHarness />);
    });
    await act(async () => {
      await current.initialize();
    });

    await withoutActFlush(async () => {
      await current.reset();
      await current.send("Hi.");
    });

    const aiChatCall = mocks.invoke.mock.calls.find(([cmd]) => cmd === "ai_chat");
    expect(aiChatCall).toBeDefined();
    expect(aiChatCall?.[1]).toEqual({
      messages: [{ role: "user", content: "Hi." }],
      bookTitle: "Frankenstein",
      bookAuthor: "Mary Shelley",
      currentChapter: "Chapter III",
    });

    await act(async () => {
      listeners.get("ai-stream-chunk")?.({ payload: { delta: "", done: true } });
    });
  });

  it("appends the new turn to loaded history and persists the streamed reply", async () => {
    mockCommands([
      {
        id: "chat-1",
        messages: [
          { id: "m1", role: "user", content: "First" },
          { id: "m2", role: "assistant", content: "Reply" },
        ],
      },
    ]);
    await act(async () => {
      root.render(<AiChatHarness />);
    });
    await act(async () => {
      await current.initialize();
    });

    await withoutActFlush(() => current.send("Second"));

    const aiChatCall = mocks.invoke.mock.calls.find(([cmd]) => cmd === "ai_chat");
    expect(aiChatCall?.[1]).toMatchObject({
      messages: [
        { role: "user", content: "First" },
        { role: "assistant", content: "Reply" },
        { role: "user", content: "Second" },
      ],
    });

    await act(async () => {
      listeners.get("ai-stream-chunk")?.({ payload: { delta: "Done", done: false } });
      listeners.get("ai-stream-chunk")?.({ payload: { delta: "", done: true } });
    });

    expect(mocks.invoke).toHaveBeenCalledWith("save_chat_message", {
      chatId: "chat-1",
      role: "assistant",
      content: "Done",
      context: null,
      metadata: null,
    });
  });

  it("skips ai_chat if reset() runs while saving the user message", async () => {
    let resolveSave!: (value: unknown) => void;
    mockCommands([
      {
        id: "chat-1",
        messages: [],
      },
    ]);
    const baseImpl = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation((command, args) => {
      if (command === "save_chat_message") {
        return new Promise((resolve) => {
          resolveSave = resolve;
        });
      }
      return baseImpl(command, args);
    });

    await act(async () => {
      root.render(<AiChatHarness />);
    });
    await act(async () => {
      await current.initialize();
    });

    await withoutActFlush(async () => {
      const sendPromise = current.send("Aborted");
      await current.reset();
      resolveSave({
        id: "msg-saved",
        chat_id: "chat-1",
        role: "user",
        content: "Aborted",
        context: null,
        metadata: null,
        created_at: 2,
        updated_at: 2,
      });
      await sendPromise;
    });

    expect(mocks.invoke.mock.calls.some(([cmd]) => cmd === "ai_chat")).toBe(false);
    expect(listeners.has("ai-stream-chunk")).toBe(false);
  });
});
