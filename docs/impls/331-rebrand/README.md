# 331 Desktop Rebrand — Program Record

Implementation record for [feature 331](../../features/331-rebrand.md) ([#331](https://github.com/yicheng47/quill/issues/331), also closing [#322](https://github.com/yicheng47/quill/issues/322) and [#325](https://github.com/yicheng47/quill/issues/325)).

The spec says *what*; this directory says *how, in what order, and what has landed*:

- [`README.md`](README.md) (this file) — condensed program status, mission table, and binding architectural/scope decisions.
- [`plan.md`](plan.md) — tactical 8-mission execution plan across Phases 1–4, backend command additions, file boundaries, and per-mission verification gates.
- [`design-map.md`](design-map.md) — complete inventory of all 58 frames/boards and 29 `cmp/*` reusable components in `quill/desktop/specs/331-rebrand.pen` (`YeelinksCo/yeelinks_design` `f7cb448`), plus the Dawn (`light`) and Nocturne (`dark`) token tables.
- [`impl_log.md`](impl_log.md) — chronological log of design sign-offs, mission handoffs, QA findings, and operator rulings.
- Mission briefs live in [`docs/impls/briefs/`](../briefs/README.md) as `331-m<N>-<slug>.md` on each mission's branch.

## Status (2026-11-18)

Design is signed off and pushed to `YeelinksCo/yeelinks_design` `main` at `f7cb448` (`quill/desktop/specs/331-rebrand.pen`, 58 frames/boards + 29 reusable components). **M1** merged on 2026-11-18 ([#332](https://github.com/yicheng47/quill/pull/332)); **M2** and **M6** are unblocked.

| Mission | Phase | Branch | Waits on | Pull request | State |
|---|---|---|---|---|---|
| **M1** — Foundations, Icons, `cmp/*` & Queries | 1 | `feat/331-rebrand` | — | [#332](https://github.com/yicheng47/quill/pull/332) | Merged |
| **M2** — `TopBar`, Quiet Updates, `⌘K` (Books), `Library` & Collections | 1 | `feat/331-m2-topbar-and-library` | M1 | — | Planned |
| **M3** — `Home` Bento, Full `⌘K`, `Highlights`, `Words` (#322) & `Chats` | 2 | `feat/331-m3-main-views` | M2 | — | Planned |
| **M4** — 9-Tab In-Window `Settings`, `iCloud Sync` States, `Updates` & `About` | 2 | `feat/331-m4-settings-and-updates` | M2 (M3 preferred) | — | Planned |
| **M5** — `AI Assistant`, Auth Lifecycle & `#325` Session Expiry | 2 | `feat/331-m5-ai-assistant-and-auth` | M4 | — | Planned |
| **M6** — `Reader` Dawn Shell, Themes, PDF Spread, Navigation Islands & iCloud | 3 | `feat/331-m6-reader-shell` | M1 | — | Planned |
| **M7** — `Reader` Selection Menu, Reading Popovers, `Words in Book` & `Ask Quill` | 3 | `feat/331-m7-reader-ai-and-popovers` | M5, M6 | — | Planned |
| **M8** — Nocturne Dark Mode (`.dawn.dark`, `Appearance` & Window Sync) | 4 | `feat/331-m8-nocturne-dark-mode` | M3, M5, M7 | — | Planned |

## Decisions That Bind

- **Direct-to-`main` per-mission PRs, no umbrella branch.** Each mission works in `.worktrees/feat-331-m<N>-<slug>` (M1 uses `.worktrees/feat-331-rebrand`), opens a focused PR against `main`, passes code review, live QA, and macOS/Windows CI, and lands on `main` as a merge commit (`gh pr merge --merge`). `main` stays buildable and visually coherent after every merge.
- **Dawn Light first (M1–M7), Nocturne Dark Mode last (M8)** (Jason, 2026-11-18). M1 scopes Dawn tokens under `.dawn`; M2–M7 ship every main-window and reader surface in Dawn Light while keeping `Appearance`'s `System` and `Dark` cards disabled; M8 adds `.dawn.dark` Nocturne variable values (`q62MgQ`, `Y803E5`, `T1qAJe`, `CPGY5`) and enables `System` / `Light` / `Dark` across all windows.
- **`#276` Reset All Data stays separate from M4** (Jason, 2026-11-18). Although `dkFHc` designs both `General`'s inline `Display name` edit and `#276`'s 2-step `RESET` confirmation modals, M4 implements only the inline `Display name` edit and omits the `DATA` reset card until [#276](https://github.com/yicheng47/quill/issues/276) lands in its own dedicated `core-review` PR.
- **Settings navigation uses 4 uppercase groups and 9 tabs** (Jason, 2026-11-18): `APP` (`General`, `Appearance`, `Reading`), `AI` (`AI Assistant`, `Tools`), `INTEGRATIONS` (`iCloud Sync`, `MCP`), and `SYSTEM` (`Updates`, `About`), with `Settings` reached directly from `TopBar`'s right gear `IconButton` (`qPeyq` / `⌘,`) rather than an avatar menu or back button.
- **Updates follow Runner's quiet model using Quill's `$accent` violet** (Jason, 2026-11-18): `TopBar` shows a quiet 24px `$accent` indicator (`ArdQm`) whose `Available` state downloads immediately without a popover; only `Ready` opens the 264px restart popover, while `Settings → Updates` (`HnSex`, `Rh6Ai`) owns all 6 hero states.
- **Home import states are separate single-state overlays, never side-by-side** (Jason, 2026-11-18): `isDragging` (`BC0DA`) and `importing` (`BUxUo`) each center a single modal card over the blurred scrim, while `importError` (`J6aW1P`) renders as a top-center dismissible toast over an un-dimmed interactive window.
- **Library includes end-to-end collection creation and population** (Jason, 2026-11-18): users can create, drag-reorder, inline-rename, and non-destructively delete collections inside the `Collections` popover (`Zzvta`), toggle multi-collection checkmarks or quick-create-and-add from `BookContextMenu` (`F7B1gQ`, backed by `list_book_collections`), and populate an empty collection via `Add Books from Library…` (`r532a5`).
- **iCloud Sync preserves all existing data-safety invariants (`LibrarySyncSettings.tsx`):** `sync_enabled` (durable intent, driving the toggle and cached `DEVICES` visibility) stays separate from `enabled` (session engine, showing `Paused` offline while disabling `Sync now`, `Compact log`, and `Rebuild`), and turning sync off runs the blocking `Copying library to this Mac…` verification modal before repointing storage. Live QA keeps iCloud sync strictly **off**.
- **Windows keeps its native title bar for now** (Jason, 2026-11-18): the `TopBar` and reader toolbar are designed around macOS traffic lights only. On Windows they render below the native frame without the traffic-light spacer; a custom Windows title bar waits for its own design.
- **Crew confirmation before every mission start (`AGENTS.md`):** confirm the crew with Jason before launching each Runner mission (claude trio by default for live-checked UI missions unless Jason specifies codex/hydrogen).
