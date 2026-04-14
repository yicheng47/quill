# 29 — CLI AI Providers (Claude Code & Codex)

**Status:** Planned
**GitHub Issue:** [#183](https://github.com/yicheng47/quill/issues/183)

## Motivation

Quill currently supports HTTP-based AI providers (OpenAI, Anthropic, Ollama). Users who have Claude Code or Codex CLI installed — tools that handle their own authentication and model access — can't use them as Quill's AI backend. Adding CLI providers broadens the audience: anyone with a working `claude` or `codex` command gets AI features without configuring API keys.

## Scope

Add Claude Code and Codex as two new AI provider options. Both run in **headless mode** — one process per request, stream stdout, done. No persistent sessions, no daemon, no orchestrator. They slot into the existing provider dispatch alongside Anthropic/OpenAI/Ollama.

### In scope

- New `ai/cli.rs` module: spawn CLI process, parse JSON streaming output, emit `AiStreamChunk` events
- New `ai/dispatch.rs` module: extract the 4x-duplicated settings-loading and provider-dispatch boilerplate into shared helpers
- `claude_cli` provider: invokes `claude -p --output-format stream-json`
- `codex_cli` provider: invokes `codex exec --json`
- Settings UI: add providers to dropdown, show/hide fields conditionally (no API key/base URL for CLIs, show optional command path)
- Tools disabled for both CLIs (reading assistant, not coding tool)
- 120s process timeout

### Out of scope

- Session management / conversation continuity across CLI invocations
- Health dashboard / CLI status checking
- OpenCode support (can be added later if needed)
- Cancellation infrastructure (process runs to completion)

## Implementation Phases

### Phase 1: Backend refactor + CLI module

1. Add `"process"` feature to tokio in `Cargo.toml`
2. Create `ai/dispatch.rs` — `AiSettings` struct, `load_ai_settings()`, `dispatch_stream()`, `emit_stream_error()`
3. Create `ai/cli.rs` — `stream_chat_claude()`, `stream_chat_codex()`, `format_prompt()`
4. Refactor `commands/ai.rs` and `commands/translation.rs` to use dispatch helpers
5. Unit tests for `format_prompt`

### Phase 2: Frontend

1. Add `claude_cli` and `codex_cli` to provider dropdown in `AiSettings.tsx`
2. Conditional field visibility (hide API key, base URL, temperature for CLI providers; show command path)
3. i18n keys for both languages

## Key Technical Decisions

- **Headless, not daemon:** One process per request. No `OrchestratorManager`, no session tracking. The process exits when done.
- **Refactor alongside:** The settings-reading block is copy-pasted 4 times across `ai_lookup`, `ai_chat`, `ai_generate_title`, and `ai_translate_passage`. Extract into shared helpers before adding 2 more provider cases.
- **Tools disabled:** CLIs support tool use (file editing, code execution), but Quill is a reading assistant. Always pass flags to disable tools (`--allowedTools ""` for Claude, `--skip-git-repo-check` for Codex).
- **No API key required:** CLIs handle their own auth (`claude auth login`, `codex auth`). The `AI_NOT_CONFIGURED` check skips CLI providers.

## CLI Invocations

**Claude Code:**
```
claude -p --output-format stream-json --allowedTools "" [--model X] [--max-tokens N] "<prompt>"
```
JSON events: `content_block_delta` (with `delta.text`), `result` (done)

**Codex:**
```
codex exec --json --skip-git-repo-check [-m model] "<prompt>"
```
JSON events: `item.completed` + `item.type == "agent_message"` (with `item.text`), `turn.completed` (done)

## Verification

- [ ] `cargo test` passes (format_prompt unit tests)
- [ ] `cargo build` compiles with process feature
- [ ] Claude CLI: lookup, chat, translate, title all stream correctly
- [ ] Codex: same 4 operations
- [ ] CLI not found: friendly error message in chat bubble
- [ ] Settings UI: fields show/hide correctly per provider
- [ ] Regression: OpenAI, Anthropic, Ollama still work after refactor
