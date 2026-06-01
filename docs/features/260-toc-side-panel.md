# 260 — TOC as Collapsible Left Side Panel

GitHub issue: https://github.com/yicheng47/quill/issues/260

## Motivation

The Table of Contents is a fixed popover anchored to the TOC button (`src/components/TableOfContents.tsx`), capped at `w-[320px]` / `max-h-[300px]`. For books with long or deeply-nested TOCs this is cramped — lots of scrolling in a tiny box, and titles truncate.

## Scope

Replace the popover with a **left side panel** that can be collapsed, mirroring the right-hand panel pattern in the Reader body (`src/pages/Reader.tsx` — content column + side panel flex row).

- Left-docked TOC panel that pushes the reader content aside when open.
- Collapsible via the existing TOC (`List`) button.
- Reuses the existing chapter data, active-chapter highlight, and click-to-navigate behavior from the current popover.

## Open Design Questions

The exact design is **deferred to implementation** — finalize these then rather than now:

- **Collapse model:** fully open/hidden toggle vs. persistent thin rail.
- **Window scope:** main reader, standalone reader, or both (TOC button is on the left in the standalone window, on the right in the main window today).
- **Persistence:** remember open/collapsed state globally, per-book, or not at all.
- **Width:** fixed (~300px, matching the current popover) vs. drag-to-resize like the AI panel.

## Implementation Phases

1. Convert `TableOfContents` from a fixed popover into a docked left panel; integrate into the Reader body flex row.
2. Wire the TOC button to toggle the panel; remove popover anchor/positioning logic.
3. Finalize collapse / persistence / width design (see open questions).

## Verification

- Open a book with a long, deeply-nested TOC: panel shows full height, scrolls cleanly, no truncation of the box.
- Toggling the TOC button opens/collapses the panel; content reflows.
- Click-to-navigate and active-chapter highlight still work.
