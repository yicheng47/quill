# Mission briefs

A brief gives a mission its working directory, problem, deliverables, validation and authorization. Write it on the mission's branch before launch, as `{issue}-{slug}.md`, or `{issue}-m{n}-{slug}.md` when a feature takes several missions; it is folded into an implementation commit when the work lands. Small fixes normally stay inline; launch a mission only when Jason requests or approves one. Keep each launch goal under 8 KB and link to the spec or plan for detail.

## Writing a brief

1. **Starting point.** Name the issue or existing PR, branch, exact worktree and base revision. The root checkout stays on `main`; every worktree has its own `node_modules/` and `src-tauri/target/`.
2. **Problem and outcome.** Describe the trigger, current behavior and intended result. Name the spec and the Pencil frame in `design/` when applicable, and say which source wins on detail.
3. **Read first.** Point to the few source files and docs needed to begin. Prefer symbols over line numbers that will drift.
4. **Deliverables and boundaries.** State observable acceptance criteria, non-goals and any approved probes or fixtures. Avoid repeating the repo's rulebook.
5. **Validation and handoffs.** Tie each selected check to changed behavior under [Test Scope](../../../AGENTS.md#test-scope). State who implements, reviews and runs live checks, and what evidence the final handoff carries.
6. **Authorization.** State only what is specific to this mission: the approved crew, whether it may commit, push and open a PR, and any exception to the [Crew Missions](../../../AGENTS.md#crew-missions) rules. Do not restate those rules: a crew follows them by default. One or two sentences is usually enough.

## Retention

At a release's docs sweep, prune the briefs of merged missions. Keep a brief while its work is active. Before pruning, preserve unique current decisions in `docs/arch/` and outstanding scope in its issue.
