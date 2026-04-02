# 19 — Reading Status Control

> GitHub Issue: https://github.com/yicheng47/quill/issues/91
> Milestone: 2 (Core Reading Experience Polish)

## Motivation

Currently, opening a book automatically marks it as "Currently Reading" (via `save_book_progress` setting `status = 'reading'`). There's no way to explicitly control this — you can't remove a book from "Currently Reading" without marking it as "Finished", and you can't mark it as unread. Users need fine-grained control over their reading status to keep the "Currently Reading" shelf meaningful.

## Scope

### Reading status model
Three states: `unread`, `reading`, `finished`

### Context menu changes
Replace the current single toggle button with explicit status actions:
- **Mark as Currently Reading** — sets status to `reading` (visible when status is `unread` or `finished`)
- **Mark as Finished** — sets status to `finished` (visible when status is `reading` or `unread`)
- **Mark as Unread** — resets status to `unread` (visible when status is `reading` or `finished`)

### Auto-marking behavior
- Opening a book should **not** automatically mark it as "Currently Reading"
- Instead, explicitly prompt or let the user decide
- Alternative: keep auto-marking on first open, but allow manual override via context menu

### Backend
- `save_book_progress` (`books.rs:265`) should stop force-setting `status = 'reading'` — only update progress/CFI
- Add a dedicated `update_book_status` command that takes `(book_id, status)`

## Key Decisions

- Keep auto-mark on first open (unread → reading), but never override a manual status change
- Context menu shows all applicable status transitions
- Sidebar "Currently Reading" filter only shows books with `status = 'reading'`

## Verification

- [ ] Right-click a book → can mark as Currently Reading / Finished / Unread
- [ ] "Currently Reading" sidebar filter reflects manual status changes
- [ ] Opening an unread book marks it as reading (first time only)
- [ ] Opening a book marked as finished does NOT re-mark it as reading
- [ ] Mark as Unread resets status and removes from Currently Reading shelf
