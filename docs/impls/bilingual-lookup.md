# Bilingual Lookup for ESL Readers — Implementation Plan

## Context

ESL readers (e.g., Chinese speakers reading English books) want the UI in English to practice, but need a quick native-language translation in word lookups. Currently, the single "Language" setting controls both UI language and lookup translation — they can't be separated.

## Approach

Move the translation config into the Lookup settings section with a live preview. The user sees exactly what the lookup result will look like and can toggle translation on/off with a language selector.

---

## Design (Figma)

### Lookup Settings (new section in Settings page — with preview)

```
┌──────────────────────────────────────────────────┐
│  📖 Lookup                                       │
│  Customize how word lookups appear               │
│                                                  │
│  Translation          ┌──────────────┐           │
│  ○ Off                │ Preview      │           │
│  ● On  [简体中文  ▾]   │              │           │
│                       │  regain      │           │
│                       │              │           │
│                       │  恢复；重新获得 │           │
│                       │              │           │
│                       │  /rɪˈɡeɪn/   │           │
│                       │  verb. To get│           │
│                       │  back some-  │           │
│                       │  thing lost. │           │
│                       │              │           │
│                       │  In context: │           │
│                       │  The author  │           │
│                       │  uses this...│           │
│                       └──────────────┘           │
└──────────────────────────────────────────────────┘
```

### Preview when translation is OFF

```
                        ┌──────────────┐
                        │ Preview      │
                        │              │
                        │  regain      │
                        │              │
                        │  /rɪˈɡeɪn/   │
                        │  verb. To get│
                        │  back some-  │
                        │  thing lost. │
                        │              │
                        │  In context: │
                        │  The author  │
                        │  uses this...│
                        └──────────────┘
```

The preview updates live when the user toggles translation on/off or changes the language — they see exactly what they'll get before leaving settings.

---

## Implementation

### Files to modify

| File | Change |
|------|--------|
| `src-tauri/src/commands/ai.rs` | Read `lookup_translation` setting; prepend translation prompt when set |
| `src/pages/SettingsPage.tsx` | Add "Lookup" settings section with translation toggle, language picker, and static preview |
| `src/i18n/en.json` | Add i18n keys for lookup settings |
| `src/i18n/zh.json` | Add i18n keys for lookup settings |

### Backend change (`ai.rs`)

Current behavior: reads `language` setting, adds translation prefix when `language != "en"`.

New behavior:
- Read `lookup_translation` setting (new; value is a language code like `"zh"`, or empty/`"off"` for disabled)
- When set, add translation prefix: "Before the definition, provide a brief translation in [language]..."
- Decoupled from the UI language setting entirely

### Settings

- `lookup_translation`: language code (`"zh"`, `"en"`, etc.) or `"off"` (default: `"off"`)
- Stored in settings DB alongside other preferences

## Verification

1. Toggle translation ON, select 简体中文 → lookup shows Chinese translation line above English definition
2. Toggle translation OFF → lookup shows English definition only
3. Preview in settings updates live to match the toggle state
4. Changing system language does NOT affect lookup translation (decoupled)
