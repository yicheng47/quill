# 326 — AI Connections: Agent (Codex) or API, + First-Launch AI Setup

**Starting point.** Issue #326. Work in `/Users/jason/repos/yicheng47/quill/.worktrees/feat-326-agent-connections` on branch `feat/326-agent-connections`, based on `origin/main` `5d2aa71`. The branch already carries the spec commits. The [spec](../../features/326-agent-connections.md) sets scope, decisions, phases and checks; read it first, together with [AGENTS.md](../../../AGENTS.md). Follow its implementation phases in order. Phase 1 (consolidating provider dispatch) is a behavior-preserving refactor and may be its own commit.

**Design.** `quill/desktop/specs/326-agent-connections.pen` in `YeelinksCo/yeelinks_design` (committed at `096d826`), signed off on 2026-11-19. Frames: `326 / Settings — AI · Codex ready`, `326 / Codex status row — states`, `326 / API connection — selected states and service menu`, `326 / First-launch AI setup — dialog over Home`, `326 / Setup helper — states`. Read it from `/Users/jason/repos/yeelinks/yeelinks_design` through the Pencil MCP, and do not edit it.

**Protocol reference.** Generate the app-server schema with `codex app-server generate-json-schema --out <dir>` (Codex 0.170.0 is installed). Record protocol transcripts for the tests from a real `codex app-server` using `initialize`, `account/read`, `model/list`, `config/read` and `thread/start`, which make no model calls. A recorded turn may use one tiny prompt on the cheapest listed model at `low` effort.

**Jason's own Codex is off limits.** Never edit or move anything under `~/.codex`, including `AGENTS.md`, which is a symlink into his memory repo. Never run `codex login`, `codex logout`, `account/logout` or a sign-in flow against it. Never stop or restart his Codex daemon. Only kill an app-server process that Quill itself started, identified by its parent PID.

## Deliverables

The spec's scope and phases 1–8: shared dispatch; Codex discovery; the app-server client with isolation; in-memory chat continuity; the API connection with service presets, the base-URL convention and `/models` listing; removal of the ChatGPT login with the `oauth` → `codex` migration and token cleanup; the settings UI, setup dialog and #348 setup card per the design; i18n in `en.json` and `zh.json`; and the tests the spec lists.

## Validation

- **Automated:** `cargo test --workspace`, `cargo clippy --workspace -- -D warnings`, `make typecheck`, `make lint`, `npm test`, `npm run electron:build`; CI green.
- **Live, `qa` on macOS, `make dev`, iCloud sync off.** Before launching, back up `~/Library/Application Support/com.wycstudios.quill-dev` and `com.wycstudios.quill-chromium-dev`, then restore both byte-for-byte afterwards. Use the cheapest model at `low` effort with tiny prompts, and Jason's existing Codex login read-only. Run the spec's live checks that fit those limits:
  - the setup dialog on a fresh dev profile, in the ready state;
  - the Settings screens;
  - all five call types streaming through Codex;
  - a single app-server process, and recovery after Quill's own child is killed;
  - chat continuity and reseeding;
  - no tool calls, and nothing added to Codex history;
  - not-installed status, via a path override pointing at a missing file;
  - the migration from a dev profile seeded with `ai_auth_mode = oauth`;
  - Skip for now;
  - the API presets, OpenAI-compatible against Ollama if one is running and otherwise a key Jason provides;
  - light and dark themes, English and Chinese.

  Record the run in `docs/tests/runs/326-agent-connections-mac.md`.
- **Left to Jason:** the signed-out **Sign in with ChatGPT** flow, the loud-`AGENTS.md` isolation check, a Finder-launched build finding Homebrew or npm Codex, any paid API preset he wants checked, and Windows. List them in the PR description and keep `needs-live-test` until he has run them.

## Authorization

`claude trio`, approved by Jason on 2026-11-19. The crew may commit on `feat/326-agent-connections`, folding this brief into the implementation commits and review/QA fixes into the commits they correct. It may push and open a PR against `main` that closes #326, with labels `core-review`, `risk-high` and `needs-live-test`, then drive CI green and stop. Jason reviews and merges.
