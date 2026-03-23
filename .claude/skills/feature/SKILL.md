---
name: feature
description: Create, list, or manage feature specs and GitHub issues
---

# Feature Management

Manage Quill's feature pipeline: specs live in `docs/features/`, tracking lives in GitHub Issues with the `feature` label.

## Usage

`/feature <action> [args]`

### Actions

#### `new <name>`
Create a new feature from scratch.

1. Ask the user to describe the feature (motivation, scope, key decisions).
2. Assign the next available number by checking existing files in `docs/features/`.
3. Create `docs/features/{number}-{slug}.md` with sections: Motivation, Scope, Implementation Phases, Verification.
4. Create a GitHub Issue with label `feature`:
   - Title: `feat: <short description>`
   - Body: Motivation, Scope summary, Implementation Phases, and a reference back to the spec file.
5. Update `docs/features/README.md` to include the new spec.
6. Report the spec path and issue URL.

#### `list`
Show all features and their status.

1. List all GitHub Issues with the `feature` label: `gh issue list --label feature --state all --limit 50`
2. List all spec files in `docs/features/` (excluding README).
3. Present a combined view: feature name, issue number, state (open/closed), spec file (if exists).

#### `close <issue-number>`
Mark a feature as shipped.

1. Close the GitHub Issue: `gh issue close <number>`
2. If a matching spec file exists in `docs/features/`, ask the user whether to remove it (shipped code is the source of truth) or keep it.
3. If removing, delete the spec file and update `docs/features/README.md`.

#### `spec <issue-number-or-name>`
Open or create a spec for an existing feature issue.

1. If a spec file already exists, show its path.
2. If not, create one following the same format as `new`, pre-populated from the issue body.

## Labels

- `feature` — all feature issues use this label
- `bug` — for bug reports (not managed by this skill)

## Conventions

- Spec files are numbered sequentially: `01-product-spec.md`, `02-ai-quick-explain.md`, etc.
- Slugs are lowercase kebab-case derived from the feature name.
- Specs for shipped features get deleted — the implementation is the source of truth.
- The `docs/features/README.md` index only lists in-progress/planned specs.

## Notes

- Do not commit or push unless the user explicitly asks.
- When creating issues, always include a reference to the spec file path in the issue body.
- When creating specs, always include a reference to the GitHub issue URL.
