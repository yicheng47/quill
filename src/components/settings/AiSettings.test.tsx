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
    slug: "gpt-6-luna",
    display_name: "GPT-6-Luna",
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

  it("shows Codex ready state, live models, effort tiers, and hides Temperature on Agent", async () => {
    mocks.invoke.mockImplementation(async (cmd) => {
      if (cmd === "codex_status") return READY_STATUS;
      if (cmd === "list_codex_models") return { models: SAMPLE_CODEX_MODELS };
      return undefined;
    });

    const { saveBulk } = await render({
      ai_auth_mode: "codex",
      ai_model: "gpt-6.2-sol",
      ai_effort_quick: "low",
      ai_effort_deep: "medium",
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

    // Live model catalog populates the Model picker.
    const modelBtn = container.querySelector<HTMLButtonElement>(
      'button[aria-label="settings.ai.model"]',
    )!;
    expect(modelBtn.textContent).toContain("GPT-6.2 Sol");

    await act(async () => {
      modelBtn.click();
    });
    const lunaOption = buttonContaining("GPT-6-Luna");
    expect(lunaOption).toBeDefined();
    await act(async () => {
      lunaOption!.click();
    });
    expect(saveBulk).toHaveBeenCalledWith({
      ai_auth_mode: "codex",
      ai_model: "gpt-6-luna",
      ai_setup_seen: "true",
    });
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

  it("resets unsupported Codex effort tiers when switching models and hides unsupported tiers", async () => {
    mocks.invoke.mockImplementation(async (cmd) => {
      if (cmd === "codex_status") return READY_STATUS;
      if (cmd === "list_codex_models") return { models: SAMPLE_CODEX_MODELS };
      return undefined;
    });

    const { saveBulk } = await render({
      ai_auth_mode: "codex",
      ai_model: "gpt-6-luna",
      ai_effort_quick: "low",
      ai_effort_deep: "max",
    });

    // Switch from gpt-6-luna (supports max) to gpt-6.2-sol (supports only low/medium/high).
    const modelBtn = container.querySelector<HTMLButtonElement>(
      'button[aria-label="settings.ai.model"]',
    )!;
    await act(async () => {
      modelBtn.click();
    });
    const solOption = buttonContaining("GPT-6.2 Sol");
    expect(solOption).toBeDefined();
    await act(async () => {
      solOption!.click();
    });
    await flush();

    expect(saveBulk).toHaveBeenCalledWith({
      ai_auth_mode: "codex",
      ai_model: "gpt-6.2-sol",
      ai_setup_seen: "true",
      ai_effort_deep: "default",
    });

    // Deep effort picker now displays default and hides unsupported tiers (xhigh/max).
    const deepBtn = container.querySelector<HTMLButtonElement>(
      'button[aria-label="settings.ai.effortDeep"]',
    )!;
    expect(deepBtn.textContent).toContain("settings.ai.effortDefaultWithLevel");
    await act(async () => {
      deepBtn.click();
    });
    const optionButtons = () =>
      [...document.querySelectorAll("button")].map((b) => b.textContent?.trim() ?? "");
    expect(optionButtons()).not.toContain("max");
    expect(optionButtons()).not.toContain("xhigh");
    expect(optionButtons()).toContain("high");

    // Close Deep picker, then switch to Custom model -> fallback effort options (including max) remain available.
    await act(async () => {
      deepBtn.click();
    });
    await act(async () => {
      modelBtn.click();
    });
    const customOption = buttonContaining("settings.ai.modelCustom");
    expect(customOption).toBeDefined();
    await act(async () => {
      customOption!.click();
    });
    await flush();
    await act(async () => {
      deepBtn.click();
    });
    expect(optionButtons()).toContain("max");
  });
});
