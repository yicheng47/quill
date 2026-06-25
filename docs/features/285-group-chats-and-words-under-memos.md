# 285 - Group Chats and Words under Memos

GitHub issue: https://github.com/yicheng47/quill/issues/285

## Motivation

Quill currently separates Chats and Vocab in the navigation, which makes the sidebar feel fragmented and gives Vocab an overly educational tone. Quill should feel like a calm reading app, not a study tool.

Introduce **Memos** as a personal saved-material section for reader-owned artifacts. The label should feel lightweight and reader-native, while leaving room for Notes to join later when that separate feature ships.

## Scope

In scope:

- Add a top-level sidebar section named **Memos**.
- Move **Chats** under **Memos**.
- Move **Vocab** under **Memos** and rename its navigation label to **Words**.
- Use this initial section order:
  - Chats
  - Words
- Preserve existing routes and data where possible; this is primarily information architecture and naming, not a data migration.
- Keep English and Chinese i18n strings in sync.

Out of scope:

- Adding Notes as part of this feature.
- Changing chat persistence, vocabulary storage, or saved-word behavior.
- Reworking the reader-side highlight/bookmark/sidebar model.

## Implementation Phases

1. Update sidebar navigation grouping, labels, and selected states so Chats and Words appear under Memos.
2. Rename user-facing Vocab navigation strings to Words where this menu item is shown.
3. Keep existing Chats and Vocab/Words navigation behavior working without changing stored data.
4. Review empty states, page titles, breadcrumbs, and i18n entries for mismatched educational language.

## Verification

- Sidebar shows **Memos** with **Chats** and **Words**.
- Existing Chats navigation still opens the same chat/history experience.
- Existing Vocab/Words navigation still opens the saved words experience.
- Selected and hover states work correctly for both Memos children.
- English and Chinese i18n strings stay in sync.
