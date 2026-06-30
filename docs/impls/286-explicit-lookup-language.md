# 286 — Make lookup language explicit for source-language lookups

Issue: https://github.com/yicheng47/quill/issues/286

## Problem

Look Up's main definition/context output does not deterministically follow the configured **Lookup language**. Two things cause this:

1. **English emits no language directive.** In `lookup_system_prompt`, the "Respond entirely in {X}" instruction is only built when `language != "en"`. So with Lookup language = English and a Chinese selection, the model gets no instruction to answer in English, sees Chinese input, and answers in Chinese. The setting looks ignored. This is the core bug.

2. **Source-language lookup is implicit, not chosen.** "Chinese definition for a Chinese book" is genuinely useful, but today it only happens as a side effect of defaults (app language `zh` → `lookup_language` defaults to `zh`) or of bug #1. Nobody turned it on deliberately, so it reads as a glitch, and the mix of an English gloss line above a Chinese definition makes it unclear which setting did what.

The gloss (brief translation) is a separate, orthogonal feature and is working correctly; it should stay separate.

## Goal

- The main definition/context output **always** honors `lookup_language` deterministically, English included.
- Source-language lookup is the **default** and an explicit, self-documenting choice: a new **Same as selection** option in the Lookup language dropdown, and the value `lookup_language` falls back to when unset. Users can still pin a concrete language.
- The brief-translation gloss stays an independent add-on, allowed alongside any main language including "Same as selection".

## Current Shape

Setting keys (do **not** rename):
- `lookup_language` — main definition/context language. Gains a new sentinel value `"selection"`.
- `lookup_translation_language` — gloss target language.
- `show_translation` — whether to show the gloss.
- `explain_language` — `"lookup"`/unset means "Same as Look Up"; otherwise an explicit language.

Surfaces:
- `src-tauri/src/commands/ai.rs`
  - `lookup_system_prompt(kind, language, lookup_translation_language, show_translation)` builds the prompt. The `language != "en"` guard (lines ~54–70) is bug #1.
  - `ai_lookup` reads settings; `lookup_language` currently defaults to the app `language` — this changes to `"selection"`.
  - `explain_system_prompt(language)` has the same English-only guard, and `ai_explain` resolves `explain_language = "lookup"` → `lookup_language`, so the `"selection"` sentinel and the always-explicit directive must be handled here too or they leak in as a literal "Respond entirely in selection."
  - `language_name(code)` maps codes → English names; returns the raw code for unknown values.
- `src/components/settings/ToolsSettings.tsx` — Look Up subsection: lookup language `Select`, brief-translation `Toggle`, gloss target `Select`, and the static preview.
- `src/components/settings/languageOptions.ts` — `LANGUAGE_OPTIONS` (en, zh).
- `src/i18n/en.json`, `src/i18n/zh.json` — `settings.tools.*` keys.
- `src/components/LookupPopover.tsx` — consumes the streams; splits the `[[QUILL_TRANSLATION]]` marker out of the definition. No change needed.

The selection's language is determined by instructing the model ("respond in the same language as the selected word/phrase"). We deliberately do **not** detect language client-side or add a book-language column — there is no `language` field on the `books` table, and a model instruction is reliable enough for real selections.

## Direction

### 1. Backend — always emit the main-language directive (`ai.rs`)

In `lookup_system_prompt`, drop the `language != "en"` special-case. Compute one "main language clause" and always prepend a response-language directive to both definition and context.

Add a sentinel constant and a small helper:

```rust
const LOOKUP_LANGUAGE_SELECTION: &str = "selection";

fn main_language_clause(language: &str) -> String {
    if language == LOOKUP_LANGUAGE_SELECTION {
        "the same language as the selected word/phrase".to_string()
    } else {
        language_name(language)
    }
}
```

Rework the prefix block so:
- `definition_language_prefix`:
  - if `should_show_translation` → `"After that first line, respond entirely in {clause}.\n\n"`
  - else → `"Respond entirely in {clause}.\n\n"`
- `context_language_prefix` → always `"Respond entirely in {clause}.\n\n"` (no English exception).

`should_show_translation` keeps its existing definition: `show_translation && !gloss.is_empty() && gloss != language`. Because the gloss target is always a concrete language and `"selection"` is never a gloss value, `gloss != "selection"` is always true — so the gloss is correctly allowed when the main language is "Same as selection". The `gloss != language` guard still suppresses a redundant gloss when both are the same concrete language. (Edge case: if the selection happens to be in the same language as the gloss target, the model may produce a redundant gloss line under "selection" mode; acceptable, not worth detecting.)

`language_name` is never called on `"selection"` (the gloss still uses the concrete `lookup_translation_language`), so no change there.

Also change the `ai_lookup` default: `lookup_language` should fall back to `LOOKUP_LANGUAGE_SELECTION` instead of the app `language`, so a fresh install (no `lookup_language` set) does source-language lookups.

### 2. Backend — handle "selection" + always-explicit in explain (`ai.rs`)

`ai_explain` already resolves `explain_language = "lookup"` to `lookup_language`, so `language` here can be `"selection"`. Update `explain_system_prompt`:

```rust
fn explain_system_prompt(language: &str) -> String {
    let target = if language == LOOKUP_LANGUAGE_SELECTION {
        "the same language as the selected passage".to_string()
    } else {
        language_name(language)
    };
    let language_prefix = format!("Respond entirely in {}.\n\n", target);
    format!("{}You are a reading assistant ...", language_prefix)
}
```

This switches explain to the shared `language_name` map (replacing its local zh-only match) and makes English explicit too, for the same determinism reason as Look Up.

Match the new default in `ai_explain`'s settings read: the `lookup_language` it resolves `explain_language = "lookup"` against should also fall back to `LOOKUP_LANGUAGE_SELECTION` instead of the app `language`, so an unconfigured install explains in the selected passage's language.

### 3. Frontend — add the "Same as selection" option (`ToolsSettings.tsx`)

- Build the lookup dropdown options with the sentinel first:
  ```ts
  const lookupLanguageOptions = [
    { value: "selection", label: t("settings.tools.sameAsSelection") },
    ...LANGUAGE_OPTIONS,
  ];
  ```
  Use `lookupLanguageOptions` only for the **Lookup language** `Select`. Gloss target, Explain, and Translate keep plain `LANGUAGE_OPTIONS` (no "selection" there).
- Default the dropdown to **Same as selection** when `lookup_language` is unset, matching the backend default:
  ```ts
  setLookupLanguage(settings.lookup_language || "selection");
  ```
- Preview behavior under "selection": the sample word is the English string `interfaces`, so "Same as selection" should preview an English definition. The existing preview branches on `lookupLanguage === "zh"`, so `"selection"` already falls into the English branch — no preview logic change required. The gloss preview guard (`shouldShowTranslation`) already shows the gloss for `"selection"` since the gloss target differs from `"selection"`.

### 4. i18n (`en.json`, `zh.json`)

Add one key in both files:
- `settings.tools.sameAsSelection` — en: `"Same as selection"`, zh: `"跟随所选内容"`.

Optionally tighten `settings.tools.lookupLanguageHint` to mention that the definition and context follow this language; not required.

### 5. Tests (`ai.rs` `#[cfg(test)]`)

Update existing tests broken by removing the English guard, and add regression coverage:
- `explain_prompt_english_has_no_language_directive` → replace with `explain_prompt_english_emits_english_directive` asserting `explain_system_prompt("en")` contains `"Respond entirely in English."`.
- `explain_prompt_non_english_prepends_response_language` → update the `fr` expectation from `"Respond entirely in fr."` to `"Respond entirely in French."` (now via `language_name`).
- Add `lookup_english_emits_explicit_english_directive`: `lookup_system_prompt("definition", "en", "", false)` contains `"Respond entirely in English."` (guards bug #1).
- Add `lookup_selection_uses_source_language`: `lookup_system_prompt("definition", "selection", "", false)` contains `"the same language as the selected word/phrase"` and does **not** contain `"Respond entirely in selection."`.
- Add `lookup_selection_allows_gloss`: `lookup_system_prompt("definition", "selection", "en", true)` contains `LOOKUP_TRANSLATION_MARKER` and `"After that first line, respond entirely in the same language as the selected word/phrase."`.
- Add `explain_selection_uses_source_language`: `explain_system_prompt("selection")` contains `"the same language as the selected passage"`.

Confirm the remaining lookup tests still pass (they assert non-English directives and marker presence, which are unaffected).

## Out of Scope

- No language detection library and no `books.language` column / metadata plumbing — "selection" is a model instruction.
- No change to `LookupPopover.tsx` marker-splitting, save/copy, or the gloss-language "not configured" error path.
- No change to the `translation` (passage translate) tool.
- No migration: `"selection"` is a value the existing `lookup_language` key can hold, not a new key. Existing installs that never set `lookup_language` shift from app-language definitions to source-language definitions on update — intentional, and the new default makes that behavior explicit/visible in Settings.

## Verification

Backend:
- `cargo test` in `src-tauri` — all lookup/explain prompt tests pass.

Manual (app):
1. Lookup language = English, open a Chinese book, look up a Chinese word → definition and context are in **English** (previously drifted to Chinese).
2. Lookup language = **Same as selection**, Chinese book, Chinese word → definition and context in **Chinese**.
3. Same as #2 with Brief translation on + gloss target English → one English gloss line above a Chinese definition, clearly the gloss, not the main output.
4. Lookup language = 简体中文, English book, English word → Chinese definition (unchanged).
5. Explain language = Same as Look Up with Lookup language = Same as selection → explanation matches the selected passage's language.
6. Fresh install / `lookup_language` unset → dropdown shows **Same as selection** and lookups come back in the selected text's language.

## Implementation Order

1. `ai.rs`: sentinel + `main_language_clause`, rework `lookup_system_prompt`, update `explain_system_prompt`, change the `lookup_language` fallback to `"selection"` in both `ai_lookup` and `ai_explain`; update/add tests; `cargo test`.
2. `en.json` / `zh.json`: add `settings.tools.sameAsSelection`.
3. `ToolsSettings.tsx`: lookup options with sentinel, default alignment.
4. Manual verification pass per above.
