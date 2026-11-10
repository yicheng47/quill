---
name: feature
description: File, list, or manage feature issues, and write a feature's spec when its development starts
---

# Feature Management

A feature is a GitHub issue with the `feature` label until someone starts building it. Filing, prioritizing and scheduling a feature touch only GitHub: nothing is written to the repo and nothing is committed. Its spec in `docs/features/` is written when development starts, on the feature's branch, and reaches `main` in the same pull request as the code, together with any impl plan or mission brief.

## Usage

`/feature <action> [args]`

### Actions

#### `new <name>`
File a new feature as an issue.

1. Ask the user to describe the feature (motivation, scope, key decisions) unless they already have.
2. **Pick a priority** (see Priority below). If the user didn't state one, propose one and confirm before filing. Don't file unlabeled.
3. **Pick a readiness label** (see Readiness below) and propose it together with the priority. A feature with new UI or open questions is `needs-design`.
4. **Schedule it** (see Scheduling below): set a milestone only when the user names one; otherwise add `backlog`.
5. Create the issue with labels `feature`, the chosen `P0`/`P1`/`P2`/`P3`, the readiness label, if any, and `backlog` when it has no milestone:
   - Title: `feat: <short description>`
   - Body: Motivation, Scope, and Open questions when there are any. The issue holds the design discussion until development starts.
   - Command shape: `gh issue create --label feature --label P1 [--label needs-design] --title "…" --body "…" (--milestone "Milestone 2" | --label backlog)`
6. Report the issue URL, priority, readiness and milestone or `backlog`. Do not create a spec or edit any doc.

#### `list`
Show all features, sorted by priority.

1. Fetch open features with priority + metadata as JSON so they can be sorted:
   `gh issue list --label feature --state open --limit 50 --json number,title,labels,milestone,createdAt,assignees`
2. List the spec files in `docs/features/` (excluding README); most features have none until development starts.
3. Sort the rows by priority (`P0` first, then `P1`, `P2`, `P3`, then unlabeled-by-priority last). Within a priority bucket, sort by issue number ascending.
4. Present a combined view: **Priority**, **Readiness** (`agent-ready`, `needs-design` or —), feature name, **#** (issue), **Milestone** (`backlog` for a backlog issue), spec file (if one exists), **Created**. Issues without a P-label show `—` in priority, and issues with neither a milestone nor `backlog` show `—` in Milestone; add a callout asking the user to triage either.
5. If the user asks for closed/shipped features too, repeat with `--state all` and add a **State** column.

#### `spec <issue-number>`
Write the spec when development of a feature starts.

1. Work in the feature's branch worktree (`AGENTS.md`, Worktrees), never in the root checkout on `main`. If the branch does not exist yet, create it as `AGENTS.md` describes once the user has asked to start the work.
2. Create `docs/features/{issue}-{slug}.md`, pre-populated from the issue body and its discussion: a header linking the tracking issue, then Motivation, Scope, Implementation Phases, Verification. Leave priority and milestone out; they live on the issue.
3. Add the spec's line under Active in `docs/features/README.md`.
4. The spec is committed on the branch and lands with the code. A crew mission folds it into its commits like the brief.

#### `close <issue-number>`
Close a feature that shipped or was dropped.

1. Close the GitHub issue: `gh issue close <number>`, adding `--reason "not planned"` when it was dropped.
2. Leave its spec where it is. The release's docs sweep archives specs (`release` skill, `sweep`).

#### `prioritize <issue-number> <P0|P1|P2|P3>`
Set or change the priority of an existing feature.

1. Remove any existing P-label on the issue, then add the new one:
   `gh issue edit <number> --remove-label P0 --remove-label P1 --remove-label P2 --remove-label P3 --add-label <priority>`
   (Removing all four is safe — `gh` ignores remove-label for labels not present.)
2. Confirm the new priority.

#### `ready <issue-number> <agent-ready|needs-design|none>`
Set or change an existing feature's readiness.

1. Remove both readiness labels, then add the new one unless it is `none`:
   `gh issue edit <number> --remove-label agent-ready --remove-label needs-design [--add-label <readiness>]`
2. Confirm the new readiness.

#### `schedule <issue-number> <milestone|backlog>`
Put an existing feature on a milestone or in the backlog.

1. For a milestone: `gh issue edit <number> --milestone <milestone> --remove-label backlog`. For the backlog: `gh issue edit <number> --remove-milestone --add-label backlog`.
2. Confirm the new milestone or `backlog`.

## Labels

- `feature` — all feature issues use this label.
- `bug` — for bug reports (not managed by this skill).
- `P0` / `P1` / `P2` / `P3` — priority, exactly one per issue.
- `agent-ready` / `needs-design` — readiness, at most one per issue (see Readiness below).
- `backlog` — no release commitment; see Scheduling below.

## Scheduling

Every open issue has exactly one of a milestone or the `backlog` label. A milestone is a release commitment; `backlog` means the issue is triaged but has none. Setting a milestone removes `backlog`, and taking an issue off its milestone without closing it adds `backlog`. Priority and scheduling are separate: a P1 can sit in the backlog when its development is deliberately later.

## Readiness

A readiness label says what has to happen before development can start. Many features get neither.

- **`needs-design`** — development cannot start yet: the feature adds or changes UI that has no signed-off Pencil frame, it has open questions the user must decide, or it spans several surfaces and needs a spec or plan first. Most new features start here.
- **`agent-ready`** — small and fully specified: nothing is left to decide, no UI needs drawing, and an agent can build and verify it in one pass. Build it inline, not as a crew mission.
- **Neither** — specified but substantial work for a crew mission, or an evaluation or investigation rather than a build.

Update the label as the issue moves: remove `needs-design` once the design is signed off or the questions are settled, and add `agent-ready` if what is left is small.

## Priority

Every feature gets exactly one priority label. Rubric:

- **P0** — Required for the next ship; nothing else moves until this lands. Rare for features.
- **P1** — Wanted this cycle; blocks an active user workflow or has a stakeholder commitment.
- **P2** — Real product win, but no urgency. Pick up when the P1 queue is clear.
- **P3** — Idea / nice-to-have / "if we ever revisit X." OK to sit indefinitely; closing as `wontfix` later is fine.

When in doubt between two levels, pick the lower-urgency one and say why; over-labeling P0/P1 dilutes the signal.

## Conventions

- A spec is named after its tracking issue, `{issue}-{slug}.md`, with a lowercase kebab-case slug.
- Specs, impl plans (`docs/impls/`) and mission briefs (`docs/impls/briefs/`) are written on the feature's branch and land with its code. Design files are the exception: `.pen` files are settled on `main` first (`AGENTS.md`, Engineering Conventions).
- At the release's docs sweep, retain specs in `docs/features/archive/` only when their decisions, compatibility constraints or implementation context still help. Obsolete or duplicate proposals can be pruned after preserving useful unique content and fixing references; issues and git history are enough for many dropped ideas. The implementation is the source of truth.

## Notes

- Do not commit or push unless the user explicitly asks.
- A spec always links its GitHub issue URL.
