/** @vitest-environment jsdom */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CodexModel, CodexStatus } from "../../lib/aiConnections";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn<(command: string, args?: Record<string, unknown>) => Promise<unknown>>(),
  openFileDialog: vi.fn<() => Promise<string | null>>(),
  openUrl: vi.fn<(url: string) => Promise<void>>(),
}));

vi.mock("../../platform", () => ({
  invoke: (command: string, args?: Record<string, unknown>) =>
    args !== undefined ? mocks.invoke(command, args) : mocks.invoke(command),
  listen: vi.fn(async () => () => {}),
  openFileDialog: () => mocks.openFileDialog(),
  openUrl: (url: string) => mocks.openUrl(url),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) =>
      params && Object.keys(params).length > 0 ? `${key}:${JSON.stringify(params)}` : key,
  }),
}));

import AiSettings from "./AiSettings";
import { resetCodexModelsCacheForTests } from "../../hooks/useCodexModels";

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

const SAMPLE_CODEX_MODELS: CodexModel[] = [
  {
    slug: "gpt-6.2-sol",
    display_name: "GPT-6.2 Sol",
    description: "Default balanced Codex model",
    supported_reasoning_levels: ["low", "medium", "high"],
    default_reasoning_level: "low",
    is_default: true,
  },
  {
    slug: "gpt-6.1-terra",
    display_name: "GPT-6.1 Terra",
    description: "Mid-size reasoning model",
    supported_reasoning_levels: ["low", "medium", "high", "xhigh"],
    default_reasoning_level: "medium",
    is_default: false,
  },
  {
    slug: "gpt-6-luna",
    display_name: "GPT-6 Luna",
    description: "Fast lightweight Codex model",
    supported_reasoning_levels: ["low", "medium", "high", "xhigh", "max"],
    default_reasoning_level: "medium",
    is_default: false,
  },
];

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function buttonContaining(text: string): HTMLButtonElement | undefined {
  return [...document.querySelectorAll("button")].find((b) => b.textContent?.includes(text));
}

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("AiSettings (#326 Agent/API connections)", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    resetCodexModelsCacheForTests();
    mocks.invoke.mockReset();
    mocks.openFileDialog.mockReset();
    mocks.openUrl.mockReset().mockResolvedValue(undefined);
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

  async function render(
    settings: Record<string, string>,
    opts?: { initialConnection?: "agent" | "api"; refreshNonce?: number },
  ) {
    const save = vi.fn().mockResolvedValue(undefined);
    const saveBulk = vi.fn().mockResolvedValue(undefined);
    const showSavedToast = vi.fn();
    await act(async () => {
      root.render(
        <AiSettings
          settings={settings}
          loading={false}
          save={save}
          saveBulk={saveBulk}
          showSavedToast={showSavedToast}
          initialConnection={opts?.initialConnection}
          refreshNonce={opts?.refreshNonce ?? 0}
        />,
      );
      await Promise.resolve();
    });
    await flush();
    return { save, saveBulk, showSavedToast };
  }

  it("shows Codex ready state, four per-feature family defaults, and hides Temperature on Agent", async () => {
    mocks.invoke.mockImplementation(async (cmd) => {
      if (cmd === "codex_status") return READY_STATUS;
      if (cmd === "list_codex_models") return { models: SAMPLE_CODEX_MODELS };
      return undefined;
    });

    const { save } = await render({
      ai_auth_mode: "codex",
    });

    const agentRadio = container.querySelector('[data-testid="connection-option-agent"]');
    expect(agentRadio?.getAttribute("aria-checked")).toBe("true");

    const statusRow = container.querySelector('[data-testid="codex-status-row"]');
    expect(statusRow?.textContent).toContain("reader@example.com · ChatGPT Pro · Codex 0.170.0");
    expect(statusRow?.textContent).toContain("settings.ai.codex.ready");

    const locationRow = container.querySelector('[data-testid="codex-location-row"]');
    expect(locationRow?.textContent).toContain("/opt/homebrew/bin/codex");

    // Temperature is API-only and must not appear under Agent.
    expect(container.textContent).not.toContain("settings.ai.temperature");

    // Four feature rows show family defaults resolved from the live catalog.
    const lookupBtn = container.querySelector<HTMLButtonElement>(
      '[data-testid="codex-feature-picker-lookup"]',
    )!;
    const explainBtn = container.querySelector<HTMLButtonElement>(
      '[data-testid="codex-feature-picker-explain"]',
    )!;
    const chatBtn = container.querySelector<HTMLButtonElement>(
      '[data-testid="codex-feature-picker-chat"]',
    )!;
    const translateBtn = container.querySelector<HTMLButtonElement>(
      '[data-testid="codex-feature-picker-translate"]',
    )!;
    expect(lookupBtn.textContent).toBe("GPT-6 Luna · low");
    expect(explainBtn.textContent).toBe("GPT-6.1 Terra · high");
    expect(chatBtn.textContent).toBe("GPT-6.2 Sol · high");
    expect(translateBtn.textContent).toBe("GPT-6.1 Terra · medium");

    // Open Explain's menu: Default model and Default (High) reasoning are marked checked.
    await act(async () => {
      explainBtn.click();
    });
    const explainMenu = document.querySelector('[data-testid="codex-feature-menu-explain"]')!;
    expect(explainMenu).not.toBeNull();
    expect(
      explainMenu.querySelector('[data-testid="codex-model-option-default"]')?.getAttribute("aria-checked"),
    ).toBe("true");
    expect(
      explainMenu.querySelector('[data-testid="codex-effort-option-default"]')?.getAttribute("aria-checked"),
    ).toBe("true");

    // Save a model on Explain -> writes only ai_codex_model_explain, leaving other rows untouched.
    const lunaOption = explainMenu.querySelector<HTMLButtonElement>(
      '[data-testid="codex-model-option-gpt-6-luna"]',
    )!;
    await act(async () => {
      lunaOption.click();
    });
    expect(save).toHaveBeenCalledWith("ai_codex_model_explain", "gpt-6-luna");
    expect(explainBtn.textContent).toBe("GPT-6 Luna · high");
    expect(chatBtn.textContent).toBe("GPT-6.2 Sol · high");

    // Save a reasoning level on Explain -> writes only ai_codex_effort_explain.
    await act(async () => {
      explainBtn.click();
    });
    const xhighOption = document.querySelector<HTMLButtonElement>(
      '[data-testid="codex-effort-option-xhigh"]',
    )!;
    await act(async () => {
      xhighOption.click();
    });
    expect(save).toHaveBeenCalledWith("ai_codex_effort_explain", "xhigh");
    expect(explainBtn.textContent).toBe("GPT-6 Luna · xhigh");

    // Clearing model and reasoning to Default clears each key to "".
    await act(async () => {
      explainBtn.click();
    });
    await act(async () => {
      document.querySelector<HTMLButtonElement>('[data-testid="codex-model-option-default"]')!.click();
    });
    expect(save).toHaveBeenCalledWith("ai_codex_model_explain", "");
    expect(explainBtn.textContent).toBe("GPT-6.1 Terra · xhigh");

    await act(async () => {
      explainBtn.click();
    });
    await act(async () => {
      document.querySelector<HTMLButtonElement>('[data-testid="codex-effort-option-default"]')!.click();
    });
    expect(save).toHaveBeenCalledWith("ai_codex_effort_explain", "");
    expect(explainBtn.textContent).toBe("GPT-6.1 Terra · high");
  });

  it("renders all Codex status states: checking, not_signed_in, signing_in, not_installed, too_old, failed", async () => {
    // 1) Checking
    const pending = deferred<CodexStatus>();
    mocks.invoke.mockImplementation((cmd) => {
      if (cmd === "codex_status") return pending.promise;
      return Promise.resolve(undefined);
    });
    await render({ ai_auth_mode: "codex" });
    expect(container.querySelector('[data-testid="codex-status-row"]')?.textContent).toContain(
      "settings.ai.codex.checking",
    );

    // 2) Not signed in -> Sign in with ChatGPT -> Signing in -> Cancel
    const loginPending = deferred<{ success: boolean; error: string | null }>();
    mocks.invoke.mockImplementation((cmd) => {
      if (cmd === "codex_status") {
        return Promise.resolve({ ...READY_STATUS, state: "not_signed_in", email: null, plan: null });
      }
      if (cmd === "codex_login") return loginPending.promise;
      if (cmd === "codex_login_cancel") return Promise.resolve(undefined);
      return Promise.resolve(undefined);
    });
    await render({ ai_auth_mode: "codex" }, { refreshNonce: 1 });
    const signInBtn = buttonContaining("settings.ai.signInWithChatGpt");
    expect(signInBtn).toBeDefined();
    await act(async () => {
      signInBtn!.click();
    });
    expect(container.querySelector('[data-testid="codex-status-row"]')?.textContent).toContain(
      "settings.ai.codex.waitingForBrowser",
    );
    const cancelBtn = buttonContaining("common.cancel");
    expect(cancelBtn).toBeDefined();
    await act(async () => {
      cancelBtn!.click();
    });
    expect(mocks.invoke).toHaveBeenCalledWith("codex_login_cancel");

    // 3) Not installed
    mocks.invoke.mockImplementation(async (cmd) => {
      if (cmd === "codex_status") {
        return { ...READY_STATUS, state: "not_installed", version: null, path: null, email: null, plan: null };
      }
      return undefined;
    });
    await render({ ai_auth_mode: "codex" }, { refreshNonce: 2 });
    const notInstalledRow = container.querySelector('[data-testid="codex-status-row"]');
    expect(notInstalledRow?.textContent).toContain("settings.ai.codex.copyCommand");
    expect(notInstalledRow?.textContent).toContain("settings.ai.codex.installGuide");
    expect(notInstalledRow?.textContent).toContain("settings.ai.codex.checkAgain");

    const guideBtn = buttonContaining("settings.ai.codex.installGuide");
    await act(async () => {
      guideBtn!.click();
    });
    expect(mocks.openUrl).toHaveBeenCalledWith("https://developers.openai.com/codex/cli");

    // 4) Too old
    mocks.invoke.mockImplementation(async (cmd) => {
      if (cmd === "codex_status") {
        return { ...READY_STATUS, state: "too_old", version: "0.141.2", email: null, plan: null };
      }
      return undefined;
    });
    await render({ ai_auth_mode: "codex" }, { refreshNonce: 3 });
    const tooOldRow = container.querySelector('[data-testid="codex-status-row"]');
    expect(tooOldRow?.textContent).toContain("settings.ai.codex.updateNeeded");
    expect(tooOldRow?.textContent).toContain("0.141.2");

    // 5) Failed to start
    mocks.invoke.mockImplementation(async (cmd) => {
      if (cmd === "codex_status") {
        return {
          ...READY_STATUS,
          state: "failed",
          email: null,
          plan: null,
          error: "codex app-server exited: bad config",
        };
      }
      return undefined;
    });
    await render({ ai_auth_mode: "codex" }, { refreshNonce: 4 });
    const failedRow = container.querySelector('[data-testid="codex-status-row"]');
    expect(failedRow?.textContent).toContain("settings.ai.codex.errorBadge");
    expect(failedRow?.textContent).toContain("codex app-server exited: bad config");
    expect(failedRow?.textContent).toContain("settings.ai.retry");
  });

  it("opens saved API-key and Ollama configs on API with presets, /models listing, and Temperature", async () => {
    mocks.invoke.mockImplementation(async (cmd, args) => {
      if (cmd === "codex_status") return READY_STATUS;
      if (cmd === "list_api_models") {
        if (args?.provider === "openrouter") {
          return { models: ["deepseek/deepseek-v4", "openai/gpt-4o"] };
        }
        return Promise.reject(new Error("offline"));
      }
      if (cmd === "check_ollama_status") {
        return { running: true, models: 6 };
      }
      return undefined;
    });

    // OpenRouter with /models listing
    const { saveBulk } = await render({
      ai_auth_mode: "api_key",
      ai_provider: "openrouter",
      ai_base_url: "https://openrouter.ai/api/v1",
      ai_api_key: "sk-or-test",
      ai_model: "deepseek/deepseek-v4",
    });

    expect(
      container.querySelector('[data-testid="connection-option-api"]')?.getAttribute("aria-checked"),
    ).toBe("true");
    // Collapsed Agent row shows Ready badge.
    expect(container.querySelector('[data-testid="connection-option-agent"]')?.textContent).toContain(
      "settings.ai.codex.ready",
    );
    // Temperature stepper is shown for API.
    expect(container.textContent).toContain("settings.ai.temperature");
    // Model picker populated from /models.
    const modelBtn = container.querySelector<HTMLButtonElement>(
      'button[aria-label="settings.ai.model"]',
    );
    expect(modelBtn?.textContent).toContain("deepseek/deepseek-v4");

    // Switch service to Ollama via the Service menu -> hides API key, fills versioned Ollama URL
    const serviceBtn = container.querySelector<HTMLButtonElement>(
      'button[aria-label="settings.ai.service"]',
    )!;
    await act(async () => {
      serviceBtn.click();
    });
    const ollamaOption = buttonContaining("settings.ai.providers.ollama");
    expect(ollamaOption).toBeDefined();
    await act(async () => {
      ollamaOption!.click();
    });
    await flush();

    expect(saveBulk).toHaveBeenCalledWith(
      expect.objectContaining({
        ai_auth_mode: "api_key",
        ai_provider: "ollama",
        ai_base_url: "http://localhost:11434/v1",
        ai_api_key: "",
      }),
    );
    expect(container.querySelector('input[aria-label="settings.ai.apiKey"]')).toBeNull();
    expect(container.textContent).toContain("settings.ai.connectedBadge");
    expect(container.textContent).toContain("settings.ai.ollamaReachableWithCount");
    // When /models fails for Ollama, falls back to free-text input.
    expect(container.querySelector('input[aria-label="settings.ai.model"]')).not.toBeNull();
  });

  it("persists Codex location override via Change… before re-probing", async () => {
    const callOrder: string[] = [];
    mocks.openFileDialog.mockResolvedValue("/custom/bin/codex");
    mocks.invoke.mockImplementation(async (cmd) => {
      callOrder.push(cmd);
      if (cmd === "codex_status") return READY_STATUS;
      if (cmd === "list_codex_models") return { models: SAMPLE_CODEX_MODELS };
      return undefined;
    });

    const save = vi.fn().mockImplementation(async (k: string, v: string) => {
      callOrder.push(`save:${k}=${v}`);
    });
    await act(async () => {
      root.render(
        <AiSettings
          settings={{ ai_auth_mode: "codex" }}
          loading={false}
          save={save}
          saveBulk={vi.fn().mockResolvedValue(undefined)}
          showSavedToast={vi.fn()}
        />,
      );
      await Promise.resolve();
    });
    await flush();
    callOrder.length = 0;

    const changeBtn = buttonContaining("settings.ai.codex.changeLocation")!;
    await act(async () => {
      changeBtn.click();
      await Promise.resolve();
    });
    await flush();

    expect(callOrder[0]).toBe("save:ai_codex_path=/custom/bin/codex");
    expect(callOrder).toContain("codex_status");
  });

  it("opens on API when initialConnection='api' without auto-saving Codex", async () => {
    mocks.invoke.mockImplementation(async (cmd) => {
      if (cmd === "codex_status") return READY_STATUS;
      return undefined;
    });
    const { saveBulk } = await render({}, { initialConnection: "api" });
    expect(
      container.querySelector('[data-testid="connection-option-api"]')?.getAttribute("aria-checked"),
    ).toBe("true");
    expect(saveBulk).not.toHaveBeenCalled();
  });

  it("clears the API key on cross-origin Base URL edits, keeps it on same-origin edits, and drops stale /models results on key clear", async () => {
    const staleList = deferred<{ models: string[] }>();
    let useDeferredList = false;

    mocks.invoke.mockImplementation((cmd, args) => {
      if (cmd === "codex_status") return Promise.resolve(READY_STATUS);
      if (cmd === "list_api_models") {
        if (useDeferredList) return staleList.promise;
        if (args?.baseUrl === "https://api.openai.com/v1") {
          return Promise.resolve({ models: ["gpt-4o", "gpt-4.1"] });
        }
        if (args?.baseUrl === "https://api.openai.com/v2") {
          return Promise.resolve({ models: ["gpt-4.1-v2"] });
        }
        if (args?.baseUrl === "https://other.example/v1") {
          return Promise.resolve({ models: ["other-model"] });
        }
        return Promise.resolve({ models: [] });
      }
      return Promise.resolve(undefined);
    });

    const { save, saveBulk } = await render({
      ai_auth_mode: "api_key",
      ai_provider: "openai",
      ai_base_url: "https://api.openai.com/v1",
      ai_api_key: "sk-live",
      ai_model: "gpt-4o",
    });

    // Automatic model listing omits apiKey so Rust resolves the origin-bound secret.
    expect(mocks.invoke).toHaveBeenCalledWith("list_api_models", {
      provider: "openai",
      baseUrl: "https://api.openai.com/v1",
    });

    const baseUrlInput = container.querySelector<HTMLInputElement>(
      'input[aria-label="settings.ai.baseUrl"]',
    )!;
    const apiKeyInput = container.querySelector<HTMLInputElement>(
      'input[aria-label="settings.ai.apiKey"]',
    )!;

    // 1) Same-origin path change preserves the saved API key and fetches /models without passing apiKey.
    mocks.invoke.mockClear();
    await act(async () => {
      setInputValue(baseUrlInput, "https://api.openai.com/v2");
      baseUrlInput.focus();
      baseUrlInput.blur();
    });
    await flush();

    expect(save).toHaveBeenCalledWith("ai_base_url", "https://api.openai.com/v2");
    expect(saveBulk).not.toHaveBeenCalled();
    expect(apiKeyInput.value).toBe("sk-live");
    expect(mocks.invoke).toHaveBeenCalledWith("list_api_models", {
      provider: "openai",
      baseUrl: "https://api.openai.com/v2",
    });

    // 2) Cross-origin change clears the saved API key before any /models call can run.
    mocks.invoke.mockClear();
    await act(async () => {
      setInputValue(baseUrlInput, "https://other.example/v1");
      baseUrlInput.focus();
      baseUrlInput.blur();
    });
    await flush();

    expect(saveBulk).toHaveBeenCalledWith(
      expect.objectContaining({
        ai_auth_mode: "api_key",
        ai_provider: "openai",
        ai_base_url: "https://other.example/v1",
        ai_api_key: "",
      }),
    );
    expect(apiKeyInput.value).toBe("");
    const listCallsAfterCrossOrigin = mocks.invoke.mock.calls.filter(
      ([cmd]) => cmd === "list_api_models",
    );
    expect(listCallsAfterCrossOrigin).toHaveLength(0);

    // 3) Entering a fresh key on the new origin commits the key and fetches /models without passing apiKey,
    //    and clearing the key while a fetch is in flight invalidates the stale response.
    useDeferredList = true;
    mocks.invoke.mockClear();
    await act(async () => {
      setInputValue(apiKeyInput, "sk-other");
      apiKeyInput.focus();
      apiKeyInput.blur();
    });
    await flush();

    expect(mocks.invoke).toHaveBeenCalledWith("list_api_models", {
      provider: "openai",
      baseUrl: "https://other.example/v1",
    });

    const clearBtn = container.querySelector<HTMLButtonElement>(
      'button[aria-label="settings.ai.clear"]',
    )!;
    expect(clearBtn).not.toBeNull();
    await act(async () => {
      clearBtn.click();
    });
    await flush();

    await act(async () => {
      staleList.resolve({ models: ["stale-model-from-cleared-key"] });
    });
    await flush();

    // Model picker must NOT appear with stale models after the key was cleared.
    expect(container.querySelector('button[aria-label="settings.ai.model"]')).toBeNull();
    expect(container.textContent).not.toContain("stale-model-from-cleared-key");
  });

  it("resets unsupported per-feature effort on model switch, hides unsupported levels, and supports custom model IDs", async () => {
    mocks.invoke.mockImplementation(async (cmd) => {
      if (cmd === "codex_status") return READY_STATUS;
      if (cmd === "list_codex_models") return { models: SAMPLE_CODEX_MODELS };
      return undefined;
    });

    const { save, saveBulk } = await render({
      ai_auth_mode: "codex",
      ai_codex_model_explain: "gpt-6-luna",
      ai_codex_effort_explain: "max",
    });

    // Switch Explain from gpt-6-luna (supports max) to gpt-6.2-sol (supports low/medium/high).
    const explainBtn = container.querySelector<HTMLButtonElement>(
      '[data-testid="codex-feature-picker-explain"]',
    )!;
    expect(explainBtn.textContent).toBe("GPT-6 Luna · max");

    await act(async () => {
      explainBtn.click();
    });
    await act(async () => {
      document.querySelector<HTMLButtonElement>('[data-testid="codex-model-option-gpt-6.2-sol"]')!.click();
    });
    await flush();

    expect(save).toHaveBeenCalledWith("ai_codex_model_explain", "gpt-6.2-sol");
    expect(saveBulk).not.toHaveBeenCalled();
    expect(explainBtn.textContent).toBe("GPT-6.2 Sol · high");

    // Explain's menu now marks Default (High) and hides unsupported tiers (xhigh/max).
    await act(async () => {
      explainBtn.click();
    });
    expect(
      document.querySelector('[data-testid="codex-effort-option-default"]')?.getAttribute("aria-checked"),
    ).toBe("true");
    expect(document.querySelector('[data-testid="codex-effort-option-max"]')).toBeNull();
    expect(document.querySelector('[data-testid="codex-effort-option-xhigh"]')).toBeNull();
    expect(document.querySelector('[data-testid="codex-effort-option-high"]')).not.toBeNull();

    // Switching straight back to gpt-6-luna preserves the explicit max choice.
    await act(async () => {
      document.querySelector<HTMLButtonElement>('[data-testid="codex-model-option-gpt-6-luna"]')!.click();
    });
    await flush();
    expect(save).toHaveBeenCalledWith("ai_codex_model_explain", "gpt-6-luna");
    expect(explainBtn.textContent).toBe("GPT-6 Luna · max");

    // Pick Custom… -> reveals per-feature custom input, saves custom slug on blur, and keeps fallback effort levels including max.
    await act(async () => {
      explainBtn.click();
    });
    await act(async () => {
      document.querySelector<HTMLButtonElement>('[data-testid="codex-model-option-custom"]')!.click();
    });
    const customInput = container.querySelector<HTMLInputElement>(
      '[data-testid="codex-custom-model-input-explain"]',
    )!;
    expect(customInput).not.toBeNull();

    await act(async () => {
      setInputValue(customInput, "my-custom-codex");
      customInput.focus();
      customInput.blur();
    });
    await flush();

    expect(save).toHaveBeenCalledWith("ai_codex_model_explain", "my-custom-codex");
    expect(explainBtn.textContent).toBe("my-custom-codex · max");

    await act(async () => {
      explainBtn.click();
    });
    expect(
      document.querySelector('[data-testid="codex-model-option-custom"]')?.getAttribute("aria-checked"),
    ).toBe("true");
    expect(document.querySelector('[data-testid="codex-effort-option-max"]')).not.toBeNull();
    await act(async () => {
      document.querySelector<HTMLButtonElement>('[data-testid="codex-effort-option-low"]')!.click();
    });
    expect(save).toHaveBeenCalledWith("ai_codex_effort_explain", "low");
    expect(explainBtn.textContent).toBe("my-custom-codex · low");
  });

  it("sends minimal Default clear without sibling writes and preserves legacy Luna across an API round-trip", async () => {
    mocks.invoke.mockImplementation(async (cmd) => {
      if (cmd === "codex_status") return READY_STATUS;
      if (cmd === "list_codex_models") return { models: SAMPLE_CODEX_MODELS };
      return undefined;
    });

    const { save, saveBulk } = await render({
      ai_auth_mode: "codex",
      ai_model: "gpt-6-luna",
      ai_effort_deep: "medium",
    });

    const explainBtn = container.querySelector<HTMLButtonElement>(
      '[data-testid="codex-feature-picker-explain"]',
    )!;
    const chatBtn = container.querySelector<HTMLButtonElement>(
      '[data-testid="codex-feature-picker-chat"]',
    )!;
    expect(explainBtn.textContent).toBe("GPT-6 Luna · medium");
    expect(chatBtn.textContent).toBe("GPT-6 Luna · medium");

    // Switching Codex -> API -> Codex preserves carried-over Luna on untouched rows.
    const apiRadio = container.querySelector<HTMLButtonElement>('[data-testid="connection-option-api"]')!;
    const agentRadio = container.querySelector<HTMLButtonElement>('[data-testid="connection-option-agent"]')!;
    await act(async () => {
      apiRadio.click();
    });
    await flush();
    await act(async () => {
      agentRadio.click();
    });
    await flush();

    const explainAfter = container.querySelector<HTMLButtonElement>(
      '[data-testid="codex-feature-picker-explain"]',
    )!;
    const chatAfter = container.querySelector<HTMLButtonElement>(
      '[data-testid="codex-feature-picker-chat"]',
    )!;
    expect(explainAfter.textContent).toBe("GPT-6 Luna · medium");
    expect(chatAfter.textContent).toBe("GPT-6 Luna · medium");
    expect(saveBulk).toHaveBeenCalledWith(
      expect.objectContaining({ ai_auth_mode: "api_key", ai_model: "gpt-4o" }),
    );
    expect(saveBulk).toHaveBeenCalledWith(
      expect.objectContaining({ ai_auth_mode: "codex", ai_model: "" }),
    );

    // Clearing Explain to Default sends ONLY ai_codex_model_explain="" (no stale sibling writes).
    await act(async () => {
      explainAfter.click();
    });
    await act(async () => {
      document.querySelector<HTMLButtonElement>('[data-testid="codex-model-option-default"]')!.click();
    });
    expect(save).toHaveBeenCalledWith("ai_codex_model_explain", "");
    expect(explainAfter.textContent).toBe("GPT-6.1 Terra · medium");
    expect(chatAfter.textContent).toBe("GPT-6 Luna · medium");
  });

  it("clears settled custom model UI when a remote composer changes Chat to a catalog model", async () => {
    mocks.invoke.mockImplementation(async (cmd) => {
      if (cmd === "codex_status") return READY_STATUS;
      if (cmd === "list_codex_models") return { models: SAMPLE_CODEX_MODELS };
      return undefined;
    });

    const save = vi.fn().mockResolvedValue(undefined);
    const saveBulk = vi.fn().mockResolvedValue(undefined);
    const showSavedToast = vi.fn();

    await act(async () => {
      root.render(
        <AiSettings
          settings={{ ai_auth_mode: "codex" }}
          loading={false}
          save={save}
          saveBulk={saveBulk}
          showSavedToast={showSavedToast}
        />,
      );
      await Promise.resolve();
    });
    await flush();

    // Save a custom Chat model in Settings.
    const chatBtn = container.querySelector<HTMLButtonElement>(
      '[data-testid="codex-feature-picker-chat"]',
    )!;
    await act(async () => {
      chatBtn.click();
    });
    await act(async () => {
      document.querySelector<HTMLButtonElement>('[data-testid="codex-model-option-custom"]')!.click();
    });
    const customInput = container.querySelector<HTMLInputElement>(
      '[data-testid="codex-custom-model-input-chat"]',
    )!;
    await act(async () => {
      setInputValue(customInput, "my-custom-chat");
      customInput.focus();
      customInput.blur();
    });
    await flush();
    expect(save).toHaveBeenCalledWith("ai_codex_model_chat", "my-custom-chat");
    expect(
      container.querySelector('[data-testid="codex-custom-model-input-chat"]'),
    ).not.toBeNull();

    // Leave Settings mounted; reader composer saves Chat = gpt-6-luna.
    await act(async () => {
      root.render(
        <AiSettings
          settings={{ ai_auth_mode: "codex", ai_codex_model_chat: "gpt-6-luna" }}
          loading={false}
          save={save}
          saveBulk={saveBulk}
          showSavedToast={showSavedToast}
        />,
      );
      await Promise.resolve();
    });
    await flush();

    expect(chatBtn.textContent).toBe("GPT-6 Luna · high");
    expect(container.querySelector('[data-testid="codex-custom-model-input-chat"]')).toBeNull();
    await act(async () => {
      chatBtn.click();
    });
    expect(
      document.querySelector('[data-testid="codex-model-option-gpt-6-luna"]')?.getAttribute("aria-checked"),
    ).toBe("true");
    expect(
      document.querySelector('[data-testid="codex-model-option-custom"]')?.getAttribute("aria-checked"),
    ).toBe("false");
  });

  it("refetches the Codex catalog once per active account on a same-path sign-in switch", async () => {
    let activeAccount: "a" | "signed_out" | "b" = "a";
    let listCalls = 0;

    mocks.invoke.mockImplementation(async (cmd) => {
      if (cmd === "codex_status") {
        if (activeAccount === "a") {
          return { ...READY_STATUS, email: "a@example.com", plan: "pro" };
        }
        if (activeAccount === "signed_out") {
          return { ...READY_STATUS, state: "not_signed_in", email: null, plan: null };
        }
        return { ...READY_STATUS, email: "b@example.com", plan: "plus" };
      }
      if (cmd === "codex_login") {
        activeAccount = "b";
        return { success: true, error: null };
      }
      if (cmd === "list_codex_models") {
        listCalls += 1;
        if (activeAccount === "b") {
          return { models: [SAMPLE_CODEX_MODELS[0]] }; // Account B has no Luna
        }
        return { models: SAMPLE_CODEX_MODELS };
      }
      return undefined;
    });

    // Account A ready -> 1 catalog fetch, Luna is listed.
    await render({ ai_auth_mode: "codex" }, { refreshNonce: 0 });
    expect(listCalls).toBe(1);
    const lookupBtn = container.querySelector<HTMLButtonElement>(
      '[data-testid="codex-feature-picker-lookup"]',
    )!;
    expect(lookupBtn.textContent).toBe("GPT-6 Luna · low");

    // Re-probe while signed out (enabled becomes false).
    activeAccount = "signed_out";
    await render({ ai_auth_mode: "codex" }, { refreshNonce: 1 });
    expect(listCalls).toBe(1);

    // Sign in as Account B at the same executable path -> cache invalidated, 1 fetch for B, Luna gone.
    const signInBtn = buttonContaining("settings.ai.signInWithChatGpt")!;
    await act(async () => {
      signInBtn.click();
    });
    await flush();

    expect(listCalls).toBe(2);
    expect(lookupBtn.textContent).toBe("GPT-6.2 Sol · low");
    await act(async () => {
      lookupBtn.click();
    });
    expect(document.querySelector('[data-testid="codex-model-option-gpt-6-luna"]')).toBeNull();
    expect(document.querySelector('[data-testid="codex-model-option-gpt-6.2-sol"]')).not.toBeNull();
  });

  it("keeps the custom model input focused through debounce when the catalog is empty and settles on Enter/blur", async () => {
    vi.useFakeTimers();
    try {
      mocks.invoke.mockImplementation(async (cmd) => {
        if (cmd === "codex_status") {
          return { ...READY_STATUS, state: "not_signed_in", email: null, plan: null };
        }
        if (cmd === "list_codex_models") {
          return { models: [] };
        }
        return undefined;
      });

      const { save } = await render({ ai_auth_mode: "codex" });

      const explainBtn = container.querySelector<HTMLButtonElement>(
        '[data-testid="codex-feature-picker-explain"]',
      )!;
      await act(async () => {
        explainBtn.click();
      });
      await act(async () => {
        document.querySelector<HTMLButtonElement>('[data-testid="codex-model-option-custom"]')!.click();
      });

      const customInput = container.querySelector<HTMLInputElement>(
        '[data-testid="codex-custom-model-input-explain"]',
      )!;
      expect(customInput).not.toBeNull();
      customInput.focus();

      // Type part of a model ID and pause past the 450ms debounce autosave.
      await act(async () => {
        setInputValue(customInput, "my-mo");
      });
      await act(async () => {
        vi.advanceTimersByTime(500);
      });

      expect(save).toHaveBeenCalledWith("ai_codex_model_explain", "my-mo");
      // Input must remain mounted and focused with the user's draft intact.
      const stillOpen = container.querySelector<HTMLInputElement>(
        '[data-testid="codex-custom-model-input-explain"]',
      );
      expect(stillOpen).toBe(customInput);
      expect(document.activeElement).toBe(customInput);
      expect(stillOpen?.value).toBe("my-mo");

      // Continue typing and press Enter -> commits final value and settles the editor.
      await act(async () => {
        setInputValue(customInput, "my-model");
      });
      await act(async () => {
        customInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      });

      expect(save).toHaveBeenCalledWith("ai_codex_model_explain", "my-model");
      expect(explainBtn.textContent).toBe("my-model · high");
      expect(
        container.querySelector('[data-testid="codex-custom-model-input-explain"]'),
      ).toBeNull();

      // Re-opening Custom… while catalog is still empty pre-fills the saved model ID,
      // and blurring after debounce settles the editor cleanly.
      await act(async () => {
        explainBtn.click();
      });
      await act(async () => {
        document.querySelector<HTMLButtonElement>('[data-testid="codex-model-option-custom"]')!.click();
      });
      const reopenedInput = container.querySelector<HTMLInputElement>(
        '[data-testid="codex-custom-model-input-explain"]',
      )!;
      expect(reopenedInput.value).toBe("my-model");
      reopenedInput.focus();
      await act(async () => {
        setInputValue(reopenedInput, "my-model-v2");
      });
      await act(async () => {
        vi.advanceTimersByTime(500);
      });
      expect(save).toHaveBeenCalledWith("ai_codex_model_explain", "my-model-v2");
      expect(
        container.querySelector('[data-testid="codex-custom-model-input-explain"]'),
      ).toBe(reopenedInput);
      await act(async () => {
        reopenedInput.blur();
      });
      expect(
        container.querySelector('[data-testid="codex-custom-model-input-explain"]'),
      ).toBeNull();
      expect(explainBtn.textContent).toBe("my-model-v2 · high");
    } finally {
      vi.useRealTimers();
    }
  });
});
