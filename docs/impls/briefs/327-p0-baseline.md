# 327 P0 — Tauri Baseline

**Starting point.** Issue #327, phase 0 of the [plan](../327-electron/plan.md#phase-0--regression-suite-and-tauri-baseline). The worktree is `/Volumes/samsung/repos/yicheng47/quill/.worktrees/test-327-p0-baseline` on branch `test/327-p0-baseline`, cut from `origin/main` at the commit that carries this brief. Its app code is identical to v1.3.4. The operator has already run `git submodule update --init` and `npm install` there.

**Outcome.** A baseline record of today's Tauri app against the [regression suite](../../tests/regression/README.md), so every later #327 phase has something to compare with. This is a full run, because a shell change is a major change under [Test Scope](../../../AGENTS.md#test-scope).

**Read first.** The suite, in full: environments, corpus, cases and the recording rules.

## Selection

Run every `dev` case on macOS, 37 in all: LIB-01 to LIB-03, LIB-05 to LIB-09, RDR-01 to RDR-11, AI-01 to AI-07, VOC-01, SET-01 to SET-03, MCP-01, MCP-02 and APP-01 to APP-05.

Record these as Blocked, with the reason, without attempting them: every `win` instance (the Windows machine), LIB-04 and APP-06 (the signed environment), SYN-01 to SYN-04 (Jason's sync environment), and MEAS-02 and MEAS-03 (the signed environment). For MEAS-01, record the download sizes of the v1.3.4 release assets from `gh release view v1.3.4 --json assets`; the installed size is Blocked.

## Setup

1. With no development Quill running, copy `~/Library/Application Support/com.wycstudios.quill-dev` to `~/QuillQA/327-p0/dev-data-backup/` as a safety net. Do not restore it at the end: the corpus books stay in the development library for later phases.
2. Before changing any setting, record its value: the reader settings, theme, language, AI provider and model, and the MCP toggles and write access. Restore each one at the end, and list them in the record.
3. The development app is signed in to ChatGPT, with model `gpt-5.6-sol`. Before the first AI case, switch to the cheapest model it lists, use tiny prompts, and switch back at the end. Never sign out of ChatGPT.
4. Before the MCP cases, record the `quill` entries in `~/.claude.json` (`mcpServers.quill`) and `~/.codex/config.toml` (`[mcp_servers.quill]`). Both run `/Applications/Quill.app/Contents/MacOS/quill mcp`. Afterwards put back exactly those entries, as the suite describes, and nothing else.
5. Launch with `make dev` from the worktree. Before anything else, check in Settings that sync is off. If it is on, stop and report.

## Case notes

- The corpus is `~/QuillTestCorpus/`; import from there. LIB-05 uses the existing development library of about 358 books.
- LIB-07, LIB-08 and LIB-09 act only on what this run created: a new collection, deleted at the end, and corpus books. LIB-09 re-imports the book it deleted.
- AI-06: the API-key half and the ChatGPT sign-in flow need Jason, so record those parts Blocked. Check the model list and effort tiers with the existing sign-in. Run the Ollama part if a local Ollama answers on port 11434; otherwise mark it Skipped.
- AI-07: switch the provider to Anthropic, which has no key, to get the unconfigured state, then switch back.
- APP-05: launch the development binary `src-tauri/target/debug/quill` a second time. Never open `/Applications/Quill.app`.
- RDR-05 and RDR-10 are the main comparison points for Electron. Describe the selection behavior closely, and give each timing with its method.
- A pre-existing failure is still Failed, with a screenshot and a one-line description; the operator files or links the issue.

## Deliverables

- `docs/tests/runs/<YYYY-MM-DD>-mac.md` in the worktree, following the suite's recording rules. The candidate block names the commit, the `make dev` build, the version About shows, and the macOS version and architecture.
- Screenshots under `~/QuillQA/327-p0/`, named by case ID.
- Leave the record uncommitted, and quit the development app when done.
- Report to the operator through Runner: counts of Passed, Failed, Blocked and Skipped, and every failure.

## Authorization

A qa-only mission for the codex `qa` role, approved by Jason on 2026-11-10. qa changes no code and makes no commit or push; the operator commits the record to `main`.
