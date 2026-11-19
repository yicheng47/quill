/** @vitest-environment jsdom */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import fs from "node:fs";
import path from "node:path";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../../i18n";
import Button from "./Button";
import IconButton from "./IconButton";
import Select from "./Select";
import { Segment } from "./Segment";
import Chip from "./Chip";
import { StatusBadge } from "./Badge";
import BookCover from "./BookCover";
import SearchField from "./SearchField";
import Stepper from "./Stepper";
import Tile from "./Tile";
import { Menu } from "./Menu";
import Toast from "./Toast";
import TextField from "./TextField";
import { SettingsGroup } from "./SettingsRow";

vi.mock("../../platform", () => ({
  convertFileSrc: (p: string) => `quill-file://local/${p}`,
  invoke: () => Promise.resolve(null),
}));

describe("Dawn UI primitives scoping and accessibility", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    document.documentElement.classList.remove("dawn", "dark");
    await i18n.changeLanguage("en");
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    document.documentElement.classList.remove("dawn", "dark");
  });

  it("keeps legacy Button and Select geometry outside .dawn and applies Dawn inside .dawn", async () => {
    await act(async () => {
      root.render(
        <div>
          <Button variant="primary">Save</Button>
          <Select
            value="a"
            onChange={() => {}}
            options={[{ value: "a", label: "Alpha" }, { value: "b", label: "Beta" }]}
          />
        </div>,
      );
    });

    const legacyBtn = container.querySelectorAll("button")[0];
    const legacySelect = container.querySelectorAll("button")[1];
    expect(legacyBtn.className).toContain("rounded-lg");
    expect(legacySelect.className).toContain("bg-bg-input");

    await act(async () => {
      legacySelect.click();
    });
    const legacyMenu = document.body.querySelector(".shadow-popover");
    expect(legacyMenu).not.toBeNull();
    expect(legacyMenu?.className).not.toContain("dawn-menu");
    await act(async () => {
      legacySelect.click();
    });

    document.documentElement.classList.add("dawn");
    await act(async () => {
      root.render(
        <div>
          <Button variant="primary">Save</Button>
          <Select
            value="a"
            onChange={() => {}}
            options={[{ value: "a", label: "Alpha" }, { value: "b", label: "Beta" }]}
          />
        </div>,
      );
    });

    const dawnBtn = container.querySelectorAll("button")[0];
    const dawnSelect = container.querySelectorAll("button")[1];
    expect(dawnBtn.className).toContain("rounded-control");
    expect(dawnBtn.className).not.toContain("rounded-full");
    expect(dawnSelect.className).toContain("dawn-glass");
    expect(dawnSelect.className).toContain("rounded-full");

    await act(async () => {
      dawnSelect.click();
    });
    const dawnMenu = document.body.querySelector(".dawn-menu");
    expect(dawnMenu).not.toBeNull();
  });

  it("applies 12px control radius to Dawn Button sizes and IconButton while keeping pills", async () => {
    await act(async () => {
      root.render(
        <div>
          <Button appearance="dawn" size="sm">Small</Button>
          <Button appearance="dawn" size="md">Medium</Button>
          <Button appearance="dawn" size="lg">Large</Button>
          <IconButton aria-label="Search">+</IconButton>
          <Segment label="All" selected />
          <Chip>Reading</Chip>
          <StatusBadge label="Connected" tone="success" />
        </div>,
      );
    });

    const buttons = Array.from(container.querySelectorAll("button"));
    // sm, md, lg Button + IconButton -> rounded-control
    for (const controlBtn of buttons.slice(0, 4)) {
      expect(controlBtn.className).toContain("rounded-control");
      expect(controlBtn.className).not.toContain("rounded-full");
    }
    // Segment + Chip -> stay pill
    for (const pillBtn of buttons.slice(4, 6)) {
      expect(pillBtn.className).toContain("rounded-full");
      expect(pillBtn.className).not.toContain("rounded-control");
    }
    const badge = container.querySelector("span.rounded-full");
    expect(badge?.textContent).toContain("Connected");
  });

  it("resets BookCover error state when cover source changes", async () => {
    await act(async () => {
      root.render(<BookCover title="Book A" coverData="data:image/png;base64,bad" />);
    });

    const firstImg = container.querySelector("img");
    expect(firstImg).not.toBeNull();

    await act(async () => {
      firstImg!.dispatchEvent(new Event("error"));
    });
    expect(container.querySelector("img")).toBeNull();

    await act(async () => {
      root.render(<BookCover title="Book B" coverData="data:image/png;base64,good" />);
    });
    const nextImg = container.querySelector("img");
    expect(nextImg).not.toBeNull();
    expect(nextImg?.getAttribute("src")).toBe("data:image/png;base64,good");
  });

  it("renders translated accessible labels for SearchField and Stepper", async () => {
    await i18n.changeLanguage("zh");
    await act(async () => {
      root.render(
        <div>
          <SearchField value="test" onChange={() => {}} onClear={() => {}} />
          <Stepper valueLabel="100%" onDecrement={() => {}} onIncrement={() => {}} />
        </div>,
      );
    });

    expect(container.querySelector('button[aria-label="清除"]')).not.toBeNull();
    expect(container.querySelector('button[aria-label="减少"]')).not.toBeNull();
    expect(container.querySelector('button[aria-label="增加"]')).not.toBeNull();
  });

  it("defines --radius-surface: 8px separately from --radius-xl: 14px and applies 8px/6px radii to surfaces and nested controls", async () => {
    const css = fs.readFileSync(path.resolve(process.cwd(), "src/index.css"), "utf8");
    expect(css).toContain("--radius-surface: 8px;");
    expect(css).toContain("--radius-xl: 14px;");
    expect(css).toMatch(/\.dawn \.markdown-body pre\s*\{[^}]*border-radius:\s*6px;/);

    await act(async () => {
      root.render(
        <div>
          <Tile title="Saved words">Content</Tile>
          <Menu>Menu item</Menu>
          <Toast>Notice</Toast>
          <TextField placeholder="Name" />
          <SettingsGroup>Row</SettingsGroup>
        </div>,
      );
    });
    const wrapper = container.firstElementChild as HTMLElement;
    const [tile, menu, toast, textField, settingsGroup] = Array.from(wrapper.children) as HTMLElement[];
    expect(tile.className).toContain("rounded-surface");
    expect(menu.className).toContain("rounded-surface");
    expect(toast.firstElementChild?.className).toContain("rounded-surface");
    expect(textField.className).toContain("rounded-[6px]");
    expect(settingsGroup.className).toContain("rounded-[6px]");
  });

  it("disables text selection on interactive chrome in @layer base while keeping inputs and editable regions selectable", () => {
    const css = fs.readFileSync(path.resolve(process.cwd(), "src/index.css"), "utf8");
    const baseMatch = css.match(/@layer base\s*\{([\s\S]*?)\n\}/);
    expect(baseMatch).not.toBeNull();
    const baseBlock = baseMatch![1];

    expect(baseBlock).toMatch(
      /button[\s\S]*\[role="button"\][\s\S]*\[role="tab"\][\s\S]*\[role="menuitem"\][\s\S]*\[role="option"\][\s\S]*\.dawn-inset[\s\S]*\{[\s\S]*-webkit-user-select:\s*none;\s*user-select:\s*none;/,
    );
    expect(baseBlock).toMatch(
      /input,\s*textarea,\s*\[contenteditable\]:not\(\[contenteditable="false"\]\)\s*\{[\s\S]*-webkit-user-select:\s*text;\s*user-select:\s*text;/,
    );
  });
});
