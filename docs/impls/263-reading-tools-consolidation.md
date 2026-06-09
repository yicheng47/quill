# 263 — Tools Settings + Ephemeral Translate

Issue: https://github.com/yicheng47/quill/issues/263

## Problem

Quill has three selection-based AI reading tools in the reader context menu: **Look Up**, **Explain**, and **Translate**.

Their settings and persistence behavior drifted apart. Look Up has a settings pane, Translate has a separate settings pane, Explain has no settings, and saved translations add storage/sync/MCP/UI weight for something that is mostly useful only in the moment of reading.

The goal is to make settings feel coherent by merging Look Up, Explain, and Translate configuration into one **Tools** settings section, while making Translate ephemeral: stream the translation, allow copy, and discard it when the popover closes.

## Current Shape

Frontend surfaces:
- `src/components/SettingsModal.tsx` has separate `lookup` and `translation` sidebar sections.
- `src/components/settings/LookupSettings.tsx` owns lookup language, lookup translation toggle, and lookup translation target.
- `src/components/settings/TranslationSettings.tsx` owns translation target language.
- `src/components/TranslationPopover.tsx` streams translation and exposes **Save** + **Copy**.
- Saved translations appear in `src/components/TranslationsContent.tsx`, `src/components/TranslationsPanel.tsx`, `src/components/DictionaryPanel.tsx`, `src/pages/Home.tsx`, and `src/components/Sidebar.tsx`.
- `src/hooks/useTranslations.ts` wraps `list_translations` and `remove_saved_translation`.
- The main app sidebar currently groups **Dictionary**, **Chats**, and **Translations** under a **Tools** section.

Backend surfaces:
- `src-tauri/src/commands/translation.rs` contains both `ai_translate_passage` and saved-translation commands/helpers.
- `src-tauri/src/lib.rs` registers `save_translation`, `remove_saved_translation`, and `list_translations`.
- `src-tauri/migrations/006_translations.sql` creates the historical table; `009_normalize_timestamps.sql` rebuilds it.
- `src-tauri/src/db.rs` includes the translations migration and tests that assert the table exists.
- `src-tauri/src/commands/books.rs` deletes translation rows during book deletion.
- `src-tauri/src/sync/events.rs`, `merge.rs`, and `snapshot.rs` include translation add/delete events and snapshot state.
- `src-tauri/src/mcp/tools/translations.rs`, `tools/mod.rs`, `server.rs`, and `tests/mcp_binary.rs` expose and test `get_translations`.

Persisted setting keys in the current code are:
- `lookup_language`
- `lookup_translation_language`
- `show_translation`
- `translation_language`

Do not rename these keys in this change. The issue text mentions `native_language`, but this desktop codebase currently uses `lookup_translation_language` for the lookup gloss target and `translation_language` for the passage translation target.

Add one new setting key:
- `explain_language`

`explain_language` defaults to `"lookup"` / unset, meaning **Same as Look Up**. The backend should resolve it to `lookup_language` unless the user explicitly picks another language.

## Direction

### 1. Merge settings into Tools

Create `src/components/settings/ToolsSettings.tsx` and replace the two sidebar entries with one `tools` section in `SettingsModal`.

The pane should have three compact subsections:
- **Look Up**: lookup language, show brief translation toggle, lookup translation target, and the existing preview.
- **Explain**: explain language selector, defaulting to **Same as Look Up**.
- **Translate**: translation target language.

Keep the row styling and saved-toast behavior from the existing settings components. The first pass should move the existing controls and add the Explain language selector without changing default behavior.

Open-settings routing should map both old language-error entry points to the merged pane:
- `LookupPopover` opens `tools` for lookup translation language errors.
- `TranslationPopover` opens `tools` for translation language errors.
- `Home` and `SettingsModal` section types accept `tools`.

After this lands, `LookupSettings.tsx` and `TranslationSettings.tsx` can be deleted.

### 2. Make Translate ephemeral in the reader

Remove saved-translation behavior from `TranslationPopover`.

Keep:
- header, selected-original text, stream body, configuration-error state, settings affordance, and copy action.

Remove:
- `saved` state
- `handleSave`
- `BookmarkPlus` import
- `save_translation` invoke
- **Save** footer button and saved labels

The footer becomes copy-only when the stream has content and no configuration error.

### 3. Remove saved-translation frontend surfaces

Remove the sidebar **Translations** entry and the `activeFilter === "translations"` branch in `Home`.

Update the main sidebar IA to match `design/quill-desktop.pen`:
- Keep **Tools** as the Settings modal section name only. In settings, Tools means reader action configuration for Look Up, Explain, and Translate.
- Do not use **Tools** for saved artifacts in the main app sidebar.
- **Chats** is its own section above saved reading artifacts.
- **Saved** contains **Vocab** now and can contain **Notes** later.
- Rename the visible **Dictionary** nav/page label to **Vocab**.
- Keep internal component, route, and filter identifiers as-is unless a rename is required by TypeScript. This feature should not turn into a route/file rename pass.

Remove translation persistence components and hook:
- `src/components/TranslationsContent.tsx`
- `src/components/TranslationsPanel.tsx`
- `src/hooks/useTranslations.ts`

Simplify `DictionaryPanel` to dictionary-only:
- remove `initialTab`
- remove `Tab`
- remove translation search/list/delete state
- remove the translation tab button and translation list rendering
- keep the dictionary search, list, footer, and vocab detail modal behavior unchanged

Sidebar implementation should end up with this order:
- **Library**
- **Chats**
- **Saved**
- **Collections**
- User profile

Clean i18n keys that are only used by saved-translation pages/panels. Keep keys still used by the live Translate popover, such as title, translating, language-not-configured, open-settings, copy, and copied.

### 4. Remove backend saved-translation commands and MCP tool

Keep `ai_translate_passage` in `commands/translation.rs`.

Remove:
- `Translation` DTO
- `save_translation`
- `remove_saved_translation`
- `query_translations`
- `list_translations`
- `TranslationPayload` import and sync writer usage from the command module
- command registrations in `src-tauri/src/lib.rs`
- `src-tauri/src/mcp/tools/translations.rs`
- translations module registration and router merge
- `get_translations` references from MCP unit/integration tests and docs strings

Update MCP copy that says the server exposes translations. `delete_book` tool descriptions should no longer mention translations.

### 5. Retain the legacy translations table

Do not add a destructive migration for saved translations. The feature removes UI/API/MCP/sync surfaces, but existing saved translation rows can remain in the legacy `translations` table in case the data is useful later.

Remove book-delete cleanup SQL that deletes from `translations`; saved translations are no longer an active child surface of books.

### 6. Make legacy translation sync events harmless

Do not emit new translation events after removing saved translation commands.

Keep legacy wire compatibility so existing sync logs from older peers do not crash replay. The safest shape is:
- keep `translation.add` and `translation.delete` enum variants in `EventBody`, but mark them legacy/no-op in comments
- keep a legacy payload struct if serde needs it
- update `merge::apply_event` so both variants return `Ok(())`
- remove `entity::TRANSLATION` and all merge SQL that touches `translations`
- remove translation rows from snapshot state/apply/capture/determinism dumps

This means old events deserialize and replay as no-ops, while new snapshots no longer carry saved translations.

If old snapshots contain `state.translations`, serde should tolerate the field by either leaving a deprecated defaulted field that is never applied/captured or by relying on serde's default unknown-field behavior. Prefer deleting it entirely if tests confirm old snapshots decode with unknown fields ignored.

## Out of Scope

- Changing the reader context menu actions.
- Merging Look Up, Explain, and Translate into one adaptive tool.
- Persisting Explain results; that remains #257.
- Fixing the `show_translation` behavior mismatch tracked in #262, unless the change is required to keep the merged settings pane coherent.
- Renaming persisted setting keys.

## Verification

Frontend:
- `pnpm exec tsc --noEmit`
- `pnpm run lint`
- Manual smoke: Settings has one **Tools** section and no separate Lookup/Translation sections.
- Manual smoke: Look Up, Explain, and Translate still appear in the selection context menu.
- Manual smoke: Translate streams and copies, with no Save action.
- Manual smoke: Sidebar has **Chats** above **Saved**, **Saved** contains **Vocab**, and there is no Translations entry.
- Manual smoke: Vocab panel has no Translations tab.

Backend:
- `cd src-tauri && cargo test`
- `cd src-tauri && cargo clippy -- -D warnings`
- Migration smoke: fresh DB stays at schema version 13 and keeps the legacy `translations` table.
- Sync smoke: a legacy `translation.add` / `translation.delete` event deserializes and `apply_event` returns `Ok(())`.
- MCP smoke: `get_translations` is absent from the tool list.

## Implementation Order

1. Land the settings merge first, with no persistence removal.
2. Remove Save from `TranslationPopover`, update the sidebar IA to **Chats** above **Saved**, and delete saved-translation frontend surfaces.
3. Remove backend saved-translation commands and MCP tool.
4. Keep the existing legacy table migrations, but remove active backend SQL references to saved translations.
5. Convert legacy sync events to no-ops and trim snapshots.
6. Run verification and clean i18n/docs references found by `rg "translations|Translation|translation\\."`.
