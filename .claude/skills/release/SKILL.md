---
name: release
description: Tag a new release, push, and publish on GitHub
---

# Release

Create a new versioned release for Quill.

## Steps

1. Ask the user for the version number (e.g. `0.3.0`) if not provided as an argument.

2. If there are uncommitted changes, include them in the release:
   - Bump version in `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`, and `package.json`.
   - Run `cargo check` in `src-tauri/` to update `Cargo.lock`.
   - Check if `public/foliate-js` submodule has changes. If so, commit and push the submodule, then stage the updated reference.
   - Stage everything and commit with message `chore: bump version to v{version}`.

3. If the working tree is already clean, just bump version files, run `cargo check`, and commit as above.

4. Create a feature branch: `git checkout -b release/v{version}`

5. Push the branch: `git push -u origin release/v{version}`

6. Create a PR: `gh pr create --title "chore: release v{version}" --body "..."` with a summary of changes.

7. Wait for CI to pass: `gh pr checks <pr-number> --watch`

8. Once CI passes, merge the PR: `gh pr merge <pr-number> --squash --delete-branch`

9. Pull main and tag: `git checkout main && git pull && git tag -a v{version} -m "v{version}"`

10. Push the tag: `git push origin v{version}`

11. Wait for the release workflow to complete: `gh run list --workflow=release.yml --limit 1 --json status,conclusion,databaseId`

12. Once the workflow succeeds, draft a release message by reviewing commits since the last tag: `git log $(git describe --tags --abbrev=0 HEAD^)..HEAD --oneline`

13. Categorize changes into sections: **What's New**, **Improvements**, **Bug Fixes** (omit empty sections).

14. Publish the release: `gh release edit v{version} --draft=false --notes "..."`. Include a **Download** section at the bottom with the `.dmg` filenames for Apple Silicon and Intel.

If any step fails, stop and report the error — do not continue.

## Notarization Commands

- **Check notarization history**:
  ```
  xcrun notarytool history --apple-id "$APPLE_ID" --password "$APPLE_PASSWORD" --team-id "$APPLE_TEAM_ID"
  ```

- **Check a specific submission**:
  ```
  xcrun notarytool info <submission-id> --apple-id "$APPLE_ID" --password "$APPLE_PASSWORD" --team-id "$APPLE_TEAM_ID"
  ```

- **Verify stapling on a DMG or .app**:
  ```
  stapler validate <file>
  ```

- **Check code signing**:
  ```
  codesign -dvv <path-to-app>
  ```

Note: Apple credentials are in `~/.zshrc`. The shell may not have them loaded — use literal values if env vars are empty.
