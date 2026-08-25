# 318 — Reader Content Zoom vs App Zoom

GitHub issue: https://github.com/yicheng47/quill/issues/318

## Motivation

Cmd/Ctrl **+**, **−**, **0** currently scale the whole UI in every window, reader windows included. `App.tsx` installs a single capture-phase app-zoom listener that every window inherits, and the reader re-installs the same handler inside the foliate content iframe so the binding keeps working over the book text. The result is that the most prominent zoom gesture, pressed while looking at a page of prose, resizes the toolbar and the sidebar instead of the prose.

That is inverted for a reading app. In a document view the primary zoom binding belongs to the document — Preview, Books, and every browser reader mode agree. Two concrete costs today:

- **EPUB font size has no keyboard shortcut.** The single most-adjusted reading control is reachable only through Settings → Reading or the reader settings popover, while the natural gesture for it is bound to something else.
- **PDF page zoom sits in a secondary slot.** It was pushed to Cmd/Ctrl+Shift **+**/**−** when app zoom claimed the primary binding in #295/#296 — a compromise made for the app-zoom feature, not a choice made for readers.

The fix is to scope the binding by window rather than to give reader windows a second zoom concept.

## Scope

In scope:

- **Main window keeps app zoom.** In the window that hosts the library, Chats, and Memos, Cmd **+**/**−**/**0** continues to scale the interface exactly as it does today. This is the app-zoom feature from #295 and it is not being narrowed.
- **Reader windows bind the content.** Cmd **+**/**−** adjusts the thing being read: EPUB font size, PDF page zoom. Cmd **0** resets — for EPUB, by clearing the book's font-size override so it falls back to the global Settings → Reading value; for PDF, by returning to `fit`, the sentinel the zoom plumbing already understands.
- **Reader windows still inherit app zoom.** App zoom remains a global, persisted setting that applies to every window on launch and propagates live through the existing cross-window storage sync. Setting it from the main window still scales reader chrome — toolbar, TOC panel, AI panel — while a reader window is open. What changes is only which key combination is live inside a reader window, never whether that window honors app zoom. The EPUB zoom-refresh nudge that re-lays out foliate iframes after an app-zoom change stays for the same reason.
- **Font size writes the per-book override.** The nudge persists to the book's own reader-settings entry, not to the global `font_size` setting, so adjusting one book never silently resizes the rest of the library. This matches the precedent set by per-book window zoom (#198).
- **Cmd+Shift +/− retires.** PDF page zoom moves to the primary binding, so the shift variant becomes a second name for the same action and is removed. The reader's toolbar zoom controls are untouched.
- **Existing bounds and steps are reused.** EPUB font size stays within `FONT_SIZE_MIN`/`FONT_SIZE_MAX` (12–48). PDF zoom keeps its 50–300 range in steps of 10, including the fit-aware base so a step from fit mode lands near the visible size.

Out of scope:

- The Appearance settings zoom control. It remains the way to set app zoom, and it keeps applying to every window.
- Per-book *chrome* zoom. One app zoom, set in one place, applying everywhere.
- The reader settings popover and Settings → Reading. Both keep working; the shortcut is an additional path to the same per-book value, not a replacement.
- Any change to how app zoom persists, syncs, or restores.

## Implementation Phases

1. **Route-aware shortcut.** Make the app-zoom keyboard handler apply only in the main window. Two call sites matter: the global capture-phase listener in `src/App.tsx`, and the listener the reader attaches inside the foliate content document — keys pressed over book text do not bubble to the parent window, so both must agree on the same rule. Reader windows route the same key combination to a content handler instead.

2. **EPUB font-size nudge.** Step the reader's font size within the existing bounds and persist to the per-book override, reusing the reader's current settings-write path so the reactive style application already in place picks it up. Cmd **0** clears the override and falls back to the global value.

3. **PDF page zoom on the primary binding.** Point Cmd **+**/**−** at the existing zoom handler, Cmd **0** at `fit`, and delete the Cmd+Shift **+**/**−** branches — including the duplicate pair in the reader's parent-document keydown handler.

4. **Verification pass.** Confirm app zoom still reaches reader windows on launch and through live cross-window sync, that the EPUB re-layout nudge still fires, and that settings copy still describes what the control actually does.

## Verification

- In the main window — library, Chats, and Memos — Cmd **+**/**−**/**0** scales the interface, unchanged from today.
- In an EPUB reader window, Cmd **+**/**−** changes font size and nothing else; the surrounding chrome does not move. The change persists for that book across reopen, and other books are unaffected.
- In a PDF reader window, Cmd **+**/**−** changes page zoom, Cmd **0** returns to fit, and stepping from fit mode lands near the previously visible size.
- Cmd **0** in an EPUB returns to the size configured in Settings → Reading, and a later change to that global value is reflected in the book.
- The shortcut works with focus in the book content itself, not only on surrounding chrome — the case the iframe-level listener exists to cover.
- Changing app zoom in the main window while a reader window is open still scales that reader window's chrome, live.
- Relaunching with a non-default app zoom restores it in both the main window and any reopened reader window, with EPUB text correctly re-laid out.
- Cmd+Shift **+**/**−** no longer does anything in either window, and the reader's toolbar zoom controls still work.
- Font size stays within 12–48 and PDF zoom within 50–300 when the shortcut is held at the limits.
