---
name: bug
description: Report, list, or manage bug reports as GitHub issues
---

# Bug Reporting

Report and manage bugs for Quill via GitHub Issues with the `bug` label.

## Usage

`/bug <action> [args]`

### Actions

#### `new`
Report a new bug.

1. Ask the user to describe the bug: what happened, what was expected, and steps to reproduce (if known).
2. Investigate the codebase to confirm the area of code involved. Note relevant file paths.
3. Create a GitHub Issue with label `bug`:
   - Title: `bug: <short description>`
   - Body using this template:

     ```
     ## Description
     <what's wrong>

     ## Expected behavior
     <what should happen>

     ## Steps to reproduce
     <if known>

     ## Relevant code
     <file paths and brief pointers to the affected area>

     ## Environment
     - OS: <if relevant>
     - Version: <app version from `src-tauri/tauri.conf.json`>
     ```
4. Report the issue URL.

#### `list`
Show all bugs and their status.

1. List all GitHub Issues with the `bug` label: `gh issue list --label bug --state all --limit 50`
2. Present a table: issue number, title, state (open/closed), assignee.

#### `close <issue-number>`
Mark a bug as fixed.

1. Close the GitHub Issue: `gh issue close <number>`
2. Confirm closure to the user.

#### `view <issue-number>`
Show details of a specific bug report.

1. Fetch the issue: `gh issue view <number>`
2. Display the full issue body, comments count, and current state.

## Labels

- `bug` — all bug issues use this label

## Notes

- Do not commit or push unless the user explicitly asks.
- When creating issues, investigate the codebase first to include relevant file paths — this makes bugs actionable.
- Read the app version from `src-tauri/tauri.conf.json` when populating the Environment section.
