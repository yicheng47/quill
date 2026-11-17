# Validation docs

Use these documents to select checks and preserve their evidence. [Test Scope](../../AGENTS.md#test-scope) governs ordinary changes: name the changed behavior, choose checks that cover it, and explain the connection before running them.

| Location | Purpose |
| --- | --- |
| [regression/README.md](regression/README.md) | Maintained live cases with stable IDs, tiers and environment requirements, plus the run-recording procedure. |
| [runs/](runs/) | Candidate-specific results. Feature and bug-fix QA uses `<issue>-<slug>-<platform>.md`; full regression and release runs use `YYYY-MM-DD-<platform>.md` (`mac`, `win` or `both`). Existing filenames remain stable. |

Select only regression cases affected by the diff and add feature-specific checks. Use the smoke tier for a release smoke, and the full suite for a major change or an explicit full-regression request. Reusing setup or recording procedures does not expand a feature's scope.

Live checks run through Runner's `qa` role in the development app, with iCloud sync off and the installed Quill untouched, as Test Scope requires. Documentation changes do not need the app to run.

Record the candidate commit and build, selected cases and platforms, commands and exit codes, observations, screenshot evidence, setting restoration and gaps. Preserve failed attempts alongside later retries. A code review or CI pass does not establish a native pass.

At a release sweep, promote lasting live checks into the regression suite and retain run results and investigation history separately from pruned plans or briefs.
