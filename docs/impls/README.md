# Implementation Plans

An impl plan is tactical: the spec says *what*, the plan says how a change lands, what it touches and how it is verified. A plan is named `{issue}-{slug}.md` (or `{issue}-{slug}/` for multi-mission programs) after its feature, written on the feature's branch or `main` when coordinating direct-to-`main` missions, and lands with the work. Mission briefs live in [`briefs/`](briefs/README.md). After shipping, delete small-feature, bug-fix and routine-refactor plans; keep only important records in [`archive/`](archive/) under the [archive policy](../README.md#archive-policy), after folding decisions that outlive the work into [`../arch/`](../arch/).

## Active Programs & Plans

- [316 — Chats Infinite Scroll with Backend Pagination](316-chats-pagination.md)
- [327 — Electron Migration](327-electron/plan.md)
- **331 — Desktop Rebrand (Dawn & Nocturne):** [program record](331-rebrand/README.md) · [plan](331-rebrand/plan.md) · [design map](331-rebrand/design-map.md) · [implementation log](331-rebrand/impl_log.md)
