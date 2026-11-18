export type HighlightSwatchColor = "yellow" | "green" | "blue" | "pink";

export interface HighlightColorMeta {
  name: string;
  barClass: string;
  bgClass: string;
  swatchClass: string;
  i18nKey: string;
}

export const HIGHLIGHT_FILTER_COLORS: HighlightColorMeta[] = [
  {
    name: "yellow",
    barClass: "border-hl-yellow",
    bgClass: "bg-hl-yellow",
    swatchClass: "bg-hl-yellow",
    i18nKey: "highlights.color.yellow",
  },
  {
    name: "green",
    barClass: "border-hl-green",
    bgClass: "bg-hl-green",
    swatchClass: "bg-hl-green",
    i18nKey: "highlights.color.green",
  },
  {
    name: "blue",
    barClass: "border-hl-blue",
    bgClass: "bg-hl-blue",
    swatchClass: "bg-hl-blue",
    i18nKey: "highlights.color.blue",
  },
  {
    name: "pink",
    barClass: "border-hl-pink",
    bgClass: "bg-hl-pink",
    swatchClass: "bg-hl-pink",
    i18nKey: "highlights.color.pink",
  },
];

const VIOLET_META: HighlightColorMeta = {
  name: "violet",
  barClass: "border-hl-violet",
  bgClass: "bg-hl-violet",
  swatchClass: "bg-hl-violet",
  i18nKey: "highlights.color.violet",
};

const COLOR_MAP = new Map<string, HighlightColorMeta>([
  ...HIGHLIGHT_FILTER_COLORS.map((c) => [c.name, c] as const),
  ["purple", VIOLET_META],
  ["violet", VIOLET_META],
]);

export function getHighlightColorMeta(color: string | null | undefined): HighlightColorMeta {
  const key = (color ?? "yellow").toLowerCase();
  return COLOR_MAP.get(key) ?? HIGHLIGHT_FILTER_COLORS[0];
}
