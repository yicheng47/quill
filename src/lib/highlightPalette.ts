import type { ReaderTheme } from "../components/ReaderSettings";

export const LIGHT_HIGHLIGHT_COLOR_MAP: Record<string, string> = {
  yellow: "#FBE7A1",
  green: "#CDEFD5",
  blue: "#CFE3FF",
  pink: "#FAD3E3",
  purple: "#E4DEFF",
};

export const DARK_HIGHLIGHT_COLOR_MAP: Record<string, string> = {
  yellow: "#E5B83B",
  green: "#3BB86E",
  blue: "#4A8FE7",
  pink: "#E05A94",
  purple: "#8477EE",
};

export interface HighlightAppearance {
  fill: string;
  opacity: string;
  mixBlendMode: string;
}

export function resolveHighlightAppearance(
  colorName: string,
  theme: ReaderTheme,
  isPdf: boolean,
): HighlightAppearance {
  const isDarkTheme = theme === "dark" && !isPdf;
  const colorMap = isDarkTheme ? DARK_HIGHLIGHT_COLOR_MAP : LIGHT_HIGHLIGHT_COLOR_MAP;
  return {
    fill: colorMap[colorName] || colorMap.yellow,
    opacity: isDarkTheme ? "0.38" : isPdf ? "0.7" : "0.9",
    mixBlendMode: isDarkTheme ? "normal" : "multiply",
  };
}

export function createAnnotationDrawCallback(
  annotationColor: string,
  getTheme: () => ReaderTheme,
  isPdf: boolean,
) {
  return (rects: ArrayLike<{ left: number; top: number; height: number; width: number }>) => {
    // Resolve theme dynamically inside the draw callback so Overlayer.redraw()
    // picks up paper theme changes without re-emitting draw-annotation.
    const { fill, opacity, mixBlendMode } = resolveHighlightAppearance(
      annotationColor,
      getTheme(),
      isPdf,
    );
    const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
    g.setAttribute("fill", fill);
    g.setAttribute("opacity", opacity);
    g.style.mixBlendMode = mixBlendMode;
    const pad = isPdf ? 1 : 0;
    for (const rect of Array.from(rects)) {
      const el = document.createElementNS("http://www.w3.org/2000/svg", "rect");
      // PDF text layer spans have sub-pixel gaps; pad rects vertically to close them
      el.setAttribute("x", String(Math.floor(rect.left)));
      el.setAttribute("y", String(rect.top - pad));
      el.setAttribute("height", String(rect.height + pad * 2));
      el.setAttribute("width", String(Math.ceil(rect.width)));
      el.setAttribute("rx", isPdf ? "1" : "3");
      g.append(el);
    }
    return g;
  };
}
