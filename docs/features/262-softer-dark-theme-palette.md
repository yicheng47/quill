# 262 - Softer Dark Theme Palette

GitHub issue: https://github.com/yicheng47/quill/issues/268

## Motivation

Quill's current dark theme uses very dark page colors and a reader Dark theme that can feel harsh for long reading sessions. Complete or near-complete black backgrounds make contrast feel brittle, make borders/shadows harder to tune, and can create a less polished visual tone across settings, library, popovers, and reading surfaces.

The dark palette should stay clearly dark while moving away from pure black. The target is a softer neutral palette with enough contrast for text and controls, better separation between page/surface/input layers, and a reader Dark theme that is comfortable for sustained reading.

## Scope

Refresh Quill's dark color palette across the app shell and reader theme.

In scope:

- Replace pure or near-pure black dark surfaces with softer neutral dark values.
- Keep a clear hierarchy between `bg-page`, `bg-surface`, `bg-muted`, and `bg-input`.
- Update dark text, border, overlay, and accent-adjacent values only where needed to preserve contrast.
- Update the reader Dark theme body/text colors and matching swatches in reader settings and default reading settings.
- Audit common dark-mode screens: library, settings, reader, lookup/translation popovers, sync settings, and update toast.
- Keep the existing theme keys and settings values unchanged.

Out of scope:

- Adding new named themes.
- Changing the app's light palette.
- Redesigning layouts or component structure.
- User-customizable color themes.

## Implementation Phases

1. Define the target dark palette.
   - Pick neutral dark values for page, surface, muted, input, borders, and overlays.
   - Pick reader Dark body/text values that avoid pure black and keep long-form reading comfortable.
   - Check contrast for primary, secondary, muted, and link text.

2. Update shared theme tokens.
   - Adjust `.dark` variables in `src/index.css`.
   - Replace hard-coded dark-only black values where they conflict with the softer palette.
   - Preserve semantic token usage where possible instead of scattering raw colors.

3. Update reader theme surfaces.
   - Change `getThemeStyles("dark")` to use the new reader Dark body/text colors.
   - Update dark theme swatches in `ReaderSettings` and `ReadingSettings`.
   - Verify EPUB and PDF overlays still preserve readability.

4. Visual QA.
   - Review the main app in dark mode across library, settings, and reader.
   - Check modal/popover surfaces and controls for enough layer separation.
   - Adjust any hard-coded black overlays or dividers that feel out of place.

## Verification

- App dark mode no longer uses complete black or near-complete black for primary page/reader surfaces.
- Library, settings, reader, lookup, translation, sync, and update surfaces remain readable and visually separated.
- Reader Dark theme is comfortable for long-form reading and works for both EPUB and PDF.
- Text contrast remains acceptable for primary, secondary, muted, link, and accent text.
- Existing theme settings continue to load unchanged, including `theme = dark` and `reader_theme = dark`.
