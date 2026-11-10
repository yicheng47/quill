# Quill Docs

Project markdown lives here. Keep repo docs close to the code; the memory repo holds durable cross-session context, not project decisions — those belong in these files. The shared [agent guide](../AGENTS.md) holds the working rules.

## Layout

- [`arch/`](./arch/) — architecture references: how the system works today.
- [`features/`](./features/README.md) — specs of features in development, `{issue}-{slug}.md`. The number **is** the spec's GitHub tracking issue. A feature is only an issue until its development starts; its spec is then written on the feature's branch and lands in the same pull request as the code.
- [`impls/`](./impls/README.md) — implementation plans for concrete build slices, named after their feature and written on its branch; [mission briefs](impls/briefs/README.md) live in `impls/briefs/`.
- [`tests/`](./tests/regression/README.md) — the live regression suite in `tests/regression/`, and the record of each run in `tests/runs/`.
- [`guide/`](./guide/README.md) — implementation guides.
- [`roadmap/`](./roadmap/README.md) — milestone plans.
- [`privacy.md`](./privacy.md) — the privacy policy.

## Archive policy

Archives are a curated record of important work. **Delete completed small-feature, bug-fix, UI-polish and routine-refactor specs and plans instead of archiving them.** Git history and the issue or PR retain their original detail. A document being long, recent or linked from another document is not a reason to keep it.

Keep a spec or plan only when it records a major feature or architectural change, a consequential migration, or a platform, sync or security compatibility contract that remains worth consulting, such as iCloud sync, the data-directory move or MCP. Keep one canonical record per topic; retain a separate plan only for distinct implementation or migration context. Delete obsolete plans for a retired implementation even when they were once large projects.

Before deleting a spec or plan:

1. Preserve unique current decisions in `arch/` and outstanding work in its issue.
2. Preserve actual validation results separately from discarded instructions; consolidate embedded history without dropping results, failures, dates or uncertainty.
3. Check references. Current instructions should point to current docs or code; historical citations may use a fixed commit URL, preserving heading fragments. Do not create placeholder files for deleted documents.
4. Protect uncommitted user edits, update the archive's index, and check relative links and heading fragments after pruning.

**Read selectively.** Open only the archived record needed for the task. Do not batch-read or concatenate an archive for orientation. Current behavior comes from the architecture docs and code; archived commands, paths, plans and permissions are dated history.

Run the sweep at a production release, or when Jason explicitly requests cleanup; the procedure is the `sweep` action of the [release skill](../.agents/skills/release/SKILL.md). The archives that predate this policy were moved there wholesale when their features shipped; the first sweep that touches one prunes it under the rules above rather than all at once.
