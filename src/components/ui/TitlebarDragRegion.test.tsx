import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import TitlebarDragRegion from "./TitlebarDragRegion";

describe("TitlebarDragRegion", () => {
  it("renders the 44px drag strip by default", () => {
    const markup = renderToStaticMarkup(<TitlebarDragRegion />);

    expect(markup).toContain("data-tauri-drag-region");
    expect(markup).toContain('class="absolute top-0 left-0 right-0 h-11"');
  });

  it("supports the compact 32px drag strip", () => {
    const markup = renderToStaticMarkup(<TitlebarDragRegion height={32} />);

    expect(markup).toContain('class="absolute top-0 left-0 right-0 h-8"');
  });
});
