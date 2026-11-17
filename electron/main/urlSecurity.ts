export function resolveWindowUrl(routePath: string, rendererDevUrl?: string): string {
  if (!routePath.startsWith("/") || routePath.startsWith("//") || routePath.includes("\\")) {
    throw new Error(`Unsafe window route: ${routePath}`);
  }

  let base: URL;
  if (rendererDevUrl) {
    base = new URL(rendererDevUrl);
    if (base.username || base.password) {
      throw new Error("Dev renderer URL must not carry credentials");
    }
  } else {
    base = new URL("quill-app://app/");
  }

  const resolved = new URL(routePath, `${base.protocol}//${base.host}/`);
  if (
    resolved.protocol !== base.protocol ||
    resolved.host !== base.host ||
    resolved.username !== "" ||
    resolved.password !== ""
  ) {
    throw new Error(`Resolved URL escaped trusted origin: ${routePath}`);
  }

  const normalizedPath = resolved.pathname;
  if (normalizedPath !== "/" && !normalizedPath.startsWith("/reader/")) {
    throw new Error(`Disallowed window route path: ${normalizedPath}`);
  }

  return resolved.toString();
}

export function isAllowedNavigation(rawUrl: string, rendererDevUrl?: string): boolean {
  let target: URL;
  try {
    target = new URL(rawUrl);
  } catch {
    return false;
  }

  if (target.username !== "" || target.password !== "") {
    return false;
  }

  if (target.protocol === "quill-app:") {
    return target.hostname === "app" && target.port === "";
  }

  if (rendererDevUrl) {
    try {
      const dev = new URL(rendererDevUrl);
      if (dev.username !== "" || dev.password !== "") {
        return false;
      }
      return target.protocol === dev.protocol && target.host === dev.host;
    } catch {
      return false;
    }
  }

  return false;
}

export function isSafeHttpUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}
