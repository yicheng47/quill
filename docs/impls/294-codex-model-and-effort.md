# Impl Plan — 294: Codex Model Card + Two-Tier Reasoning Effort

Spec: `docs/features/294-codex-model-and-effort.md`. OpenAI + OAuth (Codex subscription) path only; API-key OpenAI, Anthropic, and Ollama are untouched.

## Backend

### New module: `src-tauri/src/ai/codex_models.rs`

- `CodexModel { slug, display_name, description, supported_reasoning_levels }` — Serialize + Deserialize, snake_case. Parsed from the endpoint's `{ "models": [...] }` envelope with serde defaults so missing `description` / `supported_reasoning_levels` / `visibility` don't fail the whole list. The live catalog (codex-cli 0.146.0) ships reasoning levels as objects (`{"effort": "low", "description": "..."}`); parsing accepts both that and the bare-string form, flattening to the effort slug.
- `list_codex_models` Tauri command (registered in `lib.rs` under the AI block, command fn lives in `codex_models.rs`): returns `CodexModelList { models: Vec<CodexModel>, from_fallback: bool }`.
- Flow: resolve OAuth credentials first via `oauth::get_valid_token` (secrets.db) — no token → bundled fallback with `from_fallback: true`, without ever consulting the cache. With credentials: account-scoped cache hit → cached list; else fetch; fetch/parse error or empty list → bundled fallback (never an error to the frontend). Successful fetches are visibility-filtered, cached, returned with `from_fallback: false`.
- Endpoint: `GET https://chatgpt.com/backend-api/codex/models?client_version=<CARGO_PKG_VERSION>` with `Bearer` token + `chatgpt-account-id` header — same plumbing as `openai_responses::stream_chat`. Request timeout: 5 s (reqwest client timeout).
- Visibility filter: drop entries whose `visibility` is `"hidden"`/`"hide"`; keep everything else (including missing visibility). Erring toward showing avoids an empty picker if the server introduces a new visible variant.
- Cache: module-level `ModelListCache` (Mutex over `Option<(account_id, Instant, Vec<CodexModel>)>`), TTL 300 s, scoped to the OAuth account it was fetched for — an account switch within the TTL can never serve the previous account's catalog, and tokens without a decodable account id skip the cache entirely. Only successful remote fetches are cached — fallback results are never cached, so the first call after OAuth connect goes live. `get_at`/`put_at` take an explicit `Instant` for TTL tests.
- Bundled fallback: `gpt-5.3-codex` (default), `gpt-5.2-codex`, `gpt-5.1-codex-max`, each with empty `supported_reasoning_levels` (frontend then falls back to the effort union).

### Effort plumbing

- `openai_responses::stream_chat` gains `effort: Option<&str>` (after `account_id`). Body construction moves to `build_request_body(model, messages, effort) -> serde_json::Value`: emits `"reasoning": { "effort": <v> }` only for `Some`; for `None` the key is absent and the body is byte-identical to today's.
- Settings keys (KV `settings` table): `ai_effort_quick`, `ai_effort_deep`. Sentinel = missing key, `""`, or `"default"` → `None` (helper `effort_from_setting`).
- Tier mapping helper `effort_tier_key(call)` in `commands/ai.rs`: `lookup` / `generate_title` → `ai_effort_quick`; `chat` / `explain` / `translate` → `ai_effort_deep`. Each command reads its key alongside the existing settings reads and passes the resolved effort **only** into the `openai_responses` branch — Anthropic / openai_compat / Ollama call sites unchanged.
- Call sites: `ai_lookup`, `ai_generate_title` (quick); `ai_chat`, `ai_explain` (`commands/ai.rs`), `ai_translate_passage` (`commands/translation.rs`) (deep).

### Backend tests

- `codex_models`: envelope parsing against a fixture of the real codex-cli 0.146.0 catalog (object-shaped reasoning levels) plus the bare-string form and missing optional fields, visibility filtering (hidden dropped, missing kept), cache TTL (hit within TTL, miss after expiry), cache account-scoping (other account misses, no-identity skips), no-token fallback even with a fresh cached entry (in-memory `Secrets`), fallback on fetch error (unreachable base URL, injected), account-switch never serving the previous account's cache, fallback list contains the `gpt-5.3-codex` default, fallback is not cached.
- `openai_responses::build_request_body`: `None` → no `reasoning` key anywhere and body equals the exact pre-change shape; `Some("high")` → `reasoning.effort == "high"` and all other fields unchanged.
- `commands/ai`: `effort_from_setting` sentinel handling; `effort_tier_key` mapping matches the spec table.

## Frontend (`AiSettings.tsx`)

Rendered only when `provider === "openai" && authMode === "oauth"`; every other provider/auth combination keeps the existing free-text model `Input` and gets no effort rows.

- **Model card.** `Select` fed by `list_codex_models` (fetched on entering the openai+oauth state and refetched when `oauthStatus.connected` flips true), options `{ value: slug, label: display_name, description }`, plus a trailing `custom` option ("Custom…") that reveals the existing text input pre-filled with the current `ai_model`. Selection state: a saved `ai_model` not present in the list renders as Custom with the slug in the input — never remapped or cleared. Picking a list model writes the slug to the `model` state; saving persists via the existing `handleSaveAI` bulk save (and the OAuth auto-save).
- **Fallback hint.** When `from_fallback` is true and OAuth is connected, show the fetch-failed hint under the model row; when simply not connected, the fallback list renders without the error hint.
- **Effort rows.** Two rows below the model row following the section's row pattern: quick ("Lookup") and deep ("Chat, explain & translate"). Options: `default` sentinel first, then the selected model's `supported_reasoning_levels`, falling back to the union `low / medium / high / xhigh / max / ultra` when the model is unknown/custom or reports none. A saved level missing from the option set is appended (raw value as label) so it stays visible — never coerced.
- **Select component.** Extend `SelectOption` with optional `description` rendered as a second line; menu-height math accounts for taller described options. No behavior change for existing call sites.
- Saved via `ai_effort_quick` / `ai_effort_deep` in both save paths; loaded from `settings` like the other AI keys.

## i18n

New keys in `en.json` / `zh.json` (flat `settings.ai.*`): `modelCustom`, `modelPickerHint`, `modelListFallbackHint`, `effortQuick`, `effortQuickHint`, `effortDeep`, `effortDeepHint`, `effortDefault`, `effort.low/medium/high/xhigh/max/ultra`. No hardcoded strings.

## Checks

`cargo test` + `cargo clippy` in `src-tauri`; `npx tsc --noEmit` + `pnpm build` for the frontend. Manual QA per spec verification list (light/dark, custom round-trip, sentinel byte-identical bodies).
