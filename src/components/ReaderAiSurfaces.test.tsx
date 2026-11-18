// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Book } from "../hooks/useBooks";
import type { ChatMessage } from "../hooks/useAiChat";

type ChunkListener = (event: { payload: { delta: string; done: boolean } }) => void;

const chunkListeners = new Map<string, ChunkListener[]>();
let settingsMap: Record<string, string> = {};
let vocabRows: Array<Record<string, unknown>> = [];
let chatRows: Array<Record<string, unknown>> = [];
let chatMessagesMap = new Map<string, Array<Record<string, unknown>>>();

let onListAllChatsImpl: ((args: Record<string, unknown>) => Promise<unknown>) | null = null;
let onAiLookupImpl: ((args: Record<string, unknown>) => Promise<void>) | null = null;
let onAiExplainImpl: ((args: Record<string, unknown>) => Promise<void>) | null = null;
let onAiTranslateImpl: ((args: Record<string, unknown>) => Promise<void>) | null = null;
let onAiChatImpl: ((args: Record<string, unknown>) => Promise<void>) | null = null;

const invokeMock = vi.fn(async (cmd: string, args: Record<string, unknown> = {}) => {
  switch (cmd) {
    case "get_all_settings":
      return { ...settingsMap };
    case "ai_lookup":
      if (onAiLookupImpl) return onAiLookupImpl(args);
      return null;
    case "ai_explain":
      if (onAiExplainImpl) return onAiExplainImpl(args);
      return null;
    case "ai_translate_passage":
      if (onAiTranslateImpl) return onAiTranslateImpl(args);
      return null;
    case "ai_chat":
      if (onAiChatImpl) return onAiChatImpl(args);
      return null;
    case "check_vocab_exists":
      return null;
    case "add_vocab_word": {
      const created = {
        id: "vocab-saved-1",
        book_id: String(args.bookId),
        word: String(args.word),
        definition: String(args.definition),
        context_sentence: args.contextSentence ?? null,
        cfi: args.cfi ?? null,
        created_at: 1_700_000_000,
      };
      vocabRows = [created, ...vocabRows];
      return created;
    }
    case "list_vocab_words":
    case "list_all_vocab_words":
      return [...vocabRows];
    case "remove_vocab_word":
      vocabRows = vocabRows.filter((w) => w.id !== args.id);
      return null;
    case "list_chats":
      return [...chatRows];
    case "list_all_chats": {
      if (onListAllChatsImpl) return onListAllChatsImpl(args);
      const mapped = chatRows.map((c) => ({
        id: c.id,
        book_id: c.book_id,
        title: c.title,
        model: c.model ?? null,
        pinned: false,
        metadata: null,
        created_at: c.created_at ?? 1_700_000_000,
        updated_at: c.updated_at ?? 1_700_000_000,
        book_title: "Dune",
        message_count: (chatMessagesMap.get(String(c.id)) ?? []).length,
        last_message: null,
      }));
      if (mapped.length > 1) {
        if (!args.cursor) {
          return { chats: [mapped[0]], next_cursor: "page-2", total: mapped.length };
        }
        return { chats: mapped.slice(1), next_cursor: null, total: mapped.length };
      }
      return { chats: mapped, next_cursor: null, total: mapped.length };
    }
    case "delete_chat":
      chatRows = chatRows.filter((c) => c.id !== args.chatId);
      chatMessagesMap.delete(String(args.chatId));
      return null;
    case "get_chat_counts":
      return { total: chatRows.length, by_book: [] };
    case "get_chat": {
      const found = chatRows.find((c) => c.id === args.chatId);
      return found ?? null;
    }
    case "list_chat_messages":
      return [...(chatMessagesMap.get(String(args.chatId)) ?? [])];
    case "create_chat": {
      const created = {
        id: "chat-new",
        book_id: String(args.bookId ?? "b-1"),
        title: "",
        model: null,
        created_at: 1_700_000_010,
        updated_at: 1_700_000_010,
      };
      chatRows = [created, ...chatRows];
      chatMessagesMap.set(created.id, []);
      return created;
    }
    case "save_chat_message": {
      const chatId = String(args.chatId);
      const list = chatMessagesMap.get(chatId) ?? [];
      const row = {
        id: `msg-${list.length + 1}`,
        chat_id: chatId,
        role: String(args.role),
        content: String(args.content),
        context: args.context ?? null,
        context_cfi: args.contextCfi ?? null,
        created_at: 1_700_000_020,
      };
      chatMessagesMap.set(chatId, [...list, row]);
      return row;
    }
    case "ai_generate_title":
      return "Arrakis Strategy";
    case "open_settings_on_main":
      return null;
    default:
      return null;
  }
});

const focusWindowMock = vi.fn(async () => {});

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      if (key === "lookup.title") return "Look Up";
      if (key === "lookup.lookingUp") return "Looking up…";
      if (key === "lookup.analyzing") return "Analyzing…";
      if (key === "lookup.inContext") return "In this passage";
      if (key === "lookup.saveToDict") return "Save to Words";
      if (key === "lookup.saved") return "Saved";
      if (key === "lookup.copy") return "Copy";
      if (key === "lookup.copied") return "Copied";
      if (key === "lookup.translationLanguageNotConfigured") {
        return "Set a lookup translation language in Settings first";
      }
      if (key === "lookup.openSettings") return "Open Tools Settings";
      if (key === "explain.title") return "Explain";
      if (key === "explain.thinking") return "Explaining…";
      if (key === "explain.copy") return "Copy";
      if (key === "translation.title") return "Translate";
      if (key === "translation.translating") return "Translating…";
      if (key === "translation.showSurroundingContext") return "Show surrounding context";
      if (key === "translation.hideSurroundingContext") return "Hide surrounding context";
      if (key === "translation.showFullSelection") return "Show full selection";
      if (key === "translation.showLessSelection") return "Show less";
      if (key === "translation.languageNotConfigured") {
        return "Set a translation language in Settings first";
      }
      if (key === "translation.openSettings") return "Open Tools Settings";
      if (key === "contextMenu.lookUp") return "Look Up";
      if (key === "contextMenu.explain") return "Explain";
      if (key === "contextMenu.quote") return "Quote in Chat";
      if (key === "contextMenu.translate") return "Translate";
      if (key === "contextMenu.highlight") return "Highlight";
      if (key === "contextMenu.copy") return "Copy";
      if (key === "vocab.title") return "Words in Book";
      if (key === "vocab.searchPanel") return "Search saved words…";
      if (key === "vocab.wordCountInBook") {
        const count = Number(opts?.count ?? 0);
        return count === 1 ? "1 word in this book" : `${count} words in this book`;
      }
      if (key === "vocab.matchCountInBook") {
        return `${String(opts?.count ?? 0)} of ${String(opts?.total ?? 0)} words matching`;
      }
      if (key === "vocab.openInWords") return "Open in Words";
      if (key === "ai.newChat") return "New conversation";
      if (key === "ai.startChat") return "Think alongside the book";
      if (key === "ai.startChatSub") return `Explore ${String(opts?.title ?? "Book")}.`;
      if (key === "ai.thinking") return "Thinking…";
      if (key === "ai.followup.simplify") return "Explain that more simply";
      if (key === "ai.followup.example") return "Give a concrete example";
      if (key === "ai.followup.context") return "How does this connect to the chapter?";
      if (key === "ai.reauthTitle") return "Your ChatGPT sign-in expired";
      if (key === "ai.notConfiguredTitle") return "Set up an AI provider";
      if (key === "ai.signInAgain") return "Sign in again";
      if (key === "ai.openSettings") return "Open AI Settings";
      if (key === "aiPanel.quoteChip.label") return "Quoting passage";
      if (key === "aiPanel.quoteChip.labelWithPage") {
        return `Quoting · p. ${String(opts?.page ?? "")}`;
      }
      if (key === "aiPanel.quoteChip.dismiss") return "Remove quote";
      if (key === "aiPanel.messageCount") {
        const count = Number(opts?.count ?? 0);
        return count === 1 ? "1 message" : `${count} messages`;
      }
      if (key === "bookmarks.shortPage") return `p. ${String(opts?.page ?? "")}`;
      if (key === "settings.ai.effort.high") return "High";
      return key;
    },
    i18n: { language: "en", changeLanguage: vi.fn() },
  }),
  initReactI18next: { type: "3rdParty", init: vi.fn() },
}));

vi.mock("../platform", () => ({
  invoke: (cmd: string, args?: Record<string, unknown>) => invokeMock(cmd, args),
  listen: vi.fn(async (event: string, cb: ChunkListener) => {
    const list = chunkListeners.get(event) ?? [];
    list.push(cb);
    chunkListeners.set(event, list);
    return () => {
      const next = (chunkListeners.get(event) ?? []).filter((fn) => fn !== cb);
      chunkListeners.set(event, next);
    };
  }),
  listenCurrentWindow: vi.fn(async () => () => {}),
  emit: vi.fn(async () => {}),
  emitTo: vi.fn(async () => {}),
  focusWindow: () => focusWindowMock(),
  closeCurrentWindow: vi.fn(async () => {}),
  convertFileSrc: (p: string) => p,
}));

import ReaderContextMenu from "./ReaderContextMenu";
import LookupPopover from "./LookupPopover";
import ExplainPopover from "./ExplainPopover";
import TranslationPopover from "./TranslationPopover";
import DictionaryPanel from "./DictionaryPanel";
import AiPanel from "./AiPanel";
import MessageBubble from "./MessageBubble";
import ChatsView from "./ChatsView";

async function flushMicrotasks(ticks = 6): Promise<void> {
  for (let i = 0; i < ticks; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

function emitChunks(eventPrefix: string, requestId: string, deltas: string[], done = true): void {
  const event = `${eventPrefix}${requestId}`;
  const listeners = [...(chunkListeners.get(event) ?? [])];
  for (const delta of deltas) {
    for (const cb of listeners) {
      cb({ payload: { delta, done: false } });
    }
  }
  if (done) {
    for (const cb of listeners) {
      cb({ payload: { delta: "", done: true } });
    }
  }
}

function findButton(container: HTMLElement, text: string): HTMLButtonElement {
  const btn = Array.from(container.querySelectorAll("button")).find((el) =>
    el.textContent?.includes(text),
  );
  if (!btn) {
    throw new Error(`Expected button containing "${text}" in:\n${container.innerHTML}`);
  }
  return btn;
}

describe("M7 reader AI and word surfaces", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
    chunkListeners.clear();
    settingsMap = {
      translation_language: "zh",
      ai_provider: "openai",
      ai_auth_mode: "oauth",
      ai_model: "gpt-5.6-sol",
      ai_effort_deep: "high",
    };
    vocabRows = [];
    chatRows = [];
    chatMessagesMap = new Map();
    onAiLookupImpl = null;
    onListAllChatsImpl = null;
    onAiExplainImpl = null;
    onAiTranslateImpl = null;
    onAiChatImpl = null;
    invokeMock.mockClear();
    focusWindowMock.mockClear();

    Element.prototype.scrollIntoView = vi.fn();
    Object.assign(navigator, {
      clipboard: { writeText: vi.fn(async () => {}) },
    });

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it("ReaderContextMenu hides Look Up for long passages and exposes highlight swatches + mod+C", () => {
    const onHighlight = vi.fn();
    const onLookup = vi.fn();

    act(() => {
      root.render(
        <ReaderContextMenu
          x={20}
          y={20}
          text="ephemeral"
          onClose={vi.fn()}
          onCopy={vi.fn()}
          onExplain={vi.fn()}
          onQuote={vi.fn()}
          onLookup={onLookup}
          onTranslate={vi.fn()}
          onHighlight={onHighlight}
        />,
      );
    });

    expect(container.querySelector('[role="menu"]')?.className).toContain("reader-popover");
    expect(container.textContent).toContain("Look Up");
    expect(container.textContent).toContain("Quote in Chat");
    expect(container.textContent).toContain("Translate");
    expect(container.querySelectorAll('button[aria-label^="highlights.color."]').length).toBe(5);
    expect(container.textContent).toMatch(/⌘C|Ctrl\+C/);

    act(() => {
      findButton(container, "Look Up").click();
    });
    expect(onLookup).toHaveBeenCalledTimes(1);

    act(() => {
      root.render(
        <ReaderContextMenu
          x={20}
          y={20}
          text="this selected passage has seven distinct words"
          onClose={vi.fn()}
          onCopy={vi.fn()}
          onExplain={vi.fn()}
          onQuote={vi.fn()}
          onLookup={onLookup}
          onTranslate={vi.fn()}
        />,
      );
    });
    expect(container.textContent).not.toContain("Look Up");
  });

  it("LookupPopover renders streaming, done with In this passage + Save to Words, error, and AI auth prompt cards", async () => {
    const defReqs: string[] = [];
    const ctxReqs: string[] = [];
    onAiLookupImpl = async (args) => {
      if (args.kind === "definition") defReqs.push(String(args.requestId));
      else ctxReqs.push(String(args.requestId));
    };

    const onSaved = vi.fn();
    await act(async () => {
      root.render(
        <LookupPopover
          x={40}
          y={40}
          word="ephemeral"
          sentence="Life is ephemeral."
          bookId="b-1"
          cfi="epubcfi(/6/2!/4/2)"
          onSaved={onSaved}
          onClose={vi.fn()}
        />,
      );
    });
    await flushMicrotasks();

    // Streaming state
    expect(container.textContent).toContain("Looking up…");

    // Done state (real backend wire format: [[QUILL_TRANSLATION]]<gloss>\n<entry>)
    await act(async () => {
      emitChunks("ai-lookup-chunk-", defReqs[0], [
        "[[QUILL_TRANSLATION]]短暂的\n**/ɪˈfɛmərəl/** *(adj.)* Lasting a very short time.",
      ]);
      emitChunks("ai-lookup-chunk-", ctxReqs[0], ["Here it highlights fleeting human moments."]);
    });
    await flushMicrotasks();

    expect(container.textContent).not.toContain("[[QUILL_TRANSLATION]]");
    const glossEl = Array.from(container.querySelectorAll("p")).find(
      (el) => el.textContent?.trim() === "短暂的",
    );
    const posBadgeEl = Array.from(container.querySelectorAll("span.rounded-full")).find(
      (el) => el.textContent?.trim() === "adj",
    );
    const ipaEl = Array.from(container.querySelectorAll("span.font-mono")).find(
      (el) => el.textContent?.trim() === "/ɪˈfɛmərəl/",
    );
    expect(glossEl).toBeTruthy();
    expect(posBadgeEl).toBeTruthy();
    expect(ipaEl).toBeTruthy();
    expect(container.textContent).toContain("Lasting a very short time.");
    expect(container.textContent).toContain("In this passage");
    expect(container.textContent).toContain("Here it highlights fleeting human moments.");

    const saveBtn = findButton(container, "Save to Words");
    expect(saveBtn.className).toContain("rounded-control");
    await act(async () => {
      saveBtn.click();
    });
    await flushMicrotasks();

    expect(invokeMock).toHaveBeenCalledWith(
      "add_vocab_word",
      expect.objectContaining({
        bookId: "b-1",
        word: "ephemeral",
        definition: "短暂的\n**/ɪˈfɛmərəl/** *(adj.)* Lasting a very short time.",
      }),
    );
    expect(onSaved).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("Saved");

    // Error state
    await act(async () => {
      root.render(
        <LookupPopover
          x={40}
          y={40}
          word="tenacious"
          sentence="Hold fast."
          bookId="b-1"
          onClose={vi.fn()}
        />,
      );
    });
    await flushMicrotasks();
    await act(async () => {
      emitChunks("ai-lookup-chunk-", defReqs[defReqs.length - 1], ["Error: Gateway timeout"]);
      emitChunks("ai-lookup-chunk-", ctxReqs[ctxReqs.length - 1], []);
    });
    await flushMicrotasks();

    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Gateway timeout");

    // AI_REAUTH_REQUIRED card
    await act(async () => {
      root.render(
        <LookupPopover
          x={40}
          y={40}
          word="reauth"
          sentence="Test sentence."
          bookId="b-1"
          onClose={vi.fn()}
        />,
      );
    });
    await flushMicrotasks();
    await act(async () => {
      emitChunks("ai-lookup-chunk-", defReqs[defReqs.length - 1], ["AI_REAUTH_REQUIRED"]);
      emitChunks("ai-lookup-chunk-", ctxReqs[ctxReqs.length - 1], []);
    });
    await flushMicrotasks();

    expect(container.textContent).toContain("Your ChatGPT sign-in expired");
    await act(async () => {
      findButton(container, "Sign in again").click();
    });
    expect(invokeMock).toHaveBeenCalledWith("open_settings_on_main", { section: "ai" });
    expect(focusWindowMock).toHaveBeenCalled();

    // AI_NOT_CONFIGURED card
    await act(async () => {
      root.render(
        <LookupPopover
          x={40}
          y={40}
          word="unconfigured"
          sentence="Test sentence."
          bookId="b-1"
          onClose={vi.fn()}
        />,
      );
    });
    await flushMicrotasks();
    await act(async () => {
      emitChunks("ai-lookup-chunk-", defReqs[defReqs.length - 1], ["AI_NOT_CONFIGURED"]);
      emitChunks("ai-lookup-chunk-", ctxReqs[ctxReqs.length - 1], []);
    });
    await flushMicrotasks();

    expect(container.textContent).toContain("Set up an AI provider");
  });

  it("ExplainPopover renders streaming, done with Quote in Chat CTA, error, and prompt cards", async () => {
    const reqs: string[] = [];
    onAiExplainImpl = async (args) => {
      reqs.push(String(args.requestId));
    };
    const onQuote = vi.fn();

    await act(async () => {
      root.render(
        <ExplainPopover
          x={30}
          y={30}
          text="Fear is the mind-killer."
          sentence="I must not fear. Fear is the mind-killer."
          bookId="b-1"
          onQuote={onQuote}
          onClose={vi.fn()}
        />,
      );
    });
    await flushMicrotasks();
    expect(container.textContent).toContain("Explaining…");

    await act(async () => {
      emitChunks("ai-lookup-chunk-", reqs[0], ["Bene Gesserit litany against fear."]);
    });
    await flushMicrotasks();

    expect(container.textContent).toContain("Bene Gesserit litany against fear.");
    const quoteBtn = findButton(container, "Quote in Chat");
    expect(quoteBtn.className).toContain("rounded-control");
    act(() => {
      quoteBtn.click();
    });
    expect(onQuote).toHaveBeenCalledTimes(1);

    // Error state
    await act(async () => {
      root.render(
        <ExplainPopover
          x={30}
          y={30}
          text="Another line."
          sentence="Context."
          bookId="b-1"
          onClose={vi.fn()}
        />,
      );
    });
    await flushMicrotasks();
    await act(async () => {
      emitChunks("ai-lookup-chunk-", reqs[1], ["Error: Provider offline"]);
    });
    await flushMicrotasks();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Provider offline");

    // AI_NOT_CONFIGURED & AI_REAUTH_REQUIRED
    await act(async () => {
      root.render(
        <ExplainPopover
          x={30}
          y={30}
          text="Prompt card check."
          sentence="Context."
          bookId="b-1"
          onClose={vi.fn()}
        />,
      );
    });
    await flushMicrotasks();
    await act(async () => {
      emitChunks("ai-lookup-chunk-", reqs[2], ["AI_NOT_CONFIGURED"]);
    });
    await flushMicrotasks();
    expect(container.textContent).toContain("Set up an AI provider");

    await act(async () => {
      root.render(
        <ExplainPopover
          x={30}
          y={30}
          text="Reauth card check."
          sentence="Context."
          bookId="b-1"
          onClose={vi.fn()}
        />,
      );
    });
    await flushMicrotasks();
    await act(async () => {
      emitChunks("ai-lookup-chunk-", reqs[3], ["AI_REAUTH_REQUIRED"]);
    });
    await flushMicrotasks();
    expect(container.textContent).toContain("Your ChatGPT sign-in expired");
  });

  it("TranslationPopover supports language switching without saving settings, surrounding context toggle, errors, and prompt cards", async () => {
    const translateCalls: Array<Record<string, unknown>> = [];
    onAiTranslateImpl = async (args) => {
      translateCalls.push(args);
    };

    await act(async () => {
      root.render(
        <TranslationPopover
          x={30}
          y={30}
          text="mind-killer"
          context="I must not fear. Fear is the mind-killer."
          bookId="b-1"
          onClose={vi.fn()}
        />,
      );
    });
    await flushMicrotasks();

    expect(container.textContent).toContain("Translating…");

    await act(async () => {
      emitChunks("ai-translate-chunk-", String(translateCalls[0].requestId), ["心灵杀手"]);
    });
    await flushMicrotasks();

    expect(container.textContent).toContain("心灵杀手");
    // Toggle surrounding context
    const toggleBtn = findButton(container, "Show surrounding context");
    act(() => {
      toggleBtn.click();
    });
    expect(container.querySelector("mark")?.textContent).toBe("mind-killer");
    expect(container.textContent).toContain("Hide surrounding context");

    // Switch target language via header chip -> re-translates without set_setting
    await act(async () => {
      findButton(container, "简体中文").click();
    });
    const enOption = Array.from(container.querySelectorAll('[role="menuitemradio"]')).find((el) =>
      el.textContent?.includes("English"),
    ) as HTMLButtonElement;
    expect(enOption).toBeTruthy();

    await act(async () => {
      enOption.click();
    });
    await flushMicrotasks();

    expect(translateCalls[1].targetLanguage).toBe("en");
    expect(invokeMock).not.toHaveBeenCalledWith("set_setting", expect.anything());

    await act(async () => {
      emitChunks("ai-translate-chunk-", String(translateCalls[1].requestId), ["mind killer"]);
    });
    await flushMicrotasks();
    expect(container.textContent).toContain("mind killer");

    // Error state
    await act(async () => {
      root.render(
        <TranslationPopover
          x={30}
          y={30}
          text="Failure check"
          bookId="b-1"
          onClose={vi.fn()}
        />,
      );
    });
    await flushMicrotasks();
    await act(async () => {
      emitChunks(
        "ai-translate-chunk-",
        String(translateCalls[translateCalls.length - 1].requestId),
        ["Error: Rate limit"],
      );
    });
    await flushMicrotasks();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Rate limit");

    // Prompt cards & TRANSLATION_LANGUAGE_NOT_CONFIGURED
    await act(async () => {
      emitChunks(
        "ai-translate-chunk-",
        String(translateCalls[translateCalls.length - 1].requestId),
        [],
      );
    });
    onAiTranslateImpl = async () => {
      throw new Error("TRANSLATION_LANGUAGE_NOT_CONFIGURED");
    };
    await act(async () => {
      root.render(
        <TranslationPopover x={30} y={30} text="No lang" bookId="b-1" onClose={vi.fn()} />,
      );
    });
    await flushMicrotasks();
    expect(container.textContent).toContain("Set a translation language in Settings first");

    onAiTranslateImpl = async () => {
      throw new Error("AI_REAUTH_REQUIRED");
    };
    await act(async () => {
      root.render(
        <TranslationPopover x={30} y={30} text="Reauth" bookId="b-1" onClose={vi.fn()} />,
      );
    });
    await flushMicrotasks();
    expect(container.textContent).toContain("Your ChatGPT sign-in expired");

    onAiTranslateImpl = async () => {
      throw new Error("AI_NOT_CONFIGURED");
    };
    await act(async () => {
      root.render(
        <TranslationPopover x={30} y={30} text="No key" bookId="b-1" onClose={vi.fn()} />,
      );
    });
    await flushMicrotasks();
    expect(container.textContent).toContain("Set up an AI provider");

    // Unrelated paragraph context must not replace selected text or promise surrounding context
    const longSelection = "A ".repeat(110).trim();
    const unrelatedParagraph = "Unrelated opening text from the start of a long paragraph.";
    let latestTranslateReq = "";
    onAiTranslateImpl = async (args) => {
      latestTranslateReq = String(args.requestId);
    };
    await act(async () => {
      root.render(
        <TranslationPopover
          x={30}
          y={30}
          text={longSelection}
          context={unrelatedParagraph}
          bookId="b-1"
          onClose={vi.fn()}
        />,
      );
    });
    await flushMicrotasks();
    await act(async () => {
      emitChunks("ai-translate-chunk-", latestTranslateReq, ["长选文翻译"]);
    });
    await flushMicrotasks();

    expect(container.textContent).not.toContain("Show surrounding context");
    expect(container.textContent).not.toContain(unrelatedParagraph);
    const expandSelectionBtn = findButton(container, "Show full selection");
    act(() => {
      expandSelectionBtn.click();
    });
    expect(container.textContent).toContain("Show less");
    expect(container.textContent).not.toContain(unrelatedParagraph);

    // Repeated substring in the same context window marks the occurrence at contextOffset
    const repeatedContext = "She left the deposit bank and walked down to the river bank.";
    const riverBankOffset = repeatedContext.lastIndexOf("bank");
    await act(async () => {
      root.render(
        <TranslationPopover
          x={30}
          y={30}
          text="bank"
          context={repeatedContext}
          contextOffset={riverBankOffset}
          bookId="b-1"
          onClose={vi.fn()}
        />,
      );
    });
    await flushMicrotasks();
    await act(async () => {
      emitChunks("ai-translate-chunk-", latestTranslateReq, ["河岸"]);
    });
    await flushMicrotasks();
    act(() => {
      findButton(container, "Show surrounding context").click();
    });
    const quotePara = container.querySelector("p.font-reading")!;
    const mark = quotePara.querySelector("mark")!;
    expect(mark.textContent).toBe("bank");
    expect(quotePara.textContent).toBe(`“${repeatedContext}”`);
    expect(mark.previousSibling?.textContent).toBe(
      "She left the deposit bank and walked down to the river ",
    );
  });

  it("DictionaryPanel (Words in Book) filters words, omits null page labels, navigates on click, deletes, and triggers Open in Words", async () => {
    vocabRows = [
      {
        id: "v-1",
        book_id: "b-1",
        word: "ephemeral",
        definition: "短暂的\n/ɪˈfɛmərəl/ adj. Short-lived.",
        context_sentence: "An ephemeral bloom.",
        cfi: "epubcfi(/6/2!/4/2)",
        created_at: 1_700_000_000,
      },
      {
        id: "v-2",
        book_id: "b-1",
        word: "zenith",
        definition: "/ˈziːnɪθ/ noun. The highest point.",
        context_sentence: null,
        cfi: "epubcfi(/6/4!/2/2)",
        created_at: 1_700_000_100,
      },
    ];
    const onNavigate = vi.fn();
    const onOpenInWords = vi.fn();

    await act(async () => {
      root.render(
        <DictionaryPanel
          bookId="b-1"
          onNavigate={onNavigate}
          getPageFromCfi={() => null}
          onClose={vi.fn()}
          onOpenInWords={onOpenInWords}
        />,
      );
    });
    await flushMicrotasks();

    expect(container.textContent).toContain("Words in Book");
    expect(container.textContent).toContain("2 words in this book");
    expect(container.textContent).toContain("短暂的");
    expect(container.textContent).not.toContain("p. ");

    const searchInput = container.querySelector<HTMLInputElement>(
      'input[placeholder="Search saved words…"]',
    )!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
        searchInput,
        "eph",
      );
      searchInput.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(container.textContent).toContain("1 of 2 words matching");

    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
        searchInput,
        "",
      );
      searchInput.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(container.textContent).toContain("2 words in this book");

    const wordBtn = container.querySelector('[role="button"]');
    expect(wordBtn).toBeTruthy();
    await act(async () => {
      wordBtn?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onNavigate).toHaveBeenCalledWith("epubcfi(/6/2!/4/2)");

    await act(async () => {
      findButton(container, "Open in Words").click();
    });
    expect(onOpenInWords).toHaveBeenCalledWith("v-1");

    const delBtn = container.querySelector<HTMLButtonElement>('button[aria-label="common.delete"]');
    await act(async () => {
      delBtn?.click();
    });
    await flushMicrotasks();
    expect(invokeMock).toHaveBeenCalledWith("remove_vocab_word", { id: "v-1" });
    expect(container.textContent).toContain("1 word in this book");
  });

  it("AiPanel (Ask Quill) renders starter & follow-up prompts, paginated message counts, active thread delete, pending quote Esc, 16px/15px text sizing, errors and prompt cards", async () => {
    chatRows = [
      {
        id: "c-1",
        book_id: "b-1",
        title: "Chapter 1 Themes",
        model: null,
        created_at: 1_700_000_000,
        updated_at: 1_700_000_000,
      },
      {
        id: "c-2",
        book_id: "b-1",
        title: "Mentat discipline",
        model: null,
        created_at: 1_700_000_010,
        updated_at: 1_700_000_010,
      },
    ];
    chatMessagesMap.set("c-1", [
      {
        id: "m-1",
        chat_id: "c-1",
        role: "user",
        content: "Why does Jessica recite this?",
        context: "Fear is the mind-killer.",
        context_cfi: "epubcfi(/6/2!/4/4)",
        created_at: 1_700_000_001,
      },
      {
        id: "m-2",
        chat_id: "c-1",
        role: "assistant",
        content: "It steadies her focus during crisis.",
        context: null,
        context_cfi: null,
        created_at: 1_700_000_002,
      },
    ]);
    chatMessagesMap.set("c-2", [
      {
        id: "m-3",
        chat_id: "c-2",
        role: "user",
        content: "Who trained Thufir?",
        context: null,
        context_cfi: null,
        created_at: 1_700_000_003,
      },
      {
        id: "m-4",
        chat_id: "c-2",
        role: "assistant",
        content: "Error: Temporarily unavailable",
        context: null,
        context_cfi: null,
        created_at: 1_700_000_004,
      },
    ]);

    await act(async () => {
      root.render(
        <AiPanel
          bookId="b-1"
          bookTitle="Dune"
          context={{ text: "A beginning is a very delicate time.", page: 1 }}
          onContextConsumed={vi.fn()}
          onClose={vi.fn()}
        />,
      );
    });
    await flushMicrotasks();

    // Thread loads existing messages + pending quote chip + model footer + follow-up chips on successful reply
    expect(container.textContent).toContain("Chapter 1 Themes");
    expect(container.textContent).toContain("Quoting · p. 1");
    expect(container.textContent).toContain("GPT-5.6-Sol · high");
    expect(container.querySelector('[data-testid="followup-chips"]')).toBeTruthy();
    expect(container.textContent).toContain("Explain that more simply");
    // Switcher metadata (list_all_chats) must NOT run on initial panel load while switcher is closed
    expect(invokeMock).not.toHaveBeenCalledWith("list_all_chats", expect.anything());

    // Esc in composer clears pending quote chip
    const textarea = container.querySelector("textarea")!;
    expect(textarea.className).toContain("text-[15px]");
    await act(async () => {
      textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(container.textContent).not.toContain("Quoting · p. 1");

    // MessageBubble text size classes (16px reply & user bubble, 15px quote)
    expect(container.querySelector(".markdown-body")?.className).toContain("text-[16px]");
    expect(container.innerHTML).toContain("text-[16px] leading-[1.5]");
    expect(container.innerHTML).toContain("text-[15px] leading-[1.55]");

    // Clicking a follow-up chip dispatches through ai_chat and suppresses follow-ups while streaming
    const releaseChat = { resolve: () => {} };
    onAiChatImpl = () =>
      new Promise<void>((resolve) => {
        releaseChat.resolve = resolve;
      });
    await act(async () => {
      findButton(container, "Explain that more simply").click();
    });
    await flushMicrotasks();
    expect(invokeMock).toHaveBeenCalledWith("ai_chat", expect.anything());
    expect(container.querySelector('[data-testid="followup-chips"]')).toBeNull();
    // Switcher metadata must NOT run during send while switcher is closed
    expect(invokeMock).not.toHaveBeenCalledWith("list_all_chats", expect.anything());

    // Open switcher while still streaming with deferred list_all_chats: threads render before counts arrive
    const releaseInitialCounts = { resolve: (() => {}) as (v: unknown) => void };
    onListAllChatsImpl = () =>
      new Promise((resolve) => {
        releaseInitialCounts.resolve = resolve;
      });
    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')?.click();
    });
    expect(container.querySelector('[role="menu"]')?.className).toContain("reader-popover");
    expect(container.textContent).toContain("Chapter 1 Themes");
    expect(container.textContent).toContain("Mentat discipline");
    expect(container.textContent).not.toContain("3 messages");

    // Settle initial deferred counts -> shows persisted user message count (3 messages)
    onListAllChatsImpl = null;
    await act(async () => {
      releaseInitialCounts.resolve({
        chats: [{ id: "c-1", message_count: 3 }],
        next_cursor: "page-2",
        total: 2,
      });
    });
    await flushMicrotasks();
    expect(container.textContent).toContain("3 messages");
    expect(container.textContent).toContain("2 messages");

    // Keep switcher OPEN as streaming completes -> live count updates from 3 to 4 without reopening
    onAiChatImpl = null;
    await act(async () => {
      emitChunks("ai-stream-chunk", "", ["Simplified explanation."]);
      releaseChat.resolve();
    });
    await flushMicrotasks();

    expect(container.querySelector('[role="menu"]')).toBeTruthy();
    expect(container.textContent).toContain("Simplified explanation.");
    expect(container.querySelector('[data-testid="followup-chips"]')).toBeTruthy();
    expect(container.textContent).toContain("4 messages");

    // Reopen switcher with a fresh deferred count fetch -> threads stay immediately selectable & stale fetch is ignored after close
    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')?.click();
    });
    const releaseCounts = { resolve: (() => {}) as (v: unknown) => void };
    onListAllChatsImpl = () =>
      new Promise((resolve) => {
        releaseCounts.resolve = resolve;
      });
    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')?.click();
    });

    // Older thread is immediately selectable even while counts are still pending
    await act(async () => {
      findButton(container, "Mentat discipline").click();
    });
    await flushMicrotasks();
    expect(container.textContent).toContain("Who trained Thufir?");
    expect(container.querySelector('[data-testid="followup-chips"]')).toBeNull();

    // Resolving stale count fetch after switcher closed must not alter thread selection
    onListAllChatsImpl = null;
    await act(async () => {
      releaseCounts.resolve({ chats: [], next_cursor: null, total: 0 });
    });
    await flushMicrotasks();
    expect(container.textContent).toContain("Who trained Thufir?");

    // Re-open switcher and verify paginated message counts load cleanly
    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')?.click();
    });
    await flushMicrotasks();
    expect(invokeMock).toHaveBeenCalledWith(
      "list_all_chats",
      expect.objectContaining({ bookId: "b-1" }),
    );
    expect(container.textContent).toContain("4 messages");
    expect(container.textContent).toContain("2 messages");

    // Delete active thread c-2, then delete active/only thread c-1
    const deleteButtons = Array.from(
      container.querySelectorAll<HTMLButtonElement>('button[aria-label="common.delete"]'),
    );
    expect(deleteButtons.length).toBe(2);
    await act(async () => {
      deleteButtons[1].click();
    });
    await flushMicrotasks();
    expect(invokeMock).toHaveBeenCalledWith("delete_chat", { chatId: "c-2" });

    // Only c-1 remains and is now active; verify delete button still deletes the active/only thread
    const activeOnlyDelete = container.querySelector<HTMLButtonElement>(
      'button[aria-label="common.delete"]',
    )!;
    expect(activeOnlyDelete).toBeTruthy();
    await act(async () => {
      activeOnlyDelete.click();
    });
    await flushMicrotasks();
    expect(invokeMock).toHaveBeenCalledWith("delete_chat", { chatId: "c-1" });
    expect(container.textContent).toContain("Think alongside the book");

    // Start new conversation starter prompts remain visible in empty state
    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[aria-label="New conversation"]')?.click();
    });
    expect(container.textContent).toContain("Think alongside the book");
    expect(container.textContent).toContain("ai.prompt.summarize");

    // Direct MessageBubble state matrix: streaming, error, AI_REAUTH_REQUIRED, AI_NOT_CONFIGURED
    const bubble = (msg: ChatMessage, isStreaming = false) => (
      <MessageBubble msg={msg} messages={[msg]} streaming={isStreaming} />
    );

    await act(async () => {
      root.render(
        <div>
          {bubble({ id: "s1", role: "assistant", content: "" }, true)}
          {bubble({ id: "e1", role: "assistant", content: "Error: Model overloaded" })}
          {bubble({ id: "r1", role: "assistant", content: "AI_REAUTH_REQUIRED" })}
          {bubble({ id: "n1", role: "assistant", content: "AI_NOT_CONFIGURED" })}
        </div>,
      );
    });

    expect(container.textContent).toContain("Thinking…");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Model overloaded");
    expect(container.textContent).toContain("Your ChatGPT sign-in expired");
    expect(container.textContent).toContain("Set up an AI provider");
  });

  it("ChatsView renders 16px messages, 16px quote, 15px composer, error alert, and AI prompt cards", async () => {
    const book: Book = {
      id: "b-1",
      title: "Dune",
      author: "Frank Herbert",
      description: null,
      cover_path: null,
      file_path: "/books/dune.epub",
      format: "epub",
      genre: null,
      pages: 412,
      status: "reading",
      progress: 0,
      current_cfi: null,
      created_at: 1_700_000_000,
      updated_at: 1_700_000_000,
      available: true,
      cover_data: null,
    };
    chatRows = [
      {
        id: "c-1",
        book_id: "b-1",
        title: "Mentat logic",
        model: null,
        created_at: 1_700_000_000,
        updated_at: 1_700_000_000,
      },
    ];
    chatMessagesMap.set("c-1", [
      {
        id: "m-1",
        chat_id: "c-1",
        role: "user",
        content: "What makes Thufir a Mentat?",
        context: "A Mentat learns pattern synthesis.",
        context_cfi: "epubcfi(/6/2!/4/6)",
        created_at: 1_700_000_001,
      },
      {
        id: "m-2",
        chat_id: "c-1",
        role: "assistant",
        content: "Rigorous cognitive conditioning without thinking machines.",
        context: null,
        context_cfi: null,
        created_at: 1_700_000_002,
      },
      {
        id: "m-3",
        chat_id: "c-1",
        role: "assistant",
        content: "Error: Network drop",
        context: null,
        context_cfi: null,
        created_at: 1_700_000_003,
      },
      {
        id: "m-4",
        chat_id: "c-1",
        role: "assistant",
        content: "AI_REAUTH_REQUIRED",
        context: null,
        context_cfi: null,
        created_at: 1_700_000_004,
      },
      {
        id: "m-5",
        chat_id: "c-1",
        role: "assistant",
        content: "AI_NOT_CONFIGURED",
        context: null,
        context_cfi: null,
        created_at: 1_700_000_005,
      },
    ]);

    await act(async () => {
      root.render(
        <ChatsView
          booksById={new Map([["b-1", book]])}
          initialChatId="c-1"
          navigationSeq={1}
          onOpenSettings={vi.fn()}
          onNavigateToLibrary={vi.fn()}
        />,
      );
    });
    await flushMicrotasks();

    expect(container.querySelector(".markdown-body")?.className).toContain("text-[16px]");
    expect(container.innerHTML).toContain("font-reading italic text-[16px] leading-[1.6]");
    expect(container.innerHTML).toContain("text-[16px] leading-[1.5]");
    expect(container.querySelector("textarea")?.className).toContain("text-[15px]");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Network drop");
    expect(container.textContent).toContain("Your ChatGPT sign-in expired");
    expect(container.textContent).toContain("Set up an AI provider");

    // Opening or sending in ChatsView must not issue book-scoped switcher list_all_chats queries
    const bookScopedQueriesBeforeSend = invokeMock.mock.calls.filter(
      ([cmd, arg]) => cmd === "list_all_chats" && Boolean((arg as { bookId?: string | null })?.bookId),
    );
    expect(bookScopedQueriesBeforeSend.length).toBe(0);

    invokeMock.mockClear();
    const chatsTextarea = container.querySelector("textarea")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
        chatsTextarea,
        "Explain the orange catholic bible.",
      );
      chatsTextarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      chatsTextarea.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );
    });
    await flushMicrotasks();
    await act(async () => {
      emitChunks("ai-stream-chunk", "", ["Syncretic religious text."]);
    });
    await flushMicrotasks();

    const bookScopedQueriesOnSend = invokeMock.mock.calls.filter(
      ([cmd, arg]) => cmd === "list_all_chats" && Boolean((arg as { bookId?: string | null })?.bookId),
    );
    expect(bookScopedQueriesOnSend.length).toBe(0);
  });
});
