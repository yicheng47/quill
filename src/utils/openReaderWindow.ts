import { WebviewWindow } from "@tauri-apps/api/webviewWindow";

interface ReaderWindowOptions {
  openVocab?: boolean;
  openChat?: boolean;
  chatId?: string;
  cfi?: string | null;
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

export async function openReaderWindow(
  bookId: string,
  options?: ReaderWindowOptions
): Promise<void> {
  const label = `reader-${bookId}`;

  // Focus existing window if already open
  const existing = await WebviewWindow.getByLabel(label);
  if (existing) {
    await existing.setFocus();
    return;
  }

  // Build URL with optional query params
  let url = `/reader/${bookId}`;
  if (options) {
    const params = new URLSearchParams();
    if (options.openVocab) params.set("openVocab", "true");
    if (options.openChat) params.set("openChat", "true");
    if (options.chatId) params.set("chatId", options.chatId);
    if (options.cfi) params.set("cfi", options.cfi);
    const qs = params.toString();
    if (qs) url += `?${qs}`;
  }

  const { width, height } = loadSavedSize(bookId);

  new WebviewWindow(label, {
    url,
    title: "Quill",
    width,
    height,
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    titleBarStyle: "overlay",
    hiddenTitle: true,
  });
}
