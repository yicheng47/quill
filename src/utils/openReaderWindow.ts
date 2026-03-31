import { WebviewWindow } from "@tauri-apps/api/webviewWindow";

interface ReaderWindowOptions {
  openVocab?: boolean;
  openChat?: boolean;
  chatId?: string;
  cfi?: string | null;
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

  new WebviewWindow(label, {
    url,
    title: "Quill",
    width: 1440,
    height: 960,
    minWidth: 700,
    minHeight: 500,
    titleBarStyle: "overlay",
    hiddenTitle: true,
  });
}
