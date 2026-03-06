# Migration: epub.js → foliate-js

## Context
epub.js has fundamental scrolling issues with image-heavy books. Its iframe-based architecture creates feedback loops between `adjustImages`, `expand()`, `resizeCheck()`, and `textHeight()`, making scrolled mode unreliable. foliate-js is a more modern library using Web Components and CSS multi-column layout, with native scrolled/paginated mode switching.

**Goal**: Replace epub.js with foliate-js in `Reader.tsx`, then write a docs guide at `docs/guide/foliate-migration.md`.

---

## Step 1: Install foliate-js

Added as a git submodule from our fork:
```bash
git submodule add git@github.com:yicheng47/foliate-js.git public/foliate-js
```

This places the full library at `public/foliate-js/`, served as static assets by Vite. Key files:
- `view.js` — Main entry, registers `<foliate-view>` web component
- `epub.js` — EPUB parser (not the same as the epub.js npm package)
- `epubcfi.js` — CFI parsing/resolution
- `paginator.js` — Reflowable renderer (`<foliate-paginator>`)
- `overlayer.js` — SVG annotation overlays
- `progress.js` — TOCProgress + SectionProgress
- `vendor/zip.js` — ZIP file reading

---

## Step 2: Remove epub.js

```bash
npm uninstall epubjs
```

Remove from `package.json`. Delete `localStorage` keys for `locations_*` (epub.js cached locations).

---

## Step 3: Rewrite Reader.tsx

### 3a. Imports

**Before (epub.js)**:
```ts
import ePub, { type Book as EpubBook, type Rendition, type NavItem } from "epubjs";
```

**After (foliate-js)**:
```ts
// foliate-js uses native ES modules via <script type="module">
// Import as dynamic side-effect from public dir
```

Since foliate-js registers Web Components (`<foliate-view>`, `<foliate-paginator>`), we need to load `view.js` as a module. In Tauri/Vite, we can use a dynamic `import()` or load via `<script type="module">`.

Best approach for React: dynamic import in useEffect, then interact with the DOM element directly.

```ts
// No static imports — foliate-js is loaded dynamically
// Types we define ourselves:
interface FoliateView extends HTMLElement {
  open(file: string | File | Blob): Promise<void>;
  init(opts: { lastLocation?: string }): Promise<void>;
  goTo(target: string | number): Promise<any>;
  prev(): Promise<void>;
  next(): Promise<void>;
  close(): void;
  book: any;
  renderer: any;
  lastLocation: any;
  getCFI(index: number, range: Range): string;
  addAnnotation(annotation: { value: string; color?: string }): Promise<any>;
  deleteAnnotation(annotation: { value: string }): Promise<void>;
}
```

### 3b. Initialization

**Before (epub.js)**:
```ts
const epubBook = ePub(epubUrl);
const rendition = epubBook.renderTo(container, {
  width, height, spread: "none",
  flow: isScrolling ? "scrolled" : "paginated",
  manager: "continuous",
});
rendition.display(startCfi);
```

**After (foliate-js)**:
```ts
// Load foliate-js modules
await import("/foliate-js/view.js");

const view = document.createElement("foliate-view") as FoliateView;
container.appendChild(view);

// Open book — can take a URL string, File, or Blob
// For Tauri, fetch the file as a blob first via convertFileSrc
const epubUrl = convertFileSrc(book.file_path);
const response = await fetch(epubUrl);
const blob = new File([await response.blob()], "book.epub");
await view.open(blob);

// Set reading mode
view.renderer.setAttribute("flow", isScrolling ? "scrolled" : "paginated");

// Apply styles
view.renderer.setStyles?.(getCSS(readerSettings));

// Navigate to saved position
await view.init({ lastLocation: startCfi || undefined });
```

### 3c. Remove Constants

Delete `PAGINATED_CSS` and `SCROLLING_CSS` constants. foliate-js handles image sizing internally via `paginator.js` `setImageSize()`.

Replace with a style-generating function:

```ts
const getReaderCSS = (settings: ReaderSettingsState) => {
  const themeColors = getThemeStyles(settings.theme);
  const fontFamily = getFontFamily(settings.font);
  return `
    body {
      background-color: ${themeColors.body} !important;
      color: ${themeColors.text} !important;
      font-family: ${fontFamily} !important;
      font-size: ${settings.fontSize}px !important;
      line-height: ${settings.lineSpacing} !important;
      letter-spacing: ${settings.charSpacing === 0 ? "normal" : `${settings.charSpacing * 0.01}em`} !important;
      word-spacing: ${settings.wordSpacing === 0 ? "normal" : `${settings.wordSpacing * 0.01}em`} !important;
    }
    p, span, div, li, td, th, h1, h2, h3, h4, h5, h6 {
      color: ${themeColors.text} !important;
      font-family: ${fontFamily} !important;
      line-height: ${settings.lineSpacing} !important;
    }
  `;
};
```

### 3d. State Changes

**Remove** (epub.js-specific):
- `epubRef` (EpubBook ref)
- `renditionRef` (Rendition ref)
- `locationsReady` (foliate-js calculates progress from section sizes, no `locations.generate()` needed)
- `selectedCfiRef` (text selection is handled differently)

**Add**:
- `viewRef = useRef<FoliateView | null>(null)` — the `<foliate-view>` element

### 3e. Reading Mode Switching

**Before**: Destroy and recreate entire rendition with different `flow` config.

**After**: Just set an attribute — no reload needed!
```ts
viewRef.current?.renderer.setAttribute("flow",
  readerSettings.readingMode === "scrolling" ? "scrolled" : "paginated"
);
```

### 3f. Navigation

| epub.js | foliate-js |
|---------|-----------|
| `rendition.prev()` | `view.prev()` |
| `rendition.next()` | `view.next()` |
| `rendition.display(cfi)` | `view.goTo(cfi)` |
| `rendition.display(href)` | `view.goTo(href)` |

### 3g. Progress & Location Tracking

**Before (epub.js)**:
```ts
rendition.on("relocated", (location) => {
  const cfi = location.start.cfi;
  const pct = epubBook.locations.percentageFromCfi(cfi) * 100;
  const currentLoc = epubBook.locations.locationFromCfi(cfi);
  setProgress(pct);
  setPageInfo({ current: currentLoc + 1, total: totalLocs });
});
```

**After (foliate-js)**:
```ts
view.addEventListener("relocate", (e: CustomEvent) => {
  const { fraction, location, tocItem, pageItem, cfi } = e.detail;
  // fraction: 0-1 overall progress
  // location: { current, next, total } — loc numbers from section sizes
  // tocItem: { label, href, id } — current TOC item
  // pageItem: page list item (if EPUB has page list)
  // cfi: EPUB CFI string of current position

  const pct = Math.round(fraction * 100);
  setProgress(pct);
  currentCfiRef.current = cfi;

  if (location) {
    setPageInfo({ current: location.current + 1, total: location.total });
  }

  if (tocItem) {
    const idx = chapters.findIndex(c => c.href === tocItem.href);
    if (idx !== -1) setCurrentChapterIndex(idx);
  }

  // Save to backend
  if (bookId) {
    updateReadingProgress(bookId, pct, cfi).catch(() => {});
  }
});
```

No need for `locations.generate()` — foliate-js `SectionProgress` calculates progress from section byte sizes automatically.

### 3h. TOC Loading

**Before (epub.js)**:
```ts
epubBook.loaded.navigation.then((nav) => {
  const chs = flattenToc(nav.toc);
  setChapters(chs);
});
```

**After (foliate-js)**:
```ts
// Available immediately after view.open()
const toc = view.book.toc;
const flattenToc = (items: any[]): TocChapter[] =>
  items.flatMap(item => [
    { title: item.label?.trim() || "", href: item.href },
    ...(item.subitems ? flattenToc(item.subitems) : []),
  ]);
const chs = flattenToc(toc || []);
setChapters(chs);
```

### 3i. Text Selection & Context Menu

**Before (epub.js)**: Complex iframe coordinate mapping:
```ts
rendition.on("selected", (cfiRange, _contents) => { ... });
// Context menu coordinates require iframe-to-parent offset calculation
```

**After (foliate-js)**: Direct document access via `load` event:
```ts
view.addEventListener("load", (e: CustomEvent) => {
  const { doc, index } = e.detail;
  // doc is the Document of the loaded section
  // No iframes in scrolled mode — direct DOM access!

  doc.addEventListener("mouseup", () => {
    const sel = doc.getSelection();
    const text = sel?.toString().trim();
    if (text && sel.rangeCount > 0) {
      const range = sel.getRangeAt(0);
      const cfi = view.getCFI(index, range);
      // Store for context menu use
      selectedTextRef.current = { text, cfi, range };
    }
  });

  doc.addEventListener("contextmenu", (e: MouseEvent) => {
    const text = selectedTextRef.current?.text;
    if (text) {
      e.preventDefault();
      // In foliate-js, coordinates are in the same viewport
      setContextMenu({ x: e.clientX, y: e.clientY, text,
        cfiRange: selectedTextRef.current?.cfi });
    }
  });

  // Keyboard navigation inside loaded docs
  doc.addEventListener("keydown", (e: KeyboardEvent) => {
    if (e.key === "ArrowLeft") view.prev();
    else if (e.key === "ArrowRight") view.next();
  });
});
```

### 3j. Applying Settings / Themes

**Before (epub.js)**:
```ts
rendition.themes.default({ body: { ... }, "p, span, ...": { ... } });
```

**After (foliate-js)**:
```ts
// setStyles accepts a CSS string or [beforeStyles, afterStyles] array
view.renderer.setStyles(getReaderCSS(readerSettings));
```

When settings change, just call `setStyles` again — no need to resize or recreate.

### 3k. Layout Configuration

foliate-js paginator accepts these attributes:
```ts
// Max content width (for margins effect)
view.renderer.setAttribute("max-inline-size", `${maxWidth}px`);
// Gap between columns
view.renderer.setAttribute("gap", "5%");
// Max columns in landscape
view.renderer.setAttribute("max-column-count", "2");
// Enable page turn animation
view.renderer.setAttribute("animated", "");
// Margin for header/footer
view.renderer.setAttribute("margin", "40px");
```

### 3l. Highlights / Annotations

**Before (epub.js)**:
```ts
rendition.annotations.add("highlight", cfiRange, {},
  undefined, "hl", { fill: color, "fill-opacity": "0.3" });
```

**After (foliate-js)**:
```ts
// Listen for overlay creation
view.addEventListener("create-overlay", (e: CustomEvent) => {
  const { index } = e.detail;
  // Load highlights for this section from DB and add them
  loadHighlightsForSection(index);
});

// Drawing handler — called when an annotation is rendered
view.addEventListener("draw-annotation", (e: CustomEvent) => {
  const { draw, annotation } = e.detail;
  const color = highlightColorMap[annotation.color] || "rgba(251, 191, 36, 0.3)";
  draw(Overlayer.highlight, { color });
});

// Clicking a highlight
view.addEventListener("show-annotation", (e: CustomEvent) => {
  const { value, range } = e.detail;
  // Show note or navigate
});

// Add a highlight
const annotation = { value: cfiRange, color: "yellow" };
await view.addAnnotation(annotation);

// Remove a highlight
await view.deleteAnnotation({ value: cfiRange });
```

The `Overlayer` class provides static draw functions: `highlight`, `underline`, `squiggly`, `strikethrough`, `outline`.

### 3m. Resize Handling

**Before (epub.js)**: Manual ResizeObserver + `rendition.resize()`.

**After (foliate-js)**: The paginator has its own built-in ResizeObserver. No manual resize handling needed. Remove the ResizeObserver code entirely.

### 3n. Cleanup

**Before**:
```ts
rendition.destroy();
epubBook.destroy();
```

**After**:
```ts
view.close();
view.remove();
```

---

## Step 4: Brightness / Filter

foliate-js exposes a `::part(filter)` CSS part on the renderer:
```css
foliate-view::part(filter) {
  filter: brightness(0.8);
}
```

For dynamic brightness, set it via JS on the view element's renderer:
```ts
view.renderer.style.setProperty("--brightness", `${readerSettings.brightness / 100}`);
// Or apply directly to the filter part if accessible
```

Alternatively, keep the existing approach of `viewerRef.current.style.filter = ...` on the container div.

---

## Step 5: CSP for Security

foliate-js warns about scripted EPUB content. Add CSP meta tag or Tauri CSP config to block scripts from EPUB content. In `tauri.conf.json`, the existing CSP should already block inline scripts from blob: URLs.

---

## Files to Modify
- `src/pages/Reader.tsx` — Complete rewrite of epub.js integration
- `src/components/ReaderSettings.tsx` — Remove readingMode destruction/recreation (mode switch is now instant)
- `package.json` — Remove `epubjs` dependency

## Files to Create
- `public/foliate-js/` — Git submodule from `git@github.com:yicheng47/foliate-js.git` (already added)

## Files Unchanged
- `src/hooks/useBooks.ts` — CFI strings are compatible (both use EPUB CFI spec)
- `src/hooks/useBookmarks.ts` — Only calls backend, no epub.js dependency
- `src/components/BookmarksPanel.tsx` — No epub.js dependency
- `src/components/AiPanel.tsx` — No epub.js dependency
- `src/components/ReaderContextMenu.tsx` — No epub.js dependency
- All backend Rust files — No changes needed

---

## Verification

1. Copy foliate-js files, remove epubjs npm package
2. Rewrite Reader.tsx initialization to use `<foliate-view>`
3. Open a book → verify it renders in paginated mode
4. Switch to scrolled mode via settings → verify instant switch, no reload
5. Open image-heavy book in scroll mode → verify no layout issues (the core reason for migration)
6. Navigate via TOC → verify chapter navigation works
7. Check progress bar → verify fraction-based progress updates
8. Test text selection → context menu appears with correct coordinates
9. Test highlights → add, display, persist across navigation
10. Test keyboard navigation (arrow keys) in both modes
11. Run `npm run build` to verify no build errors
