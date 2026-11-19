// macOS 26 traffic lights span ~60pt; both TopBar and Reader toolbar share this width before their horizontal gap.
export const MAC_TRAFFIC_LIGHT_SPACER_CLASS = "w-[60px]";

export function isMacOS(): boolean {
  return typeof navigator !== "undefined" && navigator.userAgent.includes("Macintosh");
}

export function isWindows(): boolean {
  return typeof navigator !== "undefined" && navigator.userAgent.includes("Windows");
}

export function shortcutModSymbol(): string {
  return isMacOS() ? "⌘" : "Ctrl+";
}
