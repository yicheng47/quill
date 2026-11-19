# 326 — AI Connections: Agent (Codex) or API, + First-Launch AI Setup

GitHub issue: https://github.com/yicheng47/quill/issues/326

## Motivation

Quill reaches a model in three ways today: an API key (OpenAI or Anthropic), a local Ollama endpoint, or, for OpenAI only, a ChatGPT login. The ChatGPT login is the one most people want, because it uses a subscription they already pay for. It is also borrowed: Quill runs its own PKCE flow against the Codex CLI's public OAuth client and then calls the Codex backend's private request shape (`crates/quill-core/src/ai/oauth.rs`, `openai_responses.rs`, `codex_models.rs`). The login, token refresh, the model catalog (#294) and the request format all depend on an interface OpenAI can change without notice, and when it changes, Quill stays broken until a release ships.

OpenAI now ships the supported version of the same idea. `codex app-server` is a JSON-RPC protocol over stdio that OpenAI's own clients use, and its documentation invites other products to embed it for authentication, history and streamed events. A program that starts it uses the login the user already has in `~/.codex`, so a Codex user needs no sign-in at all, and a user who is not signed in can sign in through the app server's own ChatGPT login. Checked on 2026-11-19 against Codex CLI 0.170.0: `account/read` returned the signed-in ChatGPT account and plan, and `model/list` returned the catalog with each model's supported and default reasoning efforts, with no sign-in from the client.

Quill 2.0 therefore replaces the ChatGPT login with a Codex connection. 2.0 has not shipped yet (production is v1.3.4), so the change lands once, at the major version, with a migration for people saved on the ChatGPT login. Because Codex becomes the main way to get subscription AI, Quill also gains a first-launch AI setup helper that detects Codex and gets a reader to a working lookup in one or two clicks.

The same change simplifies the rest of the connection settings. Most model services now speak the OpenAI API at their own address, and Quill already sends OpenAI and Ollama calls through one OpenAI-compatible client (`ai/openai_compat.rs`). So Settings → AI offers two connections: an **Agent**, which today means Codex, and an **API**, one option with service presets that covers OpenAI, Anthropic, Gemini, DeepSeek, OpenRouter, Ollama and any custom endpoint.

Codex is the only agent in scope. Anthropic's terms do not allow a third-party product to use a Claude subscription login without prior approval, which rules out driving `claude -p` from a shipped app. Other CLIs have no supported embedding path comparable to the app server.

## Scope

In scope:

- **Two connections: Agent or API.** Settings → AI replaces the Provider and Sign-in-with rows with a Connection list of two choices, and the selected one expands its details beneath it.
  - **Agent** (tagged Recommended, the default for a fresh install): an agent picker whose only entry is Codex for now, then the Codex status row and Codex location. The picker leaves room for another agent later without reshaping the screen.
  - **API**: a Service picker, Base URL, and API key. The services are presets: OpenAI, Anthropic, Google Gemini, DeepSeek, OpenRouter, Ollama, and Custom (any OpenAI-compatible URL). A preset only fills the base URL and says whether a key is needed; the URL stays editable. Ollama needs no key and adds its server-status row. Anthropic keeps Quill's native Anthropic client behind its preset; every other service uses the OpenAI-compatible client.

  The ChatGPT login is removed. Settings keys: `ai_auth_mode` is `codex` for the agent and `api_key` for API; `ai_provider` holds the API service (`openai`, `anthropic`, `gemini`, `deepseek`, `openrouter`, `ollama`, `custom`). The existing `openai`, `anthropic` and `ollama` values keep their meaning, so a saved API-key or Ollama setup opens on API with the matching service.

- **API connection details.** The base URL now includes the API version path (`https://api.openai.com/v1`, `https://generativelanguage.googleapis.com/v1beta/openai`), and Quill appends only `/chat/completions`; today it appends `/v1/chat/completions`, which breaks services whose path is not `/v1`. A saved OpenAI or Ollama base URL without a version path gets `/v1` appended once on the first 2.0 launch. The model picker lists the service's `GET {base}/models` and keeps free-text entry for any model ID; when the listing fails, it falls back to free text. Temperature stays an API-only setting.

- **Two kinds of connection, no extra harness.** API services stay direct HTTP calls: they are official, stable APIs, and routing them through Codex would force API and Ollama users to install Codex and wrap small local models in a coding agent's prompt and tools. The shared dispatch path from phase 1 sends each call to one of two kinds: agent (the Codex app server) or API (the OpenAI-compatible client, or the Anthropic client for the Anthropic preset).

- **Codex through `codex app-server`.** Quill starts its own app server as a child process on the first AI call, keeps it for the session, restarts it after an unexpected exit, and stops it when Quill quits. It does not connect to the user's Codex daemon: most users don't run one, its lifecycle and version are not Quill's, and threads created there would show up in the user's Codex app. The child process reads the same `~/.codex` login, so the user signs in once for both. Each Quill call runs one turn and streams `item/agentMessage/delta` notifications into the existing per-request event channels, so the reader, chat and translation UIs keep their streaming code.

- **Model and effort.** The model card from #294 is filled from `model/list` (display name, description, hidden models filtered), with the existing Custom escape hatch. The quick and deep effort tiers keep their meaning and settings keys (`ai_effort_quick`, `ai_effort_deep`), with options from the selected model's `supportedReasoningEfforts`. Quill always sends the model and the effort on every turn and never inherits the user's Codex defaults: on the machine checked, an unset thread came up on the most capable model at `xhigh` effort, which would make every dictionary lookup slow and expensive. The tiers' default sentinel now means the selected model's `defaultReasoningEffort` from `model/list`, and an empty model means the catalog's `isDefault` model.

- **Reading assistant, not coding agent.** Every thread starts in an empty working directory that Quill owns, with the read-only sandbox, the `never` approval policy, Quill's system prompt as `baseInstructions`, and a per-thread `config` that turns off each MCP server listed by `config/read`, plus apps and plugins. Checked against 0.170.0: with those overrides, no MCP server starts. One gap remains: every thread loads the user's global `~/.codex/AGENTS.md`, and no per-thread setting tried removes it. Quill accepts this for v1, relies on its own base instructions taking precedence, and verifies it with a deliberately loud `AGENTS.md`. Pointing `CODEX_HOME` at a Quill-owned folder would remove the file but forces a second sign-in, and sharing `auth.json` between two homes is unsafe because Codex rotates refresh tokens.

- **Sign-in through Codex.** When Codex is installed but not signed in, Quill offers **Sign in with ChatGPT**: it calls `account/login/start` with `type: "chatgpt"`, opens the returned `authUrl` in the browser, and waits for `account/login/completed`; Cancel calls `account/login/cancel`. The login lands in `~/.codex`, so it also signs in the user's Codex CLI and app, which the UI says. Quill stores no OpenAI tokens of its own.

- **Chat continuity.** A chat keeps an ephemeral Codex thread in memory while Quill runs, and follow-up turns send only the new message. Any of these starts a fresh thread seeded with the chat's transcript: a Quill restart, an app-server restart, a changed model or provider, an edited or deleted message, or a failed turn on the old thread. Ephemeral threads leave nothing in the user's Codex history and need no stored mapping, so there is no schema change. Lookup, explain, translate and title generation are one-turn ephemeral threads. The implementation confirms that an ephemeral thread accepts several turns; if it does not, chat falls back to sending the transcript on each turn.

- **Finding Codex.** A Finder-launched app does not inherit the shell PATH. Quill resolves `codex` from the path override in settings, then the user's login shell (`$SHELL -ilc 'command -v codex'` on macOS), then the usual install locations on each platform (Homebrew, `~/.local/bin`, the npm global prefix and nvm on macOS; the npm global folder and `PATH` on Windows). It reads `codex --version` and requires a minimum version, initially the one the protocol tests are recorded against (0.170.0), lowered only when an older version is verified.

- **Status and errors.** Codex has six states that settings, the setup helper, and the AI entry points all share: checking, ready (account email, plan and Codex version), not installed, not signed in, too old, and failed to start (with the process's error). The backend returns a sentinel for each failure alongside `AI_NOT_CONFIGURED`, and the reader's AI popovers and Ask Quill map them to the setup card from #348 instead of a red error.

- **First-launch AI setup helper.** On the first launch with no AI configured, Quill runs Codex detection and offers the next step for its state: **Use Codex** when it is ready, **Sign in with ChatGPT** when it is not signed in, and the install command, a link to OpenAI's install page and **Check again** when it is missing or too old. Every state also offers **Use an API key or Ollama**, which opens Settings → AI on API, and **Skip for now**. Skipping or finishing records `ai_setup_seen` so the helper never reappears on its own; afterwards the AI entry points' setup card and Settings → AI cover the same ground. It is a dialog over Home (see Design), shown once.

- **Migration from the ChatGPT login.** On the first 2.0 launch, a saved `ai_auth_mode = oauth` becomes `codex`, the saved model and effort tiers carry over (the slugs are the same catalog), and the ChatGPT OAuth tokens are deleted from `secrets.db`, since no code can use them any more. These users see the setup helper once with a short note that ChatGPT sign-in now goes through Codex, whatever `ai_setup_seen` says.

- **Removal.** The borrowed path goes: `ai/oauth.rs`, `ai/openai_responses.rs`, `ai/codex_models.rs`, `commands/oauth.rs`, their `dispatch.rs` entries, the OAuth login panel and the `openai-oauth-changed` handling in the frontend, and `src/components/settings/codexModels.ts` once `model/list` fills the picker. `AI_REAUTH_REQUIRED` goes with it unless a Codex state reuses it.

- i18n for every new label, status line, error and helper string in `en.json` and `zh.json`.

Out of scope:

- Claude Code, Antigravity, Gemini CLI and other agents. The agent picker has one entry; the connection layer stays one code path, not a plugin system.
- Several saved API connections at once, per-feature connections, and service-specific extras (for example OpenRouter's ranking headers).
- Bundling or downloading Codex. The macOS arm64 package is about 380 MB unpacked, larger than Quill; the helper links to the install instead.
- Connecting to a running Codex daemon or remote app server.
- Agent tools, including Quill's own MCP server. Letting chat read the library and highlights is a follow-up that needs its own spec.
- Device-code sign-in. The app server offers it (`chatgptDeviceCode`), and it can follow if the browser flow fails for someone.

## Design

The UI is signed off (2026-11-19) in Pencil at `quill/desktop/specs/326-agent-connections.pen` in `YeelinksCo/yeelinks_design`. The canvas holds only the chosen design:

- `326 / Settings — AI · Codex ready`: the Agent/API connection list with the agent selected, then the model card and effort tiers. Temperature is not shown for the agent, which does not take it.
- `326 / Codex status row — states`: the status row in every state.
- `326 / API connection — selected states and service menu`: API on OpenRouter and on the Ollama preset, the model picker, and the service menu.
- `326 / First-launch AI setup — dialog over Home`: the helper as a dialog over the first-launch Home, in the ready state.
- `326 / Setup helper — states`: the dialog when not signed in, signing in, not installed and too old, and with the one-time note for people moving from the ChatGPT login.

## Implementation Phases

1. **Consolidate provider dispatch.** `ai_lookup`, `ai_explain`, `ai_generate_title`, `ai_chat` (`commands/ai.rs`) and `ai_translate_passage` (`commands/translation.rs`) each repeat the settings read, `resolve_ai_auth` and a provider `match`. Move them onto one load-and-dispatch path first so Codex is wired once. No behavior change; existing tests stay green.

2. **Codex discovery.** Path override, login shell, install locations, version parsing and the minimum-version check. Unit tests for lookup order and version parsing.

3. **App-server client.** Process lifecycle (start on first use, `initialize`/`initialized`, restart after exit, stop on quit), JSON-RPC request/notification routing, `account/read`, `model/list`, `config/read`, `account/login/start`/`cancel`/`completed`, `thread/start` with the isolation settings, `turn/start` with explicit model and effort, deltas into the event channel, turn completion and error mapping, and `turn/interrupt` when a stream is cancelled. Unit tests against recorded protocol transcripts cover each mapping, the isolation parameters on every `thread/start`, and restart.

4. **Chat continuity.** The in-memory chat → thread map and its reseed rules, one test per trigger.

5. **API connection.** Service presets, the version-in-base-URL convention and its one-time migration, the `/models` listing with free-text fallback, and the `ai_provider` values for the new services. Unit tests for each preset's request URL and auth header, the URL migration, and model-list parsing.

6. **Remove the ChatGPT login and migrate.** Delete the files listed under Removal, migrate `oauth` to `codex`, and delete the stale tokens from `secrets.db`. Tests for the migration, including a second launch being a no-op.

7. **Settings UI and setup helper.** Build the signed-off design: the Agent/API connection list, the service picker, the Codex status row in `AiSettings.tsx` following the section's row pattern, the model card on `model/list`, the setup helper, the migration note, and the #348 setup card for the new sentinels.

8. **i18n and QA.**

The PR changes secrets storage, so it gets `core-review`; it removes a sign-in path and migrates saved settings, so it is `risk-high`.

## Verification

Automated:

- Discovery order, version parsing and the minimum-version gate.
- Recorded transcripts: delta streaming, completion, each error state, restart after the process is killed, and interrupt.
- Every `thread/start` carries the empty Quill cwd, read-only sandbox, `never` approval, base instructions and the MCP/apps/plugins overrides; every `turn/start` carries an explicit model and effort.
- Migration from `oauth`: mode, model and tiers carried over, OAuth tokens gone, second run unchanged.
- Chat reseed: one test per trigger.
- Each API preset builds the right request URL and auth header; a saved base URL without a version path gains `/v1` once; `/models` parsing and the free-text fallback.

Live checks (development app, sync off, an inexpensive model with tiny prompts):

- With Codex installed and signed in, a fresh profile shows the setup helper in the ready state; **Use Codex** makes Look Up work with no sign-in.
- Settings shows the account, plan and Codex version; the model card lists the live catalog; changing the quick tier changes lookups only.
- Look Up, Explain, Translate, Ask Quill and chat titles all stream through Codex, and only one app-server process exists across them. Killing it mid-session, the next call recovers.
- A second chat turn continues the same thread; editing an earlier message starts a fresh thread from the transcript with no error.
- With a loud `~/.codex/AGENTS.md` and MCP servers configured, responses show no trace of them and no tool calls happen; none of Quill's calls appear in the Codex history.
- With Codex signed out (on a test machine or a `CODEX_HOME` test profile, never Jason's own login), **Sign in with ChatGPT** completes in the browser and the helper moves to ready; Cancel returns to not signed in.
- With `codex` hidden from discovery, the helper and settings show not installed; **Check again** finds it once restored. A path override is honored.
- Launched from Finder, Quill finds a `codex` installed through Homebrew or npm.
- A profile saved on the ChatGPT login opens on Codex after the update, shows the migration note once, and keeps its model and effort tiers.
- Skip for now: the helper does not return; Look Up shows the setup card linking to Settings.
- API: OpenAI and Anthropic keys still work; a saved Ollama setup opens on API → Ollama and still works; one other preset (OpenRouter or DeepSeek, on a cheap model) and a Custom URL stream a lookup; the model picker lists the service's models.
- Light and dark themes; English and Chinese strings.
