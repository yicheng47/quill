# 18 — AI Summarization

> GitHub Issue: https://github.com/yicheng47/quill/issues/89
> Milestone: 2 (Core Reading Experience Polish)

## Motivation

Readers often need to quickly grasp the key points of a passage or chapter — whether revisiting a section, studying, or deciding whether to read deeper. Summarization is a natural extension of the existing AI lookup and chat features.

## Scope

### Phase 1 — Selection Summary
- User selects a text range in the reader → "Summarize" action in context menu / selection toolbar
- AI returns a concise summary of the selected passage
- Displayed in a popover or inline panel (similar to lookup popover)
- Works for both EPUB and PDF

### Phase 2 — Chapter / Document Summary
- "Summarize chapter" action accessible from the table of contents or a toolbar button
- For PDFs: summarize the current page range or entire document
- For EPUBs: summarize the current chapter (section)
- Longer summaries displayed in the side panel (AI chat area) as a special message type
- May require chunking for long chapters — backend handles splitting and combining

## Key Decisions

- Reuse existing AI provider infrastructure (same model, same streaming)
- Selection summary uses a lightweight prompt (short context, fast response)
- Chapter/document summary uses a structured prompt with chunking strategy for long content
- Summaries are ephemeral (not persisted) unless the user explicitly saves to notes

## Verification

- [ ] Select text → "Summarize" → see concise summary in popover
- [ ] Chapter TOC entry → "Summarize chapter" → summary appears in side panel
- [ ] Works with all configured AI providers
- [ ] Long chapters are chunked and summarized without truncation
- [ ] PDF full-document summary works
