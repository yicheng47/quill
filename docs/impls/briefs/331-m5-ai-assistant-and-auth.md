# 331 M5 — AI Assistant, Auth Lifecycle and #325 Session Expiry

**Starting point.** Issue #331, Mission 5 of the [plan](../331-rebrand/plan.md); closes #325. Work in `/Volumes/samsung/repos/yicheng47/quill/.worktrees/feat-331-m5-ai-assistant-and-auth` on branch `feat/331-m5-ai-assistant-and-auth`, based on `origin/main` `74d7582`. M2, M3, M4 and M6 have merged: the in-window Settings view (`src/components/settings/SettingsView.tsx`, `SettingsNav.tsx`) currently mounts the old `AiSettings.tsx` under `AI Assistant`. No sibling mission is running.

**Outcome.** `Settings → AI Assistant` is rebuilt in Dawn across its connected, signed-out, API-key, waiting-for-browser, failed sign-in, Ollama and sign-out states. The backend classifies a dead OpenAI session as `AI_REAUTH_REQUIRED` (#325), clears the tokens, and every AI surface shows a session-expired card that routes to `Settings → AI Assistant`. The plan's Mission 5 section and [`325-oauth-session-expiry.md`](../../features/325-oauth-session-expiry.md) set scope and behavior; the design wins on visual detail.

**Design.** `quill/desktop/specs/331-rebrand.pen` at `323c398` in `YeelinksCo/yeelinks_design`, checked out at `/Volumes/samsung/repos/yeelinks/yeelinks_design` (pull before opening). Nodes: `k9Vj9`, `XIfpn`, `lXiaG`, `o04NH`; tokens and components in [`design-map.md`](../331-rebrand/design-map.md). Read through the Pencil MCP by node ID; do not edit the `.pen`.

**Decisions (operator, 2026-11-18, under Jason's delegation).**

- The #325 spec predates Electron: its `src-tauri/` paths are now `crates/quill-core/src/` (`ai/oauth.rs`, `ai/openai_responses.rs`, `ai/codex_models.rs`, `commands/ai.rs`, `commands/translation.rs`, `commands/oauth.rs`). Its "Settings modal" is now the in-window Settings view, opened at the `AI Assistant` tab through the existing `open-settings` routing.
- Token clearing reuses the existing secrets API. If the work needs a change to how `secrets.db` stores or reads secrets, stop and ask the operator: that makes the PR `core-review`, which Jason must review before merge.
- Reader surfaces are M7's to redesign. M5 adds the `AI_REAUTH_REQUIRED` and `AI_NOT_CONFIGURED` cards in Dawn style to `MessageBubble`, `LookupPopover`, `ExplainPopover` and `TranslationPopover` as they stand today; M7 restyles those popovers later and keeps the cards.
- `openai_oauth_cancel` aborts a pending browser sign-in and frees its callback port. Show the account email in `Connected` only when `OAuthStatus` can carry it without new token scopes; otherwise omit it.
- The Ollama `Running` badge comes from a cheap local reachability check (the configured base URL) with a short timeout, run when the tab opens; it never blocks the UI.

**Read first.** [`plan.md`](../331-rebrand/plan.md) Mission 5, [`325-oauth-session-expiry.md`](../../features/325-oauth-session-expiry.md), the [spec](../../features/331-rebrand.md), [`design-map.md`](../331-rebrand/design-map.md) and [AGENTS.md](../../../AGENTS.md). In code: `src/components/settings/AiSettings.tsx`, `src/components/settings/SettingsView.tsx`, `src/components/MessageBubble.tsx`, `crates/quill-core/src/ai/oauth.rs`, `crates/quill-core/src/ai/openai_responses.rs` and `crates/quill-core/src/commands/{ai,oauth,translation}.rs`.

## Deliverables

1. The three deliverables in the plan's Mission 5 section and the #325 spec's implementation phases.
2. Rust unit tests first for the backend: empty refresh token, refresh 400 and 401, Codex 401 (sentinel, tokens cleared), and 403, 5xx and network errors left generic; plus the cancel path and the Ollama check.
3. Frontend tests for every `AI Assistant` state and for the session-expired and not-configured cards in each surface.
4. Replaced `AiSettings` chrome, dead styles and i18n keys are removed; `en.json` and `zh.json` stay in sync. Update `AI-06` and `AI-07` in `docs/tests/regression/` where their expected UI changes.

## Validation

- **Automated:** `make typecheck`, `make lint`, `npm test`, `npm run electron:build`, `cargo test --workspace`, `cargo clippy --workspace -- -D warnings`; CI green on macOS and Windows.
- **Live, `qa` in `make dev` on macOS with iCloud sync off.** Check port 1430 first and wait if another development Quill runs. Back up `~/Library/Application Support/com.wycstudios.quill-dev` (including `secrets.db`) and `com.wycstudios.quill-chromium-dev` first, and restore both byte-for-byte afterwards.
  - `F-331-AI-STATES`: each `AI Assistant` state against its node, using whatever providers the dev profile already has; an API-key provider with a tiny prompt on an inexpensive model.
  - `F-331-REAUTH` (#325): with OpenAI OAuth tokens present in the dev `secrets.db`, make the refresh token unusable (for example, clear it with the app quit), then trigger one AI action: the session-expired card appears in place of a raw error, `Open AI Settings` lands on `AI Assistant`, and Settings shows signed out. Restore `secrets.db` afterwards. If the dev profile has no OAuth tokens, record the check as blocked; do not sign in.
  - `AI-07`: with no provider configured, the not-configured card appears in each surface; restore the provider after.
  - Sign-in: start `Sign in with ChatGPT`, confirm the waiting state, then `Cancel` and confirm the port is freed. Never complete or approve a sign-in in the browser; completing the ChatGPT login is left to Jason.
  - Compare each changed screen against its design node and screenshot it.
- Record the run in `docs/tests/runs/331-m5-ai-assistant-and-auth-mac.md`. The Windows live smoke and a real ChatGPT sign-in are left to Jason.

## Authorization

`hydrogen trio`, started by the operator under Jason's standing approval for #331 (2026-11-18). The crew may commit on `feat/331-m5-ai-assistant-and-auth` (folding this brief into an implementation commit, and folding review and QA fixes into the commits they correct), push, and open a PR against `main` labeled `needs-live-test` with the risk label its diff warrants, then drive CI green and stop; the operator merges.
