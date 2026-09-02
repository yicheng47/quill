# 325 — OpenAI OAuth Session Expiry → Re-login Prompt

GitHub issue: https://github.com/yicheng47/quill/issues/325

## Motivation

The OpenAI OAuth path already knows when its access token expires: `expires_at` is persisted in `secrets.db`, and `get_valid_token` (`src-tauri/src/ai/oauth.rs`) refreshes whenever the token is within 60s of that. That common case works. What doesn't work is everything *after* the refresh stops working — and nothing today turns those failures into something the UI can act on.

Two failure modes, both surfaced as raw strings:

1. **Dead refresh token** — revoked from the OpenAI side, password change, or simply aged out. `refresh_access_token` returns `Token refresh error 400: {"error":"invalid_grant"…}`. The stale tokens are left in `secrets.db`, so `openai_oauth_status` keeps reporting `connected: true` and the Settings panel keeps its green "Connected" row. Every subsequent AI call re-attempts the refresh and fails the same way.
2. **In-window access token rejected server-side.** `openai_responses::stream_chat` maps every non-2xx to `AppError::Ai("API error {status}: {body}")`. Chat, Lookup, Explain, and Translate all run the stream in a spawned task, and that task's error handler emits `Error: {e}` as a text *delta* — so `Error: API error 401: …` is rendered inside the assistant bubble as if the model had said it.

The frontend only special-cases one sentinel, `AI_NOT_CONFIGURED`, which renders a "set up your AI provider" card with an Open Settings button. Everything else falls through to `Error: <raw>`. A dead session is, from the user's point of view, the same problem as an unconfigured provider — there is nothing to do except go to Settings and sign in — and it should get the same treatment.

## Scope

In scope:

- **A second sentinel, `AI_REAUTH_REQUIRED`**, alongside `AI_NOT_CONFIGURED`. It is the *only* thing the OAuth path is allowed to say when the session is unrecoverable. Raw refresh-endpoint bodies and raw 401 bodies never reach the UI.
- **Refresh failure classification** in `get_valid_token`. A 400 or 401 from the token endpoint means the refresh token is dead: clear the stored tokens and return `AI_REAUTH_REQUIRED`. An empty stored refresh token is treated the same way. Network errors and 5xx stay generic `AppError::Other` — being offline, or OpenAI having a bad minute, must not log the user out.
- **401 from the Codex backend** in `openai_responses::stream_chat` (and the models fetch in `codex_models.rs`, which already degrades to the bundled list) → clear tokens and return `AI_REAUTH_REQUIRED`. Only 401. A 403 can mean a plan or model entitlement problem, not an auth problem, and stays a generic API error.
- **Error-path plumbing** in the four spawned-stream handlers (`ai_lookup`, `ai_explain`, `ai_chat`, title generation in `commands/ai.rs`) and `commands/translation.rs`: when the stream error is the sentinel, emit the bare sentinel as the delta instead of `Error: {e}` — exactly how `AI_NOT_CONFIGURED` already travels when it is raised before the spawn.
- **Frontend "session expired" card**, same shape as the not-configured card, in `MessageBubble`, `LookupPopover`, `ExplainPopover`, and `TranslationPopover`. Copy: "Your OpenAI session has expired. Sign in again to keep using AI features." Button: the existing Open AI Settings action (`open_settings_on_main` with `section: "ai"`, then focus the main window). The sentinel can arrive on either channel — as an `invoke` rejection (refresh failed before the spawn) or as the sole delta of the stream (401 mid-flight) — and both must render the card.
- **Settings reflects reality.** Because tokens are cleared on an unrecoverable failure, `openai_oauth_status` reports `connected: false` and the existing OAuth panel shows its Login state. No new status fields.
- i18n keys for the new copy in `en.json` and `zh.json`.

Out of scope:

- **Refresh-and-retry on a mid-stream 401.** `expires_at` already gates the clock case with a 60s margin, so a 401 on an in-window token means the session was revoked, not that we raced the expiry. Retrying only delays the prompt.
- **Exposing `expires_at` / an `expired` flag from `openai_oauth_status`.** An expired access token with a live refresh token is the normal steady state between calls and self-heals on the next request; labelling it "expired" in Settings would be alarming and wrong. Cleared-tokens ⇔ disconnected is the only signal Settings needs.
- **Re-login directly from the reader popover.** The OAuth flow opens a browser and binds a local callback port; keeping it in the Settings modal on the main window matches the existing entry point.
- Anthropic / OpenAI-compatible API-key paths. A 401 there means a bad key and already reads as one.

## Implementation Phases

1. **Backend — sentinel + refresh classification.** Add the `AI_REAUTH_REQUIRED` constant next to where `AI_NOT_CONFIGURED` is raised. In `get_valid_token`: empty refresh token → clear + sentinel; refresh 400/401 → clear + sentinel; everything else unchanged. `refresh_access_token` needs to expose the status rather than pre-formatting it into a string. Unit tests: dead refresh token clears tokens and yields the sentinel; a 503 leaves tokens intact and yields a generic error; empty refresh token yields the sentinel.

2. **Backend — Codex 401.** `openai_responses::stream_chat` and `codex_models::fetch_remote` map 401 to the sentinel and clear tokens; 403 and others unchanged. The stream functions do not currently see `Secrets`, so either pass it through or return a typed error the caller clears on — pick whichever keeps the signatures smallest.

3. **Backend — stream error paths.** The five spawned-stream error handlers emit the bare sentinel as the delta when the error is the sentinel, `Error: {e}` otherwise. One small helper, used in all five places, is fine; a `match` in each is also fine.

4. **Frontend.** `useAiChat`'s catch maps the sentinel to bubble content the same way it does `AI_NOT_CONFIGURED`; `MessageBubble` renders the session-expired card when `msg.content === "AI_REAUTH_REQUIRED"`. The three popover stream hooks gain a `reauthRequired` flag set from either the `invoke` catch or a done-chunk whose accumulated content equals the sentinel, and render the card. i18n keys added.

5. **QA.** Corrupt `oauth_refresh_token` in `secrets.db` with `oauth_expires_at` in the past; separately, revoke the session from the OpenAI side with a fresh token still in-window.

## Verification

- Dead refresh token: Chat, Lookup, Explain, and Translate each show the session-expired card, not `Error: Token refresh error 400: …`. Settings → AI shows the Login state, not Connected.
- In-window token revoked server-side: same card, not `Error: API error 401: …` inside the bubble. Settings shows Login.
- Clicking the card's button opens Settings on the AI section with the main window focused; signing in again makes the next AI call succeed without restarting the app.
- Offline, with a token past `expires_at`: a generic error, and the user is *not* logged out — reconnecting the network and retrying succeeds without re-login.
- A 403 from the Codex backend still surfaces as a generic API error and does not clear tokens.
- The Codex model list falls back to the bundled list on a dead session, exactly as it does when logged out.
- `AI_NOT_CONFIGURED` behavior is unchanged for the API-key and Ollama paths.
