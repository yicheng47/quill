/** @vitest-environment jsdom */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CodexStatus } from "../lib/aiConnections";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn<(cmd: string, args?: Record<string, unknown>) => Promise<unknown>>(),
  openUrl: vi.fn<(url: string) => Promise<void>>(),
}));

vi.mock("../platform", () => ({
  invoke: (cmd: string, args?: Record<string, unknown>) =>
    args !== undefined ? mocks.invoke(cmd, args) : mocks.invoke(cmd),
  openUrl: (url: string) => mocks.openUrl(url),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) =>
      params && Object.keys(params).length > 0 ? `${key}:${JSON.stringify(params)}` : key,
  }),
}));

import AiSetupDialog from "./AiSetupDialog";

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

describe("AiSetupDialog (#326 first-launch & OAuth migration helper)", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    mocks.invoke.mockReset();
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

  it("shows ready state and saves ai_auth_mode=codex + ai_setup_seen on Use Codex", async () => {
    mocks.invoke.mockImplementation(async (cmd) => {
      if (cmd === "codex_status") return READY_STATUS;
      return undefined;
    });
    const onClose = vi.fn();
    const onUseApi = vi.fn();

    await act(async () => {
      root.render(<AiSetupDialog open isMigration={false} onClose={onClose} onUseApi={onUseApi} />);
    });
    await flush();

    const dialog = document.querySelector('[data-testid="ai-setup-dialog"]');
    expect(dialog?.getAttribute("data-state")).toBe("ready");
    expect(dialog?.textContent).toContain("reader@example.com · ChatGPT Pro");
    expect(document.querySelector('[data-testid="ai-setup-migration-note"]')).toBeNull();

    const useCodexBtn = buttonContaining("aiSetup.useCodex")!;
    await act(async () => {
      useCodexBtn.click();
    });
    await flush();

    expect(mocks.invoke).toHaveBeenCalledWith("set_settings_bulk", {
      settings: { ai_setup_seen: "true", ai_auth_mode: "codex", ai_model: "" },
    });
    expect(onClose).toHaveBeenCalled();
  });

  it("shows migration note banner and clears ai_codex_migration_pending on completion", async () => {
    mocks.invoke.mockImplementation(async (cmd) => {
      if (cmd === "codex_status") return READY_STATUS;
      return undefined;
    });
    const onClose = vi.fn();

    await act(async () => {
      root.render(<AiSetupDialog open isMigration onClose={onClose} onUseApi={vi.fn()} />);
    });
    await flush();

    const note = document.querySelector('[data-testid="ai-setup-migration-note"]');
    expect(note).not.toBeNull();
    expect(document.querySelector('[data-testid="ai-setup-dialog"]')?.textContent).toContain(
      "aiSetup.migrationTitle",
    );

    await act(async () => {
      buttonContaining("aiSetup.useCodex")!.click();
    });
    await flush();

    expect(mocks.invoke).toHaveBeenCalledWith("set_settings_bulk", {
      settings: {
        ai_setup_seen: "true",
        ai_codex_migration_pending: "false",
        ai_auth_mode: "codex",
      },
    });
    expect(onClose).toHaveBeenCalled();
  });

  it("handles not_signed_in -> signing_in -> cancel and browser sign-in completion", async () => {
    let signedIn = false;
    const pendingLogin = deferred<{ success: boolean; error: string | null }>();
    mocks.invoke.mockImplementation((cmd) => {
      if (cmd === "codex_status") {
        return Promise.resolve(
          signedIn
            ? READY_STATUS
            : { ...READY_STATUS, state: "not_signed_in", email: null, plan: null },
        );
      }
      if (cmd === "codex_login") return pendingLogin.promise;
      if (cmd === "codex_login_cancel") return Promise.resolve(undefined);
      return Promise.resolve(undefined);
    });

    await act(async () => {
      root.render(<AiSetupDialog open isMigration={false} onClose={vi.fn()} onUseApi={vi.fn()} />);
    });
    await flush();
    expect(document.querySelector('[data-testid="ai-setup-dialog"]')?.getAttribute("data-state")).toBe(
      "not_signed_in",
    );

    // Start login -> signing_in -> Cancel sign-in returns to not_signed_in
    await act(async () => {
      buttonContaining("settings.ai.signInWithChatGpt")!.click();
    });
    expect(document.querySelector('[data-testid="ai-setup-dialog"]')?.getAttribute("data-state")).toBe(
      "signing_in",
    );
    await act(async () => {
      buttonContaining("aiSetup.cancelSignIn")!.click();
    });
    expect(mocks.invoke).toHaveBeenCalledWith("codex_login_cancel");
    expect(document.querySelector('[data-testid="ai-setup-dialog"]')?.getAttribute("data-state")).toBe(
      "not_signed_in",
    );

    // Sign in and complete -> transitions to ready
    mocks.invoke.mockImplementation((cmd) => {
      if (cmd === "codex_status") {
        return Promise.resolve(
          signedIn
            ? READY_STATUS
            : { ...READY_STATUS, state: "not_signed_in", email: null, plan: null },
        );
      }
      if (cmd === "codex_login") {
        signedIn = true;
        return Promise.resolve({ success: true, error: null });
      }
      return Promise.resolve(undefined);
    });
    await act(async () => {
      buttonContaining("settings.ai.signInWithChatGpt")!.click();
    });
    await flush();
    expect(document.querySelector('[data-testid="ai-setup-dialog"]')?.getAttribute("data-state")).toBe(
      "ready",
    );
  });

  it("shows install command and guide for not_installed, and update command for too_old", async () => {
    mocks.invoke.mockResolvedValue({
      ...READY_STATUS,
      state: "not_installed",
      version: null,
      path: null,
      email: null,
      plan: null,
    });
    await act(async () => {
      root.render(<AiSetupDialog open isMigration={false} onClose={vi.fn()} onUseApi={vi.fn()} />);
    });
    await flush();
    expect(document.body.textContent).toContain("npm install -g @openai/codex");
    await act(async () => {
      buttonContaining("aiSetup.openInstallGuide")!.click();
    });
    expect(mocks.openUrl).toHaveBeenCalledWith("https://developers.openai.com/codex/cli");

    // Re-check -> too_old
    mocks.invoke.mockResolvedValue({
      ...READY_STATUS,
      state: "too_old",
      version: "0.141.2",
      email: null,
      plan: null,
    });
    await act(async () => {
      buttonContaining("settings.ai.codex.checkAgain")!.click();
    });
    await flush();
    expect(document.querySelector('[data-testid="ai-setup-dialog"]')?.getAttribute("data-state")).toBe(
      "too_old",
    );
    expect(document.body.textContent).toContain("npm install -g @openai/codex@latest");
  });

  it("supports Skip for now and Use an API key or Ollama", async () => {
    mocks.invoke.mockResolvedValue(READY_STATUS);
    const onClose = vi.fn();
    const onUseApi = vi.fn();
    await act(async () => {
      root.render(<AiSetupDialog open isMigration={false} onClose={onClose} onUseApi={onUseApi} />);
    });
    await flush();

    await act(async () => {
      buttonContaining("aiSetup.skipForNow")!.click();
    });
    await flush();
    expect(mocks.invoke).toHaveBeenCalledWith("set_settings_bulk", {
      settings: { ai_setup_seen: "true" },
    });
    expect(onClose).toHaveBeenCalledTimes(1);

    mocks.invoke.mockClear();
    mocks.invoke.mockResolvedValue(READY_STATUS);
    await act(async () => {
      buttonContaining("aiSetup.useApiOrOllama")!.click();
    });
    await flush();
    expect(mocks.invoke).toHaveBeenCalledWith("set_settings_bulk", {
      settings: { ai_setup_seen: "true" },
    });
    expect(onUseApi).toHaveBeenCalledTimes(1);
  });

  it("moves focus into the dialog on open, traps Tab/Shift+Tab, and restores focus on close", async () => {
    mocks.invoke.mockResolvedValue(READY_STATUS);
    const outsideBtn = document.createElement("button");
    outsideBtn.textContent = "Outside button";
    document.body.appendChild(outsideBtn);
    try {
      outsideBtn.focus();
      expect(document.activeElement).toBe(outsideBtn);

      await act(async () => {
        root.render(<AiSetupDialog open isMigration={false} onClose={vi.fn()} onUseApi={vi.fn()} />);
      });
      await flush();

      const dialog = document.querySelector<HTMLElement>('[data-testid="ai-setup-dialog"]')!;
      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>("button:not([disabled])"));
      expect(focusable.length).toBeGreaterThanOrEqual(2);
      expect(dialog.contains(document.activeElement)).toBe(true);

      const first = focusable[0];
      const last = focusable[focusable.length - 1];

      // Shift+Tab on first focusable wraps to last.
      first.focus();
      await act(async () => {
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, cancelable: true }));
      });
      expect(document.activeElement).toBe(last);

      // Tab on last focusable wraps to first.
      await act(async () => {
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", cancelable: true }));
      });
      expect(document.activeElement).toBe(first);

      // Closing restores focus to the element that had focus before opening.
      await act(async () => {
        root.render(<AiSetupDialog open={false} isMigration={false} onClose={vi.fn()} onUseApi={vi.fn()} />);
      });
      await flush();
      expect(document.activeElement).toBe(outsideBtn);
    } finally {
      outsideBtn.remove();
    }
  });
});
