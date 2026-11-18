/** @vitest-environment jsdom */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../../i18n";
import Button from "./Button";
import Select from "./Select";
import BookCover from "./BookCover";
import SearchField from "./SearchField";
import Stepper from "./Stepper";

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
    expect(dawnBtn.className).toContain("rounded-full");
    expect(dawnSelect.className).toContain("dawn-glass");

    await act(async () => {
      dawnSelect.click();
    });
    const dawnMenu = document.body.querySelector(".dawn-menu");
    expect(dawnMenu).not.toBeNull();
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
});
