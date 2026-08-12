/** @vitest-environment jsdom */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn<(command: string, args?: object) => Promise<unknown>>(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mocks.invoke,
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

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
    await act(async () => {
      root.render(
        <AiSettings
          settings={settings}
          loading={false}
          save={vi.fn()}
          saveBulk={vi.fn().mockResolvedValue(undefined)}
          showSavedToast={vi.fn()}
        />,
      );
      await Promise.resolve();
    });
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
