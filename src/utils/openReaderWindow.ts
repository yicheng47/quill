import { emitTo, focusWindow, openReaderWindow as openPlatformReaderWindow } from "../platform";

export const READER_NAVIGATE_EVENT = "reader-navigate";

export interface ReaderWindowOptions {
  openVocab?: boolean;
  openChat?: boolean;
  chatId?: string;
  cfi?: string | null;
  quote?: string | null;
}

export function hasReaderNavigationOptions(
  options: ReaderWindowOptions | null | undefined,
): options is ReaderWindowOptions {
  return Boolean(
    options &&
      (options.openVocab || options.openChat || options.chatId || options.cfi || options.quote),
  );
}

export function buildReaderUrl(bookId: string, options?: ReaderWindowOptions): string {
  let url = `/reader/${bookId}`;
  if (!options) return url;
  const params = new URLSearchParams();
  if (options.openVocab) params.set("openVocab", "true");
  if (options.openChat) params.set("openChat", "true");
  if (options.chatId) params.set("chatId", options.chatId);
  if (options.cfi) params.set("cfi", options.cfi);
  if (options.quote) params.set("quote", options.quote);
  const qs = params.toString();
  if (qs) url += `?${qs}`;
  return url;
}

export function parseReaderNavigation(
  state: ReaderWindowOptions | null | undefined,
  search: string,
): { source: "state" | "query"; options: ReaderWindowOptions } | null {
  if (hasReaderNavigationOptions(state)) {
    return {
      source: "state",
      options: {
        openVocab: Boolean(state.openVocab),
        openChat: Boolean(state.openChat),
        chatId: state.chatId || undefined,
        cfi: state.cfi || undefined,
        quote: state.quote || undefined,
      },
    };
  }

  const params = new URLSearchParams(search);
  const parsed: ReaderWindowOptions = {
    openVocab: params.get("openVocab") === "true",
    openChat: params.get("openChat") === "true",
    chatId: params.get("chatId") || undefined,
    cfi: params.get("cfi") || undefined,
    quote: params.get("quote") || undefined,
  };
  if (hasReaderNavigationOptions(parsed)) {
    return { source: "query", options: parsed };
  }
  return null;
}

const DEFAULT_WIDTH = 1440;
const DEFAULT_HEIGHT = 960;
const MIN_WIDTH = 700;
const MIN_HEIGHT = 500;

function loadSavedSize(bookId: string): { width: number; height: number } {
  try {
    const raw = localStorage.getItem(`reader-window-${bookId}`);
    if (!raw) return { width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT };
    const parsed = JSON.parse(raw) as { width?: unknown; height?: unknown };
    const width = typeof parsed.width === "number" && Number.isFinite(parsed.width) ? parsed.width : DEFAULT_WIDTH;
    const height = typeof parsed.height === "number" && Number.isFinite(parsed.height) ? parsed.height : DEFAULT_HEIGHT;
    return {
      width: Math.max(MIN_WIDTH, Math.round(width)),
      height: Math.max(MIN_HEIGHT, Math.round(height)),
    };
  } catch {
    return { width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT };
  }
}

function loadSavedPageTheme(bookId: string): string | undefined {
  try {
    const raw = localStorage.getItem(`reader-settings-${bookId}`);
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as { theme?: unknown };
    if (
      parsed.theme === "original" ||
      parsed.theme === "paper" ||
      parsed.theme === "quiet" ||
      parsed.theme === "dark"
    ) {
      return parsed.theme;
    }
  } catch {
    // Ignore malformed localStorage state
  }
  return undefined;
}

export async function openReaderWindow(
  bookId: string,
  options?: ReaderWindowOptions
): Promise<void> {
  const label = `reader-${bookId}`;

  try {
    if (await focusWindow(label)) {
      if (hasReaderNavigationOptions(options)) {
        await emitTo(label, READER_NAVIGATE_EVENT, options);
      }
      return;
    }
  } catch (err) {
    console.error("Failed to open reader window:", err);
    return;
  }

  const url = buildReaderUrl(bookId, options);

  const { width, height } = loadSavedSize(bookId);
  const pageTheme = loadSavedPageTheme(bookId);

  await openPlatformReaderWindow({
    label,
    url,
    title: "Quill",
    width,
    height,
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    ...(pageTheme ? { pageTheme } : {}),
  });
}
