# 326 — Agent Connections (Codex App Server + Claude Code)

GitHub issue: https://github.com/yicheng47/quill/issues/326

## Motivation

Quill can reach a model in three ways today. It can use an API key (OpenAI or Anthropic) or a local Ollama endpoint. For OpenAI only, it can also use a ChatGPT login, which runs Quill's own PKCE flow against the Codex CLI's public OAuth client and then calls the Codex backend directly (`src-tauri/src/ai/oauth.rs`, `src-tauri/src/ai/openai_responses.rs`). The login path is the one most people want, because it uses a subscription they already pay for instead of metered API credit. It has two weaknesses.

**It is borrowed.** Quill presents the Codex CLI's client ID and speaks the Codex backend's private request shape. The login flow, token refresh, the model catalog (#294) and the request format all depend on an interface that OpenAI owns and can change without notice. When OpenAI changes it, Quill stays broken until a new release ships.

**It covers only one vendor.** Quill has no subscription path to Claude at all, so Anthropic is API-key only.

Both vendors now ship a supported way for another program to drive their agent locally with the user's own login. Codex has `codex app-server`, a JSON-RPC protocol over stdio that IDE integrations use. Claude Code has `claude -p`, its headless print mode with streaming JSON output. Connecting through them moves auth, token refresh, model routing and protocol changes onto the CLI, which the user keeps up to date anyway. It also gives Claude subscribers the same path that ChatGPT subscribers have. The agent connection therefore becomes the first option. The existing ChatGPT login stays as the second option and keeps working for people who don't have the CLI installed. The API key comes last.

This revisits #183 (closed as not planned), which proposed one-shot `claude -p` and `codex exec` providers. Two things have changed since then. Codex now has a persistent app server, so it is no longer limited to one `exec` process per request. The comment on #183 also settled that chat needs a mapping to agent sessions instead of replaying the whole transcript as a single prompt on every turn.

## Scope

In scope:

- **Connection options per provider, agent first.** The provider dropdown stays OpenAI / Anthropic / Ollama. The authentication row becomes:
  - OpenAI: **Codex** (agent) → **ChatGPT login** (today's OAuth) → **API key**
  - Anthropic: **Claude Code** (agent) → **API key**
  - Ollama: unchanged

  `ai_auth_mode` gains an `agent` value. Picking OpenAI or Anthropic in the provider dropdown now preselects the agent option. A saved `oauth` or `api_key` mode is left as it is. Nobody is migrated, and the ChatGPT login keeps working unchanged: the OAuth flow, its tokens in `secrets.db`, and the model picker and effort tiers from #294.

- **Codex via `codex app-server`.** Quill starts the app server on the first AI call, keeps it running for the session, and restarts it if it exits. Each call runs one turn over JSON-RPC. Its `item/agentMessage/delta` notifications stream into the existing per-request event channels, so the reader, chat and translation UIs need no changes. The model picker reads `model/list`, and the quick and deep effort tiers from #294 map onto each turn's effort, so the agent path gets the same model card and tiers as the login path. The app server exits when Quill exits.

- **Claude Code via `claude -p`.** Each call runs its own process with `--output-format stream-json --include-partial-messages`, and the text deltas go to the same event channels. The model is free text (an alias like `sonnet` or `opus`, or a full ID) and is passed through `--model`. The effort tiers map onto `--effort`.

- **Reading assistant, not coding agent.** Both agents run with no tools, no approvals, Quill's own system prompts, and no file access beyond an empty working directory that Quill owns. On the Codex side, this uses the read-only sandbox, the `never` approval policy and base instructions on `thread/start`. None of the user's own agent setup may reach Quill's calls: `AGENTS.md` and `CLAUDE.md` files, hooks, plugins, skills and MCP servers. A dictionary lookup should not be steered by someone's coding instructions. Claude's `--bare` flag can't provide this isolation, because it skips keychain reads and would therefore bypass the subscription login this feature exists to use. Isolation comes from explicit flags instead: `--tools ""`, `--strict-mcp-config`, `--system-prompt`, `--setting-sources` and `--disable-slash-commands`.

- **Chat sessions map to agent sessions.** Each Quill chat records the agent session it last used: a Codex thread ID, or a Claude session set with `--session-id` on the first turn and continued with `--resume` after that. Follow-up turns then send only the new message and get prompt caching. Quill reuses the session only while the chat's history is exactly what that session last saw. Any of the following starts a fresh session seeded with the chat transcript: switching provider mid-chat, editing or deleting messages, a missing session, or a failed resume. The mapping stays on the machine and does not sync, so another device simply starts a fresh session the same way. Lookup, explain, translate and title generation are one-shot calls and leave no session behind (an `ephemeral` Codex thread, Claude's `--no-session-persistence`), so they don't clutter the user's Codex or Claude history.

- **Finding the CLI.** A macOS app launched from Finder does not inherit the shell PATH, so a naive lookup misses a `codex` installed through nvm or a `claude` in `~/.local/bin`. Quill finds the binary through the user's login shell and the usual install locations. Settings also offer an optional path override.

- **Status and errors.** Where the ChatGPT login shows its OAuth login panel, the agent option shows a status row instead. The row says whether the CLI was found and its version, plus the signed-in account when the CLI reports one (`account/read` for Codex). Three failure cases each get their own inline message that tells the user what to run (`codex login`, or `claude` and then `/login`): the CLI is not installed, the user is not signed in, or the version is too old for the protocol. The same messages appear in the chat bubble when a call fails, instead of a generic AI error.

- i18n for all new labels, status lines and errors in `en.json` and `zh.json`.

Out of scope:

- Signing in to the CLI from inside Quill. Codex's app server does offer a login flow, but v1 tells the user to sign in from the terminal. People who want to log in inside the app can still use the ChatGPT login option.
- Letting the agent use tools, including Quill's own MCP server. Giving chat read access to the library and highlights through MCP is a natural follow-up. It would change what a chat turn can do, so it needs its own spec.
- Other agents (Gemini CLI, OpenCode, pi). The connection layer should not hard-code two cases into every call site, but only Codex and Claude Code ship here.
- Removing or deprecating the ChatGPT login.

## Implementation Phases

1. **Consolidate provider dispatch.** Five commands repeat the same settings read and provider `match`: `ai_lookup`, `ai_explain`, `ai_generate_title`, `ai_chat` (`src-tauri/src/commands/ai.rs`) and `ai_translate_passage` (`src-tauri/src/commands/translation.rs`). Move that into one shared load-and-dispatch path before adding two more connection types, so each new path is wired once instead of five times. Behavior doesn't change, and the existing tests stay green.

2. **CLI discovery.** Find `codex` and `claude` by checking the path override, then the login shell, then the usual install locations, and read each one's version. Unit tests for the lookup order and for version parsing.

3. **Codex app-server client.** Process lifecycle (start on first use, `initialize` handshake, restart after an exit), routing of JSON-RPC requests and notifications, turn streaming into the event channels, `model/list` and `account/read`. Unit tests against recorded protocol transcripts cover delta mapping, turn completion, error mapping and restart.

4. **Claude Code runner.** One process per call with the isolation flags, stream-json parsing into deltas, and session-ID and resume handling. Unit tests check that the isolation flags are always present in the arguments and that stream parsing is correct.

5. **Chat session mapping.** Store each chat's link to its agent session locally, together with the point in the history that session has seen, and apply the reseed rules. One test per reseed trigger.

6. **Settings UI.** Design the reordered authentication row and the agent status states in Pencil first: found and signed in, not installed, not signed in, and too old. Then build them in `AiSettings.tsx` following the section's row pattern. Codex reuses the model card from #294, filled from `model/list`. Claude Code uses a free-text model field.

7. **i18n + QA.** Strings in both languages, light and dark themes, and the full matrix below.

## Verification

- OpenAI shows Codex, ChatGPT login and API key in that order. Anthropic shows Claude Code, then API key. Choosing either provider fresh preselects the agent option.
- An existing install saved on ChatGPT login still opens on ChatGPT login after the update. Lookup, explain, chat, translate, titles, the model picker and the effort tiers all keep working.
- With Codex selected, all five call types stream through the app server. Only one app-server process exists across many calls. If that process is killed mid-session, the next call recovers.
- With Claude Code selected, all five call types stream through `claude -p`.
- Isolation: set up a deliberately loud `CLAUDE.md` / `AGENTS.md`, a hook and an MCP server in the user's own agent configuration. Quill's responses show no trace of any of them, and no tool calls are made.
- Chat: a second turn in the same chat reuses the session and sends only the new message. Switching provider mid-chat, deleting a message, or deleting the agent's session on disk each starts a fresh session from the full transcript, with no error.
- One-shot calls don't appear in the `codex` or `claude` session history.
- When Quill is launched from Finder rather than a terminal, it finds a `codex` installed through nvm and a `claude` in `~/.local/bin`. A path override is used when set.
- A missing CLI, a signed-out CLI and a CLI that is too old each show their own message in settings and in the chat bubble.
- Ollama and both API-key paths are untouched.
- All new strings are localized in English and Chinese.
