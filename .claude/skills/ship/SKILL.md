---
name: ship
description: Commit, create PR, wait for CI, and merge
---

# Ship

Commit current changes, open a PR, wait for CI to pass, then squash-merge.

## Steps

1. Run `git status` and `git diff --stat` to see what's changed. Run `git log --oneline -5` for commit message style.

2. Draft a concise commit message based on the changes. Stage relevant files (not `.env`, credentials, etc.) and commit.

3. Create a feature branch if not already on one (use a descriptive name based on the changes). Push with `-u`.

4. Create a PR with `gh pr create` — short title, summary bullets, test plan.

5. Wait for CI: `gh pr checks <pr-number> --watch`

6. Once CI passes, merge: `gh pr merge <pr-number> --squash --delete-branch`

If any step fails, stop and report the error.
