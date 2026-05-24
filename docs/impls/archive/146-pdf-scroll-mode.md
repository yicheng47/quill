# PDF Continuous Scroll Mode

**Issue:** [#146](https://github.com/yicheng47/quill/issues/146)
**Spec:** `docs/features/146-pdf-scroll-mode.md`

## Context

PDF rendering currently goes through foliate-js's `foliate-fxl` (FixedLayout) component, which shows one or two pages at a time in iframes. Each "page" is a section in the foliate book model; loading a section renders a fresh canvas + text layer + annotation layer into a new iframe. See `public/foliate-js/pdf.js` for `makePDF()` and `renderPage()`, and `public/foliate-js/fixed-layout.js` for the viewer.

Scroll mode needs a different viewer: all pages stacked vertically in one scroll container with virtualized rendering (only pages near the viewport hold a live iframe). The same `pdf.js` page loader can be reused — only the layout layer changes.

Reading Mode and Page Layout are **orthogonal** — all four combinations (paginated/scroll × single/two-page) must work. The new scroll renderer is therefore organized around **rows**, where a row is either one page (single-page layout) or a pair of pages rendered side-by-side (two-page layout). Virtualization, progress tracking, and keyboard navigation all operate on rows.

Per-book settings already exist (issue #119). `readingMode` is already a valid setting key with `"paginated" | "scrolling"` values, but it's currently hidden in the UI for PDFs. We just need to surface the toggle for PDFs and branch the renderer in `Reader.tsx`. The existing `pageColumns` setting (which drives `spread`) continues to drive the Page Layout toggle and maps into the new scroll renderer as the `spread` attribute — identical to how `foliate-fxl` uses it today.

## Approach

1. Add a new foliate-js custom element `foliate-pdf-scroll` (`public/foliate-js/pdf-scroll.js`) that takes a PDF book, computes rows based on the `spread` attribute (one page per row or two pages per row), renders placeholder divs for every row, and uses `IntersectionObserver` to lazy-mount/unmount the row's iframe(s) as they enter/leave a buffer around the viewport.
2. Mirror the public API surface of `foliate-fxl` enough for `Reader.tsx` to treat it as a drop-in: `open(book)`, `goTo({ index })`, `zoom` and `spread` attributes, `relocate`/`create-overlayer`/`load` events, `getContents()`, `destroy()`. Responding to the `spread` attribute (via `attributeChangedCallback`) re-lays out rows without destroying the component.
3. In `Reader.tsx`, pick the element at foliate init time based on `readerSettings.readingMode`; pass `spread` derived from `readerSettings.pageColumns` to whichever element is used, same as today.
4. Remove the `bookFormat !== "pdf"` gate on the existing reading-mode toggle in `ReaderSettings.tsx` so PDFs get the same toggle EPUBs do. The existing PDF-only Page Layout toggle stays as-is.
5. Handle both toggles live:
   - Reading Mode change → re-init the viewer with the same book, same `spread`, same current index
   - Page Layout change in scroll mode → just update the `spread` attribute; the scroll renderer re-computes rows without destroying the component

Everything else (theme overlay, selection, AI context menu, highlights, progress tracking, bookmarks) already operates on the `doc` passed in `load`/`create-overlayer` events, so it keeps working unchanged.

---

## Step 1: Create `foliate-pdf-scroll` web component

**File: `public/foliate-js/pdf-scroll.js`** (new)

Skeleton (intentionally close to `fixed-layout.js`'s conventions so future maintainers recognize it). The core data structure is a list of **rows**, where each row holds 1 or 2 pages depending on the `spread` attribute.

```javascript
const RENDER_BUFFER_VIEWPORTS = 2   // render rows within 2 viewport heights of the visible area
const UNLOAD_BUFFER_VIEWPORTS = 3   // tear down when more than 3 viewport heights away

// A page slot inside a row — holds one PDF page's iframe and metadata.
// { index, iframe, width, height, loaded, loading, overlayer, srcRef }

// A row — holds one slot (single-page layout) or two slots (two-page layout).
// { placeholder, slots, rowWidth, rowHeight }

export class PDFScroll extends HTMLElement {
    static observedAttributes = ['zoom', 'spread']
    #root = this.attachShadow({ mode: 'closed' })
    #container    // scroll container (inside shadow root)
    #rows = []    // Row[]
    #observer     // IntersectionObserver
    #zoom = 1
    #spread = 'none'   // 'none' | 'auto'
    #scrollRaf = 0
    #reportedIndex = -1
    book

    constructor() {
        super()
        const sheet = new CSSStyleSheet()
        sheet.replaceSync(`
          :host { display: block; width: 100%; height: 100%; overflow: auto; }
          .container { display: flex; flex-direction: column; align-items: center;
                       gap: 12px; padding: 12px 0; min-height: 100%; }
          .row { position: relative; display: flex; flex-direction: row;
                 box-shadow: 0 2px 8px rgba(0,0,0,0.12); background: var(--page-bg, #fff);
                 flex-shrink: 0; }
          .slot { position: relative; background: var(--page-bg, #fff); flex-shrink: 0; }
          .slot > iframe { border: 0; display: block; width: 100%; height: 100%;
                           background: var(--page-bg, #fff); }
        `)
        this.#root.adoptedStyleSheets = [sheet]
        this.#container = document.createElement('div')
        this.#container.className = 'container'
        this.#root.append(this.#container)
        this.addEventListener('scroll', this.#onScroll.bind(this))
    }

    attributeChangedCallback(name, _, value) {
        if (name === 'zoom') {
            this.#zoom = value === 'fit-width' || value === 'fit-page'
                ? value
                : parseFloat(value) || 1
            this.#layoutAll()
        } else if (name === 'spread') {
            const next = value === 'none' ? 'none' : 'auto'
            if (next === this.#spread) return
            this.#spread = next
            if (this.book) this.#rebuildRows()
        }
    }

    async open(book) {
        this.book = book
        // Pre-fetch natural page sizes so we can reserve placeholder space.
        this.#pageSizes = await Promise.all(book.sections.map((_, i) =>
            book.getPageSize?.(i) ?? Promise.resolve({ width: 800, height: 1000 })
        ))
        this.#rebuildRows()
    }

    #rebuildRows() {
        // Capture current index to preserve scroll on layout change
        const wasIndex = this.#reportedIndex >= 0 ? this.#reportedIndex : 0

        this.#observer?.disconnect()
        for (const row of this.#rows) {
            for (const slot of row.slots) this.#unmountSlot(slot)
        }
        this.#container.replaceChildren()
        this.#rows = []

        const n = this.#pageSizes.length
        const pairPages = this.#spread === 'auto'
        for (let i = 0; i < n;) {
            const leftSize = this.#pageSizes[i]
            const rightSize = pairPages && i + 1 < n ? this.#pageSizes[i + 1] : null
            const row = this.#createRow(i, leftSize, rightSize)
            this.#rows.push(row)
            i += rightSize ? 2 : 1
        }

        this.#layoutAll()
        this.#setupObserver()

        // Scroll to the row containing wasIndex
        const targetRow = this.#rows.find(r => r.slots.some(s => s.index === wasIndex))
        if (targetRow) targetRow.placeholder.scrollIntoView({ block: 'start', behavior: 'auto' })
    }

    #createRow(firstIndex, leftSize, rightSize) {
        const placeholder = document.createElement('div')
        placeholder.className = 'row'
        placeholder.dataset.rowIndex = String(this.#rows.length)
        this.#container.append(placeholder)

        const makeSlot = (index, size) => {
            const element = document.createElement('div')
            element.className = 'slot'
            placeholder.append(element)
            return {
                index, element,
                iframe: null, loaded: false, loading: false, overlayer: null, srcRef: null,
                width: size.width, height: size.height,
            }
        }
        const slots = [makeSlot(firstIndex, leftSize)]
        if (rightSize) slots.push(makeSlot(firstIndex + 1, rightSize))

        const rowWidth = slots.reduce((w, s) => w + s.width, 0)
        const rowHeight = Math.max(...slots.map(s => s.height))
        return { placeholder, slots, rowWidth, rowHeight }
    }

    #setupObserver() {
        this.#observer?.disconnect()
        const rootMargin = `${RENDER_BUFFER_VIEWPORTS * 100}%`
        this.#observer = new IntersectionObserver((entries) => {
            for (const entry of entries) {
                const rowIndex = parseInt(entry.target.dataset.rowIndex, 10)
                const row = this.#rows[rowIndex]
                if (!row) continue
                if (entry.isIntersecting) {
                    for (const slot of row.slots) this.#mountSlot(slot)
                } else if (entry.intersectionRatio === 0) {
                    const rect = entry.target.getBoundingClientRect()
                    const distance = Math.min(
                        Math.abs(rect.bottom),
                        Math.abs(rect.top - this.clientHeight),
                    )
                    if (distance > UNLOAD_BUFFER_VIEWPORTS * this.clientHeight) {
                        for (const slot of row.slots) this.#unmountSlot(slot)
                    }
                }
            }
        }, { root: this, rootMargin, threshold: [0, 0.5, 1] })
        for (const row of this.#rows) this.#observer.observe(row.placeholder)
    }

    async #mountSlot(slot) {
        if (slot.iframe || slot.loading) return
        slot.loading = true
        const section = this.book.sections[slot.index]
        const src = await section.load()
        if (!src) { slot.loading = false; return }
        slot.srcRef = src
        const iframe = document.createElement('iframe')
        iframe.setAttribute('sandbox', 'allow-same-origin allow-scripts')
        iframe.setAttribute('scrolling', 'no')
        iframe.src = typeof src === 'string' ? src : src.src
        slot.element.append(iframe)
        slot.iframe = iframe
        iframe.addEventListener('load', () => {
            slot.loaded = true
            slot.loading = false
            const doc = iframe.contentDocument
            this.dispatchEvent(new CustomEvent('load', { detail: { doc, index: slot.index } }))
            this.dispatchEvent(new CustomEvent('create-overlayer', {
                detail: {
                    doc,
                    index: slot.index,
                    attach: (overlayer) => {
                        slot.overlayer?.element?.remove()
                        slot.overlayer = overlayer
                        slot.element.style.position = 'relative'
                        slot.element.append(overlayer.element)
                    },
                },
            }))
            if (typeof src === 'object' && src.onZoom) {
                src.onZoom({ doc, scale: this.#currentScale() })
            }
        }, { once: true })
    }

    #unmountSlot(slot) {
        if (!slot.iframe) return
        slot.iframe.remove()
        slot.iframe = null
        slot.loaded = false
        slot.loading = false
        slot.overlayer?.element?.remove()
        slot.overlayer = null
    }

    #currentScale() {
        if (typeof this.#zoom === 'number') return this.#zoom
        const container = this.clientWidth - 24
        const maxRowWidth = Math.max(...this.#rows.map(r => r.rowWidth), 1)
        if (this.#zoom === 'fit-width') return container / maxRowWidth
        const containerH = this.clientHeight - 24
        const maxRowHeight = Math.max(...this.#rows.map(r => r.rowHeight), 1)
        return Math.min(container / maxRowWidth, containerH / maxRowHeight)
    }

    #layoutAll() {
        const scale = this.#currentScale()
        for (const row of this.#rows) {
            for (const slot of row.slots) {
                slot.element.style.width = `${slot.width * scale}px`
                slot.element.style.height = `${slot.height * scale}px`
            }
        }
        // Ask loaded iframes to re-render their canvases at the new scale.
        // Prefer the pdf.js onZoom hook (re-renders in place); fall back to unmount+mount
        // if the book didn't supply one.
        for (const row of this.#rows) {
            for (const slot of row.slots) {
                if (!slot.loaded || !slot.iframe) continue
                const src = slot.srcRef
                if (src && typeof src === 'object' && src.onZoom) {
                    src.onZoom({ doc: slot.iframe.contentDocument, scale })
                } else {
                    this.#unmountSlot(slot)
                    this.#mountSlot(slot)
                }
            }
        }
    }

    #onScroll() {
        cancelAnimationFrame(this.#scrollRaf)
        this.#scrollRaf = requestAnimationFrame(() => this.#reportLocation('scroll'))
    }

    #reportLocation(reason) {
        // Current page = first page of the topmost row whose bottom crosses the viewport midline.
        const viewportMid = this.scrollTop + this.clientHeight / 2
        let currentIndex = this.#rows[this.#rows.length - 1]?.slots[0]?.index ?? 0
        for (const row of this.#rows) {
            const top = row.placeholder.offsetTop
            const bottom = top + row.placeholder.offsetHeight
            if (bottom >= viewportMid) { currentIndex = row.slots[0].index; break }
        }
        if (currentIndex === this.#reportedIndex && reason === 'scroll') return
        this.#reportedIndex = currentIndex
        const total = this.#pageSizes?.length ?? 1
        const fraction = total > 1 ? currentIndex / (total - 1) : 0
        this.dispatchEvent(new CustomEvent('relocate', {
            detail: { reason, range: null, index: currentIndex, fraction, size: 1 },
        }))
    }

    async goTo(target) {
        const resolved = await target
        const index = resolved.index ?? 0
        const row = this.#rows.find(r => r.slots.some(s => s.index === index))
        if (!row) return
        row.placeholder.scrollIntoView({ block: 'start', behavior: 'auto' })
        this.#reportLocation('page')
    }

    get index() { return this.#reportedIndex }

    async next() {
        const total = this.#pageSizes?.length ?? 0
        const step = this.#spread === 'auto' ? 2 : 1
        return this.goTo({ index: Math.min(this.#reportedIndex + step, total - 1) })
    }
    async prev() {
        const step = this.#spread === 'auto' ? 2 : 1
        return this.goTo({ index: Math.max(this.#reportedIndex - step, 0) })
    }

    getContents() {
        const out = []
        for (const row of this.#rows) {
            for (const slot of row.slots) {
                if (slot.loaded && slot.iframe) {
                    out.push({
                        doc: slot.iframe.contentDocument,
                        index: slot.index,
                        overlayer: slot.overlayer,
                    })
                }
            }
        }
        return out
    }

    destroy() {
        this.#observer?.disconnect()
        for (const row of this.#rows) {
            for (const slot of row.slots) this.#unmountSlot(slot)
        }
        this.#rows = []
    }
}

customElements.define('foliate-pdf-scroll', PDFScroll)
```

**Notes on the skeleton:**
- **Row-based**: the unit of virtualization is a row. In single-page layout, each row has one slot; in two-page layout, each row has two side-by-side slots. Mounting/unmounting happens at the row level so both pages in a pair load/unload together.
- **Spread changes live**: `attributeChangedCallback('spread', ...)` calls `#rebuildRows()` which tears down all placeholders and rebuilds them in the new layout, preserving the current page via `scrollIntoView`. No need to reopen the book or unmount the custom element.
- **Zoom hook**: the real production path uses the `onZoom` function that `pdf.js`'s `renderPage()` already returns — it re-renders the canvas in place. Unmount+remount is a fallback for safety.
- `getPageSize(i)` is a new helper we add to `pdf.js`'s `makePDF()` — see Step 2.
- Error states (load failure, cancelled mid-render) are deliberately omitted from the skeleton. Add try/catch around `section.load()` and mark the slot with an error state before committing.

### Figma design prompt (scroll viewport chrome)

> Reader view in PDF scroll mode: continuous vertical column of PDF pages, each page has a subtle drop shadow and 12px gap from its neighbors. Background follows the reader theme (paper, sepia, gray, dark). Pages have rounded corners (4px). Top bar and side AI panel identical to paginated PDF mode. Scroll indicator on the right using the existing minimal scrollbar style. No page-number overlay per page — the progress bar at the bottom handles that.

---

## Step 2: Extend `pdf.js` (foliate-js) to expose page sizes

**File: `public/foliate-js/pdf.js`**

Near the bottom of `makePDF()`, before returning `book`, pre-fetch page sizes. They're cheap — just a `viewport` query without rendering:

```javascript
// Pre-fetch natural page sizes so scroll mode can reserve placeholder space
// without rendering anything.
const pageSizes = Array.from({ length: pdf.numPages }).map(() => null)
book.getPageSize = async (i) => {
    if (pageSizes[i]) return pageSizes[i]
    const page = await pdf.getPage(i + 1)
    const viewport = page.getViewport({ scale: 1 })
    const size = { width: viewport.width, height: viewport.height }
    pageSizes[i] = size
    return size
}
```

This adds `getPageSize(index)` to the book object. Paginated mode ignores it; scroll mode uses it for placeholder sizing.

---

## Step 3: Register the new element in `Reader.tsx`

**File: `src/pages/Reader.tsx`**

In the foliate-init effect (around the `await customElements.whenDefined("foliate-view")` block), add the scroll element to the load list:

```typescript
if (!customElements.get("foliate-view")) {
  await new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    script.type = "module";
    script.src = "/foliate-js/view.js";
    // ...existing...
    document.head.appendChild(script);
  });
  await customElements.whenDefined("foliate-view");
}
// New: load pdf-scroll element lazily the first time a PDF opens in scroll mode
if (book?.format === "pdf" && readerSettings.readingMode === "scrolling" && !customElements.get("foliate-pdf-scroll")) {
  await new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    script.type = "module";
    script.src = "/foliate-js/pdf-scroll.js";
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Failed to load pdf-scroll"));
    document.head.appendChild(script);
  });
  await customElements.whenDefined("foliate-pdf-scroll");
}
```

Then branch the element creation:

```typescript
const useScrollForPdf =
  book.format === "pdf" && readerSettings.readingMode === "scrolling";
const viewTag = useScrollForPdf ? "foliate-pdf-scroll" : "foliate-view";
const view = document.createElement(viewTag) as FoliateView;
```

Apply `spread` from `pageColumns` to whichever element was created:
```typescript
const spread = readerSettings.pageColumns === 1 ? "none" : "auto";
if (book.format === "pdf") {
  // foliate-fxl uses view.renderer.setAttribute; foliate-pdf-scroll is the view itself
  if (useScrollForPdf) {
    view.setAttribute("spread", spread);
  } else {
    view.renderer.setAttribute("spread", spread);
  }
}
```

Note: `foliate-view` is the outer wrapper that picks between `foliate-paginator` and `foliate-fxl` internally. For scroll mode we skip it and use `foliate-pdf-scroll` directly, since the inner element selection doesn't apply (there's no paginated-vs-fxl decision to make). We pass the book object straight to `view.open(book)`.

The `event handlers for "relocate"`, `"create-overlayer"`, and `"load"` in Reader.tsx already accept the same shape from both views — no changes needed downstream.

---

## Step 4: React to `readingMode` and `pageColumns` changes

**File: `src/pages/Reader.tsx`**

Two kinds of live updates matter for PDFs:

1. **Reading Mode change (paginated ↔ scrolling)** — requires re-opening the book in a different viewer element, since `foliate-view` and `foliate-pdf-scroll` are separate custom elements.
2. **Page Layout change (1 ↔ 2)** — in **paginated** mode the existing effect at ~line 619 already handles this via `view.renderer.setAttribute("spread", ...)`. In **scroll** mode the new `foliate-pdf-scroll` element watches its own `spread` attribute; just calling `view.setAttribute("spread", "auto")` triggers `#rebuildRows()` inside the component, no re-init needed.

### Mode-switch effect

Add a new effect keyed on `[bookReady, book?.format, readerSettings.readingMode]`:

```typescript
useEffect(() => {
  if (!bookReady || !viewerRef.current || !book || book.format !== "pdf") return;
  const wantTag = readerSettings.readingMode === "scrolling"
    ? "foliate-pdf-scroll"
    : "foliate-view";
  const currentTag = viewRef.current?.tagName.toLowerCase();
  if (currentTag === wantTag) return;
  // Re-init — capture current page first, tear down the view, recreate via initViewer()
  const currentIndex = (viewRef.current as any)?.index ?? 0;
  const targetSpread = readerSettings.pageColumns === 1 ? "none" : "auto";
  initViewer(wantTag, { spread: targetSpread, goToIndex: currentIndex });
}, [bookReady, book?.format, readerSettings.readingMode]);
```

The cleanest way is to extract the init body from the mount effect (lines ~340–600) into an `initViewer(viewTag, opts)` helper that:
- Removes the old view element from `viewerRef.current` (if any)
- Creates a new element of the requested tag
- Wires the event listeners (`relocate`, `create-overlayer`, `load`) — identical to today
- Calls `view.open(book)`
- Applies `spread` and `zoom` attributes
- If `opts.goToIndex` is provided, calls `view.goTo({ index: opts.goToIndex })` after open

Then both the mount effect and the mode-switch effect call `initViewer()`.

### Page Layout change in scroll mode

Extend the existing spread effect (currently only runs when `book.format === "pdf"` and updates `view.renderer`):

```typescript
useEffect(() => {
  if (!bookReady || !view || book?.format !== "pdf") return;
  const spread = readerSettings.pageColumns === 1 ? "none" : "auto";
  if (readerSettings.readingMode === "scrolling") {
    view.setAttribute("spread", spread);       // foliate-pdf-scroll watches this
  } else {
    view.renderer?.setAttribute("spread", spread);  // foliate-fxl path (existing)
  }
}, [bookReady, book?.format, readerSettings.readingMode, readerSettings.pageColumns]);
```

---

## Step 5: Show the reading-mode toggle for PDFs

**File: `src/components/ReaderSettings.tsx`**

The existing `readingMode` toggle at ~line 199 is wrapped in `{bookFormat !== "pdf" && ...}`. Remove that gate so PDFs get the same toggle EPUBs do:

```tsx
<div className="px-4 py-3 border-b border-border-light">
  <p className="text-[11px] ...">{t("readerSettings.readingMode")}</p>
  <div className="flex gap-2">
    <button onClick={() => update({ readingMode: "scrolling" })}>
      {t("readerSettings.scrolling")}
    </button>
    <button onClick={() => update({ readingMode: "paginated" })}>
      {t("readerSettings.paginated")}
    </button>
  </div>
</div>
```

The existing PDF-only Page Layout toggle at ~line 228 (Single Page / Two Pages) stays exactly as it is — it's a separate, orthogonal control. After this change, PDFs show both toggles: Reading Mode + Page Layout.

Double-check ordering: Reading Mode should appear **above** Page Layout in the settings panel, matching EPUB's ordering. Ensure the `border-b border-border-light` is on the right element so the horizontal rule sits between them.

---

## Step 6: Persist `readingMode` in per-book settings

**File: `src/pages/Reader.tsx`**

The persist effect (from issue #119) already writes `readingMode` to `book_settings` for EPUBs. Just verify the PDF branch includes it (it should — the key is format-agnostic). If PDFs currently skip the key because the UI was hidden, add it to the payload.

No migration needed — the key already exists for EPUBs and has a valid `"paginated"` default.

---

## Step 7: Selection + AI context menu across pages

**File: `src/pages/Reader.tsx`**

The existing context-menu handler (around line 451 onward) listens to mouse events inside foliate-js iframes. In scroll mode each page is its own iframe, so the handler needs to be attached to **every page iframe as it mounts**, not just the single active iframe.

Subscribe to the new `load` events on `foliate-pdf-scroll` (the scroll viewer already dispatches them per-page) and attach the selection / context-menu listeners on the newly-loaded `doc`. Detach on unmount.

For cross-page selections — pdfjs text layers live inside different iframes, so a native selection can't span them. We have two options:
- **v1**: selections are per-page only. If you start selecting on page N and drag onto page N+1, the selection clips at the page boundary. Document this as a known limitation.
- **v2 (follow-up)**: implement a custom overlay that aggregates text spans across pages. Out of scope for this issue.

Default to v1 and call it out in the PR description.

---

## Step 8: Keyboard shortcuts

**File: `src/pages/Reader.tsx`**

Arrow-key and page-down navigation currently calls `view.renderer.next()` / `.prev()` for EPUBs and relies on foliate-js's internal paginator for PDFs. In scroll mode, we want:
- **Space / Page Down** → `view.scrollBy(0, view.clientHeight * 0.9)`
- **Shift+Space / Page Up** → `view.scrollBy(0, -view.clientHeight * 0.9)`
- **Arrow Down / Arrow Up** → `view.scrollBy(0, ±40)`
- **Home / End** → scroll to top/bottom

Detect scroll mode via `book.format === "pdf" && readerSettings.readingMode === "scrolling"` in the existing key handler (~line 750) and branch accordingly.

---

## Files to modify

| File | Change |
|------|--------|
| `public/foliate-js/pdf-scroll.js` | **New** — virtualized scroll renderer |
| `public/foliate-js/pdf.js` | Add `book.getPageSize(index)` helper |
| `src/pages/Reader.tsx` | Lazy-load `pdf-scroll.js`, branch viewer element by mode, re-init on mode change, per-page context-menu subscription, scroll-mode keyboard handling |
| `src/components/ReaderSettings.tsx` | Remove `bookFormat !== "pdf"` gate on the reading-mode toggle |
| `src/i18n/en.json`, `src/i18n/zh.json` | (No new keys — `readerSettings.readingMode`, `scrolling`, `paginated` already exist) |

## Verification

See the user-facing checklist in `docs/features/146-pdf-scroll-mode.md`. Add these code-level checks:

- [ ] Memory under control: scroll a 500+ page PDF top-to-bottom, then watch `chrome://memory` (or equivalent) — should plateau, not grow linearly
- [ ] Same memory check in two-page scroll mode — row count is halved but per-row memory is ~doubled, should still plateau
- [ ] `IntersectionObserver` unloads rows when scrolling quickly past them (open DevTools, watch `<iframe>` count — should stay bounded, not equal the page count)
- [ ] Re-init on mode toggle preserves the current page: open PDF, scroll to page 37 in single-page scroll, switch to paginated → should land on page 37
- [ ] Page Layout toggle in scroll mode calls `#rebuildRows()` — no iframe churn for the non-visible rows beyond what's needed, and scroll position anchors on the row containing the previously-current page
- [ ] Zoom change in scroll mode calls the pdf.js `onZoom` hook on visible slots (re-renders in place) and does **not** unmount+remount visible iframes
- [ ] No regression to EPUB scroll mode (which was never touched)
- [ ] No regression to PDF paginated mode single-page (which was never touched)
- [ ] No regression to PDF paginated mode two-page (which was never touched)
- [ ] `foliate-pdf-scroll` is loaded lazily — non-PDF or paginated-mode sessions never fetch the new script

## Open questions / risks

- **Per-row iframe cost on first scroll burst**: if the user flings a 1000-page PDF from top to bottom, we briefly create and destroy dozens of iframes (or iframe pairs in two-page mode). Consider throttling mount rate or adding a scroll-velocity check that skips render for rows that'll exit the buffer within a few hundred ms.
- **pdfjs text layer CSS leakage**: each iframe loads its own copy of `text_layer_builder.css` via the blob HTML. That's fine but duplicates CSS in memory; worth revisiting if the browser's per-iframe overhead shows up in profiling. Two-page mode doubles the iframe count relative to single-page, so this risk is more acute there.
- **Cross-row selection**: text selection cannot span two rows (native selection doesn't cross iframe boundaries anyway). Within a row in two-page mode, selection across the left→right page boundary is also blocked by the iframe boundary. v1 clips selections at iframe edges; users can still Look Up any word inside a single page. Document as a known limitation.
- **Bookmarks addressing**: bookmarks use CFIs that encode `{ index }` for PDFs. No change needed — `goTo({ index })` already scrolls to the row containing the target page.
- **Scroll position on reopen**: the existing "save progress fraction" pipeline uses `fraction = index / (numPages - 1)`. In scroll mode we could store a sub-page offset (`scrollTop`) for pixel-perfect resume. v1 can skip this and land on the row top; add it later if users ask.
- **Accessibility**: screen readers traverse iframes separately. Scroll mode with N iframes (2N in two-page mode) might be noisier than paginated mode with 1-2. Not addressed in v1; revisit if it becomes a complaint.
- **Spread heuristic for heterogeneous PDFs**: some PDFs mix portrait and landscape pages. In two-page mode, pairing `[portrait, landscape]` into a row looks awkward. v1 blindly pairs by even indices; a smarter heuristic (don't pair across orientation changes) is a polish follow-up.

## Rollout

1. Land all of the above behind the existing `readingMode` toggle — default stays `paginated` for PDFs, so nothing changes for existing users.
2. Verify on a few real PDFs: a paper (~20 pages), a novel (~400 pages), a textbook (~1000+ pages).
3. Ship in the next minor release with a changelog entry.
4. Monitor for regressions; if paginated mode is unaffected and scroll mode is stable, consider flipping the default in a later release.
