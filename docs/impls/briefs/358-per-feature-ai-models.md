# 358 — Codex Model and Effort per AI Feature

**Starting point.** Issue #358. Work in `/Volumes/samsung/repos/yicheng47/quill/.worktrees/feat-358-per-feature-ai-models` on branch `feat/358-per-feature-ai-models`, based on `origin/main` `129862e`. The [spec](../../features/358-per-feature-ai-models.md) sets the scope, settings keys, resolution order, phases and checks; read it first, together with [AGENTS.md](../../../AGENTS.md). Where the spec and the design disagree on layout, the design wins; on behaviour, the spec wins.

**Sibling PR.** #359 (`fix/codex-cold-start`) is open and also edits `crates/quill-core/src/ai/codex/mod.rs` (the app-server runtime directories and start arguments), `src/components/AiSetupDialog.tsx` and `src/pages/Home.tsx`. This mission works in other functions of `codex/mod.rs` (`resolve_model_and_effort`, `TurnSpec`) and does not need the setup dialog. Keep away from #359's lines; if it merges first, rebase onto `origin/main`.

**Design.** `quill/desktop/specs/358-per-feature-ai-models.pen` in `YeelinksCo/yeelinks_design`, committed as `f62f22b`. Read it through the Pencil MCP from the working copy at `/Users/jason/repos/yeelinks/yeelinks_design` (also reachable as `/Volumes/samsung/repos/yeelinks/yeelinks_design`) and do not edit it. Frames: `YCWsJ` (Settings → AI with the four feature rows), `M72h1` (a row's open picker menu `x0TOu`, with Model and Reasoning sections), and `NdKzl` (the composer picker: Ask Quill island `XkhJu` with its open menu `P5a0d`, and the Chats view composer `qMpFS`). `dOWfE` is today's screen, for reference.

**Read first.** `crates/quill-core/src/ai/dispatch.rs` (`load_connection`), `crates/quill-core/src/commands/ai.rs` (`effort_tier_key` and its tests), `crates/quill-core/src/ai/codex/mod.rs` (`resolve_model_and_effort`, `start_turn`), `src/components/settings/AiSettings.tsx` (the Codex branch of the Models section and the `list_codex_models` fetch), `src/components/AiPanel.tsx` (`formatAiModelFooter` and the composer), `src/components/ChatsView.tsx` (its composer).

## Deliverables

1. Backend resolution per the spec's "Settings keys" section: per-feature keys, the legacy carry-over, family defaults resolved against the live catalog, and the call-to-feature map, with the unit tests phase 1 lists.
2. One shared hook for the Codex model catalog, used by Settings and both composers.
3. The four Settings feature rows and their two-section picker from `YCWsJ` / `x0TOu`, Codex connection only; the API branch unchanged.
4. The composer picker from `NdKzl` in the Ask Quill island's model line and a new matching line under the Chats view composer, writing the Chat keys; on API connections the island keeps its passive line and the Chats view shows none.
5. i18n keys in `en.json` and `zh.json` for every new string.
6. The component tests phases 3 and 4 list.

Non-goals: per-chat model memory, per-book overrides, per-feature models on API connections, and any change to the AI setup dialog.

## Validation

- **Automated:** `make typecheck`, `make lint`, `npm test`, `cargo test -p quill-core`, `cargo clippy --workspace -- -D warnings`; CI green on macOS and Windows.
- **Live, `qa` on macOS, `make dev`, iCloud sync off:** the spec's F-1 to F-4, AI-01 to AI-04, and the API part of AI-06. The checks need the development app on the Codex connection with Codex signed in on this Mac; AI-06's API part needs an API connection, so back up `~/Library/Application Support/com.wycstudios.quill-dev` before changing connections or settings and restore it byte-for-byte afterwards. Keep every AI call to a tiny prompt, one call per feature per check. Take screenshots of the Settings Models section, an open row menu, and the open composer menu in both places. Record the run in `docs/tests/runs/358-per-feature-ai-models-mac.md`.
- Until #359 lands, the first Codex start in the development app can take about 15 seconds while Codex indexes its history into Quill's private state folder. That delay is #359's fix, not a failure of this mission.
- The development app and the screen are shared: check port 1430 first and wait, through Runner messages, if another development Quill is running.

## Authorization

`neon trio`, approved by Jason on 2026-11-19. The crew may commit on `feat/358-per-feature-ai-models`, folding this brief and the spec into the implementation commits and review or QA fixes into the commits they correct. It may push and open a PR against `main` that closes #358, with the risk label its diff warrants and `needs-live-test` until qa's checks pass, then drive CI green and stop. Jason merges.
