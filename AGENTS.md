# Quill Agent Guide

This file is the repo-wide guide for any coding assistant working on Quill. Keep shared conventions here instead of putting them only in a tool-specific file: `CLAUDE.md` is a symlink to this file. The working rules from Test Scope onward follow the Runner repo's guide and were adopted here on 2026-11-10 (Jason).

## Product Context

Quill is an AI-powered desktop ebook reader. It focuses on reading EPUB/PDF books, preserving a local library, and augmenting reading with AI lookup, explanations, translation, vocabulary, bookmarks, highlights, collections, and cross-device sync.

Core vocabulary:

- **Book**: a library item backed by an EPUB or PDF file.
- **Reader**: the reading surface for a book, including progress, layout, highlights, bookmarks, and AI panels.
- **Library**: the local SQLite materialized view plus book/cover blobs under the active data directory.
- **Sync**: iCloud-backed event-log sync for library state and shared book/cover files.
- **MCP**: Quill's local MCP server/client integration surface for AI tools to inspect or modify the library.

## Stack

- Frontend: React 19, TypeScript, Tailwind CSS 4, Vite, React Router; icons from `lucide-react`; i18n through i18next and react-i18next.
- Desktop/backend: Tauri 2, Rust, SQLite via `rusqlite` in WAL mode.
- Reader engine: `foliate-js`, a git submodule at `public/foliate-js`.
- Sync: iCloud container files, append-only event logs, snapshots, and watcher-driven replay.
- AI: OpenAI, Anthropic and Ollama over HTTP, plus ChatGPT-login OAuth for OpenAI. Each request streams over its own Tauri event channel.
- CI: `.github/workflows/ci.yaml` checks pull requests; `release.yml` builds a tagged release into a draft.

## Project Map

- `src/`: React frontend.
- `src/components/`: shared UI, reader controls, settings, and library components.
- `src/components/settings/`: settings modal sections, one per tab.
- `src/components/ui/`: common UI primitives.
- `src/pages/`: route-level screens such as library, reader, chats, vocabulary, and translations.
- `src/hooks/`: frontend data hooks and command wrappers.
- `src/contexts/`: React context providers.
- `src/i18n/`: translation JSON files.
- `src-tauri/src/commands/`: Tauri command handlers exposed to the frontend.
- `src-tauri/src/sync/`: iCloud sync engine, event log, peer manifests, replay, snapshots, and writer.
- `src-tauri/src/mcp/`: MCP server and tools.
- `src-tauri/src/ai/`: AI provider integrations.
- `src-tauri/migrations/`: versioned SQL schema.
- `public/foliate-js/`: vendored reader engine submodule.
- `design/`: Pencil source files, mainly `design/quill-desktop.pen`.
- `docs/README.md`: the docs layout and the [archive policy](docs/README.md#archive-policy).
- `docs/arch/`: architecture references.
- `docs/features/`: specs of features in development, named `{tracking-issue}-{slug}.md`. A feature is only an issue until its development starts; its spec is then written on the feature's branch and lands with the code. Retained shipped records live in `docs/features/archive/`.
- `docs/impls/`: implementation plans, written on the feature's branch; mission briefs in `docs/impls/briefs/`; retained shipped plans in `docs/impls/archive/`.
- `docs/tests/`: the live [regression suite](docs/tests/regression/README.md) in `regression/`, and dated run records in `runs/`.
- `docs/guide/`: implementation guides. `docs/roadmap/`: milestone plans.

## Development Commands

- Install dependencies: `npm install`. A fresh checkout or worktree also needs `git submodule update --init` for `public/foliate-js`.
- Start the desktop app against development data: `make dev`. A debug build keeps its database, secrets and logs under `com.wycstudios.quill-dev`, apart from the installed Quill; it still shares the iCloud container (see [Test Scope](#test-scope)). Vite's port is fixed at 1430, so only one development app runs at a time on a machine.
- Frontend only, in a browser: `make dev-web`.
- Frontend typecheck: `make typecheck`. Lint: `make lint`. Tests: `npm test`. Build: `npm run build`.
- Rust, from `src-tauri/`: `cargo check`, `cargo test`, `cargo clippy -- -D warnings`.
- Package the macOS app: `make package`.

Prefer the smallest check that covers the change. For frontend changes, run typecheck, lint and the affected tests. For Rust behavior, run the relevant `cargo test` target; for sync changes, run sync-focused tests before broadening. New backend commands get unit tests before the frontend is built on them.

## Test Scope

Feature validation covers the behavior changed by the diff and regressions directly affected by it. Before testing, list the changed behaviors and the selected checks, with a concrete reason connecting each check to the change. Unchanged sync, AI providers, the reader engine, import and other shared behavior are not automatic feature checks merely because the tested screen contains them. Take the checks from the [regression suite](docs/tests/regression/README.md) where one of its cases covers the behavior, by ID, and write feature-specific checks for the rest.

Broaden coverage for major changes, such as a sync or storage rewrite, a schema migration or a refactor affecting behavior across the app, or when Jason explicitly requests broader testing. State why the change needs that coverage. CI and the automated checks still apply. An unavailable prerequisite blocks an in-scope check; an unrelated check is outside scope, not a feature blocker. A feature pass means every selected required check passed, and must not be described as a full regression pass. Preserve failures and record any later scope change explicitly.

The development app is a separate test environment: a debug build from `make dev` keeps its library, settings, secrets and logs under `com.wycstudios.quill-dev`, apart from the installed Quill, so live testing in it is authorized standing and needs no per-mission ask. Whoever runs the selected live checks, usually the `qa` slot of a trio or the `qa` role added to a mission after its code review, may launch the development app, import small test books, and make bounded AI calls on an inexpensive model with tiny prompts. **iCloud sync is the exception.** The development app uses the same iCloud container as the installed Quill (`iCloud~com~wycstudios~quill`), so turning sync on in it would write into the real library on every device. Live tests keep sync off; a check that needs sync waits for Jason to approve and set up the environment. Never touch the installed Quill or its data.

Coders and reviewers do not run the app. The reviewer only reviews code, and decides from the diff whether live checks are needed unless the brief settles it: they are required when the change alters what a person sees or operates in the running app, and not for documentation, refactors the tests cover, or logic the Rust and frontend tests exercise; its clean review names the checks, or says why none are needed. A change expected to need live checks runs in a trio, the claude trio unless Jason asks for the codex one, whose `qa` slot takes the reviewed candidate from the coder and runs the checks the clean review names. When a duo's clean review names live checks, the mission's operator, usually the chat that started it, adds the codex `qa` role once Runner reports the mission settled: `runner mission add-role <mission> qa --task-file -`, with a task naming the checks and the candidate commit. Approving the mission approves this step, so the operator does not ask again. qa runs the checks on that candidate through computer use, and its verdict says which checks ran. A failure goes back to the coder, and the fixed candidate is reviewed again before qa reruns the affected checks.

The development app and the screen are one resource: one qa runs live checks at a time. A qa that finds another development Quill already running reports it, through Runner messages to whoever handed it the candidate, and waits; it never quits another mission's app.

A live test of a pull request runs in the `qa` role through Runner, not in the chat that asked for it. When Jason asks a chat to live-test a pull request whose mission has ended, or that no mission produced, the chat reviews the diff, then starts a mission for qa alone in the PR's worktree, checking the branch out there first if it has none: `runner mission start --title "<PR> — Live QA <topic>" --cwd <repo>/.worktrees/<flattened-branch> -q` with no crew, then `runner mission add-role <mission> qa --task-file -`. The request approves this mission. The task names the PR, its candidate commit and the worktree, where qa launches the development app with `make dev`; the selected checks, the PR's own plus any the chat's review adds, each with its reason; any development setting a check changes, with a backup and the value to restore; and the verdict: pass or fail per check with screenshot evidence, the results recorded in the PR description, and `needs-live-test` kept while any required check has not passed. qa changes no code. The chat is the mission's operator: Runner reports the settled mission back to it, and it passes a failure to Jason, or to the PR's crew while that mission still runs.

## Issue Investigation And Fixes

An issue's route follows its readiness. The route is the default recommendation; Jason's explicit choice of crew or of inline work wins, and starting a crew still needs his approval, with the crew confirmed for each mission (see [Crew Missions](#crew-missions)).

1. **Needs design** (`needs-design`): the chat that took the issue finishes the design and the spec. It draws the UI in Pencil under `design/`, settles the open questions with Jason, and writes `docs/features/<issue>-<slug>.md` on the feature's branch, naming the live checks the change needs as [Test Scope](#test-scope) describes. The issue drops `needs-design` once Jason signs the design off.
2. **Designed**: a signed-off design and spec go to a claude crew, the claude trio when the spec names live checks and the claude duo otherwise. A codex crew runs only when Jason asks for one.
3. **Very small**: a change whose brief would be longer than its diff is fixed inline, as below. A trivial change that needs no review, such as copy, a typo or an obvious one-line fix, skips the reviewer.

When Jason asks an agent to check an issue, investigate first and report the problem, likely cause, scope and relevant validation. For a small code fix, confirm that Jason wants it implemented in the current session and opened as a pull request. Once confirmed, work inline in a branch worktree, implement and validate the fix, then commit, push and open the PR. An instruction that already asks for the fix and PR is that confirmation; do not ask again. Then, unless the change is trivial, have the PR reviewed: start a mission for the codex `reviewer` alone in the PR's worktree, `runner mission start --title "<PR> — Review <topic>" --cwd <repo>/.worktrees/<flattened-branch> -q` with no crew, then `runner mission add-role <mission> reviewer --runtime codex --model gpt-6-astra --effort xhigh --task-file -`, with a task naming the PR, its head commit and the worktree. The fix request approves this mission. The chat is its operator: it folds must-fix findings into the PR's commit, pushes, and asks the reviewer to review the new head until the review is clean. Leave any required live checks to Jason, identify them in the PR and label it `needs-live-test`, following Test Scope. Doc-only fixes follow [Commit And PR Conventions](#commit-and-pr-conventions) for branch, commit and PR handling.

For larger work, write a short problem brief with the evidence, proposed scope and validation needs, then confirm the next step with Jason before implementing or launching agents. Recommend the crew the route above names, and name the live checks you expect as [Test Scope](#test-scope) describes. Start the approved crew only through Runner and follow Crew Missions; the investigation alone does not authorize a mission or Git writes. Jason can choose to narrow the scope, defer the work or continue inline instead.

## Worktrees

The checkout at the repository root stays on `main`. Every branch of work gets its own linked worktree under `.worktrees/`, named after the branch with its slashes flattened: `fix/323-focus-open-reader` lives in `.worktrees/fix-323-focus-open-reader`. Create it with `git worktree add .worktrees/<flattened-branch> -b <branch> origin/main`, then run `git submodule update --init` and `npm install` inside it, and remove it with `git worktree remove` once the branch has merged. Because the directory name is the branch name, an editor window's title says which work it holds, and either name can be derived from the other.

`.worktrees/` is ignored, and the root checkout's tooling stays out of it: `git clean -xfd` skips a nested worktree and reports it as a skipped repository, so removing one takes a deliberate `-ff`; Cargo builds only `src-tauri/`; `tsc` and ESLint read only `src/`; Vitest collects only `src/` and Vite does not watch `.worktrees/` (`vite.config.ts`); and ripgrep honours the ignore, so a search from the root checkout does not cross into another branch's copy.

Each worktree carries its own `node_modules/` and `src-tauri/target/` and pays for its own build. Do not point them at a shared `CARGO_TARGET_DIR`: Cargo takes an exclusive lock on the target directory, so concurrent worktrees would queue behind each other instead of building in parallel. Every worktree's development app uses the same development data and port, so only one runs at a time.

Work stays inside its own worktree. When several are live at once, treat the others as another machine's checkout.

## Engineering Conventions

- Follow existing local patterns before adding new abstractions.
- Keep changes scoped to the request. Avoid unrelated refactors.
- Do not revert user changes. If the working tree is dirty, inspect first and preserve unrelated edits.
- Use structured APIs and parsers when available instead of ad hoc string manipulation.
- Keep comments rare and useful. Explain non-obvious intent, not mechanics.
- Design UI in Pencil before implementing it, and keep UI aligned with the file and node referenced by the user or feature spec; the product canvas is `design/quill-desktop.pen`. Pen does not autosave and a `.pen` file does not merge, so a design is settled and committed on `main` before the branch that builds it.
- All user-facing strings use i18n keys; never hardcode English in components. Keep `src/i18n/en.json` and `src/i18n/zh.json` in sync.
- Settings are key-value rows in the SQLite `settings` table: `useSettings` on the frontend, `src-tauri/src/commands/settings.rs` on the backend. Settings modal sections follow the row pattern in `GeneralSettings.tsx`: 73px rows, `flex justify-between`, 1px `black/10` dividers.
- Sensitive data such as API keys and OAuth tokens goes in `secrets.db`, which stays local and never syncs, not in `quill.db`.
- AI streaming uses a per-request event channel through the Tauri event emitter.
- Treat sync and file-copy changes as data-safety sensitive. Preserve the invariant that the app must not repoint storage or disable sync until required local files are actually reachable.
- Do not add repo conventions only to an agent-specific file. Update this file and leave tool-specific files as pointers if needed.

## Commit And PR Conventions

- Use focused commits with an imperative subject; [Crew Missions](#crew-missions) covers how a mission's pull request is shaped.
- Common scopes: `sync`, `commands`, `reader`, `library`, `settings`, `ai`, `mcp`, `ui`, `docs`, `release`.
- Example: `fix(sync): keep status reads off the webview thread`.
- A doc-only change (`docs/`, `design/`, the README, this file) is committed straight to `main` from the root checkout, with no branch, worktree or pull request; a feature's spec, impl plan and mission brief go on its branch and land with its code. Open a PR for docs only when the edit is large and spans several files, such as a restructure or a rename across the docs tree.
- A PR that changes Quill's data-safety core gets the `core-review` label, and Jason reviews it closely before it merges. The core is the sync engine (`src-tauri/src/sync/`), the SQLite schema and migrations (`src-tauri/migrations/`), secrets storage, and the code that resolves, relocates or copies the data directory. Whoever opens the PR adds the label; test-only changes do not need it. Never remove the label, and a crew asked to merge waits for Jason's review of a `core-review` PR.
- Every PR gets exactly one risk label, which tells Jason how closely to read it: `risk-low` for a small or mechanical change a skim covers, such as removing unreachable code, a rename, or a behaviour-preserving refactor whose tests are unchanged; `risk-medium` for a real behaviour change in a contained area, whose changed code paths need reading; `risk-high` for a broad or cross-cutting behaviour change, a migration, or anything hard to undo, which needs a careful review and live testing. Whoever opens the PR picks the label from what the diff does, not from which paths it touches: a `core-review` PR can still be `risk-low`. When unsure, pick the higher one, and update the label when the PR's scope changes.
- A PR whose required live checks have not passed yet carries `needs-live-test`. Whoever opens it adds the label when the brief or the clean review names required live checks (see [Test Scope](#test-scope)); whoever runs them removes it once every selected check has passed and records in the PR description which checks ran. A failed check keeps the label. A crew asked to merge waits while the label is on.
- A PR carries `reviewed` once an independent reviewer has passed its current head with no remaining must-fix findings: the crew's reviewer for a mission's PR, or the codex `reviewer` on `gpt-6-astra` for an inline fix (see [Issue Investigation And Fixes](#issue-investigation-and-fixes)). The reviewer adds the label with its clean review and names the reviewed commit in a PR comment. Whoever later pushes a code change removes the label until the new head passes review again.
- Keep PR descriptions current when scope changes.
- Bring a branch up to date by rebasing it onto `origin/main` and pushing with `git push --force-with-lease`; never merge `main` into a branch. A PR's history stays its own commits on top of `main`. A branch need not be current to merge: catch up only when GitHub shows a conflict, or when commits touching the same code have landed on `main` since the PR's CI ran.
- Pull requests land on `main` as merge commits (`gh pr merge --merge`), never squashed or rebased. The PR's commits reach `main` as written, and the merge commit makes the PR one unit that `git revert -m 1` undoes. Read `main` one PR per line with `git log --first-parent`.
- A submodule commit (`public/foliate-js`) is pushed before the parent commit that points at it.
- Do not add tool-specific co-author trailers unless the user explicitly asks.

## Crew Missions

A crew is a trio, a coder, a reviewer and `qa`, for a change that needs live checks; otherwise it is a duo, a coder and a reviewer. The claude trio and claude duo are the default, and the codex trio and codex duo run when Jason asks for them; see [Issue Investigation And Fixes](#issue-investigation-and-fixes). Before every mission start, confirm the crew with Jason by naming it, such as the codex duo, along with the work it gets. This holds even when he has set a default for a program of missions or approved an earlier one; a qa-only or reviewer-only mission that Test Scope or Issue Investigation And Fixes already approves is the exception. A duo whose clean review names live checks gets the `qa` role added after it, as [Test Scope](#test-scope) describes. A crew mission ends in an open pull request by default. The crew works on its own branch in its own worktree, commits, pushes, opens the PR against `main`, and drives CI green; then it stops. Jason reviews the PR and does the final merge, or explicitly asks the crew to merge after review and CI are clean. Crews do not cut a release without explicit authorization. A brief's authorization states only what is specific to its mission: the approved crew, whether the crew may commit, push and open a pull request, and any exception to this section's rules. A crew follows these rules without the brief restating them.

An explicit merge request includes GitHub's automatic deletion of the merged remote branch and the [post-mission cleanup](#post-mission-cleanup); neither needs a separate confirmation.

A mission runs in its worktree. Before starting it, create the worktree as described under [Worktrees](#worktrees) and commit the brief on its branch, in `docs/impls/briefs/`; then start the mission with the worktree as its directory, `runner mission start --crew <crew> --title <title> --cwd <repo>/.worktrees/<flattened-branch> …`. Every slot's agent and shell then start in the worktree instead of the root checkout, the mission still lands under the quill project because the project is inferred from the directory, and the brief names the same path. Keep the launch goal under 8 KB and link to the spec or plan for detail.

A mission's pull request is a clean history on top of `main`, shaped as the crew judges best. A single change is usually one commit; split it when the work falls into steps that each stand on their own, such as a refactor and the feature built on it, and make every commit build and pass its tests. The brief is folded into a commit rather than landing as one of its own, and each subject names the change, not the brief. Fixes after the push, from review or CI, are folded into the commit they correct (`git commit --fixup` with an autosquash rebase, or `git commit --amend` for the last commit) rather than added as "address review" commits, and pushed with `git push --force-with-lease`.

### Post-mission cleanup

An agent that merges a pull request runs the post-mission cleanup as part of the merge, without asking again. When Jason merges one directly, the cleanup waits for a request. It covers two local steps, in this order, once `gh pr view` shows the PR merged. Neither adds a commit to `main`. A worktree with uncommitted changes stops the cleanup and is reported instead: never force its removal.

1. **Archive the missions.** For every mission that worked on the branch, including a qa-only or reviewer-only one, stop it if a session is still live (`runner mission stop <id>`), then `runner mission archive <id>`.
2. **Remove the worktree and branches.** `git worktree remove .worktrees/<flattened-branch>`, then delete the local branch. GitHub deletes the remote branch on merge; delete it by hand only if it is still there.

The mission's brief and spec stay where they are until the next release's docs sweep.

## Docs Sweep At Release

Shipped work's docs are reviewed once per production release, not after each merge; Jason may also request a cleanup. Follow the [archive policy](docs/README.md#archive-policy): delete completed small-feature and bug-fix specs and plans; retain only important features, architectural changes and consequential migration or compatibility records, with a reason in the relevant archive README. Preserve unique current decisions and repair references before pruning. Read archive indexes first and load only the records needed for the task, never the whole archive for orientation.

Once a release is published, one doc-only commit on `main` sweeps everything shipped since the previous sweep: merged missions' briefs are pruned, specs and plans follow the retention policy, and their indexes drop the shipped entries. Distant features remain issues until development starts. The procedure is the `sweep` action of the [release skill](.agents/skills/release/SKILL.md).

## Notes For Agent Runtimes

This repository is intentionally agent-agnostic. Claude Code, Codex, or any other assistant should read `AGENTS.md` as the shared guide. Portable workflow skills live under `.agents/skills`, linked into `.claude/skills` for Claude Code. Tool-specific instruction files may exist only as compatibility entrypoints and should point back here.
