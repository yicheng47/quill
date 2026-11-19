/** @vitest-environment jsdom */

import { StrictMode, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../i18n";
import type { Book } from "../hooks/useBooks";
import type { ChatSummary } from "../hooks/useChats";
import type { CodexModel, CodexStatus } from "../lib/aiConnections";

type EventCb = (event: { payload: unknown }) => void;

const mocks = vi.hoisted(() => ({
  invoke: vi.fn<(cmd: string, args?: Record<string, unknown>) => Promise<unknown>>(),
  listen: vi.fn<(event: string, cb: EventCb) => Promise<() => void>>(),
  listeners: new Map<string, Set<EventCb>>(),
  settingsMap: {} as Record<string, string>,
}));

vi.mock("../platform", () => ({
  invoke: (cmd: string, args?: Record<string, unknown>) => mocks.invoke(cmd, args),
  listen: (event: string, cb: EventCb) => mocks.listen(event, cb),
  listenCurrentWindow: vi.fn(async () => () => {}),
  convertFileSrc: (p: string) => `quill-file://local/${p}`,
  focusWindow: vi.fn(async () => true),
  getAppVersion: vi.fn(async () => "2.0.0"),
  getPlatformInfo: vi.fn(async () => ({ platform: "darwin", arch: "arm64" })),
  getOpenReaderCount: vi.fn(async () => 0),
  setZoom: vi.fn(async () => {}),
  setTitlebarZoom: vi.fn(async () => {}),
  setWindowBackgroundColor: vi.fn(async () => {}),
  openUrl: vi.fn(async () => {}),
  openFileDialog: vi.fn(async () => null),
}));

vi.mock("../utils/openReaderWindow", () => ({
  openReaderWindow: vi.fn(async () => {}),
}));

vi.mock("../contexts/UpdateContext", () => ({
  useUpdate: () => ({
    status: "idle",
    update: null,
    progress: 0,
    downloadedBytes: 0,
    totalBytes: 0,
    lastCheckedAt: null,
    skippedVersion: null,
    error: null,
    manualCheck: false,
    upToDateSeq: 0,
    checkForUpdate: vi.fn(async () => null),
    downloadAndInstall: vi.fn(async () => {}),
    cancelDownload: vi.fn(async () => {}),
    skipVersion: vi.fn(async () => {}),
    restart: vi.fn(async () => {}),
  }),
}));

import AiPanel from "./AiPanel";
import ChatsView from "./ChatsView";
import SettingsView from "./settings/SettingsView";
import { resetCodexModelsCacheForTests } from "../hooks/useCodexModels";
import { applyCodexLegacyCarryOverLocal } from "../lib/codexFeatures";

const READY_STATUS: CodexStatus = {
  state: "ready",
  version: "0.170.0",
  min_version: "0.170.0",
  path: "/opt/homebrew/bin/codex",
  from_override: false,
  email: "reader@example.com",
  plan: "pro",
  error: null,
};

const SAMPLE_MODELS: CodexModel[] = [
  {
    slug: "gpt-6.2-sol",
    display_name: "GPT-6.2 Sol",
    description: "",
    supported_reasoning_levels: ["low", "medium", "high", "xhigh"],
    default_reasoning_level: "low",
    is_default: true,
  },
  {
    slug: "gpt-6.1-terra",
    display_name: "GPT-6.1 Terra",
    description: "",
    supported_reasoning_levels: ["low", "medium", "high", "xhigh"],
    default_reasoning_level: "medium",
    is_default: false,
  },
  {
    slug: "gpt-6-luna",
    display_name: "GPT-6 Luna",
    description: "",
    supported_reasoning_levels: ["low", "medium", "high"],
    default_reasoning_level: "medium",
    is_default: false,
  },
];

const SAMPLE_BOOK: Book = {
  id: "b1",
  title: "Notes from Underground",
  author: "Fyodor Dostoevsky",
  description: null,
  cover_path: null,
  file_path: "/tmp/notes.epub",
  format: "epub",
  genre: null,
  pages: 150,
  status: "reading",
  progress: 25,
  current_cfi: "epubcfi(/6/2!/4/2)",
  created_at: 1000,
  updated_at: 2000,
  available: true,
  cover_data: null,
};

const SAMPLE_CHAT: ChatSummary = {
  id: "chat-1",
  book_id: "b1",
  title: "Why he insults himself",
  model: null,
  pinned: false,
  metadata: null,
  created_at: 1000,
  updated_at: 2000,
  book_title: "Notes from Underground",
  message_count: 1,
  last_message: "He gets his defence in first.",
};

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("Codex composer model picker and shared catalog (#358)", () => {
  let container: HTMLDivElement;
  let root: Root;

  const flush = async (ticks = 6) => {
    for (let i = 0; i < ticks; i++) {
      await act(async () => {
        await Promise.resolve();
      });
    }
  };

  beforeEach(async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    await i18n.changeLanguage("en");
    resetCodexModelsCacheForTests();
    mocks.listeners.clear();
    mocks.settingsMap = {};
    Element.prototype.scrollIntoView = vi.fn();

    mocks.listen.mockReset().mockImplementation(async (event, cb) => {
      const set = mocks.listeners.get(event) ?? new Set<EventCb>();
      set.add(cb);
      mocks.listeners.set(event, set);
      return () => {
        set.delete(cb);
      };
    });

    mocks.invoke.mockReset().mockImplementation(async (cmd, args) => {
      switch (cmd) {
        case "get_all_settings":
          return { ...mocks.settingsMap };
        case "set_setting":
          if (args && typeof args.key === "string") {
            mocks.settingsMap = applyCodexLegacyCarryOverLocal(mocks.settingsMap, {
              [args.key]: String(args.value ?? ""),
            });
          }
          return null;
        case "set_settings_bulk":
          if (args && typeof args.settings === "object" && args.settings) {
            mocks.settingsMap = applyCodexLegacyCarryOverLocal(
              mocks.settingsMap,
              args.settings as Record<string, string>,
            );
          }
          return null;
        case "codex_status":
          return READY_STATUS;
        case "list_codex_models":
          return { models: SAMPLE_MODELS };
        case "list_all_chats":
          return { chats: [SAMPLE_CHAT], next_cursor: null, total: 1 };
        case "get_chat_counts":
          return {
            total: 1,
            by_book: [{ book_id: "b1", book_title: SAMPLE_BOOK.title, count: 1 }],
          };
        case "list_chats":
          return [SAMPLE_CHAT];
        case "list_chat_messages":
          return [
            {
              id: "m1",
              chat_id: "chat-1",
              role: "user",
              content: "Why does he open by insulting himself?",
              context: null,
              metadata: null,
              created_at: 1000,
              updated_at: 1000,
            },
          ];
        default:
          return null;
      }
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
  });

  it("fetches list_codex_models once across Ask Quill, ChatsView, and Settings, and syncs Chat picks across all three", async () => {
    mocks.settingsMap = {
      ai_auth_mode: "codex",
      ai_setup_seen: "true",
    };

    const booksById = new Map<string, Book>([["b1", SAMPLE_BOOK]]);

    await act(async () => {
      root.render(
        <div>
          <div data-testid="panel-host">
            <AiPanel bookId="b1" bookTitle={SAMPLE_BOOK.title} />
          </div>
          <div data-testid="chats-host">
            <ChatsView
              booksById={booksById}
              onOpenSettings={vi.fn()}
              onNavigateToLibrary={vi.fn()}
            />
          </div>
          <div data-testid="settings-host">
            <SettingsView
              section="ai"
              onSelectSection={vi.fn()}
              onClose={vi.fn()}
            />
          </div>
        </div>,
      );
    });
    await flush();

    // Shared catalog hook fetches list_codex_models once for all three surfaces.
    const catalogCalls = mocks.invoke.mock.calls.filter(([cmd]) => cmd === "list_codex_models");
    expect(catalogCalls).toHaveLength(1);

    const panelPicker = container.querySelector<HTMLButtonElement>(
      '[data-testid="panel-host"] [data-testid="codex-composer-picker"]',
    )!;
    const chatsPicker = container.querySelector<HTMLButtonElement>(
      '[data-testid="chats-host"] [data-testid="codex-composer-picker"]',
    )!;
    const settingsChatPicker = container.querySelector<HTMLButtonElement>(
      '[data-testid="settings-host"] [data-testid="codex-feature-picker-chat"]',
    )!;

    expect(panelPicker.textContent).toBe("GPT-6.2 Sol · high");
    expect(chatsPicker.textContent).toBe("GPT-6.2 Sol · high");
    expect(settingsChatPicker.textContent).toBe("GPT-6.2 Sol · High");

    // Open Ask Quill composer picker -> shows Settings note and updates model + effort.
    await act(async () => {
      panelPicker.click();
    });
    const menu = document.querySelector('[data-testid="codex-feature-menu-chat"]')!;
    expect(menu.textContent).toContain("Also changes Chat in Settings → AI");
    expect(menu.textContent).toContain("Newest Sol · now GPT-6.2 Sol");

    await act(async () => {
      menu.querySelector<HTMLButtonElement>('[data-testid="codex-model-option-gpt-6.1-terra"]')!.click();
    });
    await flush();

    expect(mocks.settingsMap.ai_codex_model_chat).toBe("gpt-6.1-terra");
    expect(panelPicker.textContent).toBe("GPT-6.1 Terra · high");
    expect(chatsPicker.textContent).toBe("GPT-6.1 Terra · high");
    expect(settingsChatPicker.textContent).toBe("GPT-6.1 Terra · High");

    // Change reasoning from ChatsView composer picker -> updates Ask Quill and Settings Chat row.
    await act(async () => {
      chatsPicker.click();
    });
    await act(async () => {
      document.querySelector<HTMLButtonElement>('[data-testid="codex-effort-option-medium"]')!.click();
    });
    await flush();

    expect(mocks.settingsMap.ai_codex_effort_chat).toBe("medium");
    expect(panelPicker.textContent).toBe("GPT-6.1 Terra · medium");
    expect(chatsPicker.textContent).toBe("GPT-6.1 Terra · medium");
    expect(settingsChatPicker.textContent).toBe("GPT-6.1 Terra · Medium");

    // Inline Custom… inside the composer picker writes ai_codex_model_chat.
    await act(async () => {
      panelPicker.click();
    });
    await act(async () => {
      document.querySelector<HTMLButtonElement>('[data-testid="codex-model-option-custom"]')!.click();
    });
    const customInput = document.querySelector<HTMLInputElement>(
      'input[aria-label="Custom model ID"]',
    )!;
    expect(customInput).not.toBeNull();
    await act(async () => {
      setInputValue(customInput, "gpt-6-custom");
      customInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    await flush();

    expect(mocks.settingsMap.ai_codex_model_chat).toBe("gpt-6-custom");
    expect(panelPicker.textContent).toBe("gpt-6-custom · medium");
    expect(chatsPicker.textContent).toBe("gpt-6-custom · medium");
    expect(settingsChatPicker.textContent).toBe("gpt-6-custom · Medium");

    // Cross-window settings-changed event refreshes surfaces when another window updates SQLite.
    mocks.settingsMap.ai_codex_model_chat = "gpt-6-luna";
    mocks.settingsMap.ai_codex_effort_chat = "low";
    await act(async () => {
      for (const cb of mocks.listeners.get("settings-changed") ?? []) {
        cb({ payload: { keys: ["ai_codex_model_chat", "ai_codex_effort_chat"] } });
      }
    });
    await flush();

    expect(panelPicker.textContent).toBe("GPT-6 Luna · low");
    expect(chatsPicker.textContent).toBe("GPT-6 Luna · low");
    expect(settingsChatPicker.textContent).toBe("GPT-6 Luna · Low");
  });

  it("keeps the passive model line in Ask Quill and shows no model line in ChatsView on API connections", async () => {
    mocks.settingsMap = {
      ai_auth_mode: "api_key",
      ai_provider: "openai",
      ai_model: "gpt-4o",
      ai_setup_seen: "true",
    };

    const booksById = new Map<string, Book>([["b1", SAMPLE_BOOK]]);

    await act(async () => {
      root.render(
        <div>
          <div data-testid="panel-host">
            <AiPanel bookId="b1" bookTitle={SAMPLE_BOOK.title} />
          </div>
          <div data-testid="chats-host">
            <ChatsView
              booksById={booksById}
              onOpenSettings={vi.fn()}
              onNavigateToLibrary={vi.fn()}
            />
          </div>
        </div>,
      );
    });
    await flush();

    // No Codex catalog fetch on API connections.
    expect(mocks.invoke.mock.calls.filter(([cmd]) => cmd === "list_codex_models")).toHaveLength(0);

    // Ask Quill keeps passive model footer text, with no interactive picker.
    const panelHost = container.querySelector('[data-testid="panel-host"]')!;
    expect(panelHost.querySelector('[data-testid="codex-composer-picker"]')).toBeNull();
    expect(panelHost.textContent).toContain("gpt-4o");

    // ChatsView shows neither a picker nor a passive model line.
    const chatsHost = container.querySelector('[data-testid="chats-host"]')!;
    expect(chatsHost.querySelector('[data-testid="codex-composer-picker"]')).toBeNull();
    expect(chatsHost.textContent).not.toContain("gpt-4o");
  });

  it("reconciles remote settings-changed events that arrive while a local save is pending", async () => {
    mocks.settingsMap = {
      ai_auth_mode: "codex",
      ai_setup_seen: "true",
    };

    let releaseLocalSave!: () => void;
    const baseImpl = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation(async (cmd, args) => {
      if (cmd === "set_setting" && args?.key === "ai_codex_model_chat") {
        mocks.settingsMap = applyCodexLegacyCarryOverLocal(mocks.settingsMap, {
          ai_codex_model_chat: String(args.value ?? ""),
        });
        await new Promise<void>((resolve) => {
          releaseLocalSave = resolve;
        });
        return null;
      }
      return baseImpl(cmd, args);
    });

    await act(async () => {
      root.render(<AiPanel bookId="b1" bookTitle={SAMPLE_BOOK.title} />);
    });
    await flush();

    const picker = container.querySelector<HTMLButtonElement>('[data-testid="codex-composer-picker"]')!;
    expect(picker.textContent).toBe("GPT-6.2 Sol · high");

    // Start local model save (remains pending).
    await act(async () => {
      picker.click();
    });
    await act(async () => {
      document.querySelector<HTMLButtonElement>('[data-testid="codex-model-option-gpt-6.1-terra"]')!.click();
    });

    // While local model save is still in flight, another window writes effort=medium and emits settings-changed.
    mocks.settingsMap.ai_codex_effort_chat = "medium";
    await act(async () => {
      for (const cb of mocks.listeners.get("settings-changed") ?? []) {
        cb({ payload: { keys: ["ai_codex_effort_chat"] } });
      }
    });

    // Finish local save -> useSettings reconciles and picker displays Terra · medium.
    await act(async () => {
      releaseLocalSave();
    });
    await flush();

    expect(picker.textContent).toBe("GPT-6.1 Terra · medium");
  });

  it("propagates codex-catalog-invalidated to open reader composers on account change", async () => {
    mocks.settingsMap = {
      ai_auth_mode: "codex",
      ai_setup_seen: "true",
    };

    let currentCatalog = SAMPLE_MODELS;
    const baseImpl = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation(async (cmd, args) => {
      if (cmd === "list_codex_models") return { models: currentCatalog };
      return baseImpl(cmd, args);
    });

    await act(async () => {
      root.render(<AiPanel bookId="b1" bookTitle={SAMPLE_BOOK.title} />);
    });
    await flush();

    const picker = container.querySelector<HTMLButtonElement>('[data-testid="codex-composer-picker"]')!;
    await act(async () => {
      picker.click();
    });
    expect(document.querySelector('[data-testid="codex-model-option-gpt-6-luna"]')).not.toBeNull();
    // Close menu
    await act(async () => {
      picker.click();
    });

    // Backend broadcasts account/catalog invalidation (Account B removes Luna).
    currentCatalog = [SAMPLE_MODELS[0]];
    await act(async () => {
      for (const cb of mocks.listeners.get("codex-catalog-invalidated") ?? []) {
        cb({ payload: { epoch: 1 } });
      }
    });
    await flush();

    const listCalls = mocks.invoke.mock.calls.filter(([cmd]) => cmd === "list_codex_models");
    expect(listCalls).toHaveLength(2);
    await act(async () => {
      picker.click();
    });
    expect(document.querySelector('[data-testid="codex-model-option-gpt-6-luna"]')).toBeNull();
    expect(document.querySelector('[data-testid="codex-model-option-gpt-6.2-sol"]')).not.toBeNull();
  });

  it("defers list_codex_models while AiPanel is hidden and fetches once when opened", async () => {
    mocks.settingsMap = {
      ai_auth_mode: "codex",
      ai_setup_seen: "true",
    };

    await act(async () => {
      root.render(<AiPanel bookId="b1" bookTitle={SAMPLE_BOOK.title} visible={false} />);
    });
    await flush();

    expect(mocks.invoke.mock.calls.filter(([cmd]) => cmd === "list_codex_models")).toHaveLength(0);

    await act(async () => {
      root.render(<AiPanel bookId="b1" bookTitle={SAMPLE_BOOK.title} visible={true} />);
    });
    await flush();

    expect(mocks.invoke.mock.calls.filter(([cmd]) => cmd === "list_codex_models")).toHaveLength(1);
    const picker = container.querySelector<HTMLButtonElement>('[data-testid="codex-composer-picker"]')!;
    expect(picker.textContent).toBe("GPT-6.2 Sol · high");
  });

  it("preserves legacy Luna across SettingsView Codex->API->Codex round-trip and does not overwrite concurrent Reader saves on Default clear", async () => {
    mocks.settingsMap = {
      ai_auth_mode: "codex",
      ai_model: "gpt-6-luna",
      ai_setup_seen: "true",
    };

    await act(async () => {
      root.render(
        <SettingsView section="ai" onSelectSection={vi.fn()} onClose={vi.fn()} />,
      );
    });
    await flush();

    // 1) Round-trip Codex -> API -> Codex keeps Luna on Chat and Explain.
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="connection-option-api"]')!.click();
    });
    await flush();
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="connection-option-agent"]')!.click();
    });
    await flush();

    expect(
      container.querySelector<HTMLButtonElement>('[data-testid="codex-feature-picker-chat"]')?.textContent,
    ).toBe("GPT-6 Luna · High");
    expect(
      container.querySelector<HTMLButtonElement>('[data-testid="codex-feature-picker-explain"]')?.textContent,
    ).toBe("GPT-6 Luna · High");

    // 2) Reset to legacy-only DB state, simulate a concurrent Reader save (Chat = Sol) while Settings holds stale snapshot, then clear Explain to Default.
    mocks.settingsMap = {
      ai_auth_mode: "codex",
      ai_model: "gpt-6-luna",
      ai_setup_seen: "true",
    };
    await act(async () => {
      root.unmount();
    });
    root = createRoot(container);
    await act(async () => {
      root.render(
        <SettingsView section="ai" onSelectSection={vi.fn()} onClose={vi.fn()} />,
      );
    });
    await flush();

    // Concurrent Reader write commits Chat=Sol directly in DB before Settings receives it.
    mocks.settingsMap.ai_codex_model_chat = "gpt-6.2-sol";

    const explainBtn = container.querySelector<HTMLButtonElement>(
      '[data-testid="codex-feature-picker-explain"]',
    )!;
    await act(async () => {
      explainBtn.click();
    });
    await act(async () => {
      document.querySelector<HTMLButtonElement>('[data-testid="codex-model-option-default"]')!.click();
    });
    await flush();

    expect(mocks.settingsMap.ai_codex_model_chat).toBe("gpt-6.2-sol");
    expect(mocks.settingsMap.ai_codex_model_explain).toBe("");
    expect(mocks.settingsMap.ai_codex_model_lookup).toBe("gpt-6-luna");
    expect(mocks.settingsMap.ai_codex_model_translate).toBe("gpt-6-luna");
    expect(explainBtn.textContent).toBe("GPT-6.1 Terra · High");
    expect(
      container.querySelector<HTMLButtonElement>('[data-testid="codex-feature-picker-chat"]')?.textContent,
    ).toBe("GPT-6.2 Sol · High");
  });

  it("preserves supported legacy reasoning fallback on model-only edit and sibling Default reset in SettingsView", async () => {
    const models: CodexModel[] = [
      {
        slug: "gpt-6-luna",
        display_name: "GPT-6 Luna",
        description: "",
        supported_reasoning_levels: ["medium", "high"],
        default_reasoning_level: "medium",
        is_default: false,
      },
      {
        slug: "gpt-6.1-terra",
        display_name: "GPT-6.1 Terra",
        description: "",
        supported_reasoning_levels: ["low", "medium", "high", "xhigh"],
        default_reasoning_level: "medium",
        is_default: false,
      },
      {
        slug: "gpt-6.2-sol",
        display_name: "GPT-6.2 Sol",
        description: "",
        supported_reasoning_levels: ["low", "medium", "high"],
        default_reasoning_level: "high",
        is_default: true,
      },
    ];
    const baseImpl = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation(async (cmd, args) => {
      if (cmd === "list_codex_models") return { models };
      return baseImpl(cmd, args);
    });

    // (a) Chat starts on Terra/xhigh with legacy deep=medium; model-only switch to Luna (medium/high)
    // keeps Chat on medium and leaves Explain/Translate on medium.
    mocks.settingsMap = {
      ai_auth_mode: "codex",
      ai_codex_model_chat: "gpt-6.1-terra",
      ai_codex_effort_chat: "xhigh",
      ai_effort_deep: "medium",
      ai_setup_seen: "true",
    };

    await act(async () => {
      root.render(<SettingsView section="ai" onSelectSection={vi.fn()} onClose={vi.fn()} />);
    });
    await flush();

    const chatBtn = container.querySelector<HTMLButtonElement>(
      '[data-testid="codex-feature-picker-chat"]',
    )!;
    const explainBtn = container.querySelector<HTMLButtonElement>(
      '[data-testid="codex-feature-picker-explain"]',
    )!;
    const translateBtn = container.querySelector<HTMLButtonElement>(
      '[data-testid="codex-feature-picker-translate"]',
    )!;

    expect(chatBtn.textContent).toBe("GPT-6.1 Terra · Extra high");
    await act(async () => {
      chatBtn.click();
    });
    await act(async () => {
      document.querySelector<HTMLButtonElement>('[data-testid="codex-model-option-gpt-6-luna"]')!.click();
    });
    await flush();

    expect(chatBtn.textContent).toBe("GPT-6 Luna · Medium");
    expect(explainBtn.textContent).toBe("GPT-6.1 Terra · Medium");
    expect(translateBtn.textContent).toBe("GPT-6.1 Terra · Medium");
    expect(mocks.settingsMap.ai_effort_deep).toBe("medium");
    expect(mocks.settingsMap.ai_codex_effort_chat).toBe("xhigh");

    // Switching straight back to Terra restores the explicit xhigh choice.
    await act(async () => {
      chatBtn.click();
    });
    await act(async () => {
      document.querySelector<HTMLButtonElement>('[data-testid="codex-model-option-gpt-6.1-terra"]')!.click();
    });
    await flush();
    expect(chatBtn.textContent).toBe("GPT-6.1 Terra · Extra high");
    expect(mocks.settingsMap.ai_codex_effort_chat).toBe("xhigh");

    // (a2) Concurrent effort save from another window is never clobbered when a still-open
    // reader picker selects a model.
    const lunaWithLowModels: CodexModel[] = [
      { ...models[0], supported_reasoning_levels: ["low", "medium", "high"] },
      models[1],
      models[2],
    ];
    mocks.invoke.mockImplementation(async (cmd, args) => {
      if (cmd === "list_codex_models") return { models: lunaWithLowModels };
      return baseImpl(cmd, args);
    });
    resetCodexModelsCacheForTests();
    mocks.settingsMap = {
      ai_auth_mode: "codex",
      ai_codex_model_chat: "gpt-6.1-terra",
      ai_codex_effort_chat: "xhigh",
      ai_effort_deep: "medium",
      ai_setup_seen: "true",
    };
    await act(async () => {
      root.unmount();
    });
    root = createRoot(container);
    await act(async () => {
      root.render(<AiPanel bookId="b1" bookTitle={SAMPLE_BOOK.title} />);
    });
    await flush();

    const readerPicker = container.querySelector<HTMLButtonElement>(
      '[data-testid="codex-composer-picker"]',
    )!;
    expect(readerPicker.textContent).toBe("GPT-6.1 Terra · extra high");
    await act(async () => {
      readerPicker.click();
    });

    // Another window saves a supported effort of "low" while the reader menu stays open.
    mocks.settingsMap.ai_codex_effort_chat = "low";

    await act(async () => {
      document.querySelector<HTMLButtonElement>('[data-testid="codex-model-option-gpt-6-luna"]')!.click();
    });
    await flush();

    // Choosing Luna wrote only ai_codex_model_chat, keeping the newer "low" effort intact.
    expect(mocks.settingsMap.ai_codex_model_chat).toBe("gpt-6-luna");
    expect(mocks.settingsMap.ai_codex_effort_chat).toBe("low");

    // Reconcile remote settings-changed event and confirm reader reflects GPT-6 Luna · low.
    await act(async () => {
      for (const cb of mocks.listeners.get("settings-changed") ?? []) {
        cb({ payload: ["ai_codex_effort_chat"] });
      }
    });
    await flush();
    expect(readerPicker.textContent).toBe("GPT-6 Luna · low");

    // Restore original Luna (medium/high) catalog for scenario (b).
    mocks.invoke.mockImplementation(async (cmd, args) => {
      if (cmd === "list_codex_models") return { models };
      return baseImpl(cmd, args);
    });
    resetCodexModelsCacheForTests();

    // (b) Saved Chat=xhigh on Luna (unsupported) with legacy deep=medium; resetting Explain
    // reasoning to Default resets Explain to High while untouched Chat and Translate keep Medium.
    mocks.settingsMap = {
      ai_auth_mode: "codex",
      ai_codex_model_chat: "gpt-6-luna",
      ai_codex_effort_chat: "xhigh",
      ai_effort_deep: "medium",
      ai_setup_seen: "true",
    };
    await act(async () => {
      root.unmount();
    });
    root = createRoot(container);
    await act(async () => {
      root.render(<SettingsView section="ai" onSelectSection={vi.fn()} onClose={vi.fn()} />);
    });
    await flush();

    const explainBtn2 = container.querySelector<HTMLButtonElement>(
      '[data-testid="codex-feature-picker-explain"]',
    )!;
    const chatBtn2 = container.querySelector<HTMLButtonElement>(
      '[data-testid="codex-feature-picker-chat"]',
    )!;
    const translateBtn2 = container.querySelector<HTMLButtonElement>(
      '[data-testid="codex-feature-picker-translate"]',
    )!;
    expect(chatBtn2.textContent).toBe("GPT-6 Luna · Medium");

    await act(async () => {
      explainBtn2.click();
    });
    await act(async () => {
      document.querySelector<HTMLButtonElement>('[data-testid="codex-effort-option-default"]')!.click();
    });
    await flush();

    expect(explainBtn2.textContent).toBe("GPT-6.1 Terra · High");
    expect(chatBtn2.textContent).toBe("GPT-6 Luna · Medium");
    expect(translateBtn2.textContent).toBe("GPT-6.1 Terra · Medium");

    // Explicit Default reasoning on Chat still resets Chat to High.
    await act(async () => {
      chatBtn2.click();
    });
    await act(async () => {
      document.querySelector<HTMLButtonElement>('[data-testid="codex-effort-option-default"]')!.click();
    });
    await flush();

    expect(chatBtn2.textContent).toBe("GPT-6 Luna · High");
    expect(translateBtn2.textContent).toBe("GPT-6.1 Terra · Medium");
  });

  it("invalidates cached catalog while unmounted and keeps a single subscription under StrictMode", async () => {
    mocks.settingsMap = {
      ai_auth_mode: "codex",
      ai_setup_seen: "true",
    };
    let catalog: CodexModel[] = SAMPLE_MODELS;
    let listCalls = 0;
    const baseImpl = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation(async (cmd, args) => {
      if (cmd === "list_codex_models") {
        listCalls += 1;
        return { models: catalog };
      }
      return baseImpl(cmd, args);
    });

    // Delay listen registration so StrictMode remount happens before the promise resolves.
    let resolveListenA: ((unlisten: () => void) => void) | null = null;
    const unlistenSpy = vi.fn();
    let catalogListenCalls = 0;
    const baseListen = mocks.listen.getMockImplementation()!;
    mocks.listen.mockImplementation((event, cb) => {
      if (event === "codex-catalog-invalidated") {
        catalogListenCalls += 1;
        let set = mocks.listeners.get(event);
        if (!set) {
          set = new Set();
          mocks.listeners.set(event, set);
        }
        set.add(cb);
        return new Promise<() => void>((resolve) => {
          resolveListenA = () =>
            resolve(() => {
              unlistenSpy();
              set!.delete(cb);
            });
        });
      }
      return baseListen(event, cb);
    });

    const booksById = new Map([[SAMPLE_BOOK.id, SAMPLE_BOOK]]);

    // Mount ChatsView under StrictMode -> only one invalidation subscription is created.
    await act(async () => {
      root.render(
        <StrictMode>
          <ChatsView
            booksById={booksById}
            onOpenSettings={vi.fn()}
            onNavigateToLibrary={vi.fn()}
          />
        </StrictMode>,
      );
    });
    await flush();
    expect(catalogListenCalls).toBe(1);
    expect(mocks.listeners.get("codex-catalog-invalidated")?.size).toBe(1);

    await act(async () => {
      resolveListenA?.(unlistenSpy);
    });
    await flush();
    expect(unlistenSpy).not.toHaveBeenCalled();

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="codex-composer-picker"]')!.click();
    });
    expect(document.querySelector('[data-testid="codex-model-option-gpt-6-luna"]')).not.toBeNull();
    expect(listCalls).toBe(1);

    // Navigate away to Library (unmount all Codex pickers in this renderer).
    await act(async () => {
      root.unmount();
    });

    // Account B signs in from another window while no picker is mounted, removing Luna.
    catalog = [SAMPLE_MODELS[0]];
    await act(async () => {
      for (const cb of mocks.listeners.get("codex-catalog-invalidated") ?? []) {
        cb({ payload: { epoch: 2 } });
      }
    });

    // Return to Chats -> refetches fresh catalog without Luna, still only 1 subscription total.
    root = createRoot(container);
    await act(async () => {
      root.render(
        <StrictMode>
          <ChatsView
            booksById={booksById}
            onOpenSettings={vi.fn()}
            onNavigateToLibrary={vi.fn()}
          />
        </StrictMode>,
      );
    });
    await flush();

    expect(catalogListenCalls).toBe(1);
    expect(listCalls).toBe(2);
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="codex-composer-picker"]')!.click();
    });
    expect(document.querySelector('[data-testid="codex-model-option-gpt-6-luna"]')).toBeNull();
    expect(document.querySelector('[data-testid="codex-model-option-gpt-6.2-sol"]')).not.toBeNull();
  });
});
