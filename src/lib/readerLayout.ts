import type { ReaderTheme } from "../components/ReaderSettings";

export const TOC_ISLAND_WIDTH = 300;
export const MIN_PAPER_WIDTH = 240;
export const MIN_PAPER_DUAL_WIDTH = 280;
export const WORKSPACE_GAP = 16;
export const WORKSPACE_PADDING_X = 40;

export const READER_SHELL_BG_BY_THEME: Record<ReaderTheme, string> = {
  original: "#EEEBF8",
  paper: "#F0E7D4",
  quiet: "#D2D2D8",
  dark: "#12111A",
};

export function readerShellClassForTheme(theme: ReaderTheme): string {
  switch (theme) {
    case "paper":
      return "reader-shell-sepia";
    case "quiet":
      return "reader-shell-quiet";
    default:
      return "dawn-atmosphere";
  }
}

/**
 * Returns true when the reader body flex row has enough horizontal budget for
 * both the left Contents island (300px) and the right panel without squeezing
 * the Paper reading surface below a usable minimum.
 */
export function canShowDualIslands(
  workspaceInnerWidth: number,
  rightPanelWidth: number,
): boolean {
  if (!Number.isFinite(workspaceInnerWidth) || workspaceInnerWidth <= 0) {
    return true;
  }
  const required =
    TOC_ISLAND_WIDTH + rightPanelWidth + WORKSPACE_GAP * 2 + MIN_PAPER_DUAL_WIDTH;
  return workspaceInnerWidth >= required;
}
