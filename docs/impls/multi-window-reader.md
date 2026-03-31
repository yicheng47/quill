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

## Phase 2: Reader Chrome Redesign

### 2.1 Layout — Always-Visible Chrome

The reader window keeps the same flex layout as the main window (header on top, content in middle, footer at bottom). The chrome is always visible — no auto-hide. This keeps the UI simple and consistent.

```
┌─────────────────────────────────────┐
│ header (flex, shrink-0, themed)     │
├─────────────────────────────────────┤
│ body (flex-1)                       │
│   ├── reader content (flex-1)       │
│   └── footer (shrink-0, themed)    │
└─────────────────────────────────────┘
```

### 2.2 Chrome Styling — Theme-Aware

The header and footer background matches the active reader theme instead of using the app design system colors (`bg-bg-surface`). This creates a seamless reading experience.

| Theme | Chrome BG | Text/Icon Color | Border |
|-------|-----------|-----------------|--------|
| Original | `#ffffff` | `#0a0a0a` at 60% | `black/10` |
| Paper | `#F2E2C9` | `#34271B` at 60% | `#34271B` at 10% |
| Quiet | `#71717b` | `#fafafa` at 60% | `#fafafa` at 10% |
| Night | `#18181b` | `#d4d4d8` at 60% | `#d4d4d8` at 10% |

### 2.3 Header Content (Standalone)

```
┌──────────────────────────────────────────────────────────┐
│ [traffic lights]  Chapter 3: The Garden    [TOC][Aa][📑][🔤] | [🤖 AI] │
│                   ← 80px pad →             ← right buttons →         │
└──────────────────────────────────────────────────────────┘
```

- Height: 48px, full drag region (`data-tauri-drag-region`)
- Left: 80px padding (traffic-light safe zone) + chapter title (14px semibold, truncated)
- Right: TOC, Aa, Bookmarks, Vocab, divider, AI button (same as current)
- Close button (X icon) replaces back button, left-aligned after traffic lights

### 2.4 Footer Content (Standalone)

```
┌──────────────────────────────────────────────────────────┐
│ ══════════════════════ progress bar ═════════════════════ │
│  Page 42 of 318          [−] 120% [+]        12 pages left │
└──────────────────────────────────────────────────────────┘
```

- Height: 36px
- Top edge: 2px progress bar (theme text at 10% track, 40% fill)
- Left: page/percentage info (12px, theme text at 60%)
- Center: zoom controls for PDF only
- Right: pages remaining (12px, theme text at 50%)

### 2.5 Side Panel Behavior

When any side panel (AI, bookmarks, vocab) is open:
- Panel uses app design system colors (`bg-bg-surface`), not reader theme colors
- Same resizable divider behavior as current

---

## Implementation Sequence

1. **Capabilities + utility** — `default.json` permissions, `openReaderWindow.ts`
2. **Rewire navigation** — All 7 call sites across 5 files
3. **Reader standalone awareness** — Detection, back→close, window title, search params
4. **App.tsx** — Skip UpdateProvider in reader windows
5. **Reader chrome restyle** — Theme-aware header/footer backgrounds for standalone windows
6. **i18n** — New string keys
7. **Test** — Multi-window creation, focus existing, all themes, panel open

---

## Design (Figma)

### Reader Window — Default State (Always-Visible Chrome)

A standalone reader window with header and footer always showing. The chrome uses the reader theme colors for a seamless look.

```
┌─────────────────────────────────────────────────────┐
│ ● ● ●  ✕  Chapter 3: The Garden   [≡][Aa][📑][🔤] | [🤖 AI] │
├─────────────────────────────────────────────────────┤
│                                                     │
│         Lorem ipsum dolor sit amet, consectetur     │
│       adipiscing elit. Sed do eiusmod tempor        │
│       incididunt ut labore et dolore magna          │
│       aliqua. Ut enim ad minim veniam, quis        │
│       nostrud exercitation ullamco laboris nisi     │
│       ut aliquip ex ea commodo consequat.           │
│                                                     │
│         Duis aute irure dolor in reprehenderit      │
│       in voluptate velit esse cillum dolore eu      │
│       fugiat nulla pariatur. Excepteur sint         │
│       occaecat cupidatat non proident, sunt in      │
│       culpa qui officia deserunt mollit anim id     │
│       est laborum.                                  │
│                                                     │
│         Sed ut perspiciatis unde omnis iste natus   │
│       error sit voluptatem accusantium doloremque   │
│       laudantium, totam rem aperiam, eaque ipsa     │
│       quae ab illo inventore veritatis et quasi     │
│       architecto beatae vitae dicta sunt            │
│       explicabo.                                    │
│                                                     │
├─────────────────────────────────────────────────────┤
│ ▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬░░░░░░░░░░░░░░░░░░░░░░░░░░░ │
│  Page 42 of 318                      12 pages left  │
└─────────────────────────────────────────────────────┘
```

**Specs:**
- Frame: 1200x800, window corner radius 10px (macOS native)
- Traffic lights at (14, 14), OS-rendered
- Background: theme body color throughout (header, content, footer all match)
- Content: Georgia 18px, centered column max-width 680px, line-height 1.8

**Header bar specs:**
- Height: 48px, full width, `data-tauri-drag-region` (buttons opt out)
- Background: theme body color (solid, same as reading surface)
- Border bottom: 1px, theme text color at 10% opacity
- Left (at x=80, clearing traffic lights): close button (X, 16px icon), then chapter title (14px semibold, theme text at 85%, truncated with ellipsis, max-width 50%)
- Right (12px from edge): icon buttons — TOC (List 16px), Aa settings, Bookmarks (Bookmark 16px), Vocab (Languages 16px), vertical divider (1px, 20px tall, theme text at 15%), AI button (Bot 16px + "AI" label 14px medium)
- Button style: 32x32 rounded-lg, icon at theme text 60% inactive, accent purple when active. Hover: bg at theme text 8%

**Footer bar specs:**
- Height: 36px, full width
- Background: theme body color (solid, same as reading surface)
- Border top: none — the progress bar acts as the visual separator
- Top edge: 2px progress bar spanning full width. Track: theme text at 10%. Fill: theme text at 40%
- Left (16px pad): page info "Page 42 of 318" or "42%", 12px regular, tabular-nums, theme text at 60%
- Center (PDF only): zoom controls [-] 120% [+]
- Right (16px pad): "12 pages left", 12px regular, theme text at 50%

### Reader Window — With AI Panel Open

```
┌─────────────────────────────────────────────────────────────────────┐
│ ● ● ●  ✕  Chapter 3: The Garden  [≡][Aa][📑][🔤] | [🤖 AI]        │
├──────────────────────────────────────┬──────────────────────────────┤
│                                   ┆  │  AI Assistant               │
│       Lorem ipsum dolor sit amet, ┆  │                             │
│     consectetur adipiscing elit.  ┆  │  What themes appear in      │
│     Sed do eiusmod tempor         ┆  │  this chapter?              │
│     incididunt ut labore et dolore┆  │                             │
│     magna aliqua.                 ┆  │  The main themes in         │
│                                   ┆  │  Chapter 3 are...           │
│       Duis aute irure dolor in    ┆  │                             │
│     reprehenderit in voluptate    ┆  │                             │
│     velit esse cillum dolore eu   ┆  │                             │
│     fugiat nulla pariatur.        ┆  │                             │
│                                   ┆  │  ┌───────────────────────┐  │
│                                   ┆  │  │ Ask anything...        │  │
│                                   ┆  │  └───────────────────────┘  │
├──────────────────────────────────────┤                              │
│ ▬▬▬▬▬▬▬▬▬▬▬░░░░░░░░░░░░░░░░░░░░░░░ │                              │
│  Page 42 of 318     12 pages left   │                              │
└──────────────────────────────────────┴──────────────────────────────┘
```

**Specs:**
- Panel: 525px default width (resizable 320-700px), `bg-bg-surface` (app design tokens, NOT reader theme)
- Reading area: viewport width - panel width. Foliate-js reflows text to fit
- Resize handle: vertical dotted grip between reading area and panel (same as current)
- Header spans full window width. Footer spans only the reading area (left of panel)

### Theme Variants — All Four Themes

Show a 2x2 grid of the full reader, each frame 1200x800 with header + footer visible.

**Original (Light)**
```
BG: #ffffff | Text: #0a0a0a | Chrome BG: #ffffff | Border: rgba(0,0,0,0.1)
Header text and icons are near-black. Clean, minimal.
```

**Paper (Sepia)**
```
BG: #F2E2C9 | Text: #34271B | Chrome BG: #F2E2C9 | Border: rgba(52,39,27,0.1)
Warm amber tones. Header blends into the page. Cozy, bookish.
```

**Quiet (Gray)**
```
BG: #71717b | Text: #fafafa | Chrome BG: #71717b | Border: rgba(250,250,250,0.1)
Muted steel gray. Low contrast, eye-friendly.
```

**Night (Dark)**
```
BG: #18181b | Text: #d4d4d8 | Chrome BG: #18181b | Border: rgba(212,212,216,0.1)
True dark mode. Chrome is seamless with reading surface.
Accent buttons use #a855f7 (lighter purple for dark themes).
```

---

## Verification

- [ ] Clicking a book in library creates a new reader window
- [ ] Clicking the same book again focuses the existing reader window
- [ ] Multiple books open in separate windows simultaneously
- [ ] Reader header shows chapter/book title with correct theme styling
- [ ] Reader footer shows accurate progress with correct theme styling
- [ ] Header and footer are always visible in reader windows
- [ ] Reading progress is saved when reader window closes
- [ ] All four themes render correctly (original, paper, quiet, night)
- [ ] Window is draggable from header bar
- [ ] All i18n strings are localized (en, zh)
- [ ] `cargo check` and `npm run build` pass
