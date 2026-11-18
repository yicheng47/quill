/** @vitest-environment jsdom */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../i18n";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn<(cmd: string, args?: Record<string, unknown>) => Promise<unknown>>(),
  listen: vi.fn<(event: string, cb: (e: { payload: unknown }) => void) => Promise<() => void>>(),
  focusWindow: vi.fn<(label: string) => Promise<boolean>>(),
}));

vi.mock("../platform", () => ({
  invoke: (cmd: string, args?: Record<string, unknown>) =>
    args !== undefined ? mocks.invoke(cmd, args) : mocks.invoke(cmd),
  listen: (event: string, cb: (e: { payload: unknown }) => void) => mocks.listen(event, cb),
  focusWindow: (label: string) => mocks.focusWindow(label),
  convertFileSrc: (p: string) => `quill-file://local/${p}`,
}));

vi.mock("../utils/openReaderWindow", () => ({
  openReaderWindow: vi.fn().mockResolvedValue(undefined),
}));

import MessageBubble from "./MessageBubble";
import LookupPopover from "./LookupPopover";
import ExplainPopover from "./ExplainPopover";
import TranslationPopover from "./TranslationPopover";
import ChatsView from "./ChatsView";

class MockResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

describe("AI session-expired and not-configured prompt cards across surfaces", () => {
  let container: HTMLDivElement;
  let root: Root;
  let listeners: Map<string, Array<(e: { payload: unknown }) => void>>;

  beforeEach(async () => {
    vi.stubGlobal("ResizeObserver", MockResizeObserver);
    Element.prototype.scrollIntoView = vi.fn();
    await i18n.changeLanguage("en");
    mocks.invoke.mockReset();
    mocks.focusWindow.mockReset().mockResolvedValue(true);
    mocks.listen.mockReset();
    listeners = new Map();
    mocks.listen.mockImplementation(async (event, cb) => {
      const list = listeners.get(event) ?? [];
      list.push(cb);
      listeners.set(event, list);
      return () => {
        const cur = listeners.get(event);
        if (!cur) return;
        const idx = cur.indexOf(cb);
        if (idx >= 0) cur.splice(idx, 1);
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

  const flush = async (ticks = 4) => {
    for (let i = 0; i < ticks; i++) {
      await act(async () => {
        await Promise.resolve();
      });
    }
  };

  function emitPrefix(prefix: string, payload: unknown) {
    for (const [event, handlers] of listeners.entries()) {
      if (event.startsWith(prefix)) {
        for (const h of [...handlers]) h({ payload });
      }
    }
  }

  it("renders reauth and not-configured cards in MessageBubble and opens AI settings on main", async () => {
    mocks.invoke.mockResolvedValue(undefined);
    const reauthMsg = { id: "m1", role: "assistant" as const, content: "AI_REAUTH_REQUIRED" };
    await act(async () => {
      root.render(<MessageBubble msg={reauthMsg} messages={[reauthMsg]} streaming={false} />);
    });

    const reauthCard = container.querySelector('[data-testid="ai-reauth-card"]');
    expect(reauthCard).not.toBeNull();
    expect(reauthCard?.textContent).toContain("Your OpenAI session has expired");
    expect(reauthCard?.textContent).not.toContain("AI_REAUTH_REQUIRED");

    const signInAgainBtn = reauthCard?.querySelector("button");
    expect(signInAgainBtn?.textContent).toContain("Sign in again");
    await act(async () => {
      signInAgainBtn?.click();
      await Promise.resolve();
    });
    expect(mocks.invoke).toHaveBeenCalledWith("open_settings_on_main", { section: "ai" });
    expect(mocks.focusWindow).toHaveBeenCalledWith("main");

    mocks.invoke.mockClear();
    mocks.focusWindow.mockClear();

    const notConfigMsg = { id: "m2", role: "assistant" as const, content: "AI_NOT_CONFIGURED" };
    await act(async () => {
      root.render(<MessageBubble msg={notConfigMsg} messages={[notConfigMsg]} streaming={false} />);
    });

    const notConfigCard = container.querySelector('[data-testid="ai-not-configured-card"]');
    expect(notConfigCard).not.toBeNull();
    expect(notConfigCard?.textContent).toContain("Set up an AI provider");
    const openSettingsBtn = notConfigCard?.querySelector("button");
    expect(openSettingsBtn?.textContent).toContain("Open AI Settings");
    await act(async () => {
      openSettingsBtn?.click();
      await Promise.resolve();
    });
    expect(mocks.invoke).toHaveBeenCalledWith("open_settings_on_main", { section: "ai" });
    expect(mocks.focusWindow).toHaveBeenCalledWith("main");
  });

  it("renders LookupPopover reauth and not-configured cards cleanly via rejection and stream", async () => {
    mocks.invoke.mockImplementation(async (cmd) => {
      if (cmd === "is_word_in_dictionary") return false;
      if (cmd === "ai_lookup") return Promise.reject(new Error("AI_REAUTH_REQUIRED"));
      return undefined;
    });

    await act(async () => {
      root.render(
        <LookupPopover x={100} y={100} word="melancholy" sentence="A melancholy evening." bookId="b1" onClose={vi.fn()} />,
      );
    });
    await flush();

    const card = container.querySelector('[data-testid="ai-reauth-card"]');
    expect(card).not.toBeNull();
    expect(container.textContent).not.toContain("AI_REAUTH_REQUIRED");

    await act(async () => {
      card?.querySelector("button")?.click();
      await Promise.resolve();
    });
    expect(mocks.invoke).toHaveBeenCalledWith("open_settings_on_main", { section: "ai" });
    expect(mocks.focusWindow).toHaveBeenCalledWith("main");

    // Streamed AI_NOT_CONFIGURED on LookupPopover
    listeners.clear();
    mocks.invoke.mockImplementation(async (cmd) => {
      if (cmd === "is_word_in_dictionary") return false;
      if (cmd === "ai_lookup") return undefined;
      return undefined;
    });

    await act(async () => {
      root.render(
        <LookupPopover x={120} y={120} word="brevity" sentence="Brevity is wit." bookId="b1" onClose={vi.fn()} />,
      );
    });
    await flush();

    await act(async () => {
      emitPrefix("ai-lookup-chunk-", { delta: "AI_NOT_CONFIGURED", done: false });
      emitPrefix("ai-lookup-chunk-", { delta: "", done: true });
    });
    expect(container.querySelector('[data-testid="ai-not-configured-card"]')).not.toBeNull();
    expect(container.textContent).not.toContain("AI_NOT_CONFIGURED");
  });

  it("renders ExplainPopover reauth (via stream) and not-configured (via rejection) cards", async () => {
    mocks.invoke.mockResolvedValue(undefined);
    await act(async () => {
      root.render(
        <ExplainPopover x={80} y={80} text="Call me Ishmael." sentence="" bookId="b1" onClose={vi.fn()} />,
      );
    });
    await flush();

    await act(async () => {
      emitPrefix("ai-lookup-chunk-", { delta: "AI_REAUTH_REQUIRED", done: false });
      emitPrefix("ai-lookup-chunk-", { delta: "", done: true });
    });

    const reauthCard = container.querySelector('[data-testid="ai-reauth-card"]');
    expect(reauthCard).not.toBeNull();
    expect(container.textContent).not.toContain("AI_REAUTH_REQUIRED");

    await act(async () => {
      reauthCard?.querySelector("button")?.click();
      await Promise.resolve();
    });
    expect(mocks.invoke).toHaveBeenCalledWith("open_settings_on_main", { section: "ai" });
    expect(mocks.focusWindow).toHaveBeenCalledWith("main");

    mocks.invoke.mockImplementation(async (cmd) => {
      if (cmd === "ai_explain") return Promise.reject(new Error("AI_NOT_CONFIGURED"));
      return undefined;
    });
    await act(async () => {
      root.render(
        <ExplainPopover x={90} y={90} text="Another line." sentence="" bookId="b1" onClose={vi.fn()} />,
      );
    });
    await flush();
    expect(container.querySelector('[data-testid="ai-not-configured-card"]')).not.toBeNull();
  });

  it("renders TranslationPopover reauth and not-configured cards and routes to settings", async () => {
    mocks.invoke.mockImplementation(async (cmd) => {
      if (cmd === "get_all_settings") return { translation_language: "zh" };
      if (cmd === "ai_translate_passage") return Promise.reject(new Error("AI_REAUTH_REQUIRED"));
      return undefined;
    });

    await act(async () => {
      root.render(
        <TranslationPopover x={60} y={60} text="Hello world" bookId="b1" onClose={vi.fn()} />,
      );
    });
    await flush();

    const reauthCard = container.querySelector('[data-testid="ai-reauth-card"]');
    expect(reauthCard).not.toBeNull();
    expect(container.textContent).not.toContain("AI_REAUTH_REQUIRED");
    await act(async () => {
      reauthCard?.querySelector("button")?.click();
      await Promise.resolve();
    });
    expect(mocks.invoke).toHaveBeenCalledWith("open_settings_on_main", { section: "ai" });
    expect(mocks.focusWindow).toHaveBeenCalledWith("main");

    // Streamed AI_NOT_CONFIGURED on TranslationPopover
    listeners.clear();
    mocks.invoke.mockImplementation(async (cmd) => {
      if (cmd === "get_all_settings") return { translation_language: "zh" };
      return undefined;
    });
    await act(async () => {
      root.render(
        <TranslationPopover x={65} y={65} text="Second passage" bookId="b1" onClose={vi.fn()} />,
      );
    });
    await flush();
    await act(async () => {
      emitPrefix("ai-translate-chunk-", { delta: "AI_NOT_CONFIGURED", done: false });
      emitPrefix("ai-translate-chunk-", { delta: "", done: true });
    });
    expect(container.querySelector('[data-testid="ai-not-configured-card"]')).not.toBeNull();
    expect(container.textContent).not.toContain("AI_NOT_CONFIGURED");
  });

  it("renders reauth and not-configured cards inside ChatsView and routes to main ai settings", async () => {
    const onOpenSettings = vi.fn();
    let mode: "reauth" | "not_configured" = "reauth";

    const chatRecord = {
      id: "c1",
      book_id: "b1",
      book_title: "Frankenstein",
      title: "Theme discussion",
      model: "gpt-5.6-sol",
      pinned: false,
      metadata: null,
      created_at: 1000,
      updated_at: 2000,
      message_count: 1,
      last_message_preview: null,
    };

    mocks.invoke.mockImplementation(async (cmd) => {
      switch (cmd) {
        case "list_all_chats":
          return {
            chats: [chatRecord],
            next_cursor: null,
            total: 1,
          };
        case "get_chat_counts":
          return { total: 1, by_book: [{ book_id: "b1", book_title: "Frankenstein", count: 1 }] };
        case "get_chat":
          return chatRecord;
        case "list_chats":
          return [chatRecord];
        case "list_chat_messages":
          return [{ id: "m1", chat_id: "c1", role: "user", content: "Explain", context: null, metadata: null, created_at: 1, updated_at: 1 }];
        case "save_chat_message":
          return { id: "m2", chat_id: "c1", role: "user", content: "Follow up", context: null, metadata: null, created_at: 2, updated_at: 2 };
        case "ai_chat":
          return Promise.reject(
            new Error(mode === "reauth" ? "AI_REAUTH_REQUIRED" : "AI_NOT_CONFIGURED"),
          );
        default:
          return undefined;
      }
    });

    await act(async () => {
      root.render(
        <ChatsView
          booksById={
            new Map([
              [
                "b1",
                {
                  id: "b1",
                  title: "Frankenstein",
                  author: "Mary Shelley",
                  description: null,
                  cover_path: null,
                  file_path: "/tmp/b1.epub",
                  format: "epub",
                  genre: null,
                  pages: 200,
                  status: "reading",
                  progress: 40,
                  current_cfi: "epubcfi(/6/4!/4/2/1:0)",
                  created_at: 1000,
                  updated_at: 5000,
                  available: true,
                  cover_data: null,
                },
              ],
            ])
          }
          initialChatId="c1"
          initialBookId="b1"
          navigationSeq={1}
          onOpenSettings={onOpenSettings}
          onNavigateToLibrary={vi.fn()}
        />,
      );
    });
    await flush(6);

    const textarea = container.querySelector<HTMLTextAreaElement>(
      'textarea[placeholder="Continue the conversation…"]',
    )!;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
    await act(async () => {
      setter?.call(textarea, "Follow up");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const sendBtn = container.querySelector<HTMLButtonElement>('button[aria-label="Send message"]')!;
    await act(async () => {
      sendBtn.click();
    });
    await flush(6);

    const reauthCard = container.querySelector('[data-testid="ai-reauth-card"]');
    expect(reauthCard).not.toBeNull();
    await act(async () => {
      reauthCard?.querySelector("button")?.click();
    });
    expect(onOpenSettings).toHaveBeenCalledWith("ai");

    mode = "not_configured";
    await act(async () => {
      setter?.call(textarea, "Second follow up");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      sendBtn.click();
    });
    await flush(6);

    const notConfigCard = container.querySelector('[data-testid="ai-not-configured-card"]');
    expect(notConfigCard).not.toBeNull();
    await act(async () => {
      notConfigCard?.querySelector("button")?.click();
    });
    expect(onOpenSettings).toHaveBeenLastCalledWith("ai");
  });
});
