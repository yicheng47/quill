# 355 — Ember Dark Palette

**Issue:** #355. **Design:** `quill/desktop/specs/331-rebrand.pen` in `YeelinksCo/yeelinks_design`, board `S189x` ("Dark mode — Ember"): the Ember row `I6G1D` (Home `v9NaG`, Reader `aKhe1`, palette card `B10G2v`) and the Before row `EsNSO` (`rz0zI`, `Pvz1Z`, `UPPhu`). The file's dark tokens now hold Ember, so the existing Dark Mode frames (Home `q62MgQ`, Library `Y803E5`, Reader `T1qAJe`, Settings → Appearance `CPGY5`) show it too. The theme axis `nocturne = before` keeps the previous values for comparison. Jason chose Ember on 2026-11-19 over Graphite (neutral grey) and Midnight (refined indigo).

## Problem

Nocturne, the dark theme, reads as one murky violet plane:

- **Panels barely lift off the page.** Surfaces are translucent violet glass only 4.9 L* above a violet-black background, so panels separate mostly by hairline borders.
- **Reading glare.** Book text is near-white on near-black (`#ECEAF4` on `#1E1D24`, about 15:1), which is harsh for long sessions.
- **Weak button labels.** White text on the primary button is 3.6:1.

System stays the default appearance (PR #354 is closed), so most people on a dark-mode Mac or PC see this palette on first launch.

## Decision

Nocturne keeps its name and every token keeps its role; only the colours change to Ember. Ember is warm charcoal like a lamp-lit page, with warm off-white UI text, cream reading text, and violet kept for actions, progress and selection.

| Role | Token | Before | Ember |
|---|---|---|---|
| Background | `bg-start` / `bg-end` | `#12111A` / `#17151F` | `#0D0C0B` / `#11100E` |
| Background glows | `bg-glow-violet` / `-peach` / `-mint` | three tinted glows | one faint warm glow: peach `rgba(138, 86, 58, 0.08)`; violet and mint transparent |
| Surface | `surface-glass` | `rgba(30, 29, 41, 0.8)` | `rgba(27, 25, 23, 0.97)` |
| Raised, popovers | `surface-solid` / `surface-popover` | `#232130` / `rgba(35, 33, 48, 0.94)` | `#27241F` / `rgba(39, 36, 31, 0.96)` |
| Chip | `surface-chip` | `rgba(40, 38, 54, 0.9)` | `#2E2A26` |
| Inset | `surface-inset` | `rgba(21, 20, 29, 0.7)` | `#12110F` |
| Reading page | `paper` | `#1B1A23` | `#161412` |
| Text | `text-primary` / `-secondary` / `-tertiary` / `-disabled` | `#F3F1F8` / `#B5B2C4` / `#7E7B8F` / `#524F61` | `#F0EAE1` / `#B6AEA2` / `#8C8378` / `#534C44` |
| Book text (reader dark page) | design token `text-reading` | `#ECEAF4` | `#DBD2C4` |
| Borders | `border-subtle` / `-default` / `-strong` | white at 7% / 12% / 20% | warm white `rgba(255, 243, 227, …)` at 6% / 10% / 17% |
| Button accent | `accent` / `-hover` / `-pressed` | `#8477EE` / `#9387F5` / `#7366DF` | `#6F62DA` / `#7B6FE4` / `#6357CC` |
| Accent foreground | `accent-fg` | — (used `accent`) | `#A193F5` (Dawn: `#6F63D2`) |
| Progress, tints | `progress` / `accent-tint` / `accent-on-tint` | `#8E82F5` / 17% / `#C8C0FF` | `#A193F5` / `rgba(161, 147, 245, 0.15)` / `#D6CEFF` |

The result:
- **Elevation:** background to surface to raised is 5.5 and 5.4 L*, up from 4.9 and 3.2.
- **Reading text:** about 12.3:1 on the reading page.
- **Button labels:** white is 4.7:1, up from 3.6:1.
- **Accent foreground:** `#A193F5` is 6.7:1 on a surface and 5.3:1 on `accent-tint` over glass.
- **Tertiary text:** 4.7:1 on a surface.

`accent` is kept for button fills, checks, selection borders, focus rings, sliders and progress rings; text, icons, spinners, hover labels (`text-accent-fg`) and markdown links (`.markdown-body a`) use `accent-fg`, which matches `accent` in Dawn (`#6F63D2`) and brightens to `#A193F5` in Ember so small counts on `accent-tint` and inline links clear 4.5:1.

Semantic colours (success, warning, danger), the highlight colours and light mode (Dawn) are unchanged.

## Implementation

- **`src/index.css`, `.dawn.dark` and accent foreground:** the token values in the table, plus `--color-accent-fg` (`#6f63d2` in `@theme` for Dawn, `#a193f5` in `.dawn.dark`), the code-only reader pill (`rgba(46, 42, 38, 0.88)`, border warm white at 12%), `surface-tint`, `surface-hover`, `segment-well`, `scrim` and the cover hover shadow, moved onto the same warm base. Every exact `text-accent` class (including `hover:text-accent`) moves to `text-accent-fg`, and `.markdown-body a` uses `var(--color-accent-fg)`; `text-accent-on-tint`, legacy `text-accent-text`, fills, borders and focus rings keep their existing tokens.
- **`src/index.css`, legacy `.dark` block:** its neutrals still colour many screens (HomeView, HighlightsView, Select, Button, ReaderSettings and others) and would otherwise stay cool grey next to Ember. They map onto Ember:

  | Legacy token | Ember value |
  |---|---|
  | `bg-page` | `#0D0C0B` |
  | `bg-surface` | `#1B1917` |
  | `bg-muted` | `#27241F` |
  | `bg-input` | `#2E2A26` |
  | `text-body` | `#E8E1D6` |
  | `text-muted` | `#A39A8E` |
  | `text-placeholder` | `#8C8378` |
  | `border` | `#3A3530` |
  | `border-light` | `#2A2622` |
  | `overlay` | `rgba(6, 5, 4, 0.72)` |

  The legacy violet tokens are left alone.
- **`src/index.css`, `:root` preview tokens:** the Dark card in Settings → Appearance uses `preview-night-*` (start `#181614`, end `#1f1b18`, surface `#2e2a26`, accent `#a193f5`), and the Light card and System card's light half pin to Dawn via `preview-light-*` (start `#eeebf8`, end `#f7f5f3`, accent `#6f63d2`) without `.dawn.dark` overrides so the Light preview stays Dawn under Dark appearance.
- **Reader dark page theme:**
  - `getThemeStyles("dark")` and the Dark swatches in `ReaderSettings.tsx` and `ReadingSettings.tsx` use body `#161412`, text `#DBD2C4`, border `rgba(255, 243, 227, 0.1)` and overline `#8C8378`.
  - `getPdfOverlays("dark")` in `src/pages/Reader.tsx` uses three blend layers over the PDF canvas: white `difference`, `multiply` with an ink colour `M = (T − P) / (1 − P)` derived per sRGB channel from `getThemeStyles("dark")`, and `screen` with the page colour `P`. This maps white pages to `#161412`, black glyphs to cream `#DBD2C4`, and scanned or antialiased tones linearly in between without changing the other page themes.
  - `ReaderBottomPills.tsx` uses `#DBD2C4`, `#F0EAE1` and `#A39A8E` (EPUB percentage/time-left label) on the dark page, leaving the light branch unchanged.
- **Native and shell backgrounds:** `#0D0C0B` for `MAIN_NOCTURNE_BG` (`src/lib/theme.ts`, `electron/main/windows.ts`) and the dark entries of `READER_SHELL_BG` (`electron/main/windows.ts`) and `READER_SHELL_BG_BY_THEME` (`src/lib/readerLayout.ts`), so the first frame matches.

## Validation

- **Automated:** tests that pinned the old values now pin Ember: window backgrounds in `windows.test.ts`, `App.theme.test.tsx`, `SettingsView.test.tsx`, `readerLayout.test.ts` and `Reader.test.tsx`, and resolved dark tokens in `ReaderMaterial.test.tsx` and `Reader.test.tsx`. Unit tests also cover the three-layer dark PDF blend math (`Reader.test.tsx`), `--color-accent-fg` resolution and usage (`ReaderMaterial.test.tsx`, `Reader.test.tsx`, `MainViews.test.tsx`), the dark EPUB pill neutral (`ReaderBottomPills.test.tsx`), and the pinned Dawn preview tokens under Dark appearance (`SettingsView.test.tsx`). Run `make typecheck`, `make lint` and `npm test`.
- **Live, macOS (qa).** These are required because the change alters what every dark screen looks like. Use `make dev` with sync off and Appearance set to Dark; restore the dev profile's theme afterwards.
  - **F-355-SURFACES:** Home, Library, Highlights, Words, Chats and Settings match the Ember frames.
    - Opaque warm panels sit a clear step above the background, text is warm off-white, selected Highlights counts, tinted icons and markdown links are legible in Ember's foreground violet, and button fills/selection outlines use the deeper accent.
    - Watch for leftover cool-grey or violet-tinted panels, inputs, dropdowns or modals. These would be legacy tokens or hardcoded colours the mapping missed.
    - Why: every dark token changed, including the legacy neutrals and accent foreground.
  - **F-355-READER:** a book opened in dark mode matches `aKhe1`.
    - Both EPUB and PDF reading pages are `#161412` with cream `#DBD2C4` text (check a text PDF and a scanned PDF page).
    - The toolbar, Contents island, Ask panel, popovers and bottom pills (including the EPUB percentage/time-left label and PDF zoom) are warm and legible.
    - Typography → Theme shows the Dark swatch in Ember.
    - Why: the reader's dark page theme, PDF blend layers and pills are styled separately from the CSS tokens.
  - **SET-02 (theme portion):** with Dark selected, restart the app and open a reader window. Each first frame is warm charcoal, with no violet or light flash. Why: the native and shell background constants changed.
  - **SET-04 (Appearance portion):** the Dark preview card shows Ember, the Light card and System card's light half stay Dawn while Dark is active, and System, Light and Dark still switch live. Why: both dark and pinned light preview tokens changed.
  - **F-355-LIGHT-UNCHANGED:** in Light, Home and a reader look as before. Why: the diff edits shared `:root` tokens next to the light values.
