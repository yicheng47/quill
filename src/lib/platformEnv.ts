export function isMacOS(): boolean {
  return typeof navigator !== "undefined" && navigator.userAgent.includes("Macintosh");
}

export function shortcutModSymbol(): string {
  return isMacOS() ? "⌘" : "Ctrl+";
}
