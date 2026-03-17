---
name: release
description: Tag a new release, push, and publish on GitHub
---

# Release

Create a new versioned release for Quill.

## Steps

1. Ask the user for the version number (e.g. `0.3.0`) if not provided as an argument.

2. Verify the working tree is clean (`git status`). If there are uncommitted changes, stop and notify the user.

3. Check that the version in `src-tauri/Cargo.toml` and `src-tauri/tauri.conf.json` matches the requested version. If not, update them.

4. Also update the version in `package.json` to match.

5. Run `cargo check` in `src-tauri/` to update `Cargo.lock` with the new version.

6. Check if `public/foliate-js` submodule has changes (`git diff public/foliate-js`). If so, `cd public/foliate-js && git add -A && git commit -m "fix: scrollbar and null guard improvements" && git push`, then back in the main repo stage the updated submodule reference.

7. Stage all version-related files (`Cargo.toml`, `Cargo.lock`, `tauri.conf.json`, `package.json`, and `public/foliate-js` if changed) and commit with message `chore: bump version to v{version}`.

8. Create an annotated git tag: `git tag -a v{version} -m "v{version}"`

9. Push the commit(s) and tag: `git push && git push origin v{version}`

10. Wait for the GitHub Actions release workflow to complete: `gh run list --workflow=release.yml --limit 1 --json status,conclusion,databaseId`

11. Once the workflow succeeds, draft a release message by reviewing commits since the last tag: `git log $(git describe --tags --abbrev=0 HEAD^)..HEAD --oneline`

12. Categorize changes into sections: **What's New**, **Improvements**, **Bug Fixes** (omit empty sections).

13. Publish the release: `gh release edit v{version} --draft=false --notes "..."`. Include a **Download** section at the bottom with the `.dmg` filenames for Apple Silicon and Intel.

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
