# 329 — Saved-Item Page Labels

GitHub issue: https://github.com/yicheng47/quill/issues/329

No design: the rows keep their existing `p. N` label (`bookmarks.shortPage`); only the number changes.

## Motivation

The reader's Highlights / Bookmarks island labels every highlight and bookmark with the reader's current page instead of the page the item was saved on. `src/pages/Reader.tsx` passes `getPageFromCfi={() => pageInfo?.current ?? null}` to `BookmarksPanel`, which ignores the CFI, so every row shows the same number and it changes as the reader turns pages. Clicking a row still jumps to the right place because navigation uses the stored CFI. The bug predates the Electron shell and was found in #328's live QA (RDR-07).

The Vocab island (`DictionaryPanel`) was half fixed in the rebrand: for a PDF it derives the page from the CFI, and for an EPUB it shows no page at all.

Fixing the labels exposes a second bug: the reader's own PDF page number is wrong. foliate-js counts pages in "locations" of 1500 bytes (`SectionProgress` in `public/foliate-js/progress.js`, built in `view.js`), and `pdf.js` gives every PDF page a nominal size of 1000. A PDF page therefore advances the location by two thirds, so on page 51 of a 100-page PDF the progress pill reads "Page 34 of 67". The pill, the two-page spread label, "Back to p. N" and the Ask Quill quote chip all use that number, while the Vocab island already shows the real PDF page. This is computed from the code; check P-3 confirms it on the candidate.

## Scope

In scope:

- **One page model per format.**
  - **PDF:** the page is the PDF's own page number, section index + 1, out of the PDF's page count. This applies to the progress pill, the two-page spread label, "Back to p. N", the Ask Quill quote chip, and the labels on highlights, bookmarks and vocab words.
  - **EPUB:** the page stays foliate's location + 1, out of its location total, as the pill shows today.
- **Saved items resolve their own page.** A highlight, bookmark or vocab word with a CFI gets its page from that CFI and never from the current page:
  - PDF: `extractPdfPageIndex(cfi) + 1`, with no document loading.
  - EPUB: resolve the CFI to its section index and a range in that section's document, measure the share of the section's text before the range start, and turn index and share into a location through foliate's `SectionProgress`. A saved item has no layout, so this uses a text measure where the pill uses the rendered page's position. After jumping to an item, the pill can read one page earlier or later than the label; it never drifts by more, and the label does not change with font size or window width.
- **No wrong number while resolving.** A label stays hidden until its page is resolved, and stays hidden when the CFI cannot be resolved.
- Resolved pages are cached per open book, so reopening an island does not resolve them again.

Out of scope:

- Storing a page number on saved items. It would need a schema migration and a sync-event change, would not cover existing items, and would disagree with the pill after a re-layout.
- Print page numbers from an EPUB's page list. The pill uses locations, and switching both to print pages is a separate feature.
- Fixed-layout EPUBs, which keep today's location numbering.
- Other surfaces. The Highlights and Vocab views, Home and search show no page labels today.
- `quill-ios`. Nothing stored or synced changes.

## Implementation Phases

1. **foliate-js fork.** Add a public `getLocationOf(index, fraction = 0)` to `View` in `public/foliate-js/view.js` that returns `this.#sectionProgress?.getProgress(index, fraction).location ?? null`, so the location constants stay in one place. Commit it to `yicheng47/foliate-js` and push the fork's `main` before the Quill commit that moves the submodule pin.
2. **Resolver.** Add `src/utils/savedItemPages.ts`:
   - `textFractionBefore(doc, range)`: the length of the section body's text before the range start, divided by the body's total text length, or 0 for an empty body.
   - `createSavedItemPageResolver(view, format)`: returns `resolvePages(cfis): Promise<Map<string, number>>`.
     - PDF: uses `extractPdfPageIndex`.
     - EPUB: calls `view.resolveCFI(cfi)`, loads each section's document at most once per call through `view.book.sections[index].createDocument()`, applies the anchor, and computes `view.getLocationOf(index, fraction).current + 1`.
     - A CFI that throws or does not resolve is left out of the map, and resolved pages are kept in a per-book cache.
3. **Reader.** In the `relocate` handler, a PDF's `pageInfo` comes from `detail.section` (`current + 1`, `total`) instead of `detail.location`; EPUBs keep `location`. The Reader creates one resolver per opened book and passes `resolvePages` to both islands in place of `getPageFromCfi`.
4. **Islands.** Add `src/hooks/useSavedItemPages.ts`, which resolves the CFIs of the listed items whenever the list changes and returns the map. `BookmarksPanel` uses it for highlights (`cfi_range`) and bookmarks (`cfi`), and `DictionaryPanel` for vocab words (`cfi`). A row shows `p. N` only when its CFI is in the map. Update the test doubles that pass `getPageFromCfi` (`ReaderAiSurfaces.test.tsx`).
5. **Tests**, then the live checks below.
   - `textFractionBefore`: start, middle and end of a section, a range inside nested elements, and an empty body.
   - The resolver:
     - A PDF CFI maps to its page without loading a document.
     - Several EPUB CFIs in one section load that section once.
     - An unresolvable CFI is left out.
     - A cached CFI is not resolved again.
   - The PDF `pageInfo` mapping: index 50 of a 100-page PDF reads 51 of 100.
   - The islands:
     - Each row shows its own resolved page.
     - Labels do not change when the current position changes.
     - No label shows while resolving or for an unresolved CFI.

## Verification

Automated: the tests from phase 5 pass, with `make typecheck`, `make lint` and `npm test`.

Live checks run on macOS in the development app with iCloud sync off. They are required because the change alters what the reader shows. Windows is not selected: the change is renderer-only, with no platform-specific code.

| Check | What it verifies | Reason |
|---|---|---|
| P-1 | The issue's repro on an EPUB (Frankenstein). Bookmark Chapter III, then go to Chapter V: the bookmark row still shows the Chapter III page. Click it: the pill shows the same page or one off. | Bookmark labels now come from the bookmark's own CFI. |
| P-2 | In the same EPUB, a highlight and a saved vocab word from different chapters show different pages that stay fixed while turning pages. Each jump lands within one page of its label. With about 50 highlights across the book, the labels appear within a second of opening the island and scrolling stays smooth. | Highlight and vocab labels now resolve EPUB CFIs by loading section documents. |
| P-3 | The 1000-page PDF from RDR-04: the pill reads "Page N of 1000", matching the PDF's own page, in paginated mode, in scroll mode and in a two-page spread. "Back to p. N" after a TOC jump uses the same numbering. | The PDF page model changes from locations to real pages. |
| P-4 | In the same PDF, a highlight, a bookmark and a vocab word each show the page they were saved on, and quoting a passage into Ask Quill shows the pill's page on the quote chip. | PDF labels and the quote chip follow the new page model. |
| RDR-06, RDR-07 | Highlights and bookmarks still list, update and jump from the island. | `BookmarksPanel` changed how its rows are built. |
