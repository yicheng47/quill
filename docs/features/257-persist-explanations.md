# 257 — Persist Explain results + Explanations tools page

GitHub issue: https://github.com/yicheng47/quill/issues/257

## Motivation

[#215](https://github.com/yicheng47/quill/issues/215) added the inline **Explain** popover, but it's one-shot — the streamed explanation is discarded when the popover closes. By contrast, **Look Up** persists to Vocab. Explain has no persistence and nowhere to revisit past explanations.

The whole point is **persistence**; the Saved section is just the surface that exposes it.

## Scope

Persist explanations and surface them in a new **Notes** or **Explanations** entry under the sidebar **Saved** section, grouped with Vocab.

Persist per explanation:
- selected passage
- explanation text
- book id + title
- chapter
- cfi (for navigate-back)
- timestamp

The Saved page provides list + search + navigate-to-cfi, matching the existing Vocab saved-item pattern.

## Open question

**Auto-persist vs. explicit Save.** Translate auto-persists every result; Look Up requires an explicit "Save to Dict". Explain could go either way:
- *Auto-persist on completion* — zero friction, but every glance clutters the page.
- *Explicit Save button in the `ExplainPopover` footer* — matches Look Up, keeps the page intentional.

Leaning toward explicit Save. This is the deferred open question from the #215 feature spec.

## Implementation Phases

### Phase 1 — Schema + backend
- New `explanations` table (migration): id, book_id, passage, explanation, chapter, cfi, created_at.
- Commands in a new/existing module: `save_explanation`, `list_explanations`, `delete_explanation` — mirror the vocab saved-item flow.

### Phase 2 — Capture from ExplainPopover
- Persist on completion (auto) or via a Save affordance in the footer, per the open question.
- Reuse the passage/cfi/book/chapter already available to `ExplainPopover`.

### Phase 3 — Explanations page
- `ExplanationsPanel` (+ standalone page if needed), modeled on the current Vocab saved-item surface: list, search, click-to-navigate (`onNavigateToCfi`).
- Sidebar **Saved** entry + icon.
- i18n strings in `en.json` + `zh.json`.

## Verification

- [ ] Explaining a passage persists it; it appears on the Explanations page.
- [ ] The page lists explanations with search; clicking an entry navigates to its cfi in the reader.
- [ ] Delete works.
- [ ] i18n works in both English and Chinese.

## Context

v2 follow-up explicitly deferred in `docs/impls/215-explain-and-quote.md` ("Save-Explain-as-note — v2") and the #215 feature spec's open question. Relates to #215.
