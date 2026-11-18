/** @vitest-environment jsdom */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn<(command: string, args?: Record<string, unknown>) => Promise<unknown>>(),
  listen: vi.fn<(event: string, cb: (e: { payload: unknown }) => void) => Promise<() => void>>(),
  listenCurrentWindow:
    vi.fn<(event: string, cb: (e: { payload: unknown }) => void) => Promise<() => void>>(),
}));

vi.mock("../../platform", () => ({
  invoke: (command: string, args?: Record<string, unknown>) =>
    args !== undefined ? mocks.invoke(command, args) : mocks.invoke(command),
  listen: (event: string, cb: (e: { payload: unknown }) => void) => mocks.listen(event, cb),
  listenCurrentWindow: (event: string, cb: (e: { payload: unknown }) => void) =>
    mocks.listenCurrentWindow(event, cb),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) =>
      params && Object.keys(params).length > 0 ? `${key}:${JSON.stringify(params)}` : key,
  }),
}));

import { useSettings } from "../../hooks/useSettings";
import AiSettings from "./AiSettings";
import { CODEX_EFFORT_LEVELS, CURATED_CODEX_MODELS, type CodexModel } from "./codexModels";

interface CodexModelList {
  models: CodexModel[];
  from_fallback: boolean;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function buttonWithText(text: string): HTMLButtonElement {
  const button = [...document.querySelectorAll("button")].find(
    (candidate) => candidate.textContent?.trim() === text,
  );
  expect(button).toBeDefined();
  return button as HTMLButtonElement;
}

describe("AiSettings Codex model catalog", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    mocks.invoke.mockReset();
    mocks.listen.mockReset().mockResolvedValue(() => {});
    mocks.listenCurrentWindow.mockReset().mockResolvedValue(() => {});
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  async function render(settings: Record<string, string>) {
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
        />,
      );
      await Promise.resolve();
    });
    return { save, saveBulk, showSavedToast };
  }

  it("ships full curated entries with the verified effort union", () => {
    expect(CURATED_CODEX_MODELS.map((model) => model.slug)).toEqual([
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "gpt-5.5",
      "gpt-5.4",
      "gpt-5.4-mini",
      "gpt-5.3-codex-spark",
    ]);
    expect(CURATED_CODEX_MODELS.every((model) => model.display_name.length > 0)).toBe(true);
    expect(CURATED_CODEX_MODELS.every((model) => model.description.length > 0)).toBe(true);
    expect(CURATED_CODEX_MODELS.every((model) => model.supported_reasoning_levels.length > 0)).toBe(true);
    expect([
      ...new Set(CURATED_CODEX_MODELS.flatMap((model) => model.supported_reasoning_levels)),
    ]).toEqual(CODEX_EFFORT_LEVELS);
  });

  it("renders the seeded picker while the background request is pending", async () => {
    const liveList = deferred<CodexModelList>();
    mocks.invoke.mockImplementation((command) => {
      if (command === "openai_oauth_status") {
        return Promise.resolve({ connected: false, account_id: null });
      }
      if (command === "list_codex_models") return liveList.promise;
      return Promise.resolve(undefined);
    });

    await render({
      ai_provider: "openai",
      ai_auth_mode: "oauth",
      ai_model: "gpt-5.6-sol",
    });

    expect(buttonWithText("GPT-5.6-Sol")).toBeTruthy();
    expect(container.querySelector('input[placeholder="gpt-5.6-sol"]')).toBeNull();
    expect(mocks.invoke).toHaveBeenCalledWith("list_codex_models");
  });

  it("upgrades to the live list without changing an absent saved selection", async () => {
    const liveList = deferred<CodexModelList>();
    mocks.invoke.mockImplementation((command) => {
      if (command === "openai_oauth_status") {
        return Promise.resolve({ connected: false, account_id: null });
      }
      if (command === "list_codex_models") return liveList.promise;
      return Promise.resolve(undefined);
    });

    await render({
      ai_provider: "openai",
      ai_auth_mode: "oauth",
      ai_model: "gpt-5.6-sol",
    });

    await act(async () => {
      liveList.resolve({
        models: [
          {
            slug: "future-codex",
            display_name: "Future Codex",
            description: "New from the live catalog.",
            supported_reasoning_levels: ["medium", "high"],
          },
        ],
        from_fallback: false,
      });
      await liveList.promise;
    });

    expect(buttonWithText("settings.ai.modelCustom")).toBeTruthy();
    expect(container.querySelector<HTMLInputElement>('input[placeholder="gpt-5.6-sol"]')?.value).toBe(
      "gpt-5.6-sol",
    );

    act(() => buttonWithText("settings.ai.modelCustom").click());
    expect(document.body.textContent).toContain("Future Codex");
    expect(document.body.textContent).toContain("New from the live catalog.");
  });

  it("keeps a matching selection and adopts its live effort levels", async () => {
    const liveList = deferred<CodexModelList>();
    mocks.invoke.mockImplementation((command) => {
      if (command === "openai_oauth_status") {
        return Promise.resolve({ connected: false, account_id: null });
      }
      if (command === "list_codex_models") return liveList.promise;
      return Promise.resolve(undefined);
    });

    await render({
      ai_provider: "openai",
      ai_auth_mode: "oauth",
      ai_model: "gpt-5.6-sol",
      ai_effort_quick: "medium",
    });

    await act(async () => {
      liveList.resolve({
        models: [
          {
            slug: "gpt-5.6-sol",
            display_name: "Live Sol",
            description: "Updated by the live catalog.",
            supported_reasoning_levels: ["medium", "high"],
          },
          {
            slug: "future-codex",
            display_name: "Future Codex",
            description: "New from the live catalog.",
            supported_reasoning_levels: ["high"],
          },
        ],
        from_fallback: false,
      });
      await liveList.promise;
    });

    expect(buttonWithText("Live Sol")).toBeTruthy();
    expect(container.querySelector('input[placeholder="gpt-5.6-sol"]')).toBeNull();

    act(() => buttonWithText("medium").click());
    const buttonTexts = [...document.querySelectorAll("button")].map((button) => button.textContent?.trim());
    expect(buttonTexts).toContain("high");
    expect(buttonTexts).not.toContain("low");
    expect(buttonTexts).not.toContain("xhigh");

    act(() => buttonWithText("Live Sol").click());
    expect(document.body.textContent).toContain("Future Codex");
  });

  it("uses the enriched backend fallback and keeps the failure hint", async () => {
    mocks.invoke.mockImplementation((command) => {
      if (command === "openai_oauth_status") {
        return Promise.resolve({ connected: true, account_id: "acct" });
      }
      if (command === "list_codex_models") {
        return Promise.resolve({
          models: [
            {
              slug: "gpt-5.6-sol",
              display_name: "Backend Sol",
              description: "Bundled by the backend.",
              supported_reasoning_levels: ["low", "medium"],
            },
          ],
          from_fallback: true,
        } satisfies CodexModelList);
      }
      return Promise.resolve(undefined);
    });

    await render({
      ai_provider: "openai",
      ai_auth_mode: "oauth",
      ai_model: "gpt-5.6-sol",
    });

    expect(buttonWithText("Backend Sol")).toBeTruthy();
    expect(container.textContent).toContain("settings.ai.modelListFallbackHint");
    act(() => buttonWithText("Backend Sol").click());
    expect(document.body.textContent).toContain("Bundled by the backend.");
  });

  it("keeps the curated seed when the model command fails", async () => {
    mocks.invoke.mockImplementation((command) => {
      if (command === "openai_oauth_status") {
        return Promise.resolve({ connected: true, account_id: "acct" });
      }
      if (command === "list_codex_models") return Promise.reject(new Error("offline"));
      return Promise.resolve(undefined);
    });

    await render({
      ai_provider: "openai",
      ai_auth_mode: "oauth",
      ai_model: "gpt-5.6-sol",
    });

    expect(buttonWithText("GPT-5.6-Sol")).toBeTruthy();
    expect(container.querySelector('input[placeholder="gpt-5.6-sol"]')).toBeNull();
    expect(container.textContent).toContain("settings.ai.modelListFallbackHint");
  });

  it("keeps a saved effort visible when the seeded model does not support it", async () => {
    const liveList = deferred<CodexModelList>();
    mocks.invoke.mockImplementation((command) => {
      if (command === "openai_oauth_status") {
        return Promise.resolve({ connected: false, account_id: null });
      }
      if (command === "list_codex_models") return liveList.promise;
      return Promise.resolve(undefined);
    });

    await render({
      ai_provider: "openai",
      ai_auth_mode: "oauth",
      ai_model: "gpt-5.6-luna",
      ai_effort_quick: "ultra",
    });

    expect(buttonWithText("GPT-5.6-Luna")).toBeTruthy();
    expect(buttonWithText("ultra")).toBeTruthy();
  });

  it.each([
    ["OpenAI API key", { ai_provider: "openai", ai_auth_mode: "api_key", ai_model: "gpt-4o" }, "gpt-4o"],
    ["Anthropic", { ai_provider: "anthropic", ai_model: "claude-sonnet-4-20250514" }, "claude-sonnet-4-20250514"],
    ["Ollama", { ai_provider: "ollama", ai_model: "qwen3.5" }, "qwen3.5"],
  ])("leaves the %s model field as free text", async (_label, settings, placeholder) => {
    mocks.invoke.mockImplementation((command) => {
      if (command === "openai_oauth_status") {
        return Promise.resolve({ connected: false, account_id: null });
      }
      if (command === "list_codex_models") {
        return Promise.resolve({ models: CURATED_CODEX_MODELS, from_fallback: true });
      }
      return Promise.resolve(undefined);
    });

    await render(settings);

    expect(container.querySelector(`input[placeholder="${placeholder}"]`)).not.toBeNull();
  });
});

function fireInput(input: HTMLInputElement, value: string) {
  const descriptor = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value");
  descriptor?.set?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("AiSettings Dawn states & interactions", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    mocks.invoke.mockReset();
    mocks.listen.mockReset().mockResolvedValue(() => {});
    mocks.listenCurrentWindow.mockReset().mockResolvedValue(() => {});
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  async function renderDawn(settings: Record<string, string>) {
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
        />,
      );
      await Promise.resolve();
    });
    return { save, saveBulk, showSavedToast };
  }

  it("renders signed-out state, transitions through waiting + cancel without showing error", async () => {
    const pendingLogin = deferred<{ connected: boolean; account_id: string | null }>();
    let rejectLogin!: (err: Error) => void;
    const loginPromise = new Promise<{ connected: boolean; account_id: string | null }>((_, rej) => {
      rejectLogin = rej;
    });
    void pendingLogin;

    mocks.invoke.mockImplementation((command) => {
      if (command === "openai_oauth_status") {
        return Promise.resolve({ connected: false, account_id: null, email: null });
      }
      if (command === "list_codex_models") {
        return Promise.resolve({ models: CURATED_CODEX_MODELS, from_fallback: false });
      }
      if (command === "openai_oauth_login") return loginPromise;
      if (command === "openai_oauth_cancel") return Promise.resolve(undefined);
      return Promise.resolve(undefined);
    });

    await renderDawn({ ai_provider: "openai", ai_auth_mode: "oauth", ai_model: "gpt-5.6-sol" });

    expect(container.querySelector('[data-testid="oauth-signed-out-row"]')).not.toBeNull();
    expect(container.textContent).toContain("settings.ai.modelSignedOutHint");

    act(() => {
      buttonWithText("settings.ai.signInWithChatGpt").click();
    });
    expect(container.querySelector('[data-testid="oauth-waiting-card"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="oauth-signed-out-row"]')).toBeNull();

    await act(async () => {
      buttonWithText("common.cancel").click();
      await Promise.resolve();
    });
    expect(mocks.invoke).toHaveBeenCalledWith("openai_oauth_cancel");
    expect(container.querySelector('[data-testid="oauth-waiting-card"]')).toBeNull();
    expect(container.querySelector('[data-testid="oauth-signed-out-row"]')).not.toBeNull();

    await act(async () => {
      rejectLogin(new Error("OAUTH_CANCELLED"));
      await Promise.resolve();
    });
    expect(container.querySelector('[data-testid="oauth-error-card"]')).toBeNull();
  });

  it("shows failed sign-in card on error and connects on try again", async () => {
    let attempts = 0;
    mocks.invoke.mockImplementation((command) => {
      if (command === "openai_oauth_status") {
        return Promise.resolve({ connected: false, account_id: null, email: null });
      }
      if (command === "list_codex_models") {
        return Promise.resolve({ models: CURATED_CODEX_MODELS, from_fallback: false });
      }
      if (command === "openai_oauth_login") {
        attempts += 1;
        if (attempts === 1) return Promise.reject(new Error("Callback timeout"));
        return Promise.resolve({
          connected: true,
          account_id: "acct_1",
          email: "reader@example.com",
        });
      }
      return Promise.resolve(undefined);
    });

    const { saveBulk, showSavedToast } = await renderDawn({
      ai_provider: "openai",
      ai_auth_mode: "oauth",
      ai_model: "gpt-5.6-sol",
    });

    await act(async () => {
      buttonWithText("settings.ai.signInWithChatGpt").click();
      await Promise.resolve();
    });

    expect(container.querySelector('[data-testid="oauth-error-card"]')).not.toBeNull();
    expect(container.textContent).toContain("settings.ai.authFailed");

    await act(async () => {
      buttonWithText("settings.ai.tryAgain").click();
      await Promise.resolve();
    });

    expect(container.querySelector('[data-testid="oauth-error-card"]')).toBeNull();
    expect(container.textContent).toContain("settings.ai.connectedBadge");
    expect(container.textContent).toContain('reader@example.com');
    expect(saveBulk).toHaveBeenCalled();
    expect(showSavedToast).toHaveBeenCalledWith("settings.ai.oauthSuccess");
  });

  it("omits raw account_id when email is unavailable and handles sign-out modal", async () => {
    mocks.invoke.mockImplementation((command) => {
      if (command === "openai_oauth_status") {
        return Promise.resolve({ connected: true, account_id: "acct_opaque_uuid", email: null });
      }
      if (command === "list_codex_models") {
        return Promise.resolve({ models: CURATED_CODEX_MODELS, from_fallback: false });
      }
      if (command === "openai_oauth_logout") return Promise.resolve(undefined);
      return Promise.resolve(undefined);
    });

    await renderDawn({ ai_provider: "openai", ai_auth_mode: "oauth", ai_model: "gpt-5.6-sol" });

    expect(container.textContent).toContain("settings.ai.signedInViaBrowser");
    expect(container.textContent).not.toContain("acct_opaque_uuid");

    act(() => {
      buttonWithText("settings.ai.signOut").click();
    });
    const dialog = document.body.querySelector('[data-testid="oauth-signout-dialog"]');
    expect(dialog).not.toBeNull();

    // Cancel leaves signed-in state untouched
    act(() => {
      buttonWithText("common.cancel").click();
    });
    expect(document.body.querySelector('[data-testid="oauth-signout-dialog"]')).toBeNull();
    expect(mocks.invoke).not.toHaveBeenCalledWith("openai_oauth_logout");

    // Reopen and confirm via the danger Sign out button inside portal
    act(() => {
      buttonWithText("settings.ai.signOut").click();
    });
    const confirmBtn = document.body.querySelectorAll('[data-testid="oauth-signout-dialog"] button')[1] as HTMLButtonElement;
    await act(async () => {
      confirmBtn.click();
      await Promise.resolve();
    });
    expect(mocks.invoke).toHaveBeenCalledWith("openai_oauth_logout");
    expect(container.querySelector('[data-testid="oauth-signed-out-row"]')).not.toBeNull();
  });

  it("syncs to signed-out if fallback codex model fetch cleared expired tokens", async () => {
    let statusCalls = 0;
    mocks.invoke.mockImplementation((command) => {
      if (command === "openai_oauth_status") {
        statusCalls += 1;
        return Promise.resolve(
          statusCalls === 1
            ? { connected: true, account_id: "acct_1", email: "reader@example.com" }
            : { connected: false, account_id: null, email: null },
        );
      }
      if (command === "list_codex_models") {
        return Promise.resolve({ models: CURATED_CODEX_MODELS, from_fallback: true });
      }
      return Promise.resolve(undefined);
    });

    await renderDawn({ ai_provider: "openai", ai_auth_mode: "oauth", ai_model: "gpt-5.6-sol" });

    expect(statusCalls).toBeGreaterThanOrEqual(2);
    expect(container.querySelector('[data-testid="oauth-signed-out-row"]')).not.toBeNull();
  });

  it("supports API key reveal, saved badge, clear, base url, temperature, and flush on unmount", async () => {
    mocks.invoke.mockImplementation((command) => {
      if (command === "openai_oauth_status") {
        return Promise.resolve({ connected: false, account_id: null });
      }
      return Promise.resolve(undefined);
    });

    const { save } = await renderDawn({
      ai_provider: "anthropic",
      ai_api_key: "sk-ant-initial",
      ai_base_url: "",
      ai_model: "claude-sonnet-4-20250514",
      ai_temperature: "0.3",
    });

    const keyInput = container.querySelector<HTMLInputElement>('input[placeholder="sk-ant-..."]')!;
    expect(keyInput.type).toBe("password");
    expect(container.textContent).toContain("settings.ai.savedBadge");

    const toggleReveal = container.querySelector<HTMLButtonElement>(
      'button[aria-label="settings.ai.showApiKey"]',
    )!;
    act(() => {
      toggleReveal.click();
    });
    expect(keyInput.type).toBe("text");

    await act(async () => {
      buttonWithText("settings.ai.clear").click();
      await Promise.resolve();
    });
    expect(save).toHaveBeenCalledWith("ai_api_key", "");
    expect(container.textContent).not.toContain("settings.ai.savedBadge");

    await act(async () => {
      const incTemp = container.querySelector<HTMLButtonElement>(
        'button[aria-label="settings.ai.temperatureIncrease"]',
      )!;
      incTemp.click();
      await Promise.resolve();
    });
    expect(save).toHaveBeenCalledWith("ai_temperature", "0.4");

    const modelInput = container.querySelector<HTMLInputElement>(
      'input[placeholder="claude-sonnet-4-20250514"]',
    )!;
    act(() => {
      fireInput(modelInput, "claude-opus-4-1");
    });

    // Unmounting before debounce fires flushes pending draft save
    act(() => {
      root.unmount();
    });
    expect(save).toHaveBeenCalledWith("ai_model", "claude-opus-4-1");
  });

  it("probes Ollama status, updates server URL on Enter, and persists keep-alive", async () => {
    mocks.invoke.mockImplementation((command, args) => {
      if (command === "check_ollama_status") {
        const url = (args as { baseUrl?: string })?.baseUrl;
        return Promise.resolve({ running: url !== "http://localhost:9999" });
      }
      return Promise.resolve(undefined);
    });

    const { save, saveBulk } = await renderDawn({
      ai_provider: "ollama",
      ai_base_url: "http://localhost:11434",
      ai_model: "qwen3.5",
      ai_keep_alive: "10m",
    });

    expect(mocks.invoke).toHaveBeenCalledWith("check_ollama_status", {
      baseUrl: "http://localhost:11434",
    });
    expect(container.textContent).toContain("settings.ai.ollamaRunning");
    // Custom saved keep-alive stays selectable
    expect(buttonWithText("10m")).toBeTruthy();

    act(() => {
      buttonWithText("10m").click();
    });
    await act(async () => {
      buttonWithText("settings.ai.keepAlive1h").click();
      await Promise.resolve();
    });
    expect(save).toHaveBeenCalledWith("ai_keep_alive", "1h");

    const urlInput = container.querySelector<HTMLInputElement>(
      'input[placeholder="http://localhost:11434"]',
    )!;
    await act(async () => {
      fireInput(urlInput, "http://localhost:9999");
      urlInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      await Promise.resolve();
    });
    expect(save).toHaveBeenCalledWith("ai_base_url", "http://localhost:9999");
    expect(container.textContent).toContain("settings.ai.ollamaNotRunning");

    await act(async () => {
      buttonWithText("settings.ai.providers.openai").click();
      await Promise.resolve();
    });
    expect(saveBulk).toHaveBeenCalledWith(
      expect.objectContaining({
        ai_provider: "openai",
        ai_auth_mode: "oauth",
        ai_model: "gpt-5.6-sol",
        ai_api_key: "",
      }),
    );
  });

  it("persists complete provider configuration on fresh OpenAI API-key setup via useSettings", async () => {
    const db: Record<string, string> = {};
    mocks.invoke.mockImplementation(async (command, args) => {
      if (command === "get_all_settings") return { ...db };
      if (command === "set_setting" && args) {
        db[String(args.key)] = String(args.value);
        return null;
      }
      if (command === "set_settings_bulk" && args && typeof args.settings === "object" && args.settings) {
        Object.assign(db, args.settings);
        return null;
      }
      if (command === "openai_oauth_status") {
        return { connected: false, account_id: null, email: null };
      }
      if (command === "list_codex_models") {
        return { models: CURATED_CODEX_MODELS, from_fallback: false };
      }
      return null;
    });

    function StatefulHarness() {
      const hook = useSettings();
      return (
        <AiSettings
          settings={hook.settings}
          loading={hook.loading}
          save={hook.save}
          saveBulk={hook.saveBulk}
          showSavedToast={vi.fn()}
        />
      );
    }

    await act(async () => {
      root.render(<StatefulHarness />);
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () => {
      buttonWithText("settings.ai.apiKeyOption").click();
      await Promise.resolve();
      await Promise.resolve();
    });

    const keyInput = container.querySelector<HTMLInputElement>('input[placeholder="sk-..."]')!;
    await act(async () => {
      keyInput.focus();
      fireInput(keyInput, "sk-fresh-test");
      keyInput.blur();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(db).toMatchObject({
      ai_provider: "openai",
      ai_auth_mode: "api_key",
      ai_model: "gpt-4o",
      ai_api_key: "sk-fresh-test",
    });
  });

  it("refreshes connected state to signed-out when expired while mounted via reopen, focus, or event", async () => {
    let connected = true;
    const globalListeners = new Map<string, Array<(e: { payload: unknown }) => void>>();
    const windowListeners = new Map<string, Array<(e: { payload: unknown }) => void>>();
    mocks.listen.mockImplementation(async (event, cb) => {
      const list = globalListeners.get(event) ?? [];
      list.push(cb);
      globalListeners.set(event, list);
      return () => {};
    });
    mocks.listenCurrentWindow.mockImplementation(async (event, cb) => {
      const list = windowListeners.get(event) ?? [];
      list.push(cb);
      windowListeners.set(event, list);
      return () => {};
    });
    mocks.invoke.mockImplementation((command) => {
      if (command === "openai_oauth_status") {
        return Promise.resolve(
          connected
            ? { connected: true, account_id: "acct_1", email: "reader@example.com" }
            : { connected: false, account_id: null, email: null },
        );
      }
      if (command === "list_codex_models") {
        return Promise.resolve({ models: CURATED_CODEX_MODELS, from_fallback: !connected });
      }
      return Promise.resolve(undefined);
    });

    const save = vi.fn().mockResolvedValue(undefined);
    const saveBulk = vi.fn().mockResolvedValue(undefined);
    const renderWithNonce = async (refreshNonce: number) => {
      await act(async () => {
        root.render(
          <AiSettings
            settings={{ ai_provider: "openai", ai_auth_mode: "oauth", ai_model: "gpt-5.6-sol" }}
            loading={false}
            save={save}
            saveBulk={saveBulk}
            showSavedToast={vi.fn()}
            refreshNonce={refreshNonce}
          />,
        );
        await Promise.resolve();
        await Promise.resolve();
      });
    };

    // 1) Returning via openSettings / refreshNonce
    await renderWithNonce(1);
    expect(container.textContent).toContain("settings.ai.connectedBadge");
    connected = false;
    await renderWithNonce(2);
    expect(container.querySelector('[data-testid="oauth-signed-out-row"]')).not.toBeNull();

    // 2) Expiring while mounted and returning via window focus
    connected = true;
    await renderWithNonce(3);
    expect(container.textContent).toContain("settings.ai.connectedBadge");
    connected = false;
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(container.querySelector('[data-testid="oauth-signed-out-row"]')).not.toBeNull();

    // 3) Expiring via window-targeted backend openai-oauth-changed event (listenCurrentWindow, not global listen)
    connected = true;
    await renderWithNonce(4);
    expect(container.textContent).toContain("settings.ai.connectedBadge");
    expect(globalListeners.get("openai-oauth-changed") ?? []).toHaveLength(0);
    expect((windowListeners.get("openai-oauth-changed") ?? []).length).toBeGreaterThanOrEqual(1);
    connected = false;
    await act(async () => {
      for (const cb of windowListeners.get("openai-oauth-changed") ?? []) {
        cb({ payload: { connected: false } });
      }
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(container.querySelector('[data-testid="oauth-signed-out-row"]')).not.toBeNull();
  });
});
