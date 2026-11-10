---
name: release
description: Cut a Quill production release — bump the version, tag vX.Y.Z, let release.yml build the draft for macOS and Windows, write the release notes, hand the publish switch to the user, and once the release is live sweep the shipped work's docs
---

# Release

A production release is a `vX.Y.Z` tag on a `main` commit whose app version is exactly `X.Y.Z`. `release.yml` builds the signed, notarized macOS DMGs for Apple Silicon and Intel, the Windows x64 installer, and the updater bundles with their signatures and `latest.json`, then attaches everything to a **draft** release. Publishing the draft is the user's switch: it moves `releases/latest`, which the in-app updater reads.

An explicit request to `run` authorizes the bump commit, the push, the tag, and editing the draft's notes; after the user publishes, it also authorizes the sweep's docs commit and push. An explicit `sweep` request authorizes that commit and push on its own. Nothing in this skill publishes the draft, deletes a release or moves an existing tag. Record only observed results.

## Usage

`/release [run <version> | notes <version> | check <version> | sweep <version>]` — no action means `run`. Ask for the version if none is given; Jason picks it, and small incremental features can ship as a patch (a `feat:` commit alone does not imply a minor release).

## `run <version>`

1. **Preflight — stop on any failure and report it.**
   - `<version>` must match `^[0-9]+\.[0-9]+\.[0-9]+$` and be greater than the current tag from `gh release list`.
   - `git fetch origin`; require branch `main`, a clean tree, and `git rev-parse main origin/main` equal. Everything meant for the release is already merged.
   - CI on `origin/main` is green: `gh run list --branch main --workflow ci.yaml --limit 1 --json conclusion`.
   - The smoke tier of the [regression suite](../../../docs/tests/regression/README.md) has passed on macOS for the `main` commit being released, in a run recorded in `docs/tests/runs/`, unless Jason waives it for this release. If no such run exists, stop and propose the qa mission that runs it.
   - No release run is in flight: `gh run list --workflow release.yml --limit 3 --json status`.
2. **Bump.** Do not use `sed` for the version. Read each file first to confirm the current version, then edit it in `package.json`, `src-tauri/tauri.conf.json` and `src-tauri/Cargo.toml`, and check all three show the new version. Run `cargo check` in `src-tauri/` to refresh `Cargo.lock`, and `npm install --package-lock-only --ignore-scripts` to refresh the root `version` in `package-lock.json`. If the `public/foliate-js` submodule moved, push the submodule commit first and stage the updated pointer. Commit as `chore: bump version to v<version>` and push `main`.
3. **Tag.** `git tag -a v<version> -m "v<version>" && git push origin v<version>`. The push starts `release.yml`.
4. **Watch.** Find the run with `gh run list --workflow release.yml --limit 1 --json databaseId,status,headSha` and `gh run watch <id> --exit-status`. Every build job must succeed. On failure, `gh run view <id> --log-failed`, report the failing step, and stop; the tag stays, the draft may be partial.
5. **Notes.** Follow `notes <version>` below and set them on the draft: `gh release edit v<version> --notes-file <file>`. Do not pass `--draft=false`.
6. **Report.** The draft URL, every asset name, and the reminder that publishing is the user's action. A draft's `untagged-…` URL changes each time it is edited, so link the latest one. After the user publishes, confirm `gh release view v<version> --json isDraft` is `false` and `gh api repos/yicheng47/quill/releases/latest --jq .tag_name` is `v<version>` before anything that assumes the release is live.
7. **Sweep.** Once the release is live, follow `sweep <version>` below.

## `notes <version>`

Source the content from `git log v<previous>..v<version> --no-merges --format='- %s (%h)'` and the closed issues those commits reference. Write for users, not for the repo: what changed for them, in their words, one bullet per change with the issue number at the end. Skip internal work (tests, CI, docs, refactors) unless it changes what users see. A draft with only the workflow's one-line stub is not ready to publish.

Sections, omitting empty ones: **What's New**, **Improvements**, **Bug Fixes**, then **Download**, naming each installer from the draft's assets (`gh release view v<version> --json assets --jq '.assets[].name'`) rather than guessing: the Apple Silicon and Intel DMGs, and the Windows x64 installer.

## `sweep <version>`

Reviews and cleans up the docs of everything shipped since the previous sweep in one doc-only commit on `main`, so merges themselves add no docs commits (`AGENTS.md`, Docs Sweep At Release). Run it only once `v<version>` is published (`gh release view v<version> --json isDraft` is `false`).

1. **Preflight.** On `main`, clean tree, `git rev-parse main origin/main` equal after `git fetch origin`, and nothing in flight in `gh run list --workflow release.yml --limit 3 --json status`.
2. **Find what shipped.** Read `docs/README.md`'s Archive policy first; do not batch-read archived files for orientation. Walk the in-progress docs rather than a commit range, so anything an earlier sweep missed is caught: each brief in `docs/impls/briefs/` (excluding `README.md`), each plan in `docs/impls/`, and each spec in `docs/features/`. Check each one's issue with `gh issue view <n> --json state,stateReason,closedAt` and its PRs with `gh pr list --state merged --search <n>`. Anything whose work is still open stays put.
3. **Briefs.** Prune the brief of every merged mission; git history keeps it. Keep the brief of any mission still running.
4. **Specs and plans.** Once an issue closes (after the last PR for a multi-PR feature), delete completed small-feature, bug-fix, UI-polish and routine-refactor specs and plans. Retain only important features, architectural changes and consequential migration, sync or security contracts under the Archive policy, moved to the matching `archive/`. Preserve unique current decisions in `docs/arch/` and deferred scope in the issue before pruning. Repair references to current docs, code or fixed commit URLs, protect uncommitted user edits, and drop shipped entries from `docs/features/README.md` and `docs/impls/README.md`.
5. **Commit.** Check the relative links with a script. Commit as `docs: clean up the docs shipped in <version>`, push `main`, and report what was retained or pruned, and anything left in place with the reason.

## `check <version>`

Read-only. `gh release view v<version> --json isDraft,isPrerelease,assets,body`: report draft state, that both DMGs, the Windows installer, the updater bundles with their `.sig` files and `latest.json` are present, and whether the body has more than the workflow's stub. After publishing, also verify `releases/latest` resolves to the tag.

## Notarization commands

Apple credentials are in `~/.zshrc`. The shell may not have them loaded — use literal values if the variables are empty.

- Notarization history: `xcrun notarytool history --apple-id "$APPLE_ID" --password "$APPLE_PASSWORD" --team-id "$APPLE_TEAM_ID"`
- One submission: `xcrun notarytool info <submission-id> --apple-id "$APPLE_ID" --password "$APPLE_PASSWORD" --team-id "$APPLE_TEAM_ID"`
- Stapling on a DMG or .app: `stapler validate <file>`
- Code signing: `codesign -dvv <path-to-app>`
