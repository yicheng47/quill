# 257 — Persist Explain results + Explanations tools page

GitHub issue: https://github.com/yicheng47/quill/issues/257

## Motivation

[#215](https://github.com/yicheng47/quill/issues/215) added the inline **Explain** popover, but it's one-shot — the streamed explanation is discarded when the popover closes. By contrast, **Look Up** persists to the Dictionary/vocab page and **Translate** persists to the Translations page. Explain has no persistence and nowhere to revisit past explanations.

The whole point is **persistence**; the Tools page is just the surface that exposes it.

## Scope

Persist explanations and surface them in a new **Explanations** entry under the sidebar **Tools** section, mirroring the Dictionary and Translations pages.

Persist per explanation:
- selected passage
- explanation text
- book id + title
- chapter
- cfi (for navigate-back)
- timestamp

The Tools page provides list + search + navigate-to-cfi, matching the existing `DictionaryPanel` / `TranslationsPanel` patterns.

## Open question

**Auto-persist vs. explicit Save.** Translate auto-persists every result; Look Up requires an explicit "Save to Dict". Explain could go either way:
- *Auto-persist on completion* — zero friction, but every glance clutters the page.
- *Explicit Save button in the `ExplainPopover` footer* — matches Look Up, keeps the page intentional.

Leaning toward explicit Save. This is the deferred open question from the #215 feature spec.

## Implementation Phases

### Phase 1 — Schema + backend
- New `explanations` table (migration), columns following the `translations` table: id, book_id, passage, explanation, chapter, cfi, created_at.
- Commands in a new/existing module: `save_explanation`, `list_explanations`, `delete_explanation` — mirror `commands/translation.rs` / vocab commands.

### Phase 2 — Capture from ExplainPopover
- Persist on completion (auto) or via a Save affordance in the footer, per the open question.
- Reuse the passage/cfi/book/chapter already available to `ExplainPopover`.

### Phase 3 — Explanations page
- `ExplanationsPanel` (+ standalone page if the others have one), modeled on `DictionaryPanel` / `TranslationsPanel`: list, search, click-to-navigate (`onNavigateToCfi`).
- Sidebar **Tools** entry + icon.
- i18n strings in `en.json` + `zh.json`.

## Verification

- [ ] Explaining a passage persists it; it appears on the Explanations page.
- [ ] The page lists explanations with search; clicking an entry navigates to its cfi in the reader.
- [ ] Delete works.
- [ ] i18n works in both English and Chinese.

## Context

v2 follow-up explicitly deferred in `docs/impls/215-explain-and-quote.md` ("Save-Explain-as-note — v2") and the #215 feature spec's open question. Relates to #215.
