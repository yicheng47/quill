# 322 — Vocab List Only + Scrollbars on Long Lists

GitHub issue: https://github.com/yicheng47/quill/issues/322

## Motivation

Two corrections to the Memos surface, both about how long lists present themselves.

**The vocab grid view earns nothing.** The Words tab carries a list/grid toggle, but the two modes are not two renderings of the same data — they are two different groupings with different information. The list groups A–Z and gives each word a definition line plus the sentence it was saved from. The grid groups by book into cards, truncates the definition to three lines, and drops the alphabetical index entirely. For a vocabulary list the alphabetical view is the one that answers the question people actually bring to it — *did I already save this word?* — while the card view mostly trades vertical space for a book heading that the book filter already provides. Keeping both means every future change to a word row has to be made twice, in two layouts that were never meant to stay in sync.

**Infinite scroll with a hidden scrollbar reads as bottomless.** The Chats and Words panes both opt out of scrollbars with `.scrollbar-none`. That was survivable while both loaded their whole dataset at once, but Chats gained infinite scroll in #320, and the scrollbar is precisely the affordance that communicates how much list is left and that another page just arrived — the thumb shrinks as content grows. Without it an infinitely scrolling list offers no sense of position or progress. The inconsistency is already visible inside the app: the book grid on Home does not opt out, so it shows a scrollbar while the two Memos panes do not.

## Scope

In scope:

- **The A–Z list becomes the only vocab view.** The toggle buttons, the view-mode state, and the book-grouped card branch are removed, along with the book-grouping memo that only that branch consumed and any icon imports it leaves unused. Nothing needs migrating or cleaning up: the mode lived in component state that always initialized to the list, was never persisted to settings or localStorage, and the icon-only buttons carry no translated strings.
- **The dead `src/pages/DictionaryPage.tsx` is deleted.** It is unreachable — nothing imports it and the router defines only `/` and `/reader/:bookId` — and it contains a stale duplicate of the entire vocab UI, grid view included. Removing the toggle from the live component while an unreachable copy keeps it would leave the next reader two search hits for the same feature, one of them a trap.
- **The Chats and Words panes get their scrollbar back**, by dropping the `.scrollbar-none` opt-out on their scroll containers. This adds no new CSS. The app already styles an 8 px scrollbar with a transparent track and a subtle thumb that darkens on hover, and that styling is what Home's book grid shows today — so the change makes the three content panes agree rather than introducing a fourth look.
- **The sidebar collection list keeps its hidden scrollbar.** It is short chrome rather than a content pane, and a scrollbar there reads as noise.

Out of scope:

- Pagination for the vocab list. It still loads every saved word in one query and filters and groups client-side; that is a separate question from how the pane presents itself, and nothing here depends on changing it.
- The vocab row layout, the A–Z grouping, the search field, and the book filter — all unchanged.
- The scrollbar styling itself. The existing global rules are the design; this only stops two panes from opting out of them.
- Chats' infinite-scroll behavior from #320. The scrollbar becomes visible alongside it; the paging logic is untouched.

## Implementation Phases

1. **Strip the grid view.** Remove the toggle, the view state and its type, and the card branch from the live vocab component, following through to the book-grouping memo and icon imports that become unused once the branch is gone.

2. **Delete the dead page.** Remove `src/pages/DictionaryPage.tsx` and confirm nothing referenced it.

3. **Restore the scrollbars.** Drop `.scrollbar-none` from the Chats and Words scroll containers, leaving the sidebar as it is.

4. **Verify.** Check both panes in light and dark themes and confirm Chats still pages correctly now that a scrollbar occupies the pane's edge.

## Verification

- The Words tab shows the A–Z list with no view toggle in the header, and the header's remaining controls — search and the book filter — keep their spacing and alignment.
- Word rows behave as before: clicking opens the detail modal, the hover delete button works, and the A–Z headings still show per-letter counts.
- Search and the book filter still narrow the list, and the empty state still appears when no words are saved.
- Deleting `DictionaryPage.tsx` leaves the app building with no unresolved imports, and the Words tab is still reachable from the sidebar.
- The Words pane shows a scrollbar once the list overflows, styled like the one on Home's book grid, in both light and dark themes.
- The Chats pane shows a scrollbar, and scrolling to the bottom still loads the next page; the thumb resizes as pages arrive rather than the list appearing bottomless.
- The sidebar collection list still scrolls without a visible scrollbar.
- No horizontal layout shift or clipped content where the scrollbar now occupies width in either pane.
