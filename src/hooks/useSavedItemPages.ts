import { useEffect, useState } from "react";
import type { ResolveSavedItemPages } from "../utils/savedItemPages";

const EMPTY_PAGES: ReadonlyMap<string, number> = new Map();

export function useSavedItemPages(
  cfis: readonly (string | null | undefined)[],
  resolvePages?: ResolveSavedItemPages,
): ReadonlyMap<string, number> {
  const uniqueCfis: string[] = [];
  const seen = new Set<string>();
  for (const cfi of cfis) {
    if (cfi && !seen.has(cfi)) {
      seen.add(cfi);
      uniqueCfis.push(cfi);
    }
  }
  const cfiKey = uniqueCfis.length > 0 ? JSON.stringify(uniqueCfis) : "";

  const [state, setState] = useState<{
    resolver: ResolveSavedItemPages | undefined;
    pages: ReadonlyMap<string, number>;
  }>({ resolver: resolvePages, pages: EMPTY_PAGES });

  useEffect(() => {
    if (!resolvePages || !cfiKey) {
      setState((prev) =>
        prev.resolver === resolvePages && prev.pages.size === 0
          ? prev
          : { resolver: resolvePages, pages: EMPTY_PAGES },
      );
      return;
    }

    let cancelled = false;
    const list = JSON.parse(cfiKey) as string[];

    void (async () => {
      try {
        const resolved = await resolvePages(list);
        if (!cancelled) {
          setState({ resolver: resolvePages, pages: new Map(resolved) });
        }
      } catch {
        if (!cancelled) {
          setState((prev) =>
            prev.resolver === resolvePages
              ? prev
              : { resolver: resolvePages, pages: EMPTY_PAGES },
          );
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [cfiKey, resolvePages]);

  return state.resolver === resolvePages ? state.pages : EMPTY_PAGES;
}
