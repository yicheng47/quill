/** @vitest-environment jsdom */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../../i18n";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn<(cmd: string, args?: Record<string, unknown>) => Promise<unknown>>(),
  getAppVersion: vi.fn<() => Promise<string>>(),
  getPlatformInfo: vi.fn<() => Promise<{ platform: string; arch: string }>>(),
  setZoom: vi.fn<(zoom: number) => Promise<void>>(),
  setTitlebarZoom: vi.fn<(zoom: number) => Promise<void>>(),
  openUrl: vi.fn<(url: string) => Promise<void>>(),
  settingsMap: {} as Record<string, string>,
}));

vi.mock("../../platform", () => ({
  invoke: (cmd: string, args?: Record<string, unknown>) =>
    args !== undefined ? mocks.invoke(cmd, args) : mocks.invoke(cmd),
  getAppVersion: () => mocks.getAppVersion(),
  getPlatformInfo: () => mocks.getPlatformInfo(),
  getOpenReaderCount: vi.fn().mockResolvedValue(0),
  setZoom: (z: number) => mocks.setZoom(z),
  setTitlebarZoom: (z: number) => mocks.setTitlebarZoom(z),
  openUrl: (url: string) => mocks.openUrl(url),
  listen: () => Promise.resolve(() => {}),
  listenCurrentWindow: () => Promise.resolve(() => {}),
}));

vi.mock("../../contexts/UpdateContext", () => ({
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
    checkForUpdate: vi.fn().mockResolvedValue(null),
    downloadAndInstall: vi.fn().mockResolvedValue(undefined),
    cancelDownload: vi.fn().mockResolvedValue(undefined),
    skipVersion: vi.fn().mockResolvedValue(undefined),
    restart: vi.fn().mockResolvedValue(undefined),
  }),
}));

import SettingsView from "./SettingsView";
import type { SettingsSection } from "./types";

function Harness({
  initialSection = "general",
  onClose,
}: {
  initialSection?: SettingsSection;
  onClose: () => void;
}) {
  const [section, setSection] = useState<SettingsSection>(initialSection);
  return (
    <SettingsView
      section={section}
      onSelectSection={setSection}
      onClose={onClose}
    />
  );
}

describe("SettingsView and redesigned sections", () => {
  const storage = new Map<string, string>();
  let container: HTMLDivElement;
  let root: Root;

  const setOs = (os: "mac" | "win") => {
    Object.defineProperty(window.navigator, "userAgent", {
      value:
        os === "mac"
          ? "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)"
          : "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
      configurable: true,
    });
  };

  const flush = async () => {
    for (let i = 0; i < 4; i++) {
      await act(async () => {
        await Promise.resolve();
      });
    }
  };

  const renderView = async (initialSection: SettingsSection = "general", onClose = vi.fn()) => {
    await act(async () => {
      root.render(<Harness initialSection={initialSection} onClose={onClose} />);
    });
    await flush();
    return { onClose };
  };

  const clickTab = async (id: SettingsSection) => {
    const btn = container.querySelector<HTMLButtonElement>(`button[data-settings-tab="${id}"]`);
    await act(async () => {
      btn?.click();
    });
    await flush();
  };

  beforeEach(async () => {
    storage.clear();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => storage.get(k) ?? null,
      setItem: (k: string, v: string) => storage.set(k, v),
      clear: () => storage.clear(),
    });
    await i18n.changeLanguage("en");
    setOs("mac");
    mocks.settingsMap = {
      user_name: "Jason",
      language: "en",
      reader_theme: "original",
      font_family: "literata",
      font_size: "18",
      line_spacing: "1.6",
      char_spacing: "0",
      word_spacing: "0",
      margins: "40",
      auto_save: "true",
    };
    mocks.getAppVersion.mockReset().mockResolvedValue("2.0.0");
    mocks.getPlatformInfo.mockReset().mockResolvedValue({ platform: "darwin", arch: "arm64" });
    mocks.setZoom.mockReset().mockResolvedValue(undefined);
    mocks.setTitlebarZoom.mockReset().mockResolvedValue(undefined);
    mocks.openUrl.mockReset().mockResolvedValue(undefined);
    mocks.invoke.mockReset().mockImplementation(async (cmd, args) => {
      if (cmd === "get_all_settings") return { ...mocks.settingsMap };
      if (cmd === "set_setting" && args) {
        mocks.settingsMap[String(args.key)] = String(args.value);
        return null;
      }
      if (cmd === "set_settings" && args && typeof args.entries === "object" && args.entries) {
        Object.assign(mocks.settingsMap, args.entries);
        return null;
      }
      if (cmd === "mcp_integration_status") {
        return { claude_code: true, codex: false, write_enabled: false, binary_path: "/usr/local/bin/quill-mcp" };
      }
      if (cmd === "mcp_config_snippet") {
        return '{"mcpServers":{"quill":{"command":"/Applications/Quill.app/Contents/Resources/quill-mcp"}}}';
      }
      if (cmd === "openai_oauth_status") {
        return { connected: false };
      }
      if (cmd === "sync_status") {
        return {
          enabled: false,
          available: false,
          sync_enabled: false,
          shared_dir: null,
          device_uuid: "d1",
          device_name: "Test Mac",
          peers: [],
          pending_events: 0,
          last_replay_at: null,
        };
      }
      return null;
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

  it("shows all 9 tabs on macOS, hides iCloud Sync on Windows, and omits Reset All Data", async () => {
    await renderView();
    const macTabs = Array.from(container.querySelectorAll("button[data-settings-tab]")).map((b) =>
      b.getAttribute("data-settings-tab"),
    );
    expect(macTabs).toEqual([
      "general",
      "appearance",
      "reading",
      "ai",
      "tools",
      "librarySync",
      "mcp",
      "updates",
      "about",
    ]);
    expect(container.textContent).not.toContain("Reset All Local Data");
    expect(container.textContent).toContain("Quill 2.0.0");

    await act(async () => {
      root.unmount();
    });
    setOs("win");
    root = createRoot(container);
    await renderView("librarySync");
    const winTabs = Array.from(container.querySelectorAll("button[data-settings-tab]")).map((b) =>
      b.getAttribute("data-settings-tab"),
    );
    expect(winTabs).not.toContain("librarySync");
    expect(container.querySelector("h2")?.textContent).toBe("General");
  });

  it("saves Display name inline edit, ignores Esc while closing Select or inline input, then closes on outer Esc", async () => {
    const onClose = vi.fn();
    await renderView("general", onClose);

    expect(container.textContent).toContain("Jason");

    // Edit Display name -> Esc cancels inline edit WITHOUT calling onClose
    const editBtn = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent === "Edit",
    );
    await act(async () => {
      editBtn?.click();
    });
    const input = container.querySelector<HTMLInputElement>('input[aria-label="Display name"]');
    expect(input?.value).toBe("Jason");

    await act(async () => {
      input?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(container.querySelector('input[aria-label="Display name"]')).toBeNull();
    expect(onClose).not.toHaveBeenCalled();

    // Edit again -> Save persists user_name
    const editBtn2 = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent === "Edit",
    );
    await act(async () => {
      editBtn2?.click();
    });
    const input2 = container.querySelector<HTMLInputElement>('input[aria-label="Display name"]')!;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      setter.call(input2, "Alice");
      input2.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const saveBtn = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent === "Save",
    );
    await act(async () => {
      saveBtn?.click();
    });
    await flush();
    expect(mocks.settingsMap.user_name).toBe("Alice");
    expect(container.textContent).toContain("Alice");

    // Open language Select -> Esc closes listbox only, second Esc calls onClose
    const selectTrigger = container.querySelector<HTMLButtonElement>('button[aria-haspopup="listbox"]');
    await act(async () => {
      selectTrigger?.click();
    });
    expect(document.querySelector('[role="listbox"]')).not.toBeNull();
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(document.querySelector('[role="listbox"]')).toBeNull();
    expect(onClose).not.toHaveBeenCalled();

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("renders Appearance with Light active, System/Dark disabled, and App zoom Stepper", async () => {
    await renderView("appearance");

    const systemCard = container.querySelector<HTMLButtonElement>('button[data-theme-card="system"]');
    const lightCard = container.querySelector<HTMLButtonElement>('button[data-theme-card="light"]');
    const darkCard = container.querySelector<HTMLButtonElement>('button[data-theme-card="dark"]');
    expect(systemCard?.disabled).toBe(true);
    expect(darkCard?.disabled).toBe(true);
    expect(lightCard?.disabled).toBe(false);
    expect(lightCard?.getAttribute("aria-pressed")).toBe("true");

    const zoomInBtn = container.querySelector<HTMLButtonElement>('button[aria-label="Zoom in"]');
    await act(async () => {
      zoomInBtn?.click();
    });
    expect(mocks.setZoom).toHaveBeenCalled();
  });

  it("renders Reading with 4 themes, Literata font, steppers, and nearest margin preset without mutating stored value", async () => {
    await renderView("reading");

    // 4 theme swatches
    expect(container.textContent).toContain("Original");
    expect(container.textContent).toContain("Sepia");
    expect(container.textContent).toContain("Gray");
    expect(container.textContent).toContain("Dark");

    const decSizeBtn = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Decrease font size"]',
    );
    expect(decSizeBtn).toBeDefined();

    // Font Select includes Literata
    const fontSelect = container.querySelector<HTMLButtonElement>('button[aria-haspopup="listbox"]');
    expect(fontSelect?.textContent).toContain("Literata");

    // Stored margins=40 maps nearest preset Normal without auto-saving "60"
    const normalBtn = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
      (el) => el.textContent === "Normal",
    );
    expect(normalBtn?.getAttribute("aria-pressed")).toBe("true");
    expect(mocks.settingsMap.margins).toBe("40");

    // Clicking Wide writes "120"; word spacing Stepper persists word_spacing
    const wideBtn = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
      (el) => el.textContent === "Wide",
    );
    await act(async () => {
      wideBtn?.click();
    });
    expect(mocks.settingsMap.margins).toBe("120");

    const incWordBtn = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Increase word spacing"]',
    );
    await act(async () => {
      incWordBtn?.click();
    });
    expect(mocks.settingsMap.word_spacing).toBe("1");
  });

  it("renders AI header Save button, Tools, MCP, and About with logs and links", async () => {
    await renderView("ai");
    const headerSaveBtn = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent === "Save",
    );
    expect(headerSaveBtn).toBeDefined();

    await clickTab("tools");
    const briefToggle = container.querySelector<HTMLButtonElement>(
      'button[role="switch"][aria-label="Brief translation"]',
    );
    await act(async () => {
      briefToggle?.click();
    });
    expect(mocks.settingsMap.show_translation).toBe("true");

    await clickTab("mcp");
    expect(container.textContent).toContain("~/.claude.json");
    expect(container.textContent).toContain("~/.codex/config.toml");

    await clickTab("about");
    expect(container.textContent).toContain("macOS · arm64");
    expect(container.textContent).toContain("An AI-powered reader for EPUB and PDF");

    const revealBtn = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Reveal in Finder"),
    );
    await act(async () => {
      revealBtn?.click();
    });
    expect(mocks.invoke).toHaveBeenCalledWith("reveal_logs");

    const ghBtn = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("GitHub"),
    );
    await act(async () => {
      ghBtn?.click();
    });
    expect(mocks.openUrl).toHaveBeenCalledWith("https://github.com/yicheng47/quill");
  });

  it("portals iCloud Sync confirmation outside the dawn-glass pane and leaves sync off on Cancel", async () => {
    mocks.invoke.mockImplementation(async (cmd) => {
      if (cmd === "get_all_settings") return { ...mocks.settingsMap };
      if (cmd === "sync_status") {
        return {
          enabled: false,
          available: true,
          sync_enabled: false,
          shared_dir: null,
          device_uuid: "d1",
          device_name: "Test Mac",
          peers: [],
          pending_events: 0,
          last_replay_at: null,
        };
      }
      return null;
    });

    await renderView("librarySync");

    const toggle = container.querySelector<HTMLButtonElement>(
      'button[role="switch"][aria-label="Sync with iCloud"]',
    );
    await act(async () => {
      toggle?.click();
    });

    const settingsView = container.querySelector('[data-testid="settings-view"]')!;
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(settingsView.contains(dialog)).toBe(false);
    expect(dialog?.parentElement?.parentElement).toBe(document.body);
    expect(dialog?.textContent).toContain("Turn on iCloud Sync?");

    const cancelBtn = Array.from(dialog!.querySelectorAll("button")).find(
      (b) => b.textContent === "Cancel",
    );
    await act(async () => {
      cancelBtn?.click();
    });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(mocks.invoke).not.toHaveBeenCalledWith("sync_enable");
  });
});
