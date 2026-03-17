# iCloud Sync — Phase 5 Frontend Implementation

## Figma frames

- **Off state**: `129:2` — toggle off (gray), no error
- **On state**: `129:1076` — toggle on (dark), syncing active
- **Migrating state**: `129:539` — spinner + "Moving files to iCloud Drive..."
- **Error state**: `129:1342` — toggle off, red error banner with Retry

## Section placement

Between "Default Layout" and "Appearance" (matching Figma order):

1. AI Assistant Configuration
2. Reading Preferences
3. Default Layout
4. **iCloud Sync** (new)
5. Appearance

## iCloud Sync card

- **Icon:** Cloud (lucide), muted color
- **Title:** "iCloud Sync"
- **Subtitle:** "Sync your books, reading progress, and highlights across your Macs"

### States

**Off (available, not enabled)**
- Toggle row: "Enable iCloud Sync" / "Store your library in iCloud Drive" — toggle OFF (gray `#cbced4`)
- Footer: "API keys and login tokens are stored locally and will not sync" (`text-[12px]` `text-[#9f9fa9]`)

**On (enabled)**
- Same layout, toggle ON (dark `#030213`, knob right)

**Migrating**
- Toggle is replaced with a spinner icon (Loader2 from lucide, animated `rotate`)
- Below: spinner icon + "Moving files to iCloud Drive..." (`text-[13px]` `text-text-muted`)
- Footer still visible

**Error**
- Toggle OFF (gray)
- Red banner below toggle: `bg-[#fef2f2]` `border-[#ffc9c9]` `rounded-lg` `px-[13px] py-[9px]`
  - Left: "Failed to enable iCloud Sync. Please try again." (`text-[12px]` `text-[#e7000b]`)
  - Right: "Retry" (`text-[12px]` `font-medium` `underline` `text-[#e7000b]`)
- Footer still visible

**Unavailable (iCloud not signed in / no entitlement)**
- Toggle greyed out / disabled
- Helper text: "Sign in to iCloud on your Mac to enable sync"

## Files to modify

- `src/pages/SettingsPage.tsx` — add iCloud Sync section, add appearance section
