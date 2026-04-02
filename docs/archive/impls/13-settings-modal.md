# Settings Modal & User Profile — Implementation Plan

## Reference

- **Issue:** [#59](https://github.com/yicheng47/quill/issues/59)
- **Feature spec:** `docs/features/13-settings-modal.md`
- **Style reference:** Obsidian settings (full-window modal, sidebar nav, scrollable content)

---

## Design (Figma)

Style reference: **Obsidian settings modal**.

### Modal

- **Overlay**: full viewport, semi-transparent dark backdrop (`bg-overlay`)
- **Container**: nearly full-window with ~40px margin on all sides, `bg-bg-page` background, `rounded-xl`, `border-border`
- **Layout**: two-column horizontal split
  - **Left panel** (sidebar): fixed ~200px width, `bg-bg-muted` background, right border separator
  - **Right panel** (content): flex-1, scrollable vertically, padded (~24px)
- **Close button**: top-right of the container, ✕ icon
- **Dismissal**: Escape key, close button, backdrop click

### Sidebar Navigation (left panel)

- **Header**: "Settings" label at top, muted text, semibold
- **Nav items**: flat vertical list, each row is icon (16px) + label (14px), left-aligned
- **Active state**: `bg-bg-surface` background, `text-text-primary`, `rounded-lg`
- **Inactive state**: `text-text-muted`, hover `bg-bg-input`
- **No chevrons, no value previews** — icon + label only
- **Sections** (in order):
  1. General (Globe icon) — language, theme
  2. Reading (BookOpen icon) — font, spacing, margins, auto-save
  3. AI Assistant (Bot icon) — provider, model, auth, temperature
  4. Lookup (Search icon) — native language, translation toggle, preview
  5. iCloud (Cloud icon) — sync toggle, status
  6. About (Info icon) — version

### Content Area (right panel)

- **Section title**: top of content area, 20px semibold `text-text-primary`
- **Setting rows**: each setting is a horizontal row with thin `border-border` separator between items
  - **Left**: setting name (14px semibold `text-text-primary`) + description below (13px `text-text-muted`)
  - **Right**: control (dropdown, toggle, slider, input) aligned to the right, vertically centered
- **Style**: Obsidian's borderless row-with-separator style (not grouped cards)
- **Scrolls independently** from the sidebar

### User Profile Region (Home page sidebar, bottom-left)

- **Position**: bottom of the left sidebar, above the bottom edge, separated by border-top
- **Content**: circular avatar with initials (from `user_name` setting) + name text beside it
- **Fallback**: if no name set, show settings gear icon with "Settings" label
- **Click action**: opens the settings modal
- **Style**: subtle, `text-text-muted`, hover highlight, matches sidebar aesthetic

### Design Tokens (existing system)

- Backgrounds: `bg-bg-page`, `bg-bg-surface`, `bg-bg-muted`, `bg-bg-input`
- Text: `text-text-primary`, `text-text-secondary`, `text-text-muted`
- Accent: `text-accent-text`, `bg-accent`, `bg-accent-bg`
- Border: `border-border`
- Overlay: `bg-overlay`

---

## Implementation

### Phase 1 — Settings modal shell + General section

| File | Action |
|------|--------|
| `src/components/SettingsModal.tsx` | CREATE — modal overlay + two-panel layout |
| `src/components/settings/GeneralSettings.tsx` | CREATE — language + theme |
| `src/pages/Home.tsx` | MODIFY — add modal state, open trigger |
| `src/components/Sidebar.tsx` | MODIFY — replace settings gear with user profile region |

**SettingsModal:**
- Full-viewport overlay with semi-transparent backdrop
- Left panel: nav list (icon + label), fixed width (~200px)
- Right panel: scrollable content, renders the active section component
- Close on Escape, close button top-right
- Close on backdrop click

**Sidebar user profile:**
- Bottom of sidebar: initials circle + user name
- Click opens `SettingsModal`
- Name stored in `settings` table as `user_name`
- If empty, show settings gear icon with "Settings" label

### Phase 2 — Migrate remaining sections

| File | Action |
|------|--------|
| `src/components/settings/ReadingSettings.tsx` | CREATE — font, spacing, margins, auto-save |
| `src/components/settings/AiSettings.tsx` | CREATE — provider, model, auth, temperature |
| `src/components/settings/LookupSettings.tsx` | CREATE — native language, translation toggle, preview |
| `src/components/settings/ICloudSettings.tsx` | CREATE — sync toggle, status |
| `src/components/settings/AboutSettings.tsx` | CREATE — version info |

Each component is extracted from the current `SettingsPage.tsx` monolith. Same logic, same auto-save behavior, just rendered inside the modal's content panel.

### Phase 3 — Cleanup

| File | Action |
|------|--------|
| `src/pages/SettingsPage.tsx` | DELETE |
| `src/App.tsx` | MODIFY — remove `/settings` route |
| `src/pages/Reader.tsx` | MODIFY — open modal instead of navigating to `/settings` |
| `src/pages/Home.tsx` | MODIFY — remove settings navigation, use modal |

---

## Settings Sections Mapping

| Section | Current location in `SettingsPage.tsx` | Content |
|---------|---------------------------------------|---------|
| General | Language + Appearance sections | Language dropdown, theme dropdown |
| Reading | Default Layout + Reading Preferences | Font family, font size, line spacing, char/word spacing, margins, auto-save |
| AI | AI Assistant Configuration | Provider, auth mode, OAuth, API key, base URL, model, temperature, keep-alive |
| Lookup | Lookup section | Native language, show translation toggle, preview card |
| iCloud | iCloud Sync section | Enable/disable, status, confirmation dialogs |
| About | (new) | App version, links |

## Notes

- All settings share one `useSettings()` hook — already works, no change needed
- i18n keys already exist for most settings labels
- The modal should be rendered at the app root (in `Home.tsx` or `App.tsx`) so it can overlay any page
- Reader page also needs a way to open settings (currently has a gear icon in the header)
