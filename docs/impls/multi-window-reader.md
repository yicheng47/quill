# Multi-Window Reader & Enhanced Reader Chrome — Implementation Plan

## Context

Quill opens books by navigating within a single window (`navigate('/reader/${bookId}')`), so only one book can be open at a time. Users want to cross-reference multiple books, compare translations, or switch between reads without losing position. The goal: each book opens in its own native macOS window (like Apple Books), with polished auto-hiding chrome for distraction-free reading.

Feature spec: `docs/features/20-multi-window-reader.md`

## Approach

Two phases, implemented sequentially:

1. **Multi-window infrastructure** — Tauri window creation, capabilities, navigation rewiring, window lifecycle
2. **Reader chrome redesign** — Auto-hiding translucent header/footer that overlays the reading surface

---

## Phase 1: Multi-Window Infrastructure

### 1.1 Tauri Capabilities

**File: `src-tauri/capabilities/default.json`**

Expand the window scope from `["main"]` to `["main", "reader-*"]` so reader windows inherit the same permissions. Add the webview creation permission so the main window can spawn new windows.

```json
{
  "windows": ["main", "reader-*"],
  "permissions": [
    // ... existing permissions ...
    "core:webview:allow-create-webview-window",
    "core:window:allow-close",
    "core:window:allow-set-focus",
    "core:window:allow-set-title"
  ]
}
```

> If Tauri 2 doesn't support glob patterns in `windows`, fall back to `"*"` or create a second capability file for reader windows.

### 1.2 Window Creation Utility

**New file: `src/utils/openReaderWindow.ts`**

Central function that replaces all `navigate('/reader/...')` calls.

```typescript
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";

interface ReaderWindowOptions {
  openVocab?: boolean;
  openChat?: boolean;
  chatId?: string;
  cfi?: string;
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
    width: 1100,
    height: 800,
    minWidth: 700,
    minHeight: 500,
    titleBarStyle: "overlay",
    hiddenTitle: true,
  });
}
```

**Design decisions:**
- Label format `reader-{bookId}` — UUIDs are safe for Tauri labels
- No Rust-side window tracking needed — `WebviewWindow.getByLabel()` is the source of truth
- Reader windows are 1100x800 (slightly smaller than library's 1440x960) to feel like document windows

### 1.3 Rewire All Navigation Call Sites

Replace `navigate('/reader/${book.id}')` with `openReaderWindow(book.id)` in these files:

| File | Line(s) | Change |
|------|---------|--------|
| `src/components/BookGrid.tsx` | 35 | `onClick={() => openReaderWindow(book.id)}` |
| `src/components/BookList.tsx` | ~34 | Same |
| `src/components/DictionaryContent.tsx` | 246, 319 | `openReaderWindow(word.book_id, { openVocab: true, cfi: word.cfi })` |
| `src/components/ChatsContent.tsx` | ~79 | `openReaderWindow(bookId, { openChat: true, chatId: chat.id })` |
| `src/pages/DictionaryPage.tsx` | 300, 379 | Same as DictionaryContent |

Remove `useNavigate` imports where no longer needed.

### 1.4 Reader Component — Standalone Window Awareness

**File: `src/pages/Reader.tsx`**

Add standalone window detection at the top of the component:

```typescript
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";

const appWindow = getCurrentWebviewWindow();
const isStandaloneWindow = appWindow.label.startsWith("reader-");
```

**Changes:**

a. **Read params from URL search params** (standalone) or `location.state` (legacy):
```typescript
const searchParams = new URLSearchParams(window.location.search);
const initialOpenChat = location.state?.openChat || searchParams.get("openChat") === "true";
const initialChatId = location.state?.chatId || searchParams.get("chatId");
// ... etc
```

b. **Back button** → close window in standalone mode:
```typescript
onClick={() => isStandaloneWindow ? appWindow.close() : navigate("/")}
// Icon: X for standalone, ArrowLeft for main window
```

c. **Set native window title** from book title:
```typescript
useEffect(() => {
  if (book && isStandaloneWindow) {
    appWindow.setTitle(book.title);
  }
}, [book]);
```

### 1.5 App Entry Point

**File: `src/App.tsx`**

Skip `UpdateProvider` and `UpdateToast` in reader windows (they only need to run in the library):

```typescript
const isMainWindow = getCurrentWebviewWindow().label === "main";

return (
  <BrowserRouter>
    {isMainWindow && (
      <UpdateProvider>
        <UpdateToast ... />
      </UpdateProvider>
    )}
    <Routes>...</Routes>
  </BrowserRouter>
);
```

### 1.6 Window Lifecycle

- **Reading progress**: Already saved on every `relocate` event — no data loss on window close.
- **App exit**: Default Tauri behavior — closing the library window quits the app (all windows close). Standard macOS behavior. Can revisit later if needed.
- **No window state persistence** in Phase 1 (deferred to Phase 3 per feature spec).

### 1.7 i18n

**Files: `src/i18n/en.json`, `src/i18n/zh.json`**

```json
{
  "reader.closeWindow": "Close",
  "reader.closeWindow_zh": "关闭"
}
```

---

## Phase 2: Reader Chrome Changes

The existing Reader page layout, footer, side panels, and theme handling are reused as-is. Only two header changes in standalone windows:

### 2.1 Header Changes (Standalone Only)

1. **Back button → Close button**: `ArrowLeft` becomes `X` icon, calls `appWindow.close()`
2. **TOC button moves to far right**: After AI button

```
┌───────────────────────────────────────────────────────────────────────┐
│ ● ● ●  [✕] | [📖] Book Title          [Aa][📑][🔤] | [🤖 AI] | [≡] │
│              Chapter 3 of 24                                          │
└───────────────────────────────────────────────────────────────────────┘
```

- Left: Close button (X), divider, book icon + title + chapter info (same as current)
- Right: Aa settings, Bookmarks, Vocab, divider, AI button, TOC (moved to far right)
- Entire header is `data-tauri-drag-region` (buttons opt out)
- 80px left padding to clear macOS traffic lights

---

## Implementation Sequence

1. **Capabilities + utility** — `default.json` permissions, `openReaderWindow.ts`
2. **Rewire navigation** — All 7 call sites across 5 files
3. **Reader standalone awareness** — Detection, back→close, TOC position, window title, search params
4. **App.tsx** — Skip UpdateProvider in reader windows
5. **i18n** — New string keys
6. **Test** — Multi-window creation, focus existing, all themes, panel open

---

## UI Changes Summary

The reader window reuses the existing Reader page UI. Only two small header changes for standalone windows:

1. **Back button → Close button**: `ArrowLeft` icon becomes `X` icon, calls `appWindow.close()` instead of `navigate("/")`
2. **TOC button moves to far right**: After the AI button, separated by a divider

Everything else (footer, side panels, settings, themes) stays identical to the current reader page.

---

## Verification

- [ ] Clicking a book in library creates a new reader window
- [ ] Clicking the same book again focuses the existing reader window
- [ ] Multiple books open in separate windows simultaneously
- [ ] Reader header shows close button (X) and TOC on far right in standalone windows
- [ ] Reader footer shows accurate progress
- [ ] Reading progress is saved when reader window closes
- [ ] Window is draggable from header bar
- [ ] All i18n strings are localized (en, zh)
- [ ] `cargo check` and `npm run build` pass
