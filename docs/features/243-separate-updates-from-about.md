# 243 — Separate Updates from About

GitHub Issue: https://github.com/yicheng47/quill/issues/243

## Motivation

The "About" settings section currently bundles app identity (name, version) with software update controls (check now, download, auto-check toggle). This makes the update flow harder to find and clutters a pane whose primary job is showing version info and links. Runner already separates these into distinct "Updates" and "About" panes — Quill should match.

## Scope

### In scope

- **New "Updates" settings section**: extract the software update block (check for update, download progress, auto-check toggle) from `AboutSettings.tsx` into a new `UpdateSettings.tsx` component.
- **Add "Updates" to the settings sidebar**: new entry between "MCP" and "About" with icon `Download` (lucide) and subtitle "Check for updates".
- **Simplify About**: keep only app identity (Quill name, version badge, description) and add links (GitHub, website, changelog).
- **Update toast**: add a top-center toast (like Runner's `UpdateToast.tsx`) that appears when an update is available, with "Update" / "Restart" actions. The toast links to the Updates settings pane.
- **i18n**: add keys for the new section title/subtitle in en.json and zh.json.

### Out of scope

- Update channel selection (stable/beta) — not applicable for Quill v1.
- Auto-install toggle — keep the existing auto-check toggle only.

## Implementation Phases

### Phase 1 — Extract UpdateSettings component

1. Create `src/components/settings/UpdateSettings.tsx` — move the software update block and auto-check toggle from `AboutSettings.tsx`.
2. Add `"updates"` to the `Section` type in `SettingsModal.tsx`.
3. Add the new sidebar entry with `Download` icon.
4. Add i18n keys.

### Phase 2 — Simplify AboutSettings

1. Remove the update-related code from `AboutSettings.tsx`.
2. Add links section (GitHub repo, changelog, licenses).

### Phase 3 — Update toast

1. Create `src/components/UpdateToast.tsx` following Runner's pattern.
2. Render in `Home.tsx` above the main content.
3. Toast shows when `status === "available"`, with "Update" button that opens Settings → Updates.

## Verification

- Settings modal shows "Updates" and "About" as separate sections.
- "Check for update" and auto-check toggle live in Updates, not About.
- About shows only version info and links.
- Update toast appears when an update is available and links to Updates pane.
- i18n works for both en and zh.
