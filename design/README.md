# Design

Pencil (`.pen`) source files for the Quill desktop UI. Open these in the Pencil app; they are encrypted on disk and not meant to be read as plain text.

Conventions:
- `quill-desktop.pen` is the canonical design source for the Tauri desktop app. Split into per-surface files (e.g. `reader.pen`, `library.pen`) only if `quill-desktop.pen` gets unwieldy.
- iOS designs live in their own repo at [`quill-design`](https://github.com/yicheng47/quill-design) (alongside the `quill-ios` repo).
- Exports land under `/public/` (icons, app images) or are referenced directly from React components via Pencil's MCP export flow.

Follow-ups parked in design (no issue yet):
- _none yet_
