# 327 M1 — Electron App In Development

**Starting point.** Issue #327, mission 1 of the [plan](../327-electron/plan.md#mission-1--electron-app-in-development). The worktree is `/Volumes/samsung/repos/yicheng47/quill/.worktrees/feat-327-electron` on the existing branch `feat/327-electron`; work on it directly and create no other branch. Its base is the commit that carries this brief, on top of `origin/main` at `3d8d4b4`. Draft PR #328 into `main` is already open for this branch, with `core-review`, `risk-high` and `needs-live-test`. `public/foliate-js` and `node_modules` are already installed.

**Outcome.** `make dev` runs the full app in Electron against the development data, end to end, with `src-tauri/` and `@tauri-apps/*` deleted. The UI and every behavior stay as they are; nothing is signed or packaged for release yet (that is mission 2). The plan's mission 1 section is the work list and wins on detail; the [spec](../../features/327-electron-shell.md) wins on scope.

**Read first.** The plan, in full, then the spec. In code: `src-tauri/src/lib.rs` (setup, data-directory resolution, `generate_handler!`), `src-tauri/build.rs` (`ensure_pdfium`), `src-tauri/src/commands/mcp.rs`, and the files that import `@tauri-apps/*` under `src/`.

## Shape

Land the work as a few commits that each build and pass their tests, so review can run alongside the next change. A sequence that fits the plan, which the crew may adjust:

1. Cargo workspace and `crates/quill-core`, with `ShellHost`, `Core` and `boot`; Tauri stays as thin wrappers, and every existing test still passes.
2. `crates/quill-mcp`.
3. `src/platform/`, implemented with today's Tauri calls, with every call site switched to it and the Vitest mocks moved.
4. `quill-node`, the Electron main process and preload, the Electron `src/platform/` implementation, desktop integration and the MCP path.
5. Tauri deleted, and CI building `quill-node` and running the Rust and frontend checks on macOS and Windows.

This brief is folded into the first commit. If the plan turns out to be wrong, or a choice would change scope (for example, no `electron-vite` release supports Vite 7 and `@tailwindcss/vite` 4), stop and ask Jason through Runner instead of improvising.

## Validation

Automated, from the plan: `cargo test` and `cargo clippy -- -D warnings` across the workspace with every existing test kept; the golden tests and the command-table test; `tsc`, lint and `npm test`; CI green on macOS and Windows.

Live checks run in two passes, so shell problems surface early:

- **Bring-up.** As soon as the Electron app boots against the development data, `coder` hands that reviewed candidate to `qa` for APP-01, LIB-01 and RDR-01 only.
- **Gate.** On the final candidate, with Tauri deleted, in the Electron development app on macOS. This is the smoke tier (LIB-01, LIB-02, RDR-01, RDR-04, RDR-06, AI-01, AI-04, SET-01, APP-01), plus the other cases the plan names: LIB-03, LIB-05 to LIB-09, RDR-02, RDR-03, RDR-05, RDR-07, RDR-08, RDR-09, AI-02, AI-03, AI-05, VOC-01, SET-03, APP-02 to APP-05, MCP-01 and MCP-02. Two more cases cover the change to first-launch theme handling. SET-02 is one. The other is a feature check: with the theme set to dark, quit, move the development Chromium profile aside, and relaunch. The app must open dark with no light flash.
- **Comparisons.** For RDR-05 (PDF selection) and RDR-10 (time to first page for the 1000-page PDF and the 5 MB EPUB), compare the Electron app with the 1.x app. Build the 1.x app with `make dev` in the root checkout on `main`, and quit the Electron app first. Describe the selection behavior closely and give each timing with its method.
- **Left to Jason.** The Windows smoke tier, which he runs once on his machine, and the ChatGPT sign-in browser hop that `open_url` now carries. List both in the record as Left to Jason.

`qa` setup and limits:

1. Before the first Electron launch, with no development Quill running, copy `~/Library/Application Support/com.wycstudios.quill-dev` to `~/QuillQA/327-m1/dev-data-backup/`. Do not restore it at the end.
2. After every launch of a new candidate, first check in Settings that sync is off. If it shows on, quit at once and report to `coder` and Jason.
3. Record every setting before changing it, and restore it at the end: reader settings, theme, language, AI provider and model, MCP toggles and write access.
4. The development app is signed in to ChatGPT. For the AI cases, switch to the cheapest listed model, use tiny prompts, and switch back afterwards. Never sign out. AI-01 working without signing in again is the evidence that `secrets.db` carried over.
5. In this mission the MCP toggles write the cargo-built `quill-mcp` path into Jason's real `~/.claude.json` and `~/.codex/config.toml`. Before MCP-01 and MCP-02, record both `quill` entries, then restore exactly those entries afterwards, as the suite describes. Confirm the restore with `claude mcp list` and `codex mcp list`.
6. For APP-05, launch the development build a second time. Never open `/Applications/Quill.app`.
7. LIB-07, LIB-08 and LIB-09 act only on what the run created, using corpus books from `~/QuillTestCorpus/`.

`qa` writes the record at `docs/tests/runs/<YYYY-MM-DD>-mac.md` in the worktree, following the suite's recording rules, and keeps screenshots under `~/QuillQA/327-m1/`, named by case ID. It leaves the record uncommitted, and `coder` commits it on the branch as its own `docs(tests)` commit once QA is clean.

## Finish

The mission ends when review and QA are clean, every commit is pushed and CI is green. Before it ends, `coder` updates the #328 description: tick mission 1, summarize what landed, and link the run record. The description also notes the Windows smoke run and the sign-in hop left to Jason. #328 stays a draft with its labels, `needs-live-test` included, because mission 2's checks remain. Post the summary to Jason through Runner and stop. Mission 2 starts separately.

## Authorization

The hydrogen trio, approved by Jason on 2026-11-17. The crew may commit on `feat/327-electron`, push it (`--force-with-lease` after a rebase or a folded fix), and update draft PR #328's description. As an exception to the crew's push rule, a commit that has cleared code review may be pushed before qa's gate run, so CI runs on it; nothing merges in this mission. The crew does not mark #328 ready, merge it, tag or release.
