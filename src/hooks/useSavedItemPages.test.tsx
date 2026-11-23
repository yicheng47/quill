/** @vitest-environment jsdom */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ResolveSavedItemPages } from "../utils/savedItemPages";
import { useSavedItemPages } from "./useSavedItemPages";

function Harness({
  cfis,
  resolvePages,
  onMap,
}: {
  cfis: readonly (string | null | undefined)[];
  resolvePages?: ResolveSavedItemPages;
  onMap: (map: ReadonlyMap<string, number>) => void;
}) {
  const map = useSavedItemPages(cfis, resolvePages);
  onMap(map);
  return null;
}

describe("useSavedItemPages", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
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

  async function flush() {
    for (let i = 0; i < 4; i += 1) {
      await act(async () => {
        await Promise.resolve();
      });
    }
  }

  it("hides stale entries immediately when the resolver changes and ignores cancelled promises", async () => {
    let latestMap: ReadonlyMap<string, number> = new Map();
    const firstResolver = vi.fn<ResolveSavedItemPages>(
      async () => new Map([["cfi-1", 10]]),
    );

    let settleSecond!: (map: Map<string, number>) => void;
    const secondResolver = vi.fn<ResolveSavedItemPages>(
      () =>
        new Promise<Map<string, number>>((resolve) => {
          settleSecond = resolve;
        }),
    );

    await act(async () => {
      root.render(
        <Harness cfis={["cfi-1"]} resolvePages={firstResolver} onMap={(m) => { latestMap = m; }} />,
      );
    });
    await flush();
    expect(latestMap.get("cfi-1")).toBe(10);

    // Switching to a new resolver (e.g. a new book) clears stale pages immediately while pending
    await act(async () => {
      root.render(
        <Harness cfis={["cfi-1"]} resolvePages={secondResolver} onMap={(m) => { latestMap = m; }} />,
      );
    });
    expect(latestMap.size).toBe(0);

    // Replace with a third resolver before the second resolves — second's stale result must be ignored
    const thirdResolver = vi.fn<ResolveSavedItemPages>(
      async () => new Map([["cfi-1", 99]]),
    );
    await act(async () => {
      root.render(
        <Harness cfis={["cfi-1"]} resolvePages={thirdResolver} onMap={(m) => { latestMap = m; }} />,
      );
    });
    await flush();
    expect(latestMap.get("cfi-1")).toBe(99);

    await act(async () => {
      settleSecond(new Map([["cfi-1", 55]]));
    });
    await flush();
    expect(latestMap.get("cfi-1")).toBe(99);
  });
});
