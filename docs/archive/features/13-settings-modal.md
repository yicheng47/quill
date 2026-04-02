# 13 — Settings Modal & User Profile Region

**Issue:** [#59](https://github.com/yicheng47/quill/issues/59)
**Status:** Planned

## Motivation

The current settings page is a full-page route (`/settings`) that's growing increasingly cluttered as we add more options (AI providers, reading preferences, appearance, i18n, iCloud, etc.). Navigating away from the reader to configure settings breaks flow.

Milestone 2 also calls for a **user profile region** in the bottom-left sidebar — an avatar/initials area that replaces the settings gear and prepares a local user identity for the Milestone 3 persona engine. These two changes are tightly coupled: the profile region is the trigger, and the settings modal is the destination.

## Scope

### User profile region (bottom-left sidebar)
- Add a user avatar/initials section at the bottom of the left sidebar
- Display user name (or initials fallback) — local identity, no auth required
- Clicking the region opens the settings modal
- Replaces the current settings gear icon in the sidebar
- Prepares the identity surface for Milestone 3 persona engine integration

### Settings modal (ChatGPT-style)
- Replace the full-page `/settings` route with a centered modal/dialog overlay
- Left side: categorized section list with icons (similar to ChatGPT desktop settings)
- Right side: detail view for the selected section
- Sections grouped by topic:
  - **General** — language, theme/appearance
  - **Reading** — default font, font size, line spacing, margins, auto-save
  - **AI** — provider, model, API key/OAuth, temperature, keep-alive
  - **Lookup** — native language, show translation toggle
  - **iCloud** — sync toggle, status
  - **About** — version, check for updates
- Each section row shows: icon, label, optional current-value preview, chevron for drill-in
- Smooth transition when navigating between sections
- Escape key or clicking backdrop closes the modal
- Settings auto-save on change (keep current behavior)

### Cleanup
- Remove the `/settings` route and `SettingsPage` component once modal is complete
- Update any navigation references (sidebar gear, keyboard shortcuts) to open the modal instead

## Implementation Phases

### Phase 1 — User profile region
1. Add local user identity to settings (name field, stored in `quill.db`)
2. Create `UserProfile` component in the sidebar bottom-left
3. Wire click to open settings modal (initially empty shell)

### Phase 2 — Settings modal shell
1. Create `SettingsModal` component (overlay + two-panel layout)
2. Implement section navigation (list on left, content on right)
3. Migrate one section (e.g., General) to validate the pattern

### Phase 3 — Migrate all sections
1. Move each settings section from `SettingsPage` into modal sub-views
2. Preserve all existing functionality and auto-save behavior
3. Remove old `/settings` route

## Verification

- [ ] Bottom-left sidebar shows user avatar/initials
- [ ] Clicking avatar opens centered settings modal
- [ ] All current settings are accessible in the modal
- [ ] Modal closes on Escape and backdrop click
- [ ] Settings changes auto-save (no regression)
- [ ] `/settings` route is removed; no dead navigation links
- [ ] Works with i18n (all labels use translation keys)