---
name: ship
description: Commit, open a PR, wait for CI, merge it as a merge commit, and clean up the worktree
---

# Ship

Invoking this skill is an explicit request to commit, push, open a PR and merge it, following `AGENTS.md` (Worktrees, Commit And PR Conventions, Post-mission cleanup).

## Steps

1. Work in the branch's worktree under `.worktrees/`, never on `main` in the root checkout. If the changes sit in the root checkout, stop and report rather than moving them.
2. Run `git status`, `git diff --stat` and `git log --oneline -5`. Stage the relevant files (never `.env` or credentials) and commit with a focused, imperative subject; fold follow-up fixes into the commit they correct.
3. Push with `-u` and open the PR with `gh pr create`: a short title, summary bullets and a test plan. Add one risk label, plus `core-review` or `needs-live-test` when `AGENTS.md` calls for them.
4. Wait for CI: `gh pr checks <pr-number> --watch`.
5. Stop before merging if the PR carries `core-review` (Jason reviews it first) or `needs-live-test` (its live checks have not passed), and report why.
6. Merge as a merge commit: `gh pr merge <pr-number> --merge`. GitHub deletes the remote branch.
7. Run the post-mission cleanup from `AGENTS.md`: archive any missions that worked on the branch, then `git worktree remove .worktrees/<flattened-branch>` and delete the local branch.

If any step fails, stop and report the error.
